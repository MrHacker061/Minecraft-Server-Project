import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LatestVersion, SetupProgress } from '../../shared/contracts'
import { AppError } from './errors'

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

interface VersionManifest {
  latest: { release: string }
  versions: Array<{ id: string; type: string; url: string }>
}

interface VersionDetails {
  id: string
  type: string
  javaVersion?: { majorVersion?: number }
  downloads?: {
    server?: {
      sha1: string
      size: number
      url: string
    }
  }
}

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
    (url.hostname === 'launchermeta.mojang.com' ||
      url.hostname === 'piston-meta.mojang.com' ||
      url.hostname.endsWith('.mojang.com') ||
      url.hostname.endsWith('.minecraft.net'))
  if (!trusted) throw new AppError('Mojang returned an unexpected download location.', 'UNTRUSTED_DOWNLOAD')
}

async function fetchJson<T>(url: string): Promise<T> {
  assertTrustedUrl(url)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'EmberHost/0.1.0' },
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
  return (await response.json()) as T
}

async function resolveManifestRelease(manifest: VersionManifest, releaseId: string): Promise<ResolvedServerVersion> {
  const entry = manifest.versions?.find((version) => version.id === releaseId && version.type === 'release')
  if (!entry) throw new AppError(`Mojang did not list release ${releaseId}.`, 'VERSION_NOT_FOUND')

  const details = await fetchJson<VersionDetails>(entry.url)
  const serverDownload = details.downloads?.server
  if (!serverDownload?.url || !serverDownload.sha1 || !serverDownload.size) {
    throw new AppError(`Minecraft ${releaseId} does not provide a vanilla server download.`, 'SERVER_JAR_NOT_FOUND')
  }
  assertTrustedUrl(serverDownload.url)

  return {
    id: releaseId,
    type: 'release',
    requiredJavaVersion: details.javaVersion?.majorVersion ?? 21,
    download: serverDownload
  }
}

export async function resolveLatestRelease(): Promise<ResolvedServerVersion> {
  const manifest = await fetchJson<VersionManifest>(VERSION_MANIFEST)
  const releaseId = manifest.latest?.release
  if (!releaseId) throw new AppError('Mojang did not list a latest release.', 'VERSION_NOT_FOUND')
  return resolveManifestRelease(manifest, releaseId)
}

export async function resolveRelease(releaseId: string): Promise<ResolvedServerVersion> {
  const manifest = await fetchJson<VersionManifest>(VERSION_MANIFEST)
  return resolveManifestRelease(manifest, releaseId)
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
  await rm(partial, { force: true })

  let response: Response
  try {
    response = await fetch(version.download.url, {
      headers: { 'User-Agent': 'EmberHost/0.1.0' },
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
