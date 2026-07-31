import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaperBuildInfo } from '../src/shared/contracts'
import {
  downloadPaperJar,
  resolveLatestPaperBuild,
  resolvePaperBuild
} from '../src/main/services/paper'

const temporaryDirectories: string[] = []
const buildsUrl = 'https://fill.papermc.io/v3/projects/paper/versions/26.2/builds'

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function apiBuild(id: number, channel: string, sha256: string): unknown {
  const name = `paper-26.2-${id}.jar`
  return {
    id,
    time: `2026-07-${String(id).padStart(2, '0')}T00:00:00.000Z`,
    channel,
    downloads: {
      'server:default': {
        name,
        checksums: { sha256 },
        size: 42,
        url: `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`
      }
    }
  }
}

function metadataResponse(body: unknown): Partial<Response> {
  return { ok: true, status: 200, url: buildsUrl, json: async () => body }
}

describe('Paper build resolution', () => {
  it('selects the highest stable compatible build independent of API ordering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metadataResponse([
      apiBuild(9, 'STABLE', '9'.repeat(64)),
      apiBuild(12, 'BETA', 'c'.repeat(64)),
      apiBuild(11, 'STABLE', 'b'.repeat(64))
    ])))

    const build = await resolveLatestPaperBuild('26.2')
    expect(build).toMatchObject({ minecraftVersion: '26.2', build: 11, channel: 'STABLE' })
    expect(build.download.name).toBe('paper-26.2-11.jar')
  })

  it('pins the exact requested build', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metadataResponse([
      apiBuild(11, 'STABLE', 'b'.repeat(64)),
      apiBuild(10, 'STABLE', 'a'.repeat(64))
    ])))

    await expect(resolvePaperBuild('26.2', 10)).resolves.toMatchObject({ build: 10 })
    await expect(resolvePaperBuild('26.2', 99)).rejects.toThrow('not available')
  })

  it('refuses both an explicitly pinned unstable build and an all-unstable latest result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metadataResponse([
      apiBuild(12, 'BETA', 'c'.repeat(64)),
      apiBuild(13, 'EXPERIMENTAL', 'd'.repeat(64))
    ])))

    await expect(resolvePaperBuild('26.2', 12)).rejects.toMatchObject({ code: 'PAPER_BUILD_NOT_STABLE' })
    await expect(resolveLatestPaperBuild('26.2')).rejects.toMatchObject({ code: 'PAPER_STABLE_BUILD_NOT_FOUND' })
  })

  it('rejects an artifact URL outside Paper\'s exact data host and object path', async () => {
    const item = apiBuild(11, 'STABLE', 'b'.repeat(64)) as {
      downloads: Record<string, { url: string }>
    }
    item.downloads['server:default']!.url = 'https://fill-data.papermc.io.evil.example/v1/objects/file.jar'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(metadataResponse([item])))

    await expect(resolveLatestPaperBuild('26.2')).rejects.toThrow('unexpected server download location')
  })
})

describe('Paper server downloads', () => {
  it('streams, verifies, and atomically promotes a SHA-256-pinned artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-paper-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'paper.jar')
    const bytes = new TextEncoder().encode('verified Paper server bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = 'paper-26.2-87.jar'
    const url = `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`
    const build: PaperBuildInfo = {
      minecraftVersion: '26.2',
      build: 87,
      channel: 'STABLE',
      publishedAt: '2026-07-31T00:00:00.000Z',
      download: { name, sha256, size: bytes.byteLength, url }
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url,
      body: new Response(bytes).body
    }))

    await downloadPaperJar(build, destination, () => undefined)

    expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
    await expect(access(`${destination}.part`)).rejects.toThrow()
  })

  it('removes a partial artifact after a SHA-256 mismatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-paper-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'paper.jar')
    const bytes = new TextEncoder().encode('tampered Paper bytes')
    const sha256 = '0'.repeat(64)
    const name = 'paper-26.2-87.jar'
    const url = `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url,
      body: new Response(bytes).body
    }))

    await expect(downloadPaperJar({
      minecraftVersion: '26.2',
      build: 87,
      channel: 'STABLE',
      publishedAt: '2026-07-31T00:00:00.000Z',
      download: { name, sha256, size: bytes.byteLength, url }
    }, destination, () => undefined)).rejects.toThrow('SHA-256 checksum')
    await expect(access(`${destination}.part`)).rejects.toThrow()
    await expect(access(destination)).rejects.toThrow()
  })

  it('reuses a verified cache entry without fetching', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-paper-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'paper.jar')
    const bytes = new TextEncoder().encode('cached Paper bytes')
    await writeFile(destination, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = 'paper-26.2-87.jar'
    const url = `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await downloadPaperJar({
      minecraftVersion: '26.2',
      build: 87,
      channel: 'STABLE',
      publishedAt: '2026-07-31T00:00:00.000Z',
      download: { name, sha256, size: bytes.byteLength, url }
    }, destination, () => undefined)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes an invalid cache entry and partial file after an interrupted stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-paper-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'paper.jar')
    await writeFile(destination, 'untrusted old cache entry', 'utf8')
    const expectedBytes = new TextEncoder().encode('expected Paper bytes')
    const sha256 = createHash('sha256').update(expectedBytes).digest('hex')
    const name = 'paper-26.2-87.jar'
    const url = `https://fill-data.papermc.io/v1/objects/${sha256}/${name}`
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: expectedBytes.slice(0, 4) })
        .mockRejectedValueOnce(new Error('connection reset'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url,
      body: { getReader: () => reader }
    }))

    await expect(downloadPaperJar({
      minecraftVersion: '26.2',
      build: 87,
      channel: 'STABLE',
      publishedAt: '2026-07-31T00:00:00.000Z',
      download: { name, sha256, size: expectedBytes.byteLength, url }
    }, destination, () => undefined)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    await expect(access(destination)).rejects.toThrow()
    await expect(access(`${destination}.part`)).rejects.toThrow()
  })
})
