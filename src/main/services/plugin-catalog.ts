import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { PaperPluginInfo, ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'
import type { PluginService } from './plugin-service'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'

const MODRINTH_API_ORIGIN = 'https://api.modrinth.com'
const MODRINTH_CDN_ORIGIN = 'https://cdn.modrinth.com'
const USER_AGENT = 'MrHacker061/EmberHost/0.4.1 (github.com/MrHacker061/Minecraft-Server-Project)'
const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_PLUGIN_BYTES = 128 * 1024 * 1024
const METADATA_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const CACHE_TTL_MS = 5 * 60_000
const idPattern = /^[A-Za-z0-9]{8}$/
const sha512Pattern = /^[a-f0-9]{128}$/i

type CatalogCategory = 'administration' | 'building' | 'protection' | 'compatibility' | 'worlds' | 'communication' | 'maps' | 'integration' | 'gameplay'

interface CuratedPluginDefinition {
  projectId: string
  slug: string
  name: string
  category: CatalogCategory
  author: string
  pluginNames: readonly string[]
  requires: readonly string[]
}

export const CURATED_PAPER_PLUGINS = [
  { projectId: 'Vebnzrzj', slug: 'luckperms', name: 'LuckPerms', category: 'administration', author: 'Luck', pluginNames: ['LuckPerms'], requires: [] },
  { projectId: '1u6JkXh5', slug: 'worldedit', name: 'WorldEdit', category: 'building', author: 'EngineHub', pluginNames: ['WorldEdit'], requires: [] },
  { projectId: 'DKY9btbd', slug: 'worldguard', name: 'WorldGuard', category: 'protection', author: 'EngineHub', pluginNames: ['WorldGuard'], requires: ['1u6JkXh5'] },
  { projectId: 'P1OZGk5p', slug: 'viaversion', name: 'ViaVersion', category: 'compatibility', author: 'ViaVersion', pluginNames: ['ViaVersion'], requires: [] },
  { projectId: 'NpvuJQoq', slug: 'viabackwards', name: 'ViaBackwards', category: 'compatibility', author: 'ViaVersion', pluginNames: ['ViaBackwards'], requires: ['P1OZGk5p'] },
  { projectId: '3wmN97b8', slug: 'multiverse-core', name: 'Multiverse-Core', category: 'worlds', author: 'Multiverse', pluginNames: ['Multiverse-Core', 'MultiverseCore'], requires: [] },
  { projectId: '9eGKb6K1', slug: 'simple-voice-chat', name: 'Simple Voice Chat', category: 'communication', author: 'henkelmax', pluginNames: ['voicechat', 'SimpleVoiceChat'], requires: [] },
  { projectId: 'gG7VFbG0', slug: 'tab-was-taken', name: 'TAB', category: 'administration', author: 'NEZNAMY', pluginNames: ['TAB'], requires: [] },
  { projectId: 'PFb7ZqK6', slug: 'squaremap', name: 'squaremap', category: 'maps', author: 'jmp', pluginNames: ['squaremap'], requires: [] },
  { projectId: 'UmLGoGij', slug: 'discordsrv', name: 'DiscordSRV', category: 'integration', author: 'Scarsz', pluginNames: ['DiscordSRV'], requires: [] },
  { projectId: 'OhduvhIc', slug: 'veinminer', name: 'VeinMiner', category: 'gameplay', author: '2008Choco', pluginNames: ['VeinMiner'], requires: [] },
  { projectId: 'lKEzGugV', slug: 'placeholderapi', name: 'PlaceholderAPI', category: 'integration', author: 'HelpChat', pluginNames: ['PlaceholderAPI'], requires: [] }
] as const satisfies readonly CuratedPluginDefinition[]

export interface CatalogPluginVersion {
  id: string
  number: string
  publishedAt: string
  fileName: string
  sizeBytes: number
}

export interface CatalogPaperPlugin {
  projectId: string
  slug: string
  name: string
  description: string
  category: CatalogCategory
  author: string
  iconUrl: string | null
  downloads: number
  license: string
  sourceUrl: string
  minecraftVersion: string
  compatible: boolean
  installed: boolean
  latestVersion: string | null
  version: CatalogPluginVersion | null
  requiredProjectIds: string[]
  requirements: string[]
  unavailableReason: string | null
}

interface CatalogDownload {
  projectId: string
  versionId: string
  versionNumber: string
  publishedAt: string
  fileName: string
  size: number
  sha512: string
  url: string
}

interface CatalogMetadata {
  definition: CuratedPluginDefinition
  description: string
  iconUrl: string | null
  downloads: number
  license: string
  download: CatalogDownload | null
  unavailableReason: string | null
}

interface CatalogManager {
  runExclusive<T>(instanceId: string, operation: () => Promise<T>): Promise<T>
  isActive(instanceId: string): boolean
}

interface CatalogDependencies {
  fetch: typeof fetch
  now: () => number
  cleanupTemporaryDirectory: (directory: string) => Promise<void>
}

const projectSchema = z.object({
  id: z.string().regex(idPattern),
  slug: z.string().min(3).max(64),
  title: z.string().min(1).max(256),
  description: z.string().max(2048),
  status: z.enum(['approved', 'archived', 'rejected', 'draft', 'unlisted', 'processing', 'withheld', 'scheduled', 'private', 'unknown']),
  server_side: z.enum(['required', 'optional', 'unsupported', 'unknown']),
  downloads: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  icon_url: z.string().url().nullable(),
  license: z.object({ id: z.string().min(1).max(128) }),
  loaders: z.array(z.string().min(1).max(64)).max(64)
})

const dependencySchema = z.object({
  version_id: z.string().regex(idPattern).nullable(),
  project_id: z.string().regex(idPattern).nullable(),
  file_name: z.string().max(240).nullable(),
  dependency_type: z.enum(['required', 'optional', 'incompatible', 'embedded'])
})

const versionFileSchema = z.object({
  hashes: z.object({ sha512: z.string().regex(sha512Pattern) }),
  url: z.string().url(),
  filename: z.string().min(5).max(160),
  primary: z.boolean(),
  size: z.number().int().positive().max(MAX_PLUGIN_BYTES),
  file_type: z.enum(['required-resource-pack', 'optional-resource-pack', 'sources-jar', 'dev-jar', 'javadoc-jar', 'unknown', 'signature']).nullable()
})

const versionSchema = z.object({
  id: z.string().regex(idPattern),
  project_id: z.string().regex(idPattern),
  version_number: z.string().min(1).max(128),
  version_type: z.enum(['release', 'beta', 'alpha']),
  status: z.enum(['listed', 'archived', 'draft', 'unlisted', 'scheduled', 'unknown']),
  date_published: z.string().min(1).max(64),
  game_versions: z.array(z.string().min(1).max(64)).max(256),
  loaders: z.array(z.string().min(1).max(64)).max(64),
  dependencies: z.array(dependencySchema).max(64),
  files: z.array(versionFileSchema).min(1).max(64)
})

const projectsSchema = z.array(projectSchema).max(64)
const versionsSchema = z.array(versionSchema).max(512)

function assertExactApiUrl(rawUrl: string, expected: URL): void {
  const url = new URL(rawUrl)
  if (
    url.href !== expected.href ||
    url.origin !== MODRINTH_API_ORIGIN ||
    url.protocol !== 'https:' ||
    url.hostname !== 'api.modrinth.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new AppError('Modrinth metadata came from an unexpected location.', 'UNTRUSTED_CATALOG_METADATA')
  }
}

function assertCdnUrl(rawUrl: string, projectId: string, versionId: string, fileName: string): void {
  const url = new URL(rawUrl)
  const segments = url.pathname.split('/')
  if (
    url.origin !== MODRINTH_CDN_ORIGIN ||
    url.protocol !== 'https:' ||
    url.hostname !== 'cdn.modrinth.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.length !== 6 ||
    segments[1] !== 'data' ||
    segments[2] !== projectId ||
    segments[3] !== 'versions' ||
    segments[4] !== versionId ||
    decodeURIComponent(segments[5] ?? '') !== fileName
  ) {
    throw new AppError('Modrinth returned an untrusted plugin download URL.', 'UNTRUSTED_CATALOG_DOWNLOAD')
  }
}

function trustedIcon(rawUrl: string | null, projectId: string): string | null {
  if (rawUrl === null) return null
  const url = new URL(rawUrl)
  if (
    url.origin !== MODRINTH_CDN_ORIGIN ||
    url.protocol !== 'https:' ||
    url.hostname !== 'cdn.modrinth.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith(`/data/${projectId}/`) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AppError('Modrinth returned an untrusted project icon URL.', 'UNTRUSTED_CATALOG_METADATA')
  }
  return url.href
}

function assertPluginFilename(fileName: string): void {
  if (
    Buffer.byteLength(fileName, 'utf8') > 240 ||
    !/^[^<>:"/\\|?*\u0000-\u001f]+\.jar$/i.test(fileName) ||
    /[. ]\.jar$/i.test(fileName) ||
    fileName.toLowerCase() === 'chunky.jar'
  ) {
    throw new AppError('Modrinth returned an unsafe plugin filename.', 'INVALID_CATALOG_METADATA')
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_METADATA_BYTES)) {
    throw new AppError('Modrinth metadata exceeded the safety limit.', 'INVALID_CATALOG_METADATA')
  }
  if (!response.body) throw new AppError('Modrinth returned an empty metadata response.', 'INVALID_CATALOG_METADATA')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new AppError('Modrinth metadata exceeded the safety limit.', 'INVALID_CATALOG_METADATA')
    }
    chunks.push(value)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new AppError(
      'Modrinth returned unreadable catalog metadata.',
      'INVALID_CATALOG_METADATA',
      error instanceof Error ? error.message : undefined
    )
  }
}

