import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import { z } from 'zod'
import type { ForgeBuildInfo, ServerLaunch, SetupProgress } from '../../shared/contracts'
import { AppError } from './errors'

const FORGE_FILES_ORIGIN = 'https://files.minecraftforge.net'
const FORGE_MAVEN_ORIGIN = 'https://maven.minecraftforge.net'
const FORGE_HOMEPAGE = `${FORGE_FILES_ORIGIN}/net/minecraftforge/forge/`
const FORGE_PROMOTIONS_URL = `${FORGE_HOMEPAGE}promotions_slim.json`
const USER_AGENT = 'EmberHost/0.7.0'
const METADATA_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 180_000
const INSTALLER_TIMEOUT_MS = 15 * 60_000
const MAX_INSTALLER_BYTES = 256 * 1024 * 1024
const MAX_CHECKSUM_BYTES = 1_024
const MAX_PROMOTIONS_BYTES = 2 * 1024 * 1024
const MAX_INSTALLER_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_ERROR_OUTPUT_CHARS = 8_192

const minecraftVersionPattern = /^[0-9]+(?:\.[0-9]+){0,3}$/
const forgeVersionPattern = /^[0-9]+(?:\.[0-9]+){1,4}$/
const sha1Pattern = /^[a-f0-9]{40}$/

const promotionKeySchema = z.string().regex(/^[0-9]+(?:\.[0-9]+){0,3}-(?:recommended|latest)$/)
const promotionsSchema = z.object({
  homepage: z.literal(FORGE_HOMEPAGE),
  promos: z.record(promotionKeySchema, z.string().regex(forgeVersionPattern))
}).strict()

export type ForgeBuildChannel = 'recommended' | 'latest' | 'exact'
export type ForgeChecksumAlgorithm = 'sha512' | 'sha256' | 'sha1'

export interface ForgeChecksum {
  algorithm: ForgeChecksumAlgorithm
  digest: string
}

export interface ForgeInstallerRunOptions {
  cwd: string
  windowsHide: true
  shell: false
  signal: AbortSignal
  maxOutputBytes: number
}

export interface ForgeInstallerRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  output: string
}

export type ForgeInstallerRunner = (
  command: string,
  args: string[],
  options: ForgeInstallerRunOptions
) => Promise<ForgeInstallerRunResult>

export interface ForgeServiceDependencies {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  runInstaller: ForgeInstallerRunner
  metadataTimeoutMs: number
  downloadTimeoutMs: number
  installerTimeoutMs: number
  maxInstallerBytes: number
  maxInstallerOutputBytes: number
}

export interface ForgeJavaRuntime {
  executable: string
  majorVersion: number
  requiredMajorVersion: number
}

const defaultDependencies: ForgeServiceDependencies = {
  fetch: (input, init) => fetch(input, init),
  runInstaller: runInstallerProcess,
  metadataTimeoutMs: METADATA_TIMEOUT_MS,
  downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
  installerTimeoutMs: INSTALLER_TIMEOUT_MS,
  maxInstallerBytes: MAX_INSTALLER_BYTES,
  maxInstallerOutputBytes: MAX_INSTALLER_OUTPUT_BYTES
}

function dependenciesWith(
  overrides: Partial<ForgeServiceDependencies> = {}
): ForgeServiceDependencies {
  return { ...defaultDependencies, ...overrides }
}

function assertMinecraftVersion(version: string): void {
  if (!minecraftVersionPattern.test(version)) {
    throw new AppError('The Minecraft version is not valid for a Forge lookup.', 'INVALID_VERSION')
  }
}

function assertForgeVersion(version: string): void {
  if (!forgeVersionPattern.test(version)) {
    throw new AppError('The Forge version is not valid.', 'INVALID_FORGE_VERSION')
  }
}

function assertExactUrl(rawUrl: string, expectedUrl: string, description: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new AppError(`Forge returned an invalid ${description} location.`, 'UNTRUSTED_FORGE_DOWNLOAD')
  }
  if (
    url.href !== expectedUrl ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AppError(`Forge returned an unexpected ${description} location.`, 'UNTRUSTED_FORGE_DOWNLOAD')
  }
}

