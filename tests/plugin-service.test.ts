import { randomUUID } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginService, pluginLimits } from '../src/main/services/plugin-service'
import { AppStore } from '../src/main/services/store'
import type { ServerInstance } from '../src/shared/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeManager {
  active = false

  runExclusive<T>(_instanceId: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  }

  isActive(): boolean {
    return this.active
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function writeStoredJar(
  filePath: string,
  descriptor = 'name: TestPlugin\nversion: "1.2.3"\nmain: test.Plugin\n',
  entryName = 'plugin.yml',
  compression: 0 | 8 = 8
): Promise<void> {
  const name = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(descriptor, 'utf8')
  const archivedData = compression === 8 ? deflateRawSync(data) : data
  const checksum = crc32(data)
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(compression, 8)
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(archivedData.length, 18)
  localHeader.writeUInt32LE(data.length, 22)
  localHeader.writeUInt16LE(name.length, 26)

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(compression, 10)
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(archivedData.length, 20)
  centralHeader.writeUInt32LE(data.length, 24)
  centralHeader.writeUInt16LE(name.length, 28)
  centralHeader.writeUInt32LE(0, 42)

  const centralDirectoryOffset = localHeader.length + name.length + archivedData.length
  const centralDirectorySize = centralHeader.length + name.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralDirectorySize, 12)
  end.writeUInt32LE(centralDirectoryOffset, 16)
  await writeFile(filePath, Buffer.concat([localHeader, name, archivedData, centralHeader, name, end]))
}

function instance(serverDirectory: string, kind: 'paper' | 'vanilla' = 'paper'): ServerInstance {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    name: `${kind} test`,
    version: '26.2',
    serverDirectory,
    software: kind === 'paper' ? { kind: 'paper', build: 87, channel: 'STABLE' } : { kind: 'vanilla' },
    launch: { kind: 'jar', path: kind === 'paper' ? 'paper.jar' : 'server.jar' },
    jarSha1: kind === 'paper' ? null : '0'.repeat(40),
    artifactSha256: kind === 'paper' ? 'a'.repeat(64) : null,
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: kind === 'paper' ? 25565 : 25566,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Plugin tests',
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
}

async function harness(
  kind: 'paper' | 'vanilla' = 'paper',
  cleanupTemporaryFile?: (filePath: string) => Promise<void>
): Promise<{
  directory: string
  server: ServerInstance
  manager: FakeManager
  service: PluginService
  trashed: string[]
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-plugins-'))
  temporaryDirectories.push(directory)
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  const server = instance(join(directory, 'server'), kind)
  await mkdir(server.serverDirectory, { recursive: true })
  await store.addInstance(server)
  const manager = new FakeManager()
  const trashDirectory = join(directory, 'trash')
  const trashed: string[] = []
  const service = new PluginService(
    store,
    manager,
    async (filePath) => {
      await mkdir(trashDirectory, { recursive: true })
      const destination = join(trashDirectory, `${trashed.length}-${filePath.split(/[\\/]/).at(-1)}`)
      await rename(filePath, destination)
      trashed.push(destination)
    },
    cleanupTemporaryFile
  )
  return { directory, server, manager, service, trashed }
}