function normalizeIdentity(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/\.jar$/i, '').replace(/[^a-z0-9]/g, '')
}

function isInstalled(definition: CuratedPluginDefinition, plugins: PaperPluginInfo[]): boolean {
  const aliases = definition.pluginNames.map(normalizeIdentity)
  return plugins.some((plugin) => {
    if (plugin.builtIn) return false
    if (plugin.catalogProjectId === definition.projectId) return true
    const pluginName = plugin.name ? normalizeIdentity(plugin.name) : ''
    const fileName = normalizeIdentity(plugin.fileName)
    return aliases.some((alias) => pluginName === alias || fileName === alias || fileName.startsWith(alias))
  })
}

function definitionById(projectId: string): CuratedPluginDefinition | undefined {
  return CURATED_PAPER_PLUGINS.find((definition) => definition.projectId === projectId)
}

export function catalogPluginPageUrl(projectId: string): string {
  const definition = definitionById(projectId)
  if (!definition) {
    throw new AppError('That project is not in EmberHost\'s curated plugin catalog.', 'CATALOG_PLUGIN_NOT_ALLOWED')
  }
  return `https://modrinth.com/plugin/${definition.slug}`
}

export class PluginCatalogService {
  private readonly dependencies: CatalogDependencies
  private readonly cache = new Map<string, { expiresAt: number; metadata: CatalogMetadata[] }>()

