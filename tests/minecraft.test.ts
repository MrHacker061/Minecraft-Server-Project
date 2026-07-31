import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadServerJar,
  listOfficialReleases,
  resolveLatestRelease,
  resolveRelease,
  type ResolvedServerVersion
} from '../src/main/services/minecraft'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function response(url: string, body: unknown): Partial<Response> {
  return { ok: true, status: 200, url, json: async () => body }
}

describe('Mojang release resolution', () => {
  it('lists only official releases in Mojang manifest order', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const mockedFetch = vi.fn().mockResolvedValue(response(manifestUrl, {
      latest: { release: '1.21.5' },
      versions: [
        { id: '1.21.5', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/new.json', releaseTime: '2025-03-25T12:00:00+00:00' },
        { id: '25w10a', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/snapshot.json', releaseTime: '2025-03-05T12:00:00+00:00' },
        { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/old.json', releaseTime: '2024-12-03T12:00:00+00:00' },
        { id: 'b1.7.3', type: 'old_beta', url: 'https://piston-meta.mojang.com/v1/packages/beta.json', releaseTime: '2011-07-08T12:00:00+00:00' }
      ]
    }))
    vi.stubGlobal('fetch', mockedFetch)

    await expect(listOfficialReleases()).resolves.toEqual([
      { id: '1.21.5', type: 'release', releaseTime: '2025-03-25T12:00:00+00:00' },
      { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T12:00:00+00:00' }
    ])
    expect(mockedFetch).toHaveBeenCalledOnce()
  })

  it('pins the exact reviewed release and its Java requirement', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/26.1.json'
    const serverUrl = 'https://piston-data.mojang.com/v1/objects/hash/server.jar'
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [
          { id: '26.1', type: 'release', url: detailsUrl, releaseTime: '2026-01-01T12:00:00+00:00' },
          { id: '26.2', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/hash/26.2.json', releaseTime: '2026-03-01T12:00:00+00:00' }
        ]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '26.1',
        type: 'release',
        javaVersion: { majorVersion: 25 },
        downloads: { server: { url: serverUrl, sha1: 'a'.repeat(40), size: 42 } }
      }))
    vi.stubGlobal('fetch', mockedFetch)

    const release = await resolveRelease('26.1')
    expect(release.id).toBe('26.1')
    expect(release.requiredJavaVersion).toBe(25)
    expect(release.download.url).toBe(serverUrl)
  })

  it('uses Java 8 for legacy Mojang metadata that predates javaVersion', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/1.6.4.json'
    const serverUrl = 'https://piston-data.mojang.com/v1/objects/hash/server.jar'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [{ id: '1.6.4', type: 'release', url: detailsUrl, releaseTime: '2013-09-19T15:52:37+00:00' }]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '1.6.4',
        type: 'release',
        downloads: { server: { url: serverUrl, sha1: 'b'.repeat(40), size: 8_000_000 } }
      })))

    await expect(resolveRelease('1.6.4')).resolves.toMatchObject({ requiredJavaVersion: 8 })
  })

  it('fails closed when non-legacy release metadata omits javaVersion', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/26.2.json'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [{ id: '26.2', type: 'release', url: detailsUrl, releaseTime: '2026-03-01T12:00:00+00:00' }]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '26.2',
        type: 'release',
        downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar', sha1: 'b'.repeat(40), size: 60_000_000 } }
      })))

    await expect(resolveRelease('26.2')).rejects.toMatchObject({ code: 'JAVA_VERSION_NOT_FOUND' })
  })

  it('reports official releases that do not have a Mojang server artifact', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/1.0.json'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [{ id: '1.0', type: 'release', url: detailsUrl, releaseTime: '2011-11-18T15:00:00+00:00' }]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '1.0',
        type: 'release',
        javaVersion: { majorVersion: 8 },
        downloads: {}
      })))

    await expect(resolveRelease('1.0')).rejects.toMatchObject({
      code: 'SERVER_JAR_NOT_FOUND',
      message: 'Minecraft 1.0 does not provide a vanilla server download.'
    })
  })

  it('rejects snapshot IDs even when they are present in the manifest', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(manifestUrl, {
      latest: { release: '26.2' },
      versions: [{ id: '25w10a', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/snapshot.json', releaseTime: '2025-03-05T12:00:00+00:00' }]
    })))

    await expect(resolveRelease('25w10a')).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
  })

  it('rejects malformed release IDs before contacting Mojang', async () => {
    const mockedFetch = vi.fn()
    vi.stubGlobal('fetch', mockedFetch)

    await expect(resolveRelease('../server')).rejects.toMatchObject({ code: 'INVALID_VERSION' })
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('rejects invalid signed download metadata', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const detailsUrl = 'https://piston-meta.mojang.com/v1/packages/hash/26.2.json'
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(manifestUrl, {
        latest: { release: '26.2' },
        versions: [{ id: '26.2', type: 'release', url: detailsUrl, releaseTime: '2026-03-01T12:00:00+00:00' }]
      }))
      .mockResolvedValueOnce(response(detailsUrl, {
        id: '26.2',
        type: 'release',
        javaVersion: { majorVersion: 25 },
        downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar', sha1: 'not-a-sha1', size: 42 } }
      })))

    await expect(resolveLatestRelease()).rejects.toMatchObject({ code: 'INVALID_MOJANG_METADATA' })
  })

  it('rejects untrusted release metadata locations before requesting them', async () => {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const mockedFetch = vi.fn().mockResolvedValueOnce(response(manifestUrl, {
      latest: { release: '26.2' },
      versions: [{ id: '26.2', type: 'release', url: 'https://example.com/26.2.json', releaseTime: '2026-03-01T12:00:00+00:00' }]
    }))
    vi.stubGlobal('fetch', mockedFetch)

    await expect(resolveRelease('26.2')).rejects.toMatchObject({ code: 'UNTRUSTED_DOWNLOAD' })
    expect(mockedFetch).toHaveBeenCalledOnce()
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