export function forgeInstallerName(minecraftVersion: string, forgeVersion: string): string {
  assertMinecraftVersion(minecraftVersion)
  assertForgeVersion(forgeVersion)
  return forgeInstallerNameForMavenVersion(`${minecraftVersion}-${forgeVersion}`)
}

export function forgeInstallerUrl(minecraftVersion: string, forgeVersion: string): string {
  assertMinecraftVersion(minecraftVersion)
  assertForgeVersion(forgeVersion)
  return forgeInstallerUrlForMavenVersion(`${minecraftVersion}-${forgeVersion}`)
}

function forgeMavenVersionCandidates(minecraftVersion: string, forgeVersion: string): string[] {
  return [
    `${minecraftVersion}-${forgeVersion}`,
    `${minecraftVersion}-${forgeVersion}-${minecraftVersion}`
  ]
}

function forgeInstallerNameForMavenVersion(mavenVersion: string): string {
  return `forge-${mavenVersion}-installer.jar`
}

function forgeInstallerUrlForMavenVersion(mavenVersion: string): string {
  return `${FORGE_MAVEN_ORIGIN}/net/minecraftforge/forge/${mavenVersion}/${forgeInstallerNameForMavenVersion(mavenVersion)}`
}

function assertBuild(build: ForgeBuildInfo): void {
  assertMinecraftVersion(build.minecraftVersion)
  assertForgeVersion(build.forgeVersion)
  const candidates = forgeMavenVersionCandidates(build.minecraftVersion, build.forgeVersion)
  if (!candidates.includes(build.mavenVersion)) {
    throw new AppError('The Forge Maven coordinate is invalid.', 'INVALID_FORGE_METADATA')
  }
  const expectedName = forgeInstallerNameForMavenVersion(build.mavenVersion)
  const expectedUrl = forgeInstallerUrlForMavenVersion(build.mavenVersion)
  if (build.installer.name !== expectedName || !sha1Pattern.test(build.installer.sha1)) {
    throw new AppError('The Forge installer metadata is invalid.', 'INVALID_FORGE_METADATA')
  }
  assertExactUrl(build.installer.url, expectedUrl, 'installer')
}

async function fetchResponse(
  url: string,
  timeoutMs: number,
  dependencies: ForgeServiceDependencies,
  failureMessage: string,
  failureCode: string
): Promise<Response> {
  let response: Response
  try {
    response = await dependencies.fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    throw new AppError(
      failureMessage,
      failureCode,
      error instanceof Error ? error.message : undefined
    )
  }
  assertExactUrl(response.url, url, 'metadata')
  return response
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      throw new AppError('Forge returned oversized metadata.', 'INVALID_FORGE_METADATA')
    }
  }

  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
      throw new AppError('Forge returned oversized metadata.', 'INVALID_FORGE_METADATA')
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw new AppError('Forge returned oversized metadata.', 'INVALID_FORGE_METADATA')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

async function fetchPromotions(
  dependencies: ForgeServiceDependencies
): Promise<z.infer<typeof promotionsSchema>> {
  const response = await fetchResponse(
    FORGE_PROMOTIONS_URL,
    dependencies.metadataTimeoutMs,
    dependencies,
    'Could not reach Forge. Check your internet connection and try again.',
    'NETWORK_ERROR'
  )
  if (!response.ok) {
    throw new AppError(`Forge returned HTTP ${response.status}. Try again in a moment.`, 'FORGE_API_ERROR')
  }

  let payload: unknown
  try {
    payload = JSON.parse(await readBoundedText(response, MAX_PROMOTIONS_BYTES))
  } catch (error) {
    throw new AppError(
      'Forge returned unreadable promotions metadata.',
      'INVALID_FORGE_METADATA',
      error instanceof Error ? error.message : undefined
    )
  }
  const parsed = promotionsSchema.safeParse(payload)
  if (!parsed.success) {
    throw new AppError('Forge returned invalid promotions metadata.', 'INVALID_FORGE_METADATA')
  }
  return parsed.data
}

