import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { PaperBuildInfo, SetupProgress } from '../../shared/contracts'
import { AppError } from './errors'

const PAPER_API_ORIGIN = 'https://fill.papermc.io'
const PAPER_DOWNLOAD_ORIGIN = 'https://fill-data.papermc.io'
const minecraftVersionPattern = /^[A-Za-z0-9._-]{1,64}$/
const sha256Pattern = /^[a-f0-9]{64}$/

const paperDownloadSchema = z.object({
  name: z.string().min(1).max(160),
  checksums: z.object({ sha256: z.string().regex(sha256Pattern) }),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  url: z.string().url()
})

const paperBuildSchema = z.object({
  id: z.number().int().positive(),
  time: z.string().min(1),
  channel: z.string().min(1).max(32),
  downloads: z.object({ 'server:default': paperDownloadSchema })
})

const paperBuildsSchema = z.array(paperBuildSchema)

function buildsUrl(minecraftVersion: string): string {
  if (!minecraftVersionPattern.test(minecraftVersion)) {
    throw new AppError('The Minecraft version is not valid for a Paper lookup.', 'INVALID_VERSION')
  }
  return `${PAPER_API_ORIGIN}/v3/projects/paper/versions/${encodeURIComponent(minecraftVersion)}/builds`
}

function assertExactMetadataUrl(rawUrl: string, expectedUrl: string): void {
  const url = new URL(rawUrl)
  if (
    url.href !== expectedUrl ||
    url.protocol !== 'https:' ||
    url.hostname !== 'fill.papermc.io' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new AppError('Paper returned an unexpected metadata location.', 'UNTRUSTED_DOWNLOAD')
  }
}

function assertDownloadUrl(rawUrl: string, sha256: string, name: string): void {
  const url = new URL(rawUrl)
  const expectedPath = `/v1/objects/${sha256}/${name}`
  if (
    url.origin !== PAPER_DOWNLOAD_ORIGIN ||
    url.protocol !== 'https:' ||
    url.hostname !== 'fill-data.papermc.io' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== expectedPath ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AppError('Paper returned an unexpected server download location.', 'UNTRUSTED_DOWNLOAD')
  }
}

function toBuildInfo(
  minecraftVersion: string,
  build: z.infer<typeof paperBuildSchema>
): PaperBuildInfo {
  const download = build.downloads['server:default']
  const expectedName = `paper-${minecraftVersion}-${build.id}.jar`
  if (download.name !== expectedName) {
    throw new AppError('Paper returned an unexpected server artifact name.', 'INVALID_PAPER_METADATA')
  }
  assertDownloadUrl(download.url, download.checksums.sha256, download.name)
  return {
    minecraftVersion,
    build: build.id,
    channel: build.channel,
    publishedAt: build.time,
    download: {
      name: download.name,
      sha256: download.checksums.sha256,
      size: download.size,
      url: download.url
    }
  }
}

async function fetchPaperBuilds(minecraftVersion: string): Promise<PaperBuildInfo[]> {
  const url = buildsUrl(minecraftVersion)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'EmberHost/0.7.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    throw new AppError(
      'Could not reach Paper. Check your internet connection and try again.',
      'NETWORK_ERROR',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new AppError(`Paper does not provide builds for Minecraft ${minecraftVersion}.`, 'PAPER_VERSION_NOT_FOUND')
    }
    throw new AppError(`Paper returned HTTP ${response.status}. Try again in a moment.`, 'PAPER_API_ERROR')
  }
  assertExactMetadataUrl(response.url, url)

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new AppError(
      'Paper returned unreadable build metadata.',
      'INVALID_PAPER_METADATA',
      error instanceof Error ? error.message : undefined
    )
  }
  const parsed = paperBuildsSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AppError('Paper returned invalid build metadata.', 'INVALID_PAPER_METADATA')
  }
  return parsed.data.map((build) => toBuildInfo(minecraftVersion, build))
}