  constructor(
    private readonly store: AppStore,
    private readonly manager: CatalogManager | ServerManager,
    private readonly pluginService: PluginService,
    private readonly cacheDirectory = join(store.dataDirectory, 'plugin-catalog-cache'),
    dependencies: Partial<CatalogDependencies> = {}
  ) {
    this.dependencies = {
      fetch: globalThis.fetch,
      now: Date.now,
      cleanupTemporaryDirectory: (directory) => rm(directory, { recursive: true, force: true }),
      ...dependencies
    }
  }

  async list(instanceId: string): Promise<CatalogPaperPlugin[]> {
    const instance = this.requirePaper(instanceId)
    const [plugins, metadata] = await Promise.all([
      this.pluginService.list(instanceId),
      this.catalogMetadata(instance.version)
    ])
    return metadata.map((item) => this.toPublic(item, instance.version, plugins))
  }

  async install(instanceId: string, projectId: string): Promise<PaperPluginInfo[]> {
    return this.manager.runExclusive(instanceId, () => this.installWithinExclusive(instanceId, projectId))
  }

  private async installWithinExclusive(instanceId: string, projectId: string): Promise<PaperPluginInfo[]> {
    const instance = this.requirePaper(instanceId)
    this.assertStopped(instanceId)
    const definition = definitionById(projectId)
    if (!definition) {
      throw new AppError('That project is not in EmberHost\'s curated plugin catalog.', 'CATALOG_PLUGIN_NOT_ALLOWED')
    }

    let plugins = await this.pluginService.listWithinExclusive(instanceId)
    if (isInstalled(definition, plugins)) {
      throw new AppError(`${definition.name} is already installed.`, 'CATALOG_PLUGIN_ALREADY_INSTALLED')
    }
    const metadata = (await this.fetchCatalogMetadata(instance.version, [definition]))[0]
    if (!metadata?.download) {
      throw new AppError(
        metadata?.unavailableReason ?? `${definition.name} has no compatible stable Paper release.`,
        'CATALOG_PLUGIN_UNAVAILABLE'
      )
    }
    this.assertDependencies(definition, plugins)
    this.assertStopped(instanceId)

    await mkdir(this.cacheDirectory, { recursive: true })
    const temporaryDirectory = await mkdtemp(join(this.cacheDirectory, '.install-'))
    const downloadedJar = join(temporaryDirectory, metadata.download.fileName)
    try {
      await this.download(metadata.download, downloadedJar)
      // Recheck after the network operation while the same per-instance lock is still held, then
      // atomically link the verified JAR into plugins/ without taking a nested lock.
      plugins = await this.pluginService.listWithinExclusive(instanceId)
      if (isInstalled(definition, plugins)) {
        throw new AppError(`${definition.name} was installed while the download was running.`, 'CATALOG_PLUGIN_ALREADY_INSTALLED')
      }
      this.assertDependencies(definition, plugins)
      this.assertStopped(instanceId)
      return await this.pluginService.installFromPathWithinExclusive(instanceId, downloadedJar, {
        projectId: definition.projectId,
        versionId: metadata.download.versionId
      })
    } finally {
      // The JAR and its manifest may already be committed. A transient antivirus/file-lock
      // failure while clearing the download cache must not turn that successful install into
      // a reported failure. Any orphan is inert and remains confined to the catalog cache.
      await this.dependencies.cleanupTemporaryDirectory(temporaryDirectory).catch(() => undefined)
    }
  }

