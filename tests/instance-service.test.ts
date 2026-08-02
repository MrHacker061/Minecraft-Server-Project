import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/services/java', () => ({
  checkJava: vi.fn(async (command = 'java') => ({
    available: true,
    command,
    majorVersion: 25,
    versionText: 'java version "25"',
    error: null
  }))
}))

vi.mock('../src/main/services/minecraft', () => ({
  resolveRelease: vi.fn(async (id: string) => ({
    id,
    type: 'release',
    requiredJavaVersion: 25,
    download: {
      sha1: '0123456789012345678901234567890123456789',
      size: 8,
      url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar'
    }
  })),
  downloadServerJar: vi.fn(async (_version: unknown, destination: string) => {
    await writeFile(destination, 'fake jar', 'utf8')
  })
}))

vi.mock('../src/main/services/paper', () => ({
  resolvePaperBuild: vi.fn(async (minecraftVersion: string, build: number) => ({
    minecraftVersion,
    build,
    channel: 'STABLE',
    publishedAt: '2026-07-31T00:00:00.000Z',
    download: {
      name: `paper-${minecraftVersion}-${build}.jar`,
      sha256: 'a'.repeat(64),
      size: 14,
      url: `https://fill-data.papermc.io/v1/objects/${'a'.repeat(64)}/paper-${minecraftVersion}-${build}.jar`
    }
  })),
  downloadPaperJar: vi.fn(async (_build: unknown, destination: string) => {
    await writeFile(destination, 'fake paper jar', 'utf8')
  })
}))

vi.mock('../src/main/services/chunky', () => ({
  resolveChunkyForPaper: vi.fn(async () => ({
    id: 'chunky-version',
    version: '1.5.3',
    file: {
      name: 'Chunky-Bukkit-1.5.3.jar',
      sha512: 'b'.repeat(128),
      size: 11,
      url: 'https://cdn.modrinth.com/data/fALzjamp/versions/chunky-version/Chunky-Bukkit-1.5.3.jar'
    }
  })),
  downloadChunky: vi.fn(async (_version: unknown, destination: string) => {
    await writeFile(destination, 'fake chunky', 'utf8')
  })
}))

import type { CreateInstanceInput } from '../src/shared/contracts'
import { BACKUP_MARKER_FILE } from '../src/main/services/backup-safety'
import { downloadChunky, resolveChunkyForPaper } from '../src/main/services/chunky'
import { InstanceService } from '../src/main/services/instance-service'
import { downloadServerJar, resolveRelease } from '../src/main/services/minecraft'
import { downloadPaperJar, resolvePaperBuild } from '../src/main/services/paper'
import { ServerManager } from '../src/main/services/server-manager'
import { AppStore } from '../src/main/services/store'

