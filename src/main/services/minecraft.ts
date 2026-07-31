import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { LatestVersion, MinecraftReleaseInfo, SetupProgress } from '../../shared/contracts'
import { AppError } from './errors'

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const LEGACY_JAVA_VERSION = 8
// Mojang's current metadata omits javaVersion only for these server-bearing releases.
const LEGACY_JAVA_8_RELEASES = new Set(['1.6.1', '1.6.2', '1.6.4'])

const versionId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/)
const serverDownloadSchema = z.object({
  sha1: z.string().regex(/^[a-f0-9]{40}$/i),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  url: z.string().url()
})
const versionManifestSchema = z.object({
  latest: z.object({ release: versionId }),
  versions: z.array(z.object({
    // Snapshot and historical manifest IDs can contain characters that are not valid release IDs.
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(32),
    url: z.string().url(),
    releaseTime: z.string().datetime({ offset: true })
  })).max(100_000)
})
const versionDetailsSchema = z.object({
  id: versionId,
  type: z.string().min(1).max(32),
  javaVersion: z.object({ majorVersion: z.number().int().positive().max(100) }).optional(),
  downloads: z.object({ server: serverDownloadSchema.optional() })
})

type VersionManifest = z.infer<typeof versionManifestSchema>

export interface ResolvedServerVersion extends LatestVersion {
  download: {
    sha1: string
    size: number
    url: string
  }
}

function assertTrustedUrl(rawUrl: string): void {
  const url = new URL(rawUrl)
  const trusted =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (url.hostname === 'launchermeta.mojang.com' ||
      url.hostname === 'piston-meta.mojang.com' ||
      url.hostname.endsWith('.mojang.com') ||
      url.hostname.endsWith('.minecraft.net'))
  if (!trusted) throw new AppError('Mojang returned an unexpected download location.', 'UNTRUSTED_DOWNLOAD')
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  assertTrustedUrl(url)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'EmberHost/0.3.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    throw new AppError(
      'Could not reach Mojang. Check your internet connection and try again.',
      'NETWORK_ERROR',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok) {
    throw new AppError(`Mojang returned HTTP ${response.status}. Try again in a moment.`, 'MOJANG_ERROR')
  }
  assertTrustedUrl(response.url)
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new AppError(
      'Mojang returned unreadable metadata.',
      'INVALID_MOJANG_METADATA',
      error instanceof Error ? error.message : undefined
    )
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new AppError('Mojang returned invalid metadata.', 'INVALID_MOJANG_METADATA')
  return parsed.data
}

async function resolveManifestRelease(manifest: VersionManifest, releaseId: string): Promise<ResolvedServerVersion> {
  const entry = manifest.versions?.find((version) => version.id === releaseId && version.type === 'release')
  if (!entry) throw new AppError(`Mojang did not list release ${releaseId}.`, 'VERSION_NOT_FOUND')

  const details = await fetchJson(entry.url, versionDetailsSchema)
  if (details.id !== releaseId || details.type !== 'release') {
    throw new AppError('Mojang returned metadata for a different release.', 'INVALID_MOJANG_METADATA')
  }
  const serverDownload = details.downloads?.server
  if (
    !serverDownload?.url
  ) {
    throw new AppError(`Minecraft ${releaseId} does not provide a vanilla server download.`, 'SERVER_JAR_NOT_FOUND')
  }
  assertTrustedUrl(serverDownload.url)
  const requiredJavaVersion = details.javaVersion?.majorVersion ??
    (LEGACY_JAVA_8_RELEASES.has(releaseId) ? LEGACY_JAVA_VERSION : null)
  if (requiredJavaVersion === null) {
    throw new AppError(
      `Mojang did not publish a Java requirement for Minecraft ${releaseId}.`,
      'JAVA_VERSION_NOT_FOUND'
    )
  }

  return {
    id: releaseId,
    type: 'release',
    requiredJavaVersion,
    download: serverDownload
  }
}

export async function listOfficialReleases(): Promise<MinecraftReleaseInfo[]> {
  const manifest = await fetchJson(VERSION_MANIFEST, versionManifestSchema)
  return manifest.versions
    .filter((version) => version.type === 'release')
    .map((version) => {
      const parsedId = versionId.safeParse(version.id)
      if (!parsedId.success) throw new AppError('Mojang returned an invalid release ID.', 'INVALID_MOJANG_METADATA')
      assertTrustedUrl(version.url)
      return {
        id: parsedId.data,
        type: 'release' as const,
        releaseTime: version.releaseTime
      }
    })
}

export async function resolveLatestRelease(): Promise<ResolvedServerVersion> {
  const manifest = await fetchJson(VERSION_MANIFEST, versionManifestSchema)
  const releaseId = manifest.latest?.release
  if (!releaseId) throw new AppError('Mojang did not list a latest release.', 'VERSION_NOT_FOUND')
  return resolveManifestRelease(manifest, releaseId)
}

export async function resolveRelease(releaseId: string): Promise<ResolvedServerVersion> {
  const parsedReleaseId = versionId.safeParse(releaseId)
  if (!parsedReleaseId.success) throw new AppError('The Minecraft release ID is invalid.', 'INVALID_VERSION')
  const manifest = await fetchJson(VERSION_MANIFEST, versionManifestSchema)
  return resolveManifestRelease(manifest, parsedReleaseId.data)
}

export async function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function downloadServerJar(
  version: ResolvedServerVersion,
  destination: string,
  onProgress: (progress: SetupProgress) => void
): Promise<void> {
  try {
    const existing = await stat(destination)
    if (existing.size === version.download.size && (await sha1File(destination)) === version.download.sha1) {
      onProgress({ phase: 'download', percent: 85, message: 'Verified the existing server download.' })
      return
    }
  } catch {
    // A missing or invalid file is downloaded below.
  }

  assertTrustedUrl(version.download.url)
  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await Promise.all([rm(destination, { force: true }), rm(partial, { force: true })])

  let response: Response
  try {
    response = await fetch(version.download.url, {
      headers: { 'User-Agent': 'EmberHost/0.3.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new AppError(
      'The server download could not be started. Check your connection and retry.',
      'DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!response.ok || !response.body) {
    throw new AppError(`The server download returned HTTP ${response.status}.`, 'DOWNLOAD_FAILED')
  }
  assertTrustedUrl(response.url)

  const file = await open(partial, 'w')
  const reader = response.body.getReader()
  let received = 0
  let streamError: AppError | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > version.download.size) {
        streamError = new AppError('The server download exceeded its signed metadata size.', 'DOWNLOAD_SIZE_MISMATCH')
        await reader.cancel().catch(() => undefined)
        break
      }
      await file.write(value)
      received += value.byteLength
      const ratio = Math.min(received / version.download.size, 1)
      onProgress({
        phase: 'download',
        percent: Math.round(20 + ratio * 60),
        message: `Downloading Minecraft ${version.id}…`,
        bytesReceived: received,
        totalBytes: version.download.size
      })
    }
  } catch (error) {
    streamError = new AppError(
      'The server download was interrupted. Try again.',
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

  const hash = await sha1File(partial)
  if (received !== version.download.size) {
    await rm(partial, { force: true })
    throw new AppError('The downloaded server file was incomplete.', 'DOWNLOAD_SIZE_MISMATCH')
  }
  if (hash !== version.download.sha1) {
    await rm(partial, { force: true })
    throw new AppError('The downloaded server file failed its Mojang checksum.', 'CHECKSUM_FAILED')
  }
  await rename(partial, destination)
  onProgress({ phase: 'download', percent: 85, message: 'Download verified with Mojang.' })
}