function checksumPattern(algorithm: ForgeChecksumAlgorithm): RegExp {
  if (algorithm === 'sha512') return /^[a-fA-F0-9]{128}$/
  if (algorithm === 'sha256') return /^[a-fA-F0-9]{64}$/
  return /^[a-fA-F0-9]{40}$/
}

async function fetchChecksumSidecar(
  artifactUrl: string,
  algorithm: ForgeChecksumAlgorithm,
  dependencies: ForgeServiceDependencies,
  allowMissing: boolean
): Promise<ForgeChecksum | null> {
  const url = `${artifactUrl}.${algorithm}`
  const response = await fetchResponse(
    url,
    dependencies.metadataTimeoutMs,
    dependencies,
    'Could not retrieve the Forge installer checksum.',
    'FORGE_CHECKSUM_FETCH_FAILED'
  )
  if (allowMissing && (response.status === 404 || response.status === 410)) return null
  if (!response.ok) {
    throw new AppError(
      `The Forge checksum service returned HTTP ${response.status}.`,
      'FORGE_CHECKSUM_FETCH_FAILED'
    )
  }
  const contents = (await readBoundedText(response, MAX_CHECKSUM_BYTES)).trim()
  const digest = contents.split(/\s+/u)[0] ?? ''
  if (!checksumPattern(algorithm).test(digest)) {
    throw new AppError('Forge returned an invalid installer checksum.', 'INVALID_FORGE_METADATA')
  }
  return { algorithm, digest: digest.toLowerCase() }
}

async function forgeBuildInfo(
  minecraftVersion: string,
  forgeVersion: string,
  channel: ForgeBuildChannel,
  dependencies: ForgeServiceDependencies
): Promise<ForgeBuildInfo> {
  for (const mavenVersion of forgeMavenVersionCandidates(minecraftVersion, forgeVersion)) {
    const url = forgeInstallerUrlForMavenVersion(mavenVersion)
    const sha1 = await fetchChecksumSidecar(url, 'sha1', dependencies, true)
    if (!sha1) continue
    return {
      minecraftVersion,
      forgeVersion,
      mavenVersion,
      channel,
      installer: {
        name: forgeInstallerNameForMavenVersion(mavenVersion),
        sha1: sha1.digest,
        url
      }
    }
  }
  throw new AppError('Forge did not publish a downloadable installer for that build.', 'FORGE_BUILD_NOT_FOUND')
}

/** Resolves Forge's recommended build, falling back to its latest published build. */
export async function resolvePreferredForgeBuild(
  minecraftVersion: string,
  dependencyOverrides: Partial<ForgeServiceDependencies> = {}
): Promise<ForgeBuildInfo> {
  assertMinecraftVersion(minecraftVersion)
  const dependencies = dependenciesWith(dependencyOverrides)
  const promotions = await fetchPromotions(dependencies)
  const recommended = promotions.promos[`${minecraftVersion}-recommended`]
  const latest = promotions.promos[`${minecraftVersion}-latest`]
  const forgeVersion = recommended ?? latest
  const channel: ForgeBuildChannel = recommended ? 'recommended' : 'latest'
  if (!forgeVersion) {
    throw new AppError(
      `Forge does not provide a build for Minecraft ${minecraftVersion}.`,
      'FORGE_VERSION_NOT_FOUND'
    )
  }
  return forgeBuildInfo(minecraftVersion, forgeVersion, channel, dependencies)
}

/**
 * Resolves and checksum-pins an exact Forge installer. For promoted channels, the
 * requested build must still be the build Forge currently publishes in that channel.
 */