export async function resolveLatestPaperBuild(minecraftVersion: string): Promise<PaperBuildInfo> {
  const builds = await fetchPaperBuilds(minecraftVersion)
  const stableBuilds = builds.filter((build) => build.channel.toUpperCase() === 'STABLE')
  const latest = stableBuilds.reduce<PaperBuildInfo | null>(
    (current, build) => current === null || build.build > current.build ? build : current,
    null
  )
  if (!latest) {
    throw new AppError(`Paper does not provide a stable build for Minecraft ${minecraftVersion}.`, 'PAPER_STABLE_BUILD_NOT_FOUND')
  }
  return latest
}

export async function resolvePaperBuild(minecraftVersion: string, buildNumber: number): Promise<PaperBuildInfo> {
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new AppError('The Paper build number is not valid.', 'INVALID_PAPER_BUILD')
  }
  const builds = await fetchPaperBuilds(minecraftVersion)
  const build = builds.find((candidate) => candidate.build === buildNumber)
  if (!build) {
    throw new AppError(
      `Paper build ${buildNumber} is not available for Minecraft ${minecraftVersion}.`,
      'PAPER_BUILD_NOT_FOUND'
    )
  }
  if (build.channel.toUpperCase() !== 'STABLE') {
    throw new AppError(
      `Paper build ${buildNumber} for Minecraft ${minecraftVersion} is not a stable build.`,
      'PAPER_BUILD_NOT_STABLE'
    )
  }
  return build
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function downloadPaperJar(
  build: PaperBuildInfo,
  destination: string,
  onProgress: (progress: SetupProgress) => void
): Promise<void> {
  assertDownloadUrl(build.download.url, build.download.sha256, build.download.name)
  try {
    const existing = await stat(destination)
    if (existing.size === build.download.size && (await sha256File(destination)) === build.download.sha256) {
      onProgress({ phase: 'download', percent: 85, message: 'Verified the cached Paper download.' })
      return
    }
  } catch {
    // A missing or invalid cache entry is replaced below.
  }

  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await Promise.all([rm(destination, { force: true }), rm(partial, { force: true })])

  let response: Response
  try {
    response = await fetch(build.download.url, {
      headers: { 'User-Agent': 'EmberHost/0.7.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new AppError(
      'The Paper server download could not be started. Check your connection and retry.',
      'DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok || !response.body) {
    throw new AppError(`The Paper server download returned HTTP ${response.status}.`, 'DOWNLOAD_FAILED')
  }
  assertDownloadUrl(response.url, build.download.sha256, build.download.name)

  const file = await open(partial, 'w')
  const reader = response.body.getReader()
  let received = 0
  let streamError: AppError | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > build.download.size) {
        streamError = new AppError('The Paper download exceeded its signed metadata size.', 'DOWNLOAD_SIZE_MISMATCH')
        await reader.cancel().catch(() => undefined)
        break
      }
      await file.write(value)
      received += value.byteLength
      const ratio = Math.min(received / build.download.size, 1)
      onProgress({
        phase: 'download',
        percent: Math.round(20 + ratio * 60),
        message: `Downloading Paper ${build.minecraftVersion} build ${build.build}…`,
        bytesReceived: received,
        totalBytes: build.download.size
      })
    }
  } catch (error) {
    streamError = new AppError(
      'The Paper server download was interrupted. Try again.',
      'DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  } finally {
    await file.close()
  }
  if (streamError) {
    await rm(partial, { force: true })
    throw streamError
  }

  if (received !== build.download.size) {
    await rm(partial, { force: true })
    throw new AppError('The downloaded Paper server file was incomplete.', 'DOWNLOAD_SIZE_MISMATCH')
  }
  if ((await sha256File(partial)) !== build.download.sha256) {
    await rm(partial, { force: true })
    throw new AppError('The downloaded Paper server file failed its SHA-256 checksum.', 'CHECKSUM_FAILED')
  }
  await rename(partial, destination)
  onProgress({ phase: 'download', percent: 85, message: 'Paper download verified with SHA-256.' })
}