  private requirePaper(instanceId: string): ServerInstance {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (instance.software.kind !== 'paper') {
      throw new AppError('The curated plugin catalog is only available for Paper servers.', 'PAPER_REQUIRED')
    }
    return instance
  }

  private assertStopped(instanceId: string): void {
    if (this.manager.isActive(instanceId)) {
      throw new AppError('Stop the Paper server before installing a catalog plugin.', 'SERVER_MUST_BE_STOPPED')
    }
  }

  private assertDependencies(definition: CuratedPluginDefinition, plugins: PaperPluginInfo[]): void {
    const missing = definition.requires
      .map((projectId) => definitionById(projectId))
      .filter((dependency): dependency is CuratedPluginDefinition => Boolean(dependency))
      .filter((dependency) => !isInstalled(dependency, plugins))
    if (missing.length) {
      throw new AppError(
        `Install ${missing.map((dependency) => dependency.name).join(' and ')} first.`,
        'CATALOG_DEPENDENCY_REQUIRED'
      )
    }
  }

  private toPublic(metadata: CatalogMetadata, minecraftVersion: string, plugins: PaperPluginInfo[]): CatalogPaperPlugin {
    const dependencyDefinitions = metadata.definition.requires
      .map((projectId) => definitionById(projectId))
      .filter((definition): definition is CuratedPluginDefinition => Boolean(definition))
    const missing = dependencyDefinitions.filter((definition) => !isInstalled(definition, plugins))
    const unavailableReason = metadata.unavailableReason ?? (missing.length
      ? `Install ${missing.map((definition) => definition.name).join(' and ')} first.`
      : null)
    return {
      projectId: metadata.definition.projectId,
      slug: metadata.definition.slug,
      name: metadata.definition.name,
      description: metadata.description,
      category: metadata.definition.category,
      author: metadata.definition.author,
      iconUrl: metadata.iconUrl,
      downloads: metadata.downloads,
      license: metadata.license,
      sourceUrl: `https://modrinth.com/plugin/${metadata.definition.slug}`,
      minecraftVersion,
      compatible: metadata.download !== null && unavailableReason === null,
      installed: isInstalled(metadata.definition, plugins),
      latestVersion: metadata.download?.versionNumber ?? null,
      version: metadata.download ? {
        id: metadata.download.versionId,
        number: metadata.download.versionNumber,
        publishedAt: metadata.download.publishedAt,
        fileName: metadata.download.fileName,
        sizeBytes: metadata.download.size
      } : null,
      requiredProjectIds: [...metadata.definition.requires],
      requirements: dependencyDefinitions.map((definition) => definition.name),
      unavailableReason
    }
  }

