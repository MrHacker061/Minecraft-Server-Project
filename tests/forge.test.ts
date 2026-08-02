import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ForgeBuildInfo } from '../src/shared/contracts'
import {
  detectForgeLaunch,
  downloadForgeInstaller,
  forgeInstallerUrl,
  installForgeServer,
  resolveForgeBuild,
  resolvePreferredForgeBuild,
  type ForgeInstallerRunner,
  type ForgeServiceDependencies
} from '../src/main/services/forge'

const temporaryDirectories: string[] = []
const promotionsUrl = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function webResponse(
  url: string,
  body: ConstructorParameters<typeof Response>[0],
  status = 200,
  headers?: RequestInit['headers']
): Response {
  const response = new Response(body, { status, headers })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function promotions(promos: Record<string, string>): Response {
  return webResponse(promotionsUrl, JSON.stringify({
    homepage: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
    promos
  }))
}

function buildFor(bytes: Uint8Array, minecraftVersion = '1.21.1', forgeVersion = '52.1.16'): ForgeBuildInfo {
  const name = `forge-${minecraftVersion}-${forgeVersion}-installer.jar`
  return {
    minecraftVersion,
    forgeVersion,
    mavenVersion: `${minecraftVersion}-${forgeVersion}`,
    channel: 'exact',
    installer: {
      name,
      sha1: createHash('sha1').update(bytes).digest('hex'),
      url: forgeInstallerUrl(minecraftVersion, forgeVersion)
    }
  }
}

function fetchDependency(mock: ReturnType<typeof vi.fn>): Partial<ForgeServiceDependencies> {
  return { fetch: mock as unknown as ForgeServiceDependencies['fetch'] }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe('Forge build resolution', () => {
  it('prefers Forge recommended and pins its official Maven SHA-1', async () => {
    const installerUrl = forgeInstallerUrl('1.21.1', '52.1.0')
    const sha1 = 'a'.repeat(40)
    let promotionsRequest: RequestInit | undefined
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === promotionsUrl) {
        promotionsRequest = init
        return promotions({
          '1.21.1-latest': '52.1.16',
          '1.21.1-recommended': '52.1.0'
        })
      }
      if (url === `${installerUrl}.sha1`) return webResponse(url, `${sha1}\n`)
      throw new Error(`Unexpected URL ${url}`)
    })

    const build = await resolvePreferredForgeBuild('1.21.1', fetchDependency(fetchMock))

    expect(build).toEqual({
      minecraftVersion: '1.21.1',
      forgeVersion: '52.1.0',
      mavenVersion: '1.21.1-52.1.0',
      channel: 'recommended',
      installer: {
        name: 'forge-1.21.1-52.1.0-installer.jar',
        sha1,
        url: installerUrl
      }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(promotionsRequest).toMatchObject({ redirect: 'error' })
  })

  it('falls back to latest and resolves an exact coordinate without guessing a promotion', async () => {
    const latestUrl = forgeInstallerUrl('26.2', '65.1.0')
    const exactUrl = forgeInstallerUrl('1.20.1', '47.4.22')
    const fetchMock = vi.fn(async (url: string) => {
      if (url === promotionsUrl) return promotions({ '26.2-latest': '65.1.0' })
      if (url === `${latestUrl}.sha1`) return webResponse(url, 'b'.repeat(40))
      if (url === `${exactUrl}.sha1`) return webResponse(url, 'c'.repeat(40))
      throw new Error(`Unexpected URL ${url}`)
    })
    const dependencies = fetchDependency(fetchMock)

    await expect(resolvePreferredForgeBuild('26.2', dependencies)).resolves.toMatchObject({
      forgeVersion: '65.1.0',
      channel: 'latest'
    })
    await expect(resolveForgeBuild('1.20.1', '47.4.22', 'exact', dependencies)).resolves.toMatchObject({
      forgeVersion: '47.4.22',
      channel: 'exact'
    })
    expect(fetchMock.mock.calls.filter((call) => call[0] === promotionsUrl)).toHaveLength(1)
  })

  it('resolves legacy promoted builds through Forge\'s Minecraft-suffixed Maven coordinate', async () => {
    const primaryUrl = forgeInstallerUrl('1.7.10', '10.13.4.1614')
    const mavenVersion = '1.7.10-10.13.4.1614-1.7.10'
    const legacyUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mavenVersion}/forge-${mavenVersion}-installer.jar`
    const sha1 = 'd'.repeat(40)
    const fetchMock = vi.fn(async (url: string) => {
      if (url === promotionsUrl) return promotions({ '1.7.10-recommended': '10.13.4.1614' })
      if (url === `${primaryUrl}.sha1`) return webResponse(url, '', 404)
      if (url === `${legacyUrl}.sha1`) return webResponse(url, sha1)
      throw new Error(`Unexpected URL ${url}`)
    })

    await expect(resolvePreferredForgeBuild('1.7.10', fetchDependency(fetchMock))).resolves.toEqual({
      minecraftVersion: '1.7.10',
      forgeVersion: '10.13.4.1614',
      mavenVersion,
      channel: 'recommended',
      installer: {
        name: `forge-${mavenVersion}-installer.jar`,
        sha1,
        url: legacyUrl
      }
    })
  })

  it('rejects malformed promotions and redirected checksum metadata', async () => {
    const malformedFetch = vi.fn(async () => webResponse(promotionsUrl, JSON.stringify({
      homepage: 'https://files.minecraftforge.net/net/minecraftforge/forge/',
      promos: { '1.21.1-recommended': '../unsafe' },
      unexpected: true
    })))
    await expect(resolvePreferredForgeBuild('1.21.1', fetchDependency(malformedFetch))).rejects.toMatchObject({
      code: 'INVALID_FORGE_METADATA'
    })

    const redirectedFetch = vi.fn(async () => webResponse(
      'https://maven.minecraftforge.net.evil.example/installer.jar.sha1',
      'a'.repeat(40)
    ))
    await expect(resolveForgeBuild('1.21.1', '52.1.16', 'exact', fetchDependency(redirectedFetch))).rejects.toMatchObject({
      code: 'UNTRUSTED_FORGE_DOWNLOAD'
    })
  })
})

describe('Forge installer downloads', () => {
  it('uses the strongest published checksum, streams atomically, and reuses a verified cache', async () => {
    const directory = await temporaryDirectory('emberhost-forge-download-')
    const destination = join(directory, 'installer.jar')
    const bytes = new TextEncoder().encode('verified Forge installer bytes')
    const build = buildFor(bytes)
    const sha512 = createHash('sha512').update(bytes).digest('hex')
    let artifactRequests = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${build.installer.url}.sha512`) return webResponse(url, sha512)
      if (url === build.installer.url) {
        artifactRequests += 1
        return webResponse(url, bytes, 200, { 'content-length': String(bytes.byteLength) })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    const progress = vi.fn()

    await expect(downloadForgeInstaller(build, destination, progress, fetchDependency(fetchMock))).resolves.toEqual({
      algorithm: 'sha512',
      digest: sha512
    })
    expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
    await expect(access(`${destination}.part`)).rejects.toThrow()

    await downloadForgeInstaller(build, destination, progress, fetchDependency(fetchMock))
    expect(artifactRequests).toBe(1)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'download', percent: 80 }))
  })

  it('falls back through missing SHA-512 and SHA-256 sidecars to official SHA-1', async () => {
    const directory = await temporaryDirectory('emberhost-forge-download-')
    const destination = join(directory, 'installer.jar')
    const bytes = new TextEncoder().encode('Forge installer with legacy checksums')
    const build = buildFor(bytes)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('.sha512') || url.endsWith('.sha256')) return webResponse(url, '', 404)
      if (url === build.installer.url) return webResponse(url, bytes)
      throw new Error(`Unexpected URL ${url}`)
    })

    await expect(downloadForgeInstaller(build, destination, undefined, fetchDependency(fetchMock))).resolves.toEqual({
      algorithm: 'sha1',
      digest: build.installer.sha1
    })
  })

  it('removes a partial download on checksum mismatch and enforces a byte ceiling', async () => {
    const directory = await temporaryDirectory('emberhost-forge-download-')
    const destination = join(directory, 'installer.jar')
    const bytes = new TextEncoder().encode('tampered Forge installer')
    const build = buildFor(bytes)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('.sha512')) return webResponse(url, '0'.repeat(128))
      if (url === build.installer.url) return webResponse(url, bytes)
      throw new Error(`Unexpected URL ${url}`)
    })

    await expect(downloadForgeInstaller(build, destination, undefined, fetchDependency(fetchMock))).rejects.toMatchObject({
      code: 'FORGE_CHECKSUM_FAILED'
    })
    await expect(access(destination)).rejects.toThrow()
    await expect(access(`${destination}.part`)).rejects.toThrow()

    const oversizedFetch = vi.fn(async (url: string) => {
      if (url.endsWith('.sha512')) {
        return webResponse(url, createHash('sha512').update(bytes).digest('hex'))
      }
      return webResponse(url, bytes, 200, { 'content-length': String(bytes.byteLength) })
    })
    await expect(downloadForgeInstaller(build, destination, undefined, {
      ...fetchDependency(oversizedFetch),
      maxInstallerBytes: 4
    })).rejects.toMatchObject({ code: 'FORGE_DOWNLOAD_SIZE_MISMATCH' })
  })
})