const temporaryDirectories: string[] = []
const input: CreateInstanceInput = {
  name: 'Integration world',
  version: '26.2',
  memoryMb: 4096,
  port: 25565,
  maxPlayers: 20,
  motd: 'Hello from a test',
  javaPath: 'java',
  eulaAccepted: true
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(downloadServerJar).mockClear()
  vi.mocked(resolveRelease).mockClear()
  vi.mocked(downloadPaperJar).mockClear()
  vi.mocked(resolvePaperBuild).mockClear()
  vi.mocked(downloadChunky).mockClear()
  vi.mocked(resolveChunkyForPaper).mockClear()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function harness(trashItem?: (path: string) => Promise<void>): Promise<{
  directory: string
  store: AppStore
  manager: ServerManager
  service: InstanceService
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-instance-'))
  temporaryDirectories.push(directory)
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  const manager = new ServerManager(store)
  const service = new InstanceService(store, manager, join(directory, 'runtime'), trashItem)
  return { directory, store, manager, service }
}

async function createWorld(serverDirectory: string, name: string, contents = 'level data'): Promise<void> {
  await mkdir(join(serverDirectory, name), { recursive: true })
  await writeFile(join(serverDirectory, name, 'level.dat'), contents, 'utf8')
}

describe('InstanceService', () => {
  it('stages an exact release and records explicit EULA acceptance', async () => {
    const { store, service } = await harness()
    const instance = await service.create(input, () => undefined)

    expect(resolveRelease).toHaveBeenCalledWith('26.2')
    expect(await readFile(join(instance.serverDirectory, 'server.jar'), 'utf8')).toBe('fake jar')
    expect(await readFile(join(instance.serverDirectory, 'eula.txt'), 'utf8')).toContain('eula=true')
    expect(await readFile(join(instance.serverDirectory, 'server.properties'), 'utf8')).toContain('online-mode=true')
    expect(store.getInstance(instance.id)?.eulaAcceptedAt).toBeTruthy()
  })

  it('pins and stages the selected Paper build as its launch artifact', async () => {
    const { store, service } = await harness()
    const instance = await service.create({
      ...input,
      name: 'Paper world',
      software: { kind: 'paper', build: 87 }
    }, () => undefined)

    expect(resolvePaperBuild).toHaveBeenCalledWith('26.2', 87)
    expect(downloadPaperJar).toHaveBeenCalledOnce()
    expect(await readFile(join(instance.serverDirectory, 'paper.jar'), 'utf8')).toBe('fake paper jar')
    expect(await readFile(join(instance.serverDirectory, 'plugins', 'Chunky.jar'), 'utf8')).toBe('fake chunky')
    expect(instance).toMatchObject({
      software: { kind: 'paper', build: 87, channel: 'STABLE' },
      launchArtifact: 'paper.jar',
      jarSha1: null,
      artifactSha256: 'a'.repeat(64)
    })
    expect(store.getInstance(instance.id)?.software).toEqual({ kind: 'paper', build: 87, channel: 'STABLE' })
  })

  it('removes staging data and does not persist an instance after setup failure', async () => {
    const { directory, store, service } = await harness()
    vi.mocked(downloadServerJar).mockRejectedValueOnce(new Error('download failed'))

    await expect(service.create(input, () => undefined)).rejects.toThrow('download failed')
    expect(store.getInstances()).toEqual([])
    const serversRoot = join(directory, 'runtime', 'servers')
    expect(await readdir(serversRoot)).toEqual([])
  })

  it('restores server.properties when metadata persistence fails', async () => {
    const { store, service } = await harness()
    const instance = await service.create(input, () => undefined)
    const propertiesPath = join(instance.serverDirectory, 'server.properties')
    const before = await readFile(propertiesPath, 'utf8')
    vi.spyOn(store, 'updateInstance').mockRejectedValueOnce(new Error('disk full'))

    await expect(service.update({
      id: instance.id,
      name: instance.name,
      memoryMb: instance.memoryMb,
      port: instance.port,
      maxPlayers: instance.maxPlayers,
      motd: instance.motd,
      gameMode: instance.gameMode,
      difficulty: instance.difficulty,
      onlineMode: false,
      viewDistance: instance.viewDistance,
      simulationDistance: instance.simulationDistance,
      performancePreset: instance.performancePreset,
      javaPath: instance.javaPath
    })).rejects.toThrow('disk full')

    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(store.getInstance(instance.id)?.onlineMode).toBe(true)
  })

  it('regenerates all three world dimensions as one recoverable recycle-bin item', async () => {
    let trashedPath = ''
    const trashItem = vi.fn(async (path: string) => {
      trashedPath = `${path}.recycle-bin`
      await rename(path, trashedPath)
    })
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await Promise.all([
      createWorld(instance.serverDirectory, 'custom_world', 'overworld'),
      createWorld(instance.serverDirectory, 'custom_world_nether', 'nether'),
      createWorld(instance.serverDirectory, 'custom_world_the_end', 'end'),
      mkdir(join(instance.serverDirectory, 'plugins')),
      mkdir(join(instance.serverDirectory, 'emberhost-backups'))
    ])
    await Promise.all([
      writeFile(
        join(instance.serverDirectory, 'server.properties'),
        '# custom\nlevel-name=custom_world\nlevel-seed=old seed\nunknown-setting=preserve\n',
        'utf8'
      ),
      writeFile(join(instance.serverDirectory, 'emberhost-performance.json'), '{"schemaVersion":1}\n', 'utf8'),
      writeFile(join(instance.serverDirectory, 'plugins', 'Example.jar'), 'plugin', 'utf8'),
      writeFile(join(instance.serverDirectory, 'emberhost-backups', 'keep.zip'), 'backup', 'utf8')
    ])

    expect(await service.getWorldSeed(instance.id)).toEqual({ instanceId: instance.id, seed: 'old seed' })
    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: '8675309',
      confirmationName: instance.name
    })).resolves.toEqual({ instanceId: instance.id, seed: '8675309' })

    expect(trashItem).toHaveBeenCalledOnce()
    expect(await readFile(join(trashedPath, 'custom_world', 'level.dat'), 'utf8')).toBe('overworld')
    expect(await readFile(join(trashedPath, 'custom_world_nether', 'level.dat'), 'utf8')).toBe('nether')
    expect(await readFile(join(trashedPath, 'custom_world_the_end', 'level.dat'), 'utf8')).toBe('end')
    expect(await readFile(join(trashedPath, 'emberhost-performance.json'), 'utf8')).toContain('schemaVersion')
    const properties = await readFile(join(instance.serverDirectory, 'server.properties'), 'utf8')
    expect(properties).toContain('level-seed=8675309')
    expect(properties).toContain('unknown-setting=preserve')
    expect(await readFile(join(instance.serverDirectory, 'plugins', 'Example.jar'), 'utf8')).toBe('plugin')
    expect(await readFile(join(instance.serverDirectory, 'emberhost-backups', 'keep.zip'), 'utf8')).toBe('backup')
  })

  it('fully restores world folders, performance metadata, and properties when recycling fails', async () => {
    const trashItem = vi.fn(async () => { throw new Error('recycle bin unavailable') })
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await createWorld(instance.serverDirectory, 'world', 'original world')
    const propertiesPath = join(instance.serverDirectory, 'server.properties')
    const before = '# preserved exactly\nlevel-seed=before\ncustom=yes\n'
    await writeFile(propertiesPath, before, 'utf8')
    await writeFile(join(instance.serverDirectory, 'emberhost-performance.json'), 'performance', 'utf8')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'after',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'WORLD_REGENERATION_FAILED' })

    expect(trashItem).toHaveBeenCalledOnce()
    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(await readFile(join(instance.serverDirectory, 'world', 'level.dat'), 'utf8')).toBe('original world')
    expect(await readFile(join(instance.serverDirectory, 'emberhost-performance.json'), 'utf8')).toBe('performance')
  })

  it('keeps quarantined recovery data when restoring a moved world fails', async () => {
    let quarantineDirectory = ''
    const trashItem = vi.fn(async (path: string) => {
      quarantineDirectory = path
      const match = /^\.([0-9a-f-]+)\.world-regeneration-/i.exec(basename(path))
      if (!match) throw new Error('Unexpected quarantine path.')
      const blockedRestore = join(dirname(path), match[1]!, 'world')
      await mkdir(blockedRestore)
      await writeFile(join(blockedRestore, 'restore-blocker'), 'keep quarantine', 'utf8')
      throw new Error('recycle bin unavailable')
    })
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await createWorld(instance.serverDirectory, 'world', 'only recoverable copy')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'after',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'WORLD_REGENERATION_ROLLBACK_FAILED' })

    expect(await readFile(join(quarantineDirectory, 'world', 'level.dat'), 'utf8')).toBe('only recoverable copy')
  })

  it('refuses to regenerate again while interrupted recovery data exists', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await mkdir(join(dirname(instance.serverDirectory), `.${instance.id}.world-regeneration-interrupted`))

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'WORLD_REGENERATION_RECOVERY_REQUIRED' })
    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'WORLD_REGENERATION_RECOVERY_REQUIRED' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('preserves the instance when an interrupted automatic backup blocks regeneration and deletion', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await createWorld(instance.serverDirectory, 'world')
    await writeFile(join(instance.serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: instance.id,
      stagingName: '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8',
      restartAfter: false,
      createdAt: '2026-07-31T00:00:00.000Z'
    })}\n`, 'utf8')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new-seed',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'BACKUP_RECOVERY_REQUIRED' })
    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'BACKUP_RECOVERY_REQUIRED' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(join(instance.serverDirectory, 'world', 'level.dat'))).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('updates the seed even when no generated world exists yet', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await rm(join(instance.serverDirectory, 'server.properties'))

    await service.regenerateWorld({ instanceId: instance.id, seed: '', confirmationName: instance.name })

    expect(await service.getWorldSeed(instance.id)).toEqual({ instanceId: instance.id, seed: '' })
    const properties = await readFile(join(instance.serverDirectory, 'server.properties'), 'utf8')
    expect(properties).toContain('level-seed=\n')
    expect(properties).toContain('server-port=25565')
    expect(properties).toContain('online-mode=true')
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses a world candidate without a normal level.dat before changing the seed', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await mkdir(join(instance.serverDirectory, 'world'))
    const propertiesPath = join(instance.serverDirectory, 'server.properties')
    const before = await readFile(propertiesPath, 'utf8')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new seed',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'UNSAFE_WORLD_DIRECTORY' })

    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses a world directory symlink or junction before changing the seed', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { directory, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    const externalWorld = join(directory, 'external-world-data')
    await createWorld(directory, 'external-world-data', 'external')
    await symlink(externalWorld, join(instance.serverDirectory, 'world'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new seed',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'UNSAFE_WORLD_DIRECTORY' })

    expect(await readFile(join(externalWorld, 'level.dat'), 'utf8')).toBe('external')
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses a reserved custom level-name that could target server infrastructure', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await createWorld(instance.serverDirectory, 'plugins', 'not a disposable world')
    const propertiesPath = join(instance.serverDirectory, 'server.properties')
    const before = 'level-name=plugins\nlevel-seed=old\n'
    await writeFile(propertiesPath, before, 'utf8')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'INVALID_LEVEL_NAME' })

    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(await readFile(join(instance.serverDirectory, 'plugins', 'level.dat'), 'utf8')).toBe('not a disposable world')
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('requires exact name confirmation and a stopped, unowned server for regeneration', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { manager, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name.toLowerCase()
    })).rejects.toMatchObject({ code: 'REGENERATE_CONFIRMATION_MISMATCH' })

    vi.spyOn(manager, 'isActive').mockReturnValue(true)
    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'SERVER_MUST_BE_STOPPED' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses regeneration while a live orphan process owns the runtime marker', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await writeFile(join(instance.serverDirectory, '.emberhost-runtime.json'), `${JSON.stringify({
      instanceId: instance.id,
      pid: process.pid,
      status: 'running'
    })}\n`, 'utf8')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'ORPHAN_PROCESS' })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses regeneration when the managed server root is a symlink or junction', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { directory, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    const externalDirectory = join(directory, 'external-server-root')
    await mkdir(externalDirectory)
    await writeFile(
      join(externalDirectory, 'emberhost-instance.json'),
      `${JSON.stringify({ id: instance.id })}\n`,
      'utf8'
    )
    await rm(instance.serverDirectory, { recursive: true })
    await symlink(externalDirectory, instance.serverDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(service.regenerateWorld({
      instanceId: instance.id,
      seed: 'new',
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'UNSAFE_SERVER_DIRECTORY' })
    expect(await readFile(join(externalDirectory, 'emberhost-instance.json'), 'utf8')).toContain(instance.id)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('moves only the managed server folder to recoverable trash and preserves shared artifacts', async () => {
    let trashedPath = ''
    const { directory, store, service } = await harness(async (path) => {
      trashedPath = `${path}.recycle-bin`
      await rename(path, trashedPath)
    })
    const instance = await service.create(input, () => undefined)
    const artifactsPath = join(directory, 'runtime', 'artifact-cache')
    const artifactsBefore = await readdir(artifactsPath)

    await service.delete({ id: instance.id, confirmationName: instance.name })

    expect(store.getInstance(instance.id)).toBeUndefined()
    await expect(access(instance.serverDirectory)).rejects.toThrow()
    expect(await readFile(join(trashedPath, 'server.jar'), 'utf8')).toBe('fake jar')
    expect(await readdir(artifactsPath)).toEqual(artifactsBefore)
    expect(trashedPath).toContain(`.${instance.id}.deleting-`)
  })

  it('requires the exact stored server name as backend confirmation', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name.toLowerCase()
    })).rejects.toMatchObject({ code: 'DELETE_CONFIRMATION_MISMATCH' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(instance.serverDirectory)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses deletion while the manager reports a live server', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, manager, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    vi.spyOn(manager, 'isActive').mockReturnValue(true)

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'SERVER_MUST_BE_STOPPED' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(instance.serverDirectory)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses deletion when a live orphan process owns the runtime marker', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await writeFile(join(instance.serverDirectory, '.emberhost-runtime.json'), `${JSON.stringify({
      instanceId: instance.id,
      pid: process.pid,
      status: 'running'
    })}\n`, 'utf8')

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'ORPHAN_PROCESS' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(instance.serverDirectory)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses folders outside the managed UUID path', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { directory, store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    const stored = store.getInstance(instance.id)
    if (!stored) throw new Error('Expected the created instance to be persisted.')
    await store.updateInstance({ ...stored, serverDirectory: join(directory, 'outside-server') })

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'UNMANAGED_SERVER_DIRECTORY' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(instance.serverDirectory)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses a mismatched EmberHost ownership marker', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    await writeFile(
      join(instance.serverDirectory, 'emberhost-instance.json'),
      `${JSON.stringify({ id: '94c675f3-a8d2-441e-95c9-eb9fbc3a68d1' })}\n`,
      'utf8'
    )

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'INVALID_INSTANCE_MARKER' })

    expect(store.getInstance(instance.id)).toBeDefined()
    await expect(access(instance.serverDirectory)).resolves.toBeUndefined()
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('refuses to trash a symbolic link or Windows directory junction', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { directory, store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    const externalDirectory = join(directory, 'external-world')
    await mkdir(externalDirectory)
    await writeFile(
      join(externalDirectory, 'emberhost-instance.json'),
      `${JSON.stringify({ id: instance.id })}\n`,
      'utf8'
    )
    await rm(instance.serverDirectory, { recursive: true })
    await symlink(externalDirectory, instance.serverDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'UNSAFE_SERVER_DIRECTORY' })

    expect(store.getInstance(instance.id)).toBeDefined()
    expect(await readFile(join(externalDirectory, 'emberhost-instance.json'), 'utf8')).toContain(instance.id)
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('restores both the directory and metadata when recycle-bin disposal fails', async () => {
    const trashItem = vi.fn(async () => { throw new Error('recycle bin unavailable') })
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'SERVER_DELETE_FAILED' })

    expect(store.getInstance(instance.id)?.name).toBe(instance.name)
    expect(await readFile(join(instance.serverDirectory, 'server.jar'), 'utf8')).toBe('fake jar')
    expect(trashItem).toHaveBeenCalledOnce()
  })

  it('restores the staged directory when metadata removal fails', async () => {
    const trashItem = vi.fn(async () => undefined)
    const { store, service } = await harness(trashItem)
    const instance = await service.create(input, () => undefined)
    vi.spyOn(store, 'removeInstance').mockRejectedValueOnce(new Error('disk full'))

    await expect(service.delete({
      id: instance.id,
      confirmationName: instance.name
    })).rejects.toMatchObject({ code: 'SERVER_DELETE_FAILED' })

    expect(store.getInstance(instance.id)?.name).toBe(instance.name)
    expect(await readFile(join(instance.serverDirectory, 'server.jar'), 'utf8')).toBe('fake jar')
    expect(trashItem).not.toHaveBeenCalled()
  })
})