  private async catalogMetadata(minecraftVersion: string): Promise<CatalogMetadata[]> {
    const cached = this.cache.get(minecraftVersion)
    if (cached && cached.expiresAt > this.dependencies.now()) return cached.metadata
    const metadata = await this.fetchCatalogMetadata(minecraftVersion, [...CURATED_PAPER_PLUGINS])
    this.cache.set(minecraftVersion, { expiresAt: this.dependencies.now() + CACHE_TTL_MS, metadata })
    return metadata
  }

  private async fetchCatalogMetadata(
    minecraftVersion: string,
    definitions: CuratedPluginDefinition[]
  ): Promise<CatalogMetadata[]> {
    const projectsUrl = new URL('/v2/projects', MODRINTH_API_ORIGIN)
    projectsUrl.searchParams.set('ids', JSON.stringify(definitions.map((definition) => definition.projectId)))
    const projects = await this.fetchParsed(projectsUrl, projectsSchema)
    const projectMap = new Map(projects.map((project) => [project.id, project]))
    if (projectMap.size !== definitions.length || projects.length !== definitions.length) {
      throw new AppError('Modrinth omitted or duplicated a curated project.', 'INVALID_CATALOG_METADATA')
    }

    return Promise.all(definitions.map(async (definition): Promise<CatalogMetadata> => {
      const project = projectMap.get(definition.projectId)
      if (
        !project ||
        project.slug !== definition.slug ||
        project.title !== definition.name ||
        project.status !== 'approved' ||
        project.server_side === 'unsupported' ||
        !project.loaders.includes('paper')
      ) {
        throw new AppError(`Modrinth returned unexpected metadata for ${definition.name}.`, 'INVALID_CATALOG_METADATA')
      }

      const versionsUrl = new URL(`/v2/project/${definition.projectId}/version`, MODRINTH_API_ORIGIN)
      versionsUrl.searchParams.set('loaders', JSON.stringify(['paper']))
      versionsUrl.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
      versionsUrl.searchParams.set('include_changelog', 'false')
      const versions = await this.fetchParsed(versionsUrl, versionsSchema)
      const selected = versions
        .filter((version) =>
          version.project_id === definition.projectId &&
          version.version_type === 'release' &&
          version.status === 'listed' &&
          version.loaders.includes('paper') &&
          version.game_versions.includes(minecraftVersion) &&
          Number.isFinite(Date.parse(version.date_published))
        )
        .sort((left, right) => Date.parse(right.date_published) - Date.parse(left.date_published))[0]

      let download: CatalogDownload | null = null
      let unavailableReason: string | null = null
      if (!selected) {
        unavailableReason = `No stable Paper release supports Minecraft ${minecraftVersion}.`
      } else {
        const required = selected.dependencies.filter((dependency) => dependency.dependency_type === 'required')
        const incompatible = selected.dependencies.filter((dependency) => dependency.dependency_type === 'incompatible')
        const requiredIds = required.map((dependency) => dependency.project_id).filter((id): id is string => Boolean(id)).sort()
        const expectedIds = [...definition.requires].sort()
        const dependencyMetadataSafe = required.every((dependency) =>
          dependency.project_id !== null && dependency.version_id === null && dependency.file_name === null
        ) && requiredIds.length === required.length && JSON.stringify(requiredIds) === JSON.stringify(expectedIds)
        if (!dependencyMetadataSafe || incompatible.length) {
          unavailableReason = 'This release has dependencies or conflicts EmberHost cannot safely resolve.'
        } else {
          const primaryFiles = selected.files.filter((file) => file.primary)
          const file = primaryFiles[0]
          if (primaryFiles.length !== 1 || !file || file.file_type !== null) {
            unavailableReason = 'Modrinth did not identify one unambiguous primary plugin JAR.'
          } else {
            assertPluginFilename(file.filename)
            assertCdnUrl(file.url, definition.projectId, selected.id, file.filename)
            download = {
              projectId: definition.projectId,
              versionId: selected.id,
              versionNumber: selected.version_number,
              publishedAt: selected.date_published,
              fileName: file.filename,
              size: file.size,
              sha512: file.hashes.sha512.toLowerCase(),
              url: file.url
            }
          }
        }
      }

      return {
        definition,
        description: project.description,
        iconUrl: trustedIcon(project.icon_url, definition.projectId),
        downloads: project.downloads,
        license: project.license.id,
        download,
        unavailableReason
      }
    }))
  }

