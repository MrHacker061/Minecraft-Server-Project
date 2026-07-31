import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadChunky,
  parseChunkyConsoleLine,
  resolveChunkyForPaper,
  type ResolvedChunkyVersion
} from '../src/main/services/chunky'
import chunkyVersions from './fixtures/chunky-versions-paper-26.2.json'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function jsonResponse(url: string, body: unknown): Partial<Response> {
  return { ok: true, status: 200, url, json: async () => body }
}

function resolvedVersion(bytes: Uint8Array): ResolvedChunkyVersion {
  return {
    id: 'fixture01',
    version: '1.5.3',
    file: {
      name: 'Chunky-Bukkit-1.5.3.jar',
      sha512: createHash('sha512').update(bytes).digest('hex'),
      size: bytes.byteLength,
      url: 'https://cdn.modrinth.com/data/fALzjamp/versions/fixture01/Chunky-Bukkit-1.5.3.jar'
    }
  }
}

describe('Chunky release resolution', () => {
  it('requests an exact Paper-compatible Minecraft release with an identifying user agent', async () => {
    const mockedFetch = vi.fn().mockImplementation(async (request: string | URL | Request) => {
      const url = new URL(String(request))
      return jsonResponse(url.toString(), chunkyVersions)
    })
    vi.stubGlobal('fetch', mockedFetch)

    const resolved = await resolveChunkyForPaper('26.2')

    expect(resolved).toEqual({
      id: 'MdY6JATr',
      version: '1.5.3',
      file: {
        name: 'Chunky-Bukkit-1.5.3.jar',
        sha512: '43ffecc6e6a734b752da41575bbb316526c124c3f878942437d5133c377bfbd9b78bda975520dc074d7158c15dade58a444ccd0fd8d8a25d165b6fc450140422',
        size: 304616,
        url: 'https://cdn.modrinth.com/data/fALzjamp/versions/MdY6JATr/Chunky-Bukkit-1.5.3.jar'
      }
    })
    const [request, options] = mockedFetch.mock.calls[0] as [URL, RequestInit]
    const url = new URL(request.toString())
    expect(JSON.parse(url.searchParams.get('loaders') ?? 'null')).toEqual(['paper'])
    expect(JSON.parse(url.searchParams.get('game_versions') ?? 'null')).toEqual(['26.2'])
    expect(url.searchParams.get('include_changelog')).toBe('false')
    expect(new Headers(options.headers).get('user-agent')).toMatch(/EmberHost.+Minecraft-Server-Project/i)
  })

  it('skips prereleases and falls back to the first file when no primary file is marked', async () => {
    const stable = structuredClone(chunkyVersions[0])
    if (!stable) throw new Error('Missing Chunky fixture')
    stable.files[0]!.primary = false
    const beta = { ...structuredClone(stable), id: 'beta0001', version_type: 'beta' }
    const url = 'https://api.modrinth.com/v2/project/fALzjamp/version?loaders=%5B%22paper%22%5D&game_versions=%5B%2226.2%22%5D'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(url, [beta, stable])))

    await expect(resolveChunkyForPaper('26.2')).resolves.toMatchObject({ id: 'MdY6JATr' })
  })

  it('reports an empty compatibility result without attempting a guessed download', async () => {
    const url = 'https://api.modrinth.com/v2/project/fALzjamp/version?loaders=%5B%22paper%22%5D&game_versions=%5B%2299.9%22%5D'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(url, [])))

    await expect(resolveChunkyForPaper('99.9')).rejects.toMatchObject({ code: 'CHUNKY_NOT_FOUND' })
  })

  it('rejects a download URL outside Chunky\'s stable Modrinth project path', async () => {
    const payload = structuredClone(chunkyVersions)
    payload[0]!.files[0]!.url = 'https://cdn.modrinth.com/data/other-project/versions/MdY6JATr/plugin.jar'
    const url = 'https://api.modrinth.com/v2/project/fALzjamp/version'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(url, payload)))

    await expect(resolveChunkyForPaper('26.2')).rejects.toMatchObject({ code: 'UNTRUSTED_DOWNLOAD' })
  })
})