describe('PluginService', () => {
  it('validates and atomically installs a Paper plugin with managed metadata', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'TestPlugin-1.2.3.jar')
    await writeStoredJar(source)

    const plugins = await service.installFromPath(server.id, source)

    expect(plugins).toEqual([expect.objectContaining({
      fileName: 'TestPlugin-1.2.3.jar',
      name: 'TestPlugin',
      version: '1.2.3',
      managed: true,
      builtIn: false
    })])
    expect(plugins[0]?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await readFile(join(server.serverDirectory, 'plugins', 'TestPlugin-1.2.3.jar')))
      .toEqual(await readFile(source))
    const manifest = await readFile(join(server.serverDirectory, 'plugins', '.emberhost-plugins.json'), 'utf8')
    expect(manifest).toContain('TestPlugin-1.2.3.jar')
    expect(manifest).toMatch(/[a-f0-9]{64}/)
  })

  it('does not report a committed install as failed when staging cleanup is locked', async () => {
    const cleanupTemporaryFile = vi.fn(async () => {
      throw new Error('simulated antivirus lock')
    })
    const { directory, server, service } = await harness('paper', cleanupTemporaryFile)
    const source = join(directory, 'LockedCleanupPlugin.jar')
    await writeStoredJar(source)

    await expect(service.installFromPath(server.id, source)).resolves.toEqual([
      expect.objectContaining({ fileName: 'LockedCleanupPlugin.jar', managed: true })
    ])
    expect(cleanupTemporaryFile).toHaveBeenCalledOnce()
    await expect(access(join(server.serverDirectory, 'plugins', 'LockedCleanupPlugin.jar'))).resolves.toBeUndefined()
  })

  it('records validated catalog provenance without trusting renderer-supplied paths', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)

    const plugins = await service.installFromPath(server.id, source, {
      projectId: 'Vebnzrzj',
      versionId: 'MBSY8toc'
    })

    expect(plugins).toEqual([expect.objectContaining({
      catalogProjectId: 'Vebnzrzj',
      catalogVersionId: 'MBSY8toc'
    })])
    const manifest = await readFile(join(server.serverDirectory, 'plugins', '.emberhost-plugins.json'), 'utf8')
    expect(manifest).toContain('"catalogProjectId": "Vebnzrzj"')
    expect(manifest).toContain('"catalogVersionId": "MBSY8toc"')
  })

  it('rejects malformed catalog provenance before copying the plugin', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)

    await expect(service.installFromPath(server.id, source, {
      projectId: '../escape',
      versionId: 'MBSY8toc'
    })).rejects.toMatchObject({ code: 'INVALID_CATALOG_PROVENANCE' })
    await expect(readdir(join(server.serverDirectory, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-JAR data and archives without a Paper plugin descriptor', async () => {
    const { directory, server, service } = await harness()
    const plainFile = join(directory, 'Plain.jar')
    const descriptorlessJar = join(directory, 'Library.jar')
    await writeFile(plainFile, 'not a zip')
    await writeStoredJar(descriptorlessJar, 'nothing to see', 'README.txt')

    await expect(service.installFromPath(server.id, plainFile)).rejects.toMatchObject({ code: 'INVALID_PLUGIN_JAR' })
    await expect(service.installFromPath(server.id, descriptorlessJar)).rejects.toMatchObject({ code: 'INVALID_PLUGIN_JAR' })
  })

  it('enforces the plugin size cap before reading archive contents', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'Huge.jar')
    await writeFile(source, '')
    await truncate(source, pluginLimits.maxPluginBytes + 1)

    await expect(service.installFromPath(server.id, source)).rejects.toMatchObject({ code: 'PLUGIN_TOO_LARGE' })
  })

  it('requires a safe JAR filename and never silently replaces a collision', async () => {
    const { directory, server, service } = await harness()
    const wrongExtension = join(directory, 'TestPlugin.zip')
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(wrongExtension)
    await writeStoredJar(source)
    await expect(service.installFromPath(server.id, wrongExtension)).rejects.toMatchObject({
      code: 'INVALID_PLUGIN_FILENAME'
    })

    await service.installFromPath(server.id, source)
    const installedBefore = await readFile(join(server.serverDirectory, 'plugins', 'TestPlugin.jar'))
    await expect(service.installFromPath(server.id, source)).rejects.toMatchObject({ code: 'PLUGIN_ALREADY_EXISTS' })
    expect(await readFile(join(server.serverDirectory, 'plugins', 'TestPlugin.jar'))).toEqual(installedBefore)
  })

  it('only mutates stopped Paper servers', async () => {
    const paper = await harness()
    const paperSource = join(paper.directory, 'TestPlugin.jar')
    await writeStoredJar(paperSource)
    paper.manager.active = true
    await expect(paper.service.installFromPath(paper.server.id, paperSource)).rejects.toMatchObject({
      code: 'SERVER_MUST_BE_STOPPED'
    })

    const vanilla = await harness('vanilla')
    const vanillaSource = join(vanilla.directory, 'TestPlugin.jar')
    await writeStoredJar(vanillaSource)
    await expect(vanilla.service.installFromPath(vanilla.server.id, vanillaSource)).rejects.toMatchObject({
      code: 'PAPER_REQUIRED'
    })
  })

  it('refuses to recreate plugins when the registered server folder is missing', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)
    await rm(server.serverDirectory, { recursive: true })

    await expect(service.installFromPath(server.id, source)).rejects.toMatchObject({
      code: 'SERVER_DIRECTORY_MISSING'
    })
  })

  it('refuses a plugins directory that redirects through a symlink or junction', async () => {
    const { directory, server, service, trashed } = await harness()
    const outside = join(directory, 'outside-plugins')
    await mkdir(outside)
    await writeStoredJar(join(outside, 'Outside.jar'))
    await symlink(outside, join(server.serverDirectory, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(service.list(server.id)).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_DIRECTORY' })
    await expect(service.remove(server.id, 'Outside.jar')).rejects.toMatchObject({ code: 'UNSAFE_PLUGIN_DIRECTORY' })
    expect(trashed).toEqual([])
  })

  it('moves removable plugins through the injected Trash operation and protects Chunky', async () => {
    const { directory, server, service, trashed } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)
    await service.installFromPath(server.id, source)
    await writeFile(join(server.serverDirectory, 'plugins', 'Chunky.jar'), 'built in')

    const before = await service.list(server.id)
    expect(before.find((plugin) => plugin.fileName === 'Chunky.jar')).toMatchObject({
      name: 'Chunky',
      managed: true,
      builtIn: true
    })
    await expect(service.remove(server.id, 'Chunky.jar')).rejects.toMatchObject({ code: 'BUILT_IN_PLUGIN' })

    const after = await service.remove(server.id, 'TestPlugin.jar')
    expect(after.map((plugin) => plugin.fileName)).toEqual(['Chunky.jar'])
    expect(trashed).toHaveLength(1)
    expect(await readFile(trashed[0]!)).toEqual(await readFile(source))
  })

  it('does not claim an externally replaced managed JAR is still managed', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)
    await service.installFromPath(server.id, source)
    await writeFile(join(server.serverDirectory, 'plugins', 'TestPlugin.jar'), 'externally replaced')

    await expect(service.list(server.id)).resolves.toEqual([
      expect.objectContaining({ fileName: 'TestPlugin.jar', managed: false, name: null, version: null })
    ])
  })

  it('restores the installed plugin if metadata persistence fails after Trash succeeds', async () => {
    const { directory, server, service, trashed } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)
    await service.installFromPath(server.id, source)
    vi.spyOn(service as unknown as { writeManifest: () => Promise<void> }, 'writeManifest')
      .mockRejectedValueOnce(new Error('disk full'))

    await expect(service.remove(server.id, 'TestPlugin.jar')).rejects.toMatchObject({
      code: 'PLUGIN_REMOVE_ROLLED_BACK'
    })
    await expect(service.list(server.id)).resolves.toEqual([
      expect.objectContaining({ fileName: 'TestPlugin.jar', managed: true })
    ])
    expect(trashed).toHaveLength(1)
    expect((await readdir(join(server.serverDirectory, 'plugins')))
      .filter((fileName) => fileName.endsWith('.rollback'))).toEqual([])
  })

  it('restores the plugin when damaged metadata is discovered after the Trash operation', async () => {
    const { directory, server, service, trashed } = await harness()
    const source = join(directory, 'TestPlugin.jar')
    await writeStoredJar(source)
    await service.installFromPath(server.id, source)
    await writeFile(join(server.serverDirectory, 'plugins', '.emberhost-plugins.json'), '{ damaged')

    await expect(service.remove(server.id, 'TestPlugin.jar')).rejects.toMatchObject({
      code: 'PLUGIN_REMOVE_ROLLED_BACK'
    })
    expect(await readFile(join(server.serverDirectory, 'plugins', 'TestPlugin.jar'))).toEqual(await readFile(source))
    expect(trashed).toHaveLength(1)
  })
})