  private async fetchParsed<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    try {
      response = await this.dependencies.fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
      })
    } catch (error) {
      throw new AppError(
        'Could not reach the Modrinth plugin catalog. Check your connection and retry.',
        'CATALOG_LOOKUP_FAILED',
        error instanceof Error ? error.message : undefined
      )
    }
    if (!response.ok) {
      throw new AppError(`Modrinth returned HTTP ${response.status}.`, 'CATALOG_LOOKUP_FAILED')
    }
    assertExactApiUrl(response.url, url)
    const parsed = schema.safeParse(await readBoundedJson(response))
    if (!parsed.success) throw new AppError('Modrinth returned invalid catalog metadata.', 'INVALID_CATALOG_METADATA')
    return parsed.data
  }

  private async download(download: CatalogDownload, destination: string): Promise<void> {
    assertPluginFilename(download.fileName)
    assertCdnUrl(download.url, download.projectId, download.versionId, download.fileName)
    let response: Response
    try {
      response = await this.dependencies.fetch(download.url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
    } catch (error) {
      throw new AppError(
        'The catalog plugin download could not be started. Check your connection and retry.',
        'CATALOG_DOWNLOAD_FAILED',
        error instanceof Error ? error.message : undefined
      )
    }
    if (!response.ok || !response.body) {
      throw new AppError(`The catalog plugin download returned HTTP ${response.status}.`, 'CATALOG_DOWNLOAD_FAILED')
    }
    assertCdnUrl(response.url, download.projectId, download.versionId, download.fileName)
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) !== download.size)) {
      throw new AppError('The catalog download size did not match signed metadata.', 'CATALOG_CHECKSUM_FAILED')
    }

    const partial = `${destination}.${randomUUID()}.part`
    const file = await open(partial, 'wx')
    const reader = response.body.getReader()
    const hash = createHash('sha512')
    let received = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (received + value.byteLength > download.size) {
          await reader.cancel().catch(() => undefined)
          throw new AppError('The catalog download exceeded signed metadata size.', 'CATALOG_CHECKSUM_FAILED')
        }
        let written = 0
        while (written < value.byteLength) {
          const result = await file.write(value, written, value.byteLength - written)
          if (result.bytesWritten < 1) throw new Error('Plugin download write made no progress.')
          written += result.bytesWritten
        }
        hash.update(value)
        received += value.byteLength
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        'The catalog plugin download was interrupted. Try again.',
        'CATALOG_DOWNLOAD_FAILED',
        error instanceof Error ? error.message : undefined
      )
    } finally {
      await file.close()
    }

    if (received !== download.size || hash.digest('hex') !== download.sha512) {
      await rm(partial, { force: true })
      throw new AppError('The catalog plugin failed its size or SHA-512 verification.', 'CATALOG_CHECKSUM_FAILED')
    }
    try {
      await rename(partial, destination)
    } finally {
      await rm(partial, { force: true })
    }
  }
}