describe('Chunky downloads', () => {
  it('streams and SHA-512 verifies the plugin before replacing its destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-chunky-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'plugins', 'Chunky.jar')
    const bytes = new TextEncoder().encode('verified Chunky plugin bytes')
    const version = resolvedVersion(bytes)
    const progress = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: version.file.url,
      body: new Response(bytes).body
    }))

    await downloadChunky(version, destination, progress)

    expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
    expect(progress).toHaveBeenLastCalledWith(bytes.byteLength, bytes.byteLength)
    await expect(access(`${destination}.part`)).rejects.toThrow()
  })

  it('removes a partial plugin when the size or checksum does not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-chunky-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'plugins', 'Chunky.jar')
    const bytes = new TextEncoder().encode('tampered plugin bytes')
    const version = resolvedVersion(bytes)
    version.file.sha512 = '0'.repeat(128)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: version.file.url,
      body: new Response(bytes).body
    }))

    await expect(downloadChunky(version, destination)).rejects.toMatchObject({ code: 'CHUNKY_CHECKSUM_FAILED' })
    await expect(access(`${destination}.part`)).rejects.toThrow()
    await expect(access(destination)).rejects.toThrow()
  })

  it('reuses a locally verified plugin without making a network request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-chunky-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'Chunky.jar')
    const bytes = new TextEncoder().encode('cached Chunky plugin bytes')
    await writeFile(destination, bytes)
    const mockedFetch = vi.fn()
    vi.stubGlobal('fetch', mockedFetch)

    await downloadChunky(resolvedVersion(bytes), destination)

    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('removes an invalid cached plugin and partial file after an interrupted stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-chunky-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, 'plugins', 'Chunky.jar')
    await mkdir(join(directory, 'plugins'), { recursive: true })
    await writeFile(destination, 'untrusted old plugin', 'utf8')
    const expectedBytes = new TextEncoder().encode('expected Chunky plugin bytes')
    const version = resolvedVersion(expectedBytes)
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: expectedBytes.slice(0, 5) })
        .mockRejectedValueOnce(new Error('connection reset'))
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: version.file.url,
      body: { getReader: () => reader }
    }))

    await expect(downloadChunky(version, destination)).rejects.toMatchObject({ code: 'CHUNKY_DOWNLOAD_FAILED' })
    await expect(access(destination)).rejects.toThrow()
    await expect(access(`${destination}.part`)).rejects.toThrow()
  })
})

describe('Chunky console events', () => {
  it('parses the official English task lifecycle and progress formats through normal Paper log prefixes', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'chunky-console.txt'), 'utf8')
    const events = fixture.trim().split(/\r?\n/).map(parseChunkyConsoleLine)

    expect(events).toEqual([
      { kind: 'started', world: 'world' },
      { kind: 'progress', world: 'world', processed: 1024, percent: 12.5, rate: 47.5 },
      { kind: 'paused', world: 'world' },
      { kind: 'stopped', world: 'world' },
      { kind: 'continuing', world: 'world' },
      { kind: 'complete', world: 'world', processed: 8192, percent: 100 },
      null,
      { kind: 'cancelled', world: 'world' },
      { kind: 'no-tasks' }
    ])
  })

  it('accepts terminal color escapes but ignores player-spoofable text even when it includes the plugin marker', () => {
    expect(parseChunkyConsoleLine('\u001b[32m[Chunky] Task paused for world_nether.\u001b[0m')).toEqual({
      kind: 'paused',
      world: 'world_nether'
    })
    expect(parseChunkyConsoleLine('[19:10:02 INFO]: <Player> Task paused for world.')).toBeNull()
    expect(parseChunkyConsoleLine('[19:10:02 INFO]: <Player> [Chunky] Task paused for world.')).toBeNull()
    expect(parseChunkyConsoleLine('[19:10:02 INFO]: <Player> ]: [Chunky] Task paused for world.')).toBeNull()
  })
})
