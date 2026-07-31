import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogPluginPageUrl,
  CURATED_PAPER_PLUGINS,
  PluginCatalogService
} from '../src/main/services/plugin-catalog'
import type { PluginService } from '../src/main/services/plugin-service'
import { AppStore } from '../src/main/services/store'
import type { PaperPluginInfo, ServerInstance } from '../src/shared/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeManager {
  active = false
  runExclusive<T>(_instanceId: string, operation: () => Promise<T>): Promise<T> { return operation() }
  isActive(): boolean { return this.active }
}

class FakePluginService {
  plugins: PaperPluginInfo[] = []
  installedBytes: Buffer | null = null
  installedPath: string | null = null
  readonly list = vi.fn(async () => this.plugins.map((plugin) => ({ ...plugin })))
  readonly listWithinExclusive = this.list
  readonly installFromPath = vi.fn(async (_instanceId: string, sourcePath: string) => {
    this.installedPath = sourcePath
    this.installedBytes = await readFile(sourcePath)
    const plugin: PaperPluginInfo = {
      fileName: basename(sourcePath),
      name: basename(sourcePath).replace(/[- ]?1\.0\.0\.jar$/i, ''),
      version: '1.0.0',
      sizeBytes: this.installedBytes.length,
      installedAt: new Date().toISOString(),
      managed: true,
      builtIn: false
    }
    this.plugins.push(plugin)
    return this.plugins.map((item) => ({ ...item }))
  })
  readonly installFromPathWithinExclusive = this.installFromPath
}

function response(url: string, body: unknown, status = 200): Response {
  const value = body instanceof Uint8Array
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(value, 'url', { value: url })
  return value
}

function project(definition: typeof CURATED_PAPER_PLUGINS[number]): unknown {
  return {
    id: definition.projectId,
    slug: definition.slug,
    title: definition.name,
    description: `${definition.name} fixture description`,
    status: 'approved',
    server_side: 'required',
    downloads: 123_456,
    icon_url: `https://cdn.modrinth.com/data/${definition.projectId}/icon.png`,
    license: { id: 'MIT' },
    loaders: ['paper']
  }
}

function version(
  definition: typeof CURATED_PAPER_PLUGINS[number],
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const index = CURATED_PAPER_PLUGINS.findIndex((item) => item.projectId === definition.projectId) + 1
  const versionId = `V${String(index).padStart(7, '0')}`
  const fileName = `${definition.slug}-1.0.0.jar`
  return {
    id: versionId,
    project_id: definition.projectId,
    version_number: '1.0.0',
    version_type: 'release',
    status: 'listed',
    date_published: '2026-07-31T12:00:00.000Z',
    game_versions: ['26.2'],
    loaders: ['paper'],
    dependencies: definition.requires.map((projectId) => ({
      version_id: null,
      project_id: projectId,
      file_name: null,
      dependency_type: 'required'
    })),
    files: [{
      hashes: { sha512: createHash('sha512').update(bytes).digest('hex') },
      url: `https://cdn.modrinth.com/data/${definition.projectId}/versions/${versionId}/${fileName}`,
      filename: fileName,
      primary: true,
      size: bytes.byteLength,
      file_type: null
    }],
    ...overrides
  }
}

function installedPlugin(name: string): PaperPluginInfo {
  return {
    fileName: `${name}-1.0.0.jar`,
    name,
    version: '1.0.0',
    sizeBytes: 100,
    installedAt: new Date().toISOString(),
    managed: true,
    builtIn: false
  }
}

async function harness(kind: 'paper' | 'vanilla' = 'paper'): Promise<{
  directory: string
  instance: ServerInstance
  manager: FakeManager
  plugins: FakePluginService
  service: PluginCatalogService
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-catalog-'))
  temporaryDirectories.push(directory)
  const store = new AppStore(join(directory, 'data'))
  await store.load()
  const now = new Date().toISOString()
  const instance: ServerInstance = {
    id: randomUUID(),
    name: 'Catalog test',
    version: '26.2',
    serverDirectory: join(directory, 'server'),
    software: kind === 'paper' ? { kind: 'paper', build: 87, channel: 'STABLE' } : { kind: 'vanilla' },
    launchArtifact: kind === 'paper' ? 'paper.jar' : 'server.jar',
    jarSha1: kind === 'paper' ? null : '0'.repeat(40),
    artifactSha256: kind === 'paper' ? 'a'.repeat(64) : null,
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25565,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Catalog tests',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 12,
    simulationDistance: 8,
    performancePreset: kind === 'paper' ? 'balanced' : 'custom',
    eulaAcceptedAt: now,
    createdAt: now,
    updatedAt: now
  }
  await store.addInstance(instance)
  const manager = new FakeManager()
  const plugins = new FakePluginService()
  const service = new PluginCatalogService(
    store,
    manager,
    plugins as unknown as PluginService,
    join(directory, 'catalog-cache')
  )
  return { directory, instance, manager, plugins, service }
}