export async function resolveForgeBuild(
  minecraftVersion: string,
  forgeVersion: string,
  channel: ForgeBuildChannel = 'exact',
  dependencyOverrides: Partial<ForgeServiceDependencies> = {}
): Promise<ForgeBuildInfo> {
  assertMinecraftVersion(minecraftVersion)
  assertForgeVersion(forgeVersion)
  const dependencies = dependenciesWith(dependencyOverrides)
  if (channel !== 'exact') {
    const promotions = await fetchPromotions(dependencies)
    if (promotions.promos[`${minecraftVersion}-${channel}`] !== forgeVersion) {
      throw new AppError(
        `Forge ${channel} build ${forgeVersion} is not available for Minecraft ${minecraftVersion}.`,
        'FORGE_BUILD_NOT_FOUND'
      )
    }
  }
  return forgeBuildInfo(minecraftVersion, forgeVersion, channel, dependencies)
}

async function strongestInstallerChecksum(
  build: ForgeBuildInfo,
  dependencies: ForgeServiceDependencies
): Promise<ForgeChecksum> {
  for (const algorithm of ['sha512', 'sha256'] as const) {
    const checksum = await fetchChecksumSidecar(build.installer.url, algorithm, dependencies, true)
    if (checksum) return checksum
  }
  return { algorithm: 'sha1', digest: build.installer.sha1 }
}

async function digestFile(path: string, algorithm: ForgeChecksumAlgorithm): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash(algorithm)
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolveDigest(hash.digest('hex')))
  })
}

async function existingInstallerIsValid(
  path: string,
  checksum: ForgeChecksum,
  expectedSha1: string,
  maximumBytes: number
): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) return false
    const [strongest, sha1] = await Promise.all([
      digestFile(path, checksum.algorithm),
      checksum.algorithm === 'sha1' ? Promise.resolve(checksum.digest) : digestFile(path, 'sha1')
    ])
    return strongest === checksum.digest && sha1 === expectedSha1
  } catch {
    return false
  }
}

async function writeFully(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset)
    if (result.bytesWritten < 1) throw new Error('Forge installer download write made no progress.')
    offset += result.bytesWritten
  }
}