describe('Forge installation and launch detection', () => {
  it('spawns Java without a shell, detects modern argfiles, and creates mods', async () => {
    const directory = await temporaryDirectory('emberhost-forge-install-')
    const installer = join(directory, 'cache', 'installer.jar')
    const staging = join(directory, 'staging')
    const bytes = new TextEncoder().encode('verified installer')
    const build = buildFor(bytes)
    await mkdir(join(directory, 'cache'), { recursive: true })
    await writeFile(installer, bytes)
    await mkdir(staging)
    const canonicalStaging = await realpath(staging)
    const runner: ForgeInstallerRunner = vi.fn(async (command, args, options) => {
      expect(command).toBe('java-21')
      expect(args).toEqual(['-jar', installer, '--installServer', staging])
      expect(options).toMatchObject({ cwd: canonicalStaging, shell: false, windowsHide: true })
      const coordinate = join(staging, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.1.16')
      await mkdir(coordinate, { recursive: true })
      await Promise.all([
        writeFile(join(coordinate, 'win_args.txt'), '-p libraries', 'utf8'),
        writeFile(join(coordinate, 'unix_args.txt'), '-p libraries', 'utf8'),
        writeFile(join(staging, 'run.bat'), 'must never execute', 'utf8')
      ])
      return { exitCode: 0, signal: null, output: 'installed' }
    })

    await expect(installForgeServer(build, installer, staging, {
      executable: 'java-21',
      majorVersion: 21,
      requiredMajorVersion: 21
    }, undefined, { runInstaller: runner })).resolves.toEqual({
      kind: 'java-argfile',
      windowsPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/win_args.txt',
      unixPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/unix_args.txt'
    })
    expect(runner).toHaveBeenCalledOnce()
    await expect(access(join(staging, 'mods'))).resolves.toBeUndefined()
  })

  it('detects a safe legacy root JAR while ignoring installer and script names', async () => {
    const directory = await temporaryDirectory('emberhost-forge-legacy-')
    await Promise.all([
      writeFile(join(directory, 'forge-1.12.2-14.23.5.2859.jar'), 'server', 'utf8'),
      writeFile(join(directory, 'forge-1.12.2-14.23.5.2859-installer.jar'), 'installer', 'utf8'),
      writeFile(join(directory, 'run.bat'), 'unsafe script', 'utf8')
    ])

    await expect(detectForgeLaunch(directory, '1.12.2', '14.23.5.2859')).resolves.toEqual({
      kind: 'jar',
      path: 'forge-1.12.2-14.23.5.2859.jar'
    })
  })

  it('detects legacy universal JARs that use a Minecraft-suffixed Maven coordinate', async () => {
    const directory = await temporaryDirectory('emberhost-forge-legacy-suffixed-')
    const mavenVersion = '1.7.10-10.13.4.1614-1.7.10'
    const fileName = `forge-${mavenVersion}-universal.jar`
    await writeFile(join(directory, fileName), 'legacy server', 'utf8')

    await expect(detectForgeLaunch(
      directory,
      '1.7.10',
      '10.13.4.1614',
      mavenVersion
    )).resolves.toEqual({ kind: 'jar', path: fileName })
  })

  it('requires exact Java, an empty staging directory, bounded output, and a bounded runtime', async () => {
    const directory = await temporaryDirectory('emberhost-forge-guards-')
    const installer = join(directory, 'installer.jar')
    const bytes = new TextEncoder().encode('verified installer')
    const build = buildFor(bytes)
    await writeFile(installer, bytes)

    const wrongJavaStaging = join(directory, 'wrong-java')
    await mkdir(wrongJavaStaging)
    const runner = vi.fn<ForgeInstallerRunner>()
    await expect(installForgeServer(build, installer, wrongJavaStaging, {
      executable: 'java',
      majorVersion: 22,
      requiredMajorVersion: 21
    }, undefined, { runInstaller: runner })).rejects.toMatchObject({ code: 'JAVA_VERSION_MISMATCH' })
    expect(runner).not.toHaveBeenCalled()

    const nonemptyStaging = join(directory, 'nonempty')
    await mkdir(nonemptyStaging)
    await writeFile(join(nonemptyStaging, 'existing.txt'), 'user data', 'utf8')
    await expect(installForgeServer(build, installer, nonemptyStaging, {
      executable: 'java', majorVersion: 21, requiredMajorVersion: 21
    }, undefined, { runInstaller: runner })).rejects.toMatchObject({ code: 'FORGE_STAGING_NOT_EMPTY' })

    const outputStaging = join(directory, 'output')
    await mkdir(outputStaging)
    const noisyRunner: ForgeInstallerRunner = async () => ({ exitCode: 0, signal: null, output: '12345' })
    await expect(installForgeServer(build, installer, outputStaging, {
      executable: 'java', majorVersion: 21, requiredMajorVersion: 21
    }, undefined, { runInstaller: noisyRunner, maxInstallerOutputBytes: 4 })).rejects.toMatchObject({
      code: 'FORGE_INSTALLER_OUTPUT_LIMIT'
    })

    const timeoutStaging = join(directory, 'timeout')
    await mkdir(timeoutStaging)
    const hangingRunner: ForgeInstallerRunner = async () => new Promise(() => undefined)
    await expect(installForgeServer(build, installer, timeoutStaging, {
      executable: 'java', majorVersion: 21, requiredMajorVersion: 21
    }, undefined, { runInstaller: hangingRunner, installerTimeoutMs: 5 })).rejects.toMatchObject({
      code: 'FORGE_INSTALLER_TIMEOUT'
    })
  })
})
