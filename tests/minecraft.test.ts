import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadServerJar, resolveRelease, type ResolvedServerVersion } from '../src/main/services/minecraft'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function response(url: string, body: unknown): Partial<Response> {
  return { ok: true, status: 200, url, json: async () => body }
}

describe('Mojang release resolution', () => {
  it('pins the exact reviewed release and its Java requirement', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/26.1.json'
    const serverUrl = 'https://piston-data.mojang.com/v1/objects/hash/server.jar'
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [
          { id: '26.1', type: 'release', url: detailsUrl },
          { id: '26.2', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/hash/26.2.json' }
        ]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '26.1',
        type: 'release',
        javaVersion: { majorVersion: 25 },
        downloads: { server: { url: serverUrl, sha1: 'abc123', size: 42 } }
      }))
    vi.stubGlobal('fetch', mockedFetch)

    const release = await resolveRelease('26.1')
    expect(release.id).toBe('26.1')
    expect(release.requiredJavaVersion).toBe(25)
    expect(release.download.url).toBe(serverUrl)
  })
})

describe('server JAR downloads', () => {
  it('streams and verifies a server artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'server.jar')
    const bytes = new TextEncoder().encode('verified server bytes')
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const version: ResolvedServerVersion = {
      id: '26.2',
      type: 'release',
      requiredJavaVersion: 25,
      download: { sha1, size: bytes.byteLength, url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar' }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: version.download.url,
      body: new Response(bytes).body
    }))

    await downloadServerJar(version, destination, () => undefined)
    expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
  })

  it('removes a partial download when checksum verification fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'server.jar')
    const bytes = new TextEncoder().encode('tampered bytes')
    const version: ResolvedServerVersion = {
      id: '26.2',
      type: 'release',
      requiredJavaVersion: 25,
      download: { sha1: '0000000000000000000000000000000000000000', size: bytes.byteLength, url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar' }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: version.download.url,
      body: new Response(bytes).body
    }))

    await expect(downloadServerJar(version, destination, () => undefined)).rejects.toThrow('checksum')
    await expect(access(`${destination}.part`)).rejects.toThrow()
    await expect(access(destination)).rejects.toThrow()
  })

  it('reuses an already verified cached artifact without fetching', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'server.jar')
    const bytes = new TextEncoder().encode('cached server bytes')
    await writeFile(destination, bytes)
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const mockedFetch = vi.fn()
    vi.stubGlobal('fetch', mockedFetch)

    await downloadServerJar({
      id: '26.2',
      type: 'release',
      requiredJavaVersion: 25,
      download: { sha1, size: bytes.byteLength, url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar' }
    }, destination, () => undefined)
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})