/** Downloads a Forge installer into the shared cache and verifies SHA-512, SHA-256, or SHA-1. */
export async function downloadForgeInstaller(
  build: ForgeBuildInfo,
  destination: string,
  onProgress: (progress: SetupProgress) => void = () => undefined,
  dependencyOverrides: Partial<ForgeServiceDependencies> = {}
): Promise<ForgeChecksum> {
  assertBuild(build)
  if (!isAbsolute(destination)) {
    throw new AppError('The Forge installer cache path must be absolute.', 'INVALID_FORGE_CACHE_PATH')
  }
  const dependencies = dependenciesWith(dependencyOverrides)
  const checksum = await strongestInstallerChecksum(build, dependencies)
  if (await existingInstallerIsValid(destination, checksum, build.installer.sha1, dependencies.maxInstallerBytes)) {
    onProgress({ phase: 'download', percent: 80, message: `Verified the cached Forge installer with ${checksum.algorithm.toUpperCase()}.` })
    return checksum
  }

  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.part`
  await Promise.all([rm(destination, { force: true }), rm(partial, { force: true })])

  const response = await fetchResponse(
    build.installer.url,
    dependencies.downloadTimeoutMs,
    dependencies,
    'The Forge installer download could not be started. Check your connection and retry.',
    'FORGE_DOWNLOAD_FAILED'
  )
  if (!response.ok || !response.body) {
    throw new AppError(
      `The Forge installer download returned HTTP ${response.status}.`,
      'FORGE_DOWNLOAD_FAILED'
    )
  }
  assertExactUrl(response.url, build.installer.url, 'installer')

  const declaredLengthText = response.headers.get('content-length')
  let declaredLength: number | null = null
  if (declaredLengthText !== null) {
    if (!/^\d+$/.test(declaredLengthText)) {
      throw new AppError('The Forge installer returned an invalid size.', 'FORGE_DOWNLOAD_SIZE_MISMATCH')
    }
    declaredLength = Number(declaredLengthText)
    if (declaredLength < 1 || declaredLength > dependencies.maxInstallerBytes) {
      throw new AppError('The Forge installer exceeded the safe download limit.', 'FORGE_DOWNLOAD_SIZE_MISMATCH')
    }
  }

  const reader = response.body.getReader()
  const file = await open(partial, 'wx')
  const strongestHash = createHash(checksum.algorithm)
  const sha1Hash = createHash('sha1')
  let received = 0
  let streamError: AppError | null = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > dependencies.maxInstallerBytes) {
        await reader.cancel().catch(() => undefined)
        streamError = new AppError(
          'The Forge installer exceeded the safe download limit.',
          'FORGE_DOWNLOAD_SIZE_MISMATCH'
        )
        break
      }
      await writeFully(file, value)
      received += value.byteLength
      strongestHash.update(value)
      sha1Hash.update(value)
      const total = declaredLength ?? dependencies.maxInstallerBytes
      onProgress({
        phase: 'download',
        percent: Math.round(20 + Math.min(received / total, 1) * 55),
        message: `Downloading Forge ${build.forgeVersion} installer...`,
        bytesReceived: received,
        ...(declaredLength === null ? {} : { totalBytes: declaredLength })
      })
    }
  } catch (error) {
    streamError = new AppError(
      'The Forge installer download was interrupted. Try again.',
      'FORGE_DOWNLOAD_FAILED',
      error instanceof Error ? error.message : undefined
    )
  } finally {
    await file.close()
  }

  if (streamError) {
    await rm(partial, { force: true })
    throw streamError
  }
  if (received < 1 || (declaredLength !== null && received !== declaredLength)) {
    await rm(partial, { force: true })
    throw new AppError('The Forge installer download was incomplete.', 'FORGE_DOWNLOAD_SIZE_MISMATCH')
  }
  if (strongestHash.digest('hex') !== checksum.digest || sha1Hash.digest('hex') !== build.installer.sha1) {
    await rm(partial, { force: true })
    throw new AppError(
      `The Forge installer failed ${checksum.algorithm.toUpperCase()} verification.`,
      'FORGE_CHECKSUM_FAILED'
    )
  }
  await rename(partial, destination)
  onProgress({
    phase: 'download',
    percent: 80,
    message: `Forge installer verified with ${checksum.algorithm.toUpperCase()}.`
  })
  return checksum
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

async function assertNormalAbsoluteFile(path: string, description: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new AppError(`${description} path must be absolute.`, 'UNSAFE_FORGE_INSTALL_PATH')
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    throw new AppError(
      `${description} could not be found.`,
      'FORGE_INSTALLER_NOT_FOUND',
      error instanceof Error ? error.message : undefined
    )
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AppError(`${description} is not a normal file.`, 'UNSAFE_FORGE_INSTALL_PATH')
  }
}

async function assertNormalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new AppError('The Forge staging directory must be absolute.', 'UNSAFE_FORGE_INSTALL_PATH')
  }
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AppError('The Forge staging directory is not a normal directory.', 'UNSAFE_FORGE_INSTALL_PATH')
  }
  return realpath(path)
}

async function assertNormalFileBelow(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/')
  let cursor = root
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new AppError('Forge produced an unsafe launch path.', 'UNSAFE_FORGE_LAUNCH')
    }
    cursor = join(cursor, segment)
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) {
      throw new AppError('Forge produced a symbolic link in its launch path.', 'UNSAFE_FORGE_LAUNCH')
    }
  }
  const info = await stat(cursor)
  if (!info.isFile()) {
    throw new AppError('Forge did not produce a normal launch file.', 'FORGE_LAUNCH_NOT_FOUND')
  }
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(cursor)])
  if (!isInside(realRoot, realCandidate)) {
    throw new AppError('Forge produced a launch file outside its server directory.', 'UNSAFE_FORGE_LAUNCH')
  }
}

/** Detects only Forge's generated argfiles or its legacy root JAR; scripts are never considered. */
export async function detectForgeLaunch(
  stagingDirectory: string,
  minecraftVersion: string,
  forgeVersion: string,
  mavenVersion?: string
): Promise<ServerLaunch> {
  assertMinecraftVersion(minecraftVersion)
  assertForgeVersion(forgeVersion)
  if (!isAbsolute(stagingDirectory)) {
    throw new AppError('The Forge staging directory must be absolute.', 'UNSAFE_FORGE_INSTALL_PATH')
  }
  const root = await assertNormalDirectory(resolve(stagingDirectory))
  const candidateCoordinates = forgeMavenVersionCandidates(minecraftVersion, forgeVersion)
  if (mavenVersion && !candidateCoordinates.includes(mavenVersion)) {
    throw new AppError('The Forge Maven coordinate is invalid.', 'INVALID_FORGE_METADATA')
  }
  const coordinates = mavenVersion
    ? [mavenVersion, ...candidateCoordinates.filter((candidate) => candidate !== mavenVersion)]
    : candidateCoordinates

  for (const coordinate of coordinates) {
    const base = `libraries/net/minecraftforge/forge/${coordinate}`
    const windowsPath = `${base}/win_args.txt`
    const unixPath = `${base}/unix_args.txt`
    try {
      await assertNormalFileBelow(root, windowsPath)
      await assertNormalFileBelow(root, unixPath)
      return { kind: 'java-argfile', windowsPath, unixPath }
    } catch (error) {
      if (error instanceof AppError && error.code === 'FORGE_LAUNCH_NOT_FOUND') continue
      if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }

  const preferredNames = coordinates.flatMap((coordinate) => [
    `forge-${coordinate}.jar`,
    `forge-${coordinate}-universal.jar`
  ])
  const allowedNames = new Set(preferredNames)
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && allowedNames.has(entry.name))
    .map((entry) => entry.name)
  const selected = preferredNames.find((name) => names.includes(name)) ?? null
  if (!selected) {
    throw new AppError(
      'The Forge installer completed without producing supported launch files.',
      'FORGE_LAUNCH_NOT_FOUND'
    )
  }
  await assertNormalFileBelow(root, selected)
  return { kind: 'jar', path: selected }
}

async function runInstallerProcess(
  command: string,
  args: string[],
  options: ForgeInstallerRunOptions
): Promise<ForgeInstallerRunResult> {
  return new Promise((resolveRun, reject) => {
    let output = ''
    let outputBytes = 0
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const finish = (error: Error | null, result?: ForgeInstallerRunResult): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else if (result) resolveRun(result)
    }
    const abort = (): void => {
      child.kill()
      finish(new AppError('The Forge installer timed out.', 'FORGE_INSTALLER_TIMEOUT'))
    }
    const append = (chunk: Buffer): void => {
      if (settled) return
      outputBytes += chunk.byteLength
      if (outputBytes > options.maxOutputBytes) {
        child.kill()
        finish(new AppError('The Forge installer produced too much output.', 'FORGE_INSTALLER_OUTPUT_LIMIT'))
        return
      }
      output += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => finish(new AppError(
      'The Forge installer could not be started.',
      'FORGE_INSTALLER_START_FAILED',
      error.message
    )))
    child.on('close', (exitCode, signal) => finish(null, { exitCode, signal, output }))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}

async function runInstallerWithLimits(
  dependencies: ForgeServiceDependencies,
  command: string,
  args: string[],
  cwd: string
): Promise<ForgeInstallerRunResult> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolveTimeout, rejectTimeout) => {
    timeout = setTimeout(() => {
      controller.abort()
      rejectTimeout(new AppError('The Forge installer timed out.', 'FORGE_INSTALLER_TIMEOUT'))
    }, dependencies.installerTimeoutMs)
  })
  try {
    const result = await Promise.race([
      dependencies.runInstaller(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        signal: controller.signal,
        maxOutputBytes: dependencies.maxInstallerOutputBytes
      }),
      timeoutPromise
    ])
    if (Buffer.byteLength(result.output, 'utf8') > dependencies.maxInstallerOutputBytes) {
      throw new AppError('The Forge installer produced too much output.', 'FORGE_INSTALLER_OUTPUT_LIMIT')
    }
    return result
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Runs the verified Forge installer directly with Java, then returns a safe launch
 * descriptor. The generated run.bat/run.sh files are deliberately never executed.
 */
export async function installForgeServer(
  build: ForgeBuildInfo,
  installerPath: string,
  stagingDirectory: string,
  java: ForgeJavaRuntime,
  onProgress: (progress: SetupProgress) => void = () => undefined,
  dependencyOverrides: Partial<ForgeServiceDependencies> = {}
): Promise<ServerLaunch> {
  assertBuild(build)
  if (
    !java.executable.trim() ||
    java.executable.length > 500 ||
    /[\0\r\n]/u.test(java.executable) ||
    !Number.isSafeInteger(java.majorVersion) ||
    !Number.isSafeInteger(java.requiredMajorVersion) ||
    java.requiredMajorVersion < 1
  ) {
    throw new AppError('The selected Java runtime is invalid.', 'INVALID_JAVA_RUNTIME')
  }
  if (java.majorVersion < java.requiredMajorVersion) {
    throw new AppError(
      `Minecraft ${build.minecraftVersion} requires Java ${java.requiredMajorVersion}; the selected runtime is Java ${java.majorVersion}.`,
      'JAVA_TOO_OLD'
    )
  }
  if (java.majorVersion !== java.requiredMajorVersion) {
    throw new AppError(
      `Forge for Minecraft ${build.minecraftVersion} requires Java ${java.requiredMajorVersion} exactly; Java ${java.majorVersion} was selected.`,
      'JAVA_VERSION_MISMATCH'
    )
  }

  if (!isAbsolute(installerPath) || !isAbsolute(stagingDirectory)) {
    throw new AppError('Forge installer paths must be absolute.', 'UNSAFE_FORGE_INSTALL_PATH')
  }
  const absoluteInstaller = resolve(installerPath)
  const absoluteStaging = resolve(stagingDirectory)
  const dependencies = dependenciesWith(dependencyOverrides)
  await assertNormalAbsoluteFile(absoluteInstaller, 'The Forge installer')
  const installerInfo = await lstat(absoluteInstaller)
  if (
    installerInfo.size < 1 ||
    installerInfo.size > dependencies.maxInstallerBytes ||
    await digestFile(absoluteInstaller, 'sha1') !== build.installer.sha1
  ) {
    throw new AppError('The cached Forge installer failed SHA-1 verification.', 'FORGE_CHECKSUM_FAILED')
  }
  const realStaging = await assertNormalDirectory(absoluteStaging)
  if ((await readdir(realStaging)).length !== 0) {
    throw new AppError('The Forge installer requires an empty staging directory.', 'FORGE_STAGING_NOT_EMPTY')
  }
  onProgress({ phase: 'loader', percent: 82, message: `Installing Forge ${build.forgeVersion}...` })

  const result = await runInstallerWithLimits(
    dependencies,
    java.executable,
    ['-jar', absoluteInstaller, '--installServer', absoluteStaging],
    realStaging
  )
  if (result.exitCode !== 0) {
    throw new AppError(
      `The Forge installer exited with code ${result.exitCode ?? 'unknown'}.`,
      'FORGE_INSTALLER_FAILED',
      result.output.slice(-MAX_ERROR_OUTPUT_CHARS)
    )
  }

  const launch = await detectForgeLaunch(
    realStaging,
    build.minecraftVersion,
    build.forgeVersion,
    build.mavenVersion
  )
  const modsDirectory = join(realStaging, 'mods')
  await mkdir(modsDirectory, { recursive: true })
  const modsInfo = await lstat(modsDirectory)
  if (!modsInfo.isDirectory() || modsInfo.isSymbolicLink() || !isInside(realStaging, await realpath(modsDirectory))) {
    throw new AppError('Forge produced an unsafe mods directory.', 'UNSAFE_FORGE_INSTALL_PATH')
  }
  onProgress({ phase: 'mods', percent: 89, message: 'Created the Forge mods folder.' })
  return launch
}