function catalogFetch(bytes: Uint8Array, transformVersion?: (
  definition: typeof CURATED_PAPER_PLUGINS[number],
  value: Record<string, unknown>
) => Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(request))
    if (url.pathname === '/v2/projects') {
      const ids = JSON.parse(url.searchParams.get('ids') ?? '[]') as string[]
      return response(url.href, ids.map((id) => project(CURATED_PAPER_PLUGINS.find((item) => item.projectId === id)!)))
    }
    const match = url.pathname.match(/^\/v2\/project\/([A-Za-z0-9]{8})\/version$/)
    if (match?.[1]) {
      const definition = CURATED_PAPER_PLUGINS.find((item) => item.projectId === match[1])!
      const value = version(definition, bytes)
      return response(url.href, [transformVersion ? transformVersion(definition, value) : value])
    }
    if (url.hostname === 'cdn.modrinth.com') return response(url.href, bytes)
    throw new Error(`Unexpected request: ${url.href}; ${String(options)}`)
  })
}

describe('PluginCatalogService', () => {
  it('constructs project pages only for fixed curated IDs', () => {
    expect(catalogPluginPageUrl('Vebnzrzj')).toBe('https://modrinth.com/plugin/luckperms')
    expect(() => catalogPluginPageUrl('fALzjamp')).toThrow(expect.objectContaining({
      code: 'CATALOG_PLUGIN_NOT_ALLOWED'
    }))
  })

  it('lists the exact allowlist, release compatibility, provenance, dependencies, and caches metadata', async () => {
    const { instance, plugins, service } = await harness()
    plugins.plugins.push(installedPlugin('WorldEdit'))
    const bytes = new TextEncoder().encode('catalog plugin fixture')
    const mockedFetch = catalogFetch(bytes)
    vi.stubGlobal('fetch', mockedFetch)
    const freshService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(instance.serverDirectory, 'cache'),
      { fetch: mockedFetch as typeof fetch }
    )

    const catalog = await freshService.list(instance.id)

    expect(catalog).toHaveLength(CURATED_PAPER_PLUGINS.length)
    expect(catalog.find((item) => item.projectId === '1u6JkXh5')).toMatchObject({ installed: true })
    expect(catalog.find((item) => item.projectId === 'DKY9btbd')).toMatchObject({
      compatible: true,
      requirements: ['WorldEdit'],
      latestVersion: '1.0.0'
    })
    expect(catalog.find((item) => item.projectId === 'NpvuJQoq')).toMatchObject({
      compatible: false,
      requirements: ['ViaVersion'],
      unavailableReason: 'Install ViaVersion first.'
    })
    expect(catalog[0]).toMatchObject({ downloads: 123_456, license: 'MIT', minecraftVersion: '26.2' })
    expect(mockedFetch).toHaveBeenCalledTimes(1 + CURATED_PAPER_PLUGINS.length)
    for (const [request, options] of mockedFetch.mock.calls as Array<[URL, RequestInit]>) {
      const url = new URL(String(request))
      expect(options.redirect).toBe('error')
      expect(new Headers(options.headers).get('user-agent')).toMatch(/MrHacker061\/EmberHost/)
      if (url.pathname.endsWith('/version')) {
        expect(JSON.parse(url.searchParams.get('loaders') ?? 'null')).toEqual(['paper'])
        expect(JSON.parse(url.searchParams.get('game_versions') ?? 'null')).toEqual(['26.2'])
      }
    }

    await freshService.list(instance.id)
    expect(mockedFetch).toHaveBeenCalledTimes(1 + CURATED_PAPER_PLUGINS.length)
  })

  it('downloads the chosen allowlisted release with SHA-512 before handing it to the atomic installer', async () => {
    const { directory, instance, plugins, service } = await harness()
    const bytes = new TextEncoder().encode('verified catalog plugin bytes')
    const mockedFetch = catalogFetch(bytes)
    vi.stubGlobal('fetch', mockedFetch)
    const freshService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'catalog-cache'),
      { fetch: mockedFetch as typeof fetch }
    )

    const result = await freshService.install(instance.id, 'Vebnzrzj')

    expect(result).toHaveLength(1)
    expect(plugins.installedBytes).toEqual(Buffer.from(bytes))
    expect(plugins.installFromPath).toHaveBeenCalledOnce()
    expect(plugins.installedPath).toMatch(/luckperms-1\.0\.0\.jar$/)
    await expect(access(plugins.installedPath!)).rejects.toThrow()
  })

  it('does not report a committed catalog install as failed when cache cleanup is locked', async () => {
    const { directory, instance, plugins, service } = await harness()
    const bytes = new TextEncoder().encode('verified plugin with locked cache cleanup')
    const mockedFetch = catalogFetch(bytes)
    const cleanupTemporaryDirectory = vi.fn(async () => {
      throw new Error('simulated antivirus lock')
    })
    const freshService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'catalog-cache'),
      {
        fetch: mockedFetch as typeof fetch,
        cleanupTemporaryDirectory
      }
    )

    await expect(freshService.install(instance.id, 'Vebnzrzj')).resolves.toEqual([
      expect.objectContaining({ name: 'luckperms', managed: true })
    ])
    expect(cleanupTemporaryDirectory).toHaveBeenCalledOnce()
    expect(plugins.installedBytes).toEqual(Buffer.from(bytes))
  })

  it('rejects prereleases and versions without exact Paper and Minecraft compatibility', async () => {
    const { directory, instance, plugins, service } = await harness()
    const bytes = new TextEncoder().encode('beta bytes')
    const mockedFetch = catalogFetch(bytes, (_definition, value) => ({
      ...value,
      version_type: 'beta',
      loaders: ['paper'],
      game_versions: ['26.2']
    }))
    const freshService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'cache'),
      { fetch: mockedFetch as typeof fetch }
    )

    await expect(freshService.install(instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'CATALOG_PLUGIN_UNAVAILABLE'
    })
    expect(plugins.installFromPath).not.toHaveBeenCalled()
  })

  it('requires curated hard dependencies and rejects unexpected dependency metadata', async () => {
    const { directory, instance, plugins, service } = await harness()
    const bytes = new TextEncoder().encode('dependency fixture')
    const normalFetch = catalogFetch(bytes)
    const normalService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'normal-cache'),
      { fetch: normalFetch as typeof fetch }
    )
    await expect(normalService.install(instance.id, 'NpvuJQoq')).rejects.toMatchObject({
      code: 'CATALOG_DEPENDENCY_REQUIRED'
    })

    const unsafeFetch = catalogFetch(bytes, (definition, value) => definition.projectId === 'Vebnzrzj'
      ? { ...value, dependencies: [{ version_id: null, project_id: '1u6JkXh5', file_name: null, dependency_type: 'required' }] }
      : value)
    const unsafeService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'unsafe-cache'),
      { fetch: unsafeFetch as typeof fetch }
    )
    await expect(unsafeService.install(instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'CATALOG_PLUGIN_UNAVAILABLE'
    })
  })

  it('rejects untrusted CDN paths and checksum mismatches without invoking the installer', async () => {
    const { directory, instance, plugins, service } = await harness()
    const bytes = new TextEncoder().encode('download fixture')
    const untrustedFetch = catalogFetch(bytes, (definition, value) => {
      if (definition.projectId !== 'Vebnzrzj') return value
      const files = structuredClone(value.files) as Array<Record<string, unknown>>
      files[0]!.url = 'https://cdn.modrinth.com/data/other123/versions/V0000001/plugin.jar'
      return { ...value, files }
    })
    const untrustedService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'untrusted-cache'),
      { fetch: untrustedFetch as typeof fetch }
    )
    await expect(untrustedService.install(instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'UNTRUSTED_CATALOG_DOWNLOAD'
    })

    const checksumFetch = catalogFetch(bytes, (definition, value) => {
      if (definition.projectId !== 'Vebnzrzj') return value
      const files = structuredClone(value.files) as Array<Record<string, unknown>>
      files[0]!.hashes = { sha512: '0'.repeat(128) }
      return { ...value, files }
    })
    const checksumService = new PluginCatalogService(
      (service as unknown as { store: AppStore }).store,
      (service as unknown as { manager: FakeManager }).manager,
      plugins as unknown as PluginService,
      join(directory, 'checksum-cache'),
      { fetch: checksumFetch as typeof fetch }
    )
    await expect(checksumService.install(instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'CATALOG_CHECKSUM_FAILED'
    })
    expect(plugins.installFromPath).not.toHaveBeenCalled()
    expect(await readdir(join(directory, 'checksum-cache'))).toEqual([])
  })

  it('rejects non-curated IDs, active servers, Vanilla servers, and duplicate plugins before downloading', async () => {
    const paper = await harness()
    const mockedFetch = vi.fn()
    const paperService = new PluginCatalogService(
      (paper.service as unknown as { store: AppStore }).store,
      paper.manager,
      paper.plugins as unknown as PluginService,
      join(paper.directory, 'cache'),
      { fetch: mockedFetch as typeof fetch }
    )
    await expect(paperService.install(paper.instance.id, 'fALzjamp')).rejects.toMatchObject({
      code: 'CATALOG_PLUGIN_NOT_ALLOWED'
    })
    paper.manager.active = true
    await expect(paperService.install(paper.instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'SERVER_MUST_BE_STOPPED'
    })
    paper.manager.active = false
    paper.plugins.plugins.push(installedPlugin('LuckPerms'))
    await expect(paperService.install(paper.instance.id, 'Vebnzrzj')).rejects.toMatchObject({
      code: 'CATALOG_PLUGIN_ALREADY_INSTALLED'
    })

    const vanilla = await harness('vanilla')
    const vanillaService = new PluginCatalogService(
      (vanilla.service as unknown as { store: AppStore }).store,
      vanilla.manager,
      vanilla.plugins as unknown as PluginService,
      join(vanilla.directory, 'cache'),
      { fetch: mockedFetch as typeof fetch }
    )
    await expect(vanillaService.install(vanilla.instance.id, 'Vebnzrzj')).rejects.toMatchObject({ code: 'PAPER_REQUIRED' })
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})
