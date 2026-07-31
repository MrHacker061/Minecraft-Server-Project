import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AppError } from './errors'

const MODRINTH_API = 'https://api.modrinth.com/v2'
const CHUNKY_PROJECT_ID = 'fALzjamp'

interface ModrinthFile {
  hashes?: { sha512?: string }
  url?: string
  filename?: string
  primary?: boolean
  size?: number
}

interface ModrinthVersion {
  id?: string
  version_number?: string
  version_type?: string
  status?: string
  game_versions?: string[]
  loaders?: string[]
  files?: ModrinthFile[]
}

export interface ResolvedChunkyVersion {
  id: string
  version: string
  file: {
    name: string
    sha512: string
    size: number
    url: string
  }
}

export type ChunkyConsoleEvent =
  | { kind: 'progress'; world: string; processed: number; percent: number; rate: number }
  | { kind: 'complete'; world: string; processed: number; percent: number }
  | { kind: 'started' | 'paused' | 'continuing' | 'cancelled' | 'stopped'; world: string }
  | { kind: 'no-tasks' }

function numberFromOutput(value: string): number {
  return Number(value.replaceAll(',', ''))
}

export function parseChunkyConsoleLine(line: string): ChunkyConsoleEvent | null {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9A-FK-OR]/gi, '')
  const loggerBoundary = plain.indexOf(']: ')
  const consoleMessage = loggerBoundary >= 0 ? plain.slice(loggerBoundary + 3) : plain
  if (!consoleMessage.startsWith('[Chunky] ')) return null
  const message = consoleMessage.slice('[Chunky] '.length)
  const progress = message.match(/Task running for (.+?)\. Processed: ([\d,]+) chunks \(([\d.]+)%\).*?Rate: ([\d.]+) cps/i)
  if (progress?.[1] && progress[2] && progress[3] && progress[4]) {
    return {
      kind: 'progress',
      world: progress[1],
      processed: numberFromOutput(progress[2]),
      percent: Number(progress[3]),
      rate: Number(progress[4])
    }
  }
  const complete = message.match(/Task finished for (.+?)\. Processed: ([\d,]+) chunks \(([\d.]+)%\)/i)
  if (complete?.[1] && complete[2] && complete[3]) {
    return {
      kind: 'complete',
      world: complete[1],
      processed: numberFromOutput(complete[2]),
      percent: Number(complete[3])
    }
  }
  const started = message.match(/Task started in (.+?) for the /i)
  if (started?.[1]) return { kind: 'started', world: started[1] }
  const state = message.match(/Task (started in|paused for|continuing for|cancelled for|stopped for) (.+?)\./i)
  if (state?.[1] && state[2]) {
    const kinds: Record<string, 'started' | 'paused' | 'continuing' | 'cancelled' | 'stopped'> = {
      'started in': 'started',
      'paused for': 'paused',
      'continuing for': 'continuing',
      'cancelled for': 'cancelled',
      'stopped for': 'stopped'
    }
    const kind = kinds[state[1].toLowerCase()]
    return kind ? { kind, world: state[2] } : null
  }
  if (/No tasks (?:running|to (?:pause|continue|cancel))/i.test(message)) return { kind: 'no-tasks' }
  return null
}

function assertApiUrl(rawUrl: string): void {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'api.modrinth.com' || !url.pathname.startsWith('/v2/')) {
    throw new AppError('Chunky metadata came from an unexpected location.', 'UNTRUSTED_DOWNLOAD')
  }
}

function assertDownloadUrl(rawUrl: string): void {
  const url = new URL(rawUrl)
  const expectedPrefix = `/data/${CHUNKY_PROJECT_ID}/`
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' || !url.pathname.startsWith(expectedPrefix)) {
    throw new AppError('The Chunky download came from an unexpected location.', 'UNTRUSTED_DOWNLOAD')
  }
}

async function sha512File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function resolveChunkyForPaper(minecraftVersion: string): Promise<ResolvedChunkyVersion> {
  const url = new URL(`${MODRINTH_API}/project/${CHUNKY_PROJECT_ID}/version`)
  url.searchParams.set('loaders', JSON.stringify(['paper']))
  url.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
  url.searchParams.set('include_changelog', 'false')
  assertApiUrl(url.toString())

  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'EmberHost/0.4.0 (github.com/MrHacker061/Minecraft-Server-Project)' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    throw new AppError(
      'Could not check for a compatible Chunky release. Check your connection and retry.',
      'CHUNKY_LOOKUP_FAILED',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok) throw new AppError(`Modrinth returned HTTP ${response.status}.`, 'CHUNKY_LOOKUP_FAILED')
  assertApiUrl(response.url)

  const versions = (await response.json()) as ModrinthVersion[]
  const selected = versions.find((version) =>
    version.version_type === 'release' &&
    version.status === 'listed' &&
    version.game_versions?.includes(minecraftVersion) &&
    version.loaders?.includes('paper')
  )
  const file = selected?.files?.find((candidate) => candidate.primary) ?? selected?.files?.[0]
  if (
    !selected?.id ||
    !selected.version_number ||
    !file?.filename ||
    !file.url ||
    !file.hashes?.sha512 ||
    !/^[a-f0-9]{128}$/i.test(file.hashes.sha512) ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > 128 * 1024 * 1024
  ) {
    throw new AppError(`No verified Paper-compatible Chunky release supports Minecraft ${minecraftVersion}.`, 'CHUNKY_NOT_FOUND')
  }
  assertDownloadUrl(file.url)
  return {
    id: selected.id,
    version: selected.version_number,
    file: {
      name: file.filename,
      sha512: file.hashes.sha512.toLowerCase(),
      size: file.size,
      url: file.url
    }
  }
}

export async function downloadChunky(
  version: ResolvedChunkyVersion,
  destination: string,
  onProgress: (received: number, total: number) => void = () => undefined
): Promise<void> {
  try {
    const existing = await stat(destination)
    if (existing.size === version.file.size && (await sha512File(destination)) === version.file.sha512) return
  } catch {
    // A missing or invalid cached plugin is downloaded below.
  }

  assertDownloadUrl(version.file.url)
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await Promise.all([rm(destination, { force: true }), rm(partial, { force: true })])

  let response: Response
  try {
    response = await fetch(version.file.url, {
      headers: { 'User-Agent': 'EmberHost/0.4.0 (github.com/MrHacker061/Minecraft-Server-Project)' },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new AppError(
      'The Chunky download could not be started. Check your connection and retry.',
      'CHUNKY_DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok || !response.body) {
    throw new AppError(`The Chunky download returned HTTP ${response.status}.`, 'CHUNKY_DOWNLOAD_FAILED')
  }
  assertDownloadUrl(response.url)

  const file = await open(partial, 'w')
  const reader = response.body.getReader()
  let received = 0
  let streamError: AppError | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > version.file.size) {
        streamError = new AppError('The Chunky download exceeded its signed metadata size.', 'CHUNKY_CHECKSUM_FAILED')
        await reader.cancel().catch(() => undefined)
        break
      }
      await file.write(value)
      received += value.byteLength
      onProgress(received, version.file.size)
    }
  } catch (error) {
    streamError = new AppError(
      'The Chunky download was interrupted. Try again.',
      'CHUNKY_DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  } finally {
    await file.close()
  }

  if (streamError) {
    await rm(partial, { force: true })
    throw streamError
  }

  if (received !== version.file.size || (await sha512File(partial)) !== version.file.sha512) {
    await rm(partial, { force: true })
    throw new AppError('The Chunky download failed its size or SHA-512 verification.', 'CHUNKY_CHECKSUM_FAILED')
  }
  await rename(partial, destination)
}
