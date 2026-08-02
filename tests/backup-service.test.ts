import { cp, access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRuntime, ServerInstance, StateEvent } from '../src/shared/contracts'
import { BackupService } from '../src/main/services/backup-service'
import { BACKUP_MARKER_FILE } from '../src/main/services/backup-safety'
import { AppError } from '../src/main/services/errors'
import type { ServerManager } from '../src/main/services/server-manager'
import { AppStore } from '../src/main/services/store'

const INSTANCE_ID = '6a2d5f16-c865-4a44-a155-5dd538a18201'
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function runtime(status: InstanceRuntime['status'] = 'offline', playerCount = 0): InstanceRuntime {
  return {
    status,
    pid: status === 'online' ? 1234 : null,
    startedAt: status === 'online' ? '2026-07-31T00:00:00.000Z' : null,
    lastExitCode: null,
    playerCount,
    players: playerCount ? ['Alex'] : [],
    health: { tps: null, mspt: null, memoryUsedMb: null, memoryMaxMb: null, cpuPercent: null }
  }
}

class FakeManager {
  currentRuntime = runtime()
  maintenanceCalls = 0
  stopCalls = 0
  startCalls = 0
  markerPresentBeforeStop = false
  markerPresentAtRestart = false
  failRestart = false
  forceUncleanStop = false
  maintenanceEntered: (() => void) | null = null
  maintenanceRelease: Promise<void> | null = null
  private readonly listeners = new Set<(event: StateEvent) => void>()

  constructor(private readonly instance: ServerInstance) {}

  onState(listener: (event: StateEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView(instance: ServerInstance) {
    return { ...instance, runtime: { ...this.currentRuntime } }
  }

  async assertStoppedAndUnowned(): Promise<void> {
    if (['online', 'starting', 'stopping'].includes(this.currentRuntime.status)) {
      throw new AppError('Server is active.', 'SERVER_MUST_BE_STOPPED')
    }
  }

  async start(): Promise<unknown> {
    this.startCalls += 1
    this.currentRuntime = runtime('online')
    this.emit()
    return this.getView(this.instance)
  }

  async runOfflineMaintenance<T>(
    _instanceId: string,
    operation: (context: { instance: ServerInstance; restartAfter: boolean }) => Promise<T>,
    lifecycle: {
      beforeStop?: (context: { instance: ServerInstance; restartAfter: boolean }) => Promise<void>
      finalize?: () => Promise<void>
    } = {}
  ): Promise<T> {
    this.maintenanceCalls += 1
    if (this.currentRuntime.status === 'starting' || this.currentRuntime.status === 'stopping') {
      throw new AppError('Server is busy.', 'SERVER_BUSY')
    }
    if (this.currentRuntime.status === 'online' && this.currentRuntime.playerCount > 0) {
      throw new AppError('Wait for players to disconnect.', 'PLAYERS_CONNECTED')
    }
    const restartAfter = this.currentRuntime.status === 'online'
    const context = { instance: this.instance, restartAfter }
    await lifecycle.beforeStop?.(context)
    if (restartAfter) {
      try {
        await access(join(this.instance.serverDirectory, BACKUP_MARKER_FILE))
        this.markerPresentBeforeStop = true
      } catch {
        this.markerPresentBeforeStop = false
      }
      this.stopCalls += 1
      this.currentRuntime = runtime('offline')
      this.emit()
    }
    this.maintenanceEntered?.()
    await this.maintenanceRelease
    let result: T | undefined
    let failure: unknown = null
    try {
      if (this.forceUncleanStop) {
        throw new AppError(
          'Minecraft did not stop gracefully, so EmberHost aborted offline maintenance without copying the world.',
          'MAINTENANCE_STOP_UNCLEAN'
        )
      }
      result = await operation(context)
    } catch (error) {
      failure = error
    }
    if (restartAfter) {
      try {
        await access(join(this.instance.serverDirectory, BACKUP_MARKER_FILE))
        this.markerPresentAtRestart = true
      } catch {
        this.markerPresentAtRestart = false
      }
      if (this.failRestart) throw new Error('restart failed')
      this.startCalls += 1
      this.currentRuntime = runtime('online')
      this.emit()
    }
    await lifecycle.finalize?.()
    if (failure) throw failure
    return result as T
  }

  async restartAfterInterruptedMaintenance(
    _instanceId: string,
    completeAfterLaunch: () => Promise<void>
  ): Promise<unknown> {
    try {
      await access(join(this.instance.serverDirectory, BACKUP_MARKER_FILE))
      this.markerPresentAtRestart = true
    } catch {
      this.markerPresentAtRestart = false
    }
    if (this.failRestart) throw new Error('restart failed')
    this.startCalls += 1
    this.currentRuntime = runtime('online')
    this.emit()
    try {
      await completeAfterLaunch()
    } catch (error) {
      if (this.currentRuntime.status === 'online') {
        this.stopCalls += 1
        this.currentRuntime = runtime('offline')
        this.emit()
      }
      throw error
    }
    return this.getView(this.instance)
  }

  private emit(): void {
    const event = { instanceId: this.instance.id, runtime: this.currentRuntime }
    for (const listener of this.listeners) listener(event)
  }
}

interface Harness {
  directory: string
  runtimeDirectory: string
  serverDirectory: string
  instance: ServerInstance
  store: AppStore
  manager: FakeManager
  service: BackupService
  now: { value: Date }
  intervalCallbacks: Array<() => void>
}

async function harness(options: {
  software?: ServerInstance['software']
  statfs?: () => Promise<{ bavail: bigint; bsize: bigint; blocks: bigint }>
  copyDirectory?: (source: string, destination: string) => Promise<void>
} = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-backups-'))
  temporaryDirectories.push(directory)
  const runtimeDirectory = join(directory, 'runtime')
  const serverDirectory = join(runtimeDirectory, 'servers', INSTANCE_ID)
  await mkdir(serverDirectory, { recursive: true })
  const instance: ServerInstance = {
    id: INSTANCE_ID,
    name: 'Backup world',
    version: '26.2',
    serverDirectory,
    software: options.software ?? { kind: 'vanilla' },
    launchArtifact: options.software?.kind === 'paper' ? 'paper.jar' : 'server.jar',
    jarSha1: options.software?.kind === 'paper' ? null : 'abc',
    artifactSha256: options.software?.kind === 'paper' ? 'a'.repeat(64) : null,
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25565,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Backup test',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 10,
    simulationDistance: 10,
    performancePreset: 'balanced',
    eulaAcceptedAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
  await writeFile(join(serverDirectory, 'emberhost-instance.json'), `${JSON.stringify({ id: instance.id })}\n`, 'utf8')
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  await store.addInstance(instance)
  const manager = new FakeManager(instance)
  const now = { value: new Date('2026-07-31T12:00:00.000Z') }
  const intervalCallbacks: Array<() => void> = []
  const service = new BackupService(
    store,
    manager as unknown as ServerManager,
    runtimeDirectory,
    async (_instanceId, operation) => operation(),
    {
      now: () => new Date(now.value),
      setInterval: (callback) => {
        intervalCallbacks.push(callback)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
       clearInterval: () => undefined,
       statfs: options.statfs ?? (async () => ({
         bavail: 200n,
         bsize: 1024n * 1024n * 1024n,
         blocks: 1_000n
      })),
      ...(options.copyDirectory ? { copyDirectory: options.copyDirectory } : {})
    }
  )
  return { directory, runtimeDirectory, serverDirectory, instance, store, manager, service, now, intervalCallbacks }
}

async function world(serverDirectory: string, name: string, extra = true): Promise<void> {
  await mkdir(join(serverDirectory, name, 'region'), { recursive: true })
  await writeFile(join(serverDirectory, name, 'level.dat'), `${name}-level`, 'utf8')
  if (extra) await writeFile(join(serverDirectory, name, 'region', 'r.0.0.mca'), `${name}-region`, 'utf8')
}

async function automaticEntries(serverDirectory: string): Promise<string[]> {
  try {
    return await readdir(join(serverDirectory, 'emberhost-backups', 'automatic'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('BackupService', () => {
  it('creates and atomically persists the enabled default policy, then validates updates', async () => {
    const { service, serverDirectory } = await harness()
    await service.initialize()

    const state = await service.getState(INSTANCE_ID)
    expect(state).toMatchObject({
      status: 'idle',
      policy: { enabled: true, intervalHours: 6, retentionCount: 3 },
      backupCount: 0,
      lastSuccessfulAt: null
    })
    const persisted = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(persisted).toMatchObject({ schemaVersion: 1, instanceId: INSTANCE_ID, enabled: true })

    await expect(service.updatePolicy({
      instanceId: INSTANCE_ID,
      enabled: true,
      intervalHours: 2 as 1,
      retentionCount: 3
    })).rejects.toThrow()
    service.beginShutdown()
  })

  it('returns the cached actionable failure after initialization cannot load an invalid policy', async () => {
    const { service, serverDirectory } = await harness()
    await writeFile(join(serverDirectory, 'emberhost-backup-policy.json'), '{"schemaVersion":1,"broken":true}\n', 'utf8')

    await service.initialize()

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'failed',
      error: 'The automatic-backup policy file is invalid.'
    })
    service.beginShutdown()
  })

  it('backs up an offline Vanilla custom world and optional Paper-style sibling without requiring the End', async () => {
    const { service, serverDirectory } = await harness()
    await writeFile(join(serverDirectory, 'server.properties'), 'level-name=cedar_world\n', 'utf8')
    await world(serverDirectory, 'cedar_world')
    await world(serverDirectory, 'cedar_world_nether')
    await service.initialize()

    const state = await service.createBackupNow(INSTANCE_ID)

    expect(state).toMatchObject({ status: 'idle', backupCount: 1, error: null })
    const entries = (await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))
    expect(entries).toHaveLength(1)
    const backup = join(serverDirectory, 'emberhost-backups', 'automatic', entries[0]!)
    expect(await readFile(join(backup, 'cedar_world', 'level.dat'), 'utf8')).toBe('cedar_world-level')
    expect(await readFile(join(backup, 'cedar_world_nether', 'level.dat'), 'utf8')).toBe('cedar_world_nether-level')
    const manifest = JSON.parse(await readFile(join(backup, 'emberhost-backup.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'automatic',
      instanceId: INSTANCE_ID,
      levelName: 'cedar_world',
      scope: 'active-world-only',
      captureMode: 'offline',
      worlds: [{ name: 'cedar_world' }, { name: 'cedar_world_nether' }]
    })
    expect(manifest.fileCount).toBe(4)
    service.beginShutdown()
  })

  it('briefly stops and restarts an empty online Paper server while retaining the marker through restart', async () => {
    const { service, serverDirectory, manager } = await harness({
      software: { kind: 'paper', build: 87, channel: 'STABLE' }
    })
    await Promise.all([world(serverDirectory, 'world'), world(serverDirectory, 'world_nether'), world(serverDirectory, 'world_the_end')])
    manager.currentRuntime = runtime('online')
    await service.initialize()

    await service.createBackupNow(INSTANCE_ID)

    expect(manager.stopCalls).toBe(1)
    expect(manager.startCalls).toBe(1)
    expect(manager.markerPresentBeforeStop).toBe(true)
    expect(manager.markerPresentAtRestart).toBe(true)
    expect(manager.currentRuntime.status).toBe('online')
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    service.beginShutdown()
  })

  it('retains the crash marker when restart fails after a successful snapshot', async () => {
    const { service, serverDirectory, manager } = await harness()
    await world(serverDirectory, 'world')
    manager.currentRuntime = runtime('online')
    manager.failRestart = true
    await service.initialize()

    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toThrow('restart failed')

    expect(manager.markerPresentAtRestart).toBe(true)
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).resolves.toBeUndefined()
    expect((await service.getState(INSTANCE_ID)).status).toBe('failed')
    service.beginShutdown()
  })

  it('persists a forced-stop failure, restarts safely, and never creates or promotes a snapshot', async () => {
    const { service, serverDirectory, manager } = await harness()
    await world(serverDirectory, 'world')
    manager.currentRuntime = runtime('online')
    manager.forceUncleanStop = true
    await service.initialize()

    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'MAINTENANCE_STOP_UNCLEAN' })

    expect(manager.markerPresentBeforeStop).toBe(true)
    expect(manager.stopCalls).toBe(1)
    expect(manager.startCalls).toBe(1)
    expect(manager.currentRuntime.status).toBe('online')
    expect((await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))).toEqual([])
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('aborted offline maintenance')
    })
    const persisted = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(persisted.lastError).toContain('aborted offline maintenance')
    service.beginShutdown()
  })

  it('rejects players and transient runtime states without beginning a manual copy', async () => {
    const { service, serverDirectory, manager } = await harness()
    await world(serverDirectory, 'world')
    manager.currentRuntime = runtime('online', 1)
    await service.initialize()

    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'PLAYERS_CONNECTED' })
    expect((await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))).toEqual([])
    expect((await service.getState(INSTANCE_ID)).status).toBe('waiting')
    service.beginShutdown()
  })

  it('waits without persisting a failure when a scheduled backup is due before the first world exists', async () => {
    const { service, serverDirectory, now, intervalCallbacks } = await harness()
    await service.initialize()
    await service.awaitIdle()
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000)

    intervalCallbacks[0]?.()
    await service.awaitIdle()

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'waiting',
      message: 'Start the server once to create its world. Automatic backups will wait until the world exists.',
      error: null,
      backupCount: 0
    })
    const persisted = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(persisted.lastError).toBeNull()
    service.beginShutdown()
  })

  it('rechecks a queued scheduled job and does not stop the server after automatic backups are disabled', async () => {
    const { service, serverDirectory, manager } = await harness()
    await world(serverDirectory, 'world')
    manager.currentRuntime = runtime('online')
    await service.initialize()
    await service.awaitIdle()
    let releaseResolve!: () => void
    const release = new Promise<void>((resolve) => { releaseResolve = resolve })
    const internal = service as unknown as {
      globalQueue: Promise<unknown>
      enqueue: (instanceId: string, manual: boolean) => Promise<unknown>
    }
    internal.globalQueue = release
    const queued = internal.enqueue(INSTANCE_ID, false)

    await service.updatePolicy({
      instanceId: INSTANCE_ID,
      enabled: false,
      intervalHours: 6,
      retentionCount: 3
    })
    releaseResolve()
    await queued

    expect(manager.stopCalls).toBe(0)
    expect(manager.maintenanceCalls).toBe(0)
    expect((await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))).toEqual([])
    service.beginShutdown()
  })

  it('waits on a crashed runtime and rejects a manual backup without entering maintenance', async () => {
    const { service, serverDirectory, manager, now, intervalCallbacks } = await harness()
    await world(serverDirectory, 'world')
    manager.currentRuntime = runtime('crashed')
    await service.initialize()
    await service.awaitIdle()
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000)

    intervalCallbacks[0]?.()
    await service.awaitIdle()

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'waiting',
      message: expect.stringContaining('clean online state')
    })
    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'SERVER_CRASHED' })
    expect(manager.maintenanceCalls).toBe(0)
    expect((await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))).toEqual([])
    service.beginShutdown()
  })

  it('refuses missing level.dat, recursive links, and insufficient disk space', async () => {
    const missing = await harness()
    await mkdir(join(missing.serverDirectory, 'world'))
    await missing.service.initialize()
    await expect(missing.service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'UNSAFE_WORLD_DIRECTORY' })
    missing.service.beginShutdown()

    const linked = await harness()
    await world(linked.serverDirectory, 'world')
    const external = join(linked.directory, 'external-data')
    await mkdir(external)
    await writeFile(join(external, 'secret'), 'external', 'utf8')
    await symlink(external, join(linked.serverDirectory, 'world', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await linked.service.initialize()
    await expect(linked.service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'UNSAFE_BACKUP_TREE' })
    expect(await readFile(join(external, 'secret'), 'utf8')).toBe('external')
    linked.service.beginShutdown()

    const lowSpace = await harness({ statfs: async () => ({ bavail: 1n, bsize: 1n, blocks: 1n }) })
    await world(lowSpace.serverDirectory, 'world')
    lowSpace.manager.currentRuntime = runtime('online')
    await lowSpace.service.initialize()
    await expect(lowSpace.service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'BACKUP_DISK_SPACE' })
    expect(lowSpace.manager.markerPresentBeforeStop).toBe(true)
    expect(lowSpace.manager.stopCalls).toBe(1)
    expect(lowSpace.manager.startCalls).toBe(1)
    await expect(access(join(lowSpace.serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    lowSpace.service.beginShutdown()
  })

  it('removes verified staging after copy verification failure and clears the marker', async () => {
    const copyDirectory = async (source: string, destination: string): Promise<void> => {
      await cp(source, destination, { recursive: true })
      await writeFile(join(destination, 'unexpected-file'), 'break verification', 'utf8')
    }
    const { service, serverDirectory } = await harness({ copyDirectory })
    await world(serverDirectory, 'world')
    await service.initialize()

    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' })

    const entries = await automaticEntries(serverDirectory)
    expect(entries.filter((name) => name.startsWith('.staging-'))).toEqual([])
    expect(entries.filter((name) => name.startsWith('auto-'))).toEqual([])
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    service.beginShutdown()
  })

  it('merges a policy edit that races a failing backup instead of overwriting the new settings', async () => {
    let enteredResolve!: () => void
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
    let releaseResolve!: () => void
    const release = new Promise<void>((resolve) => { releaseResolve = resolve })
    const copyDirectory = async (): Promise<void> => {
      enteredResolve()
      await release
      throw new Error('copy device disappeared')
    }
    const { service, serverDirectory } = await harness({ copyDirectory })
    await world(serverDirectory, 'world')
    await service.initialize()

    const backup = service.createBackupNow(INSTANCE_ID)
    await entered
    await service.updatePolicy({
      instanceId: INSTANCE_ID,
      enabled: true,
      intervalHours: 12,
      retentionCount: 7
    })
    releaseResolve()
    await expect(backup).rejects.toThrow('copy device disappeared')

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'failed',
      policy: { enabled: true, intervalHours: 12, retentionCount: 7 },
      error: 'copy device disappeared'
    })
    const persisted = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(persisted).toMatchObject({ intervalHours: 12, retentionCount: 7, lastError: 'copy device disappeared' })
    service.beginShutdown()
  })

  it('blocks automatic retry after a persisted failure, including after a deferred manual attempt', async () => {
    const statfs = vi.fn(async () => ({ bavail: 1n, bsize: 1n, blocks: 1n }))
    const { service, serverDirectory, manager, now, intervalCallbacks } = await harness({ statfs })
    await world(serverDirectory, 'world')
    await service.initialize()
    await service.awaitIdle()
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000)

    intervalCallbacks[0]?.()
    await service.awaitIdle()
    expect(manager.maintenanceCalls).toBe(1)
    expect(statfs).toHaveBeenCalledOnce()

    manager.currentRuntime = runtime('online', 1)
    await expect(service.createBackupNow(INSTANCE_ID)).rejects.toMatchObject({ code: 'PLAYERS_CONNECTED' })
    expect(manager.maintenanceCalls).toBe(2)
    manager.currentRuntime = runtime('offline')
    now.value = new Date(now.value.getTime() + 24 * 60 * 60 * 1000)
    intervalCallbacks[0]?.()
    await service.awaitIdle()

    expect(manager.maintenanceCalls).toBe(2)
    expect(statfs).toHaveBeenCalledOnce()
    const persisted = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(persisted.lastError).toContain('enough free disk space')
    service.beginShutdown()
  })

  it('blocks automatic retry after an untyped copy I/O failure', async () => {
    const copyDirectory = vi.fn(async (): Promise<void> => {
      const error = new Error('storage device I/O error') as NodeJS.ErrnoException
      error.code = 'EIO'
      throw error
    })
    const { service, serverDirectory, manager, now, intervalCallbacks } = await harness({ copyDirectory })
    await world(serverDirectory, 'world')
    await service.initialize()
    await service.awaitIdle()
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000)
    intervalCallbacks[0]?.()
    await service.awaitIdle()
    expect(copyDirectory).toHaveBeenCalledOnce()
    expect(manager.maintenanceCalls).toBe(1)

    now.value = new Date(now.value.getTime() + 24 * 60 * 60 * 1000)
    intervalCallbacks[0]?.()
    await service.awaitIdle()

    expect(copyDirectory).toHaveBeenCalledOnce()
    expect(manager.maintenanceCalls).toBe(1)
    service.beginShutdown()
  })

  it('prunes only the oldest owned automatic backups and preserves unknown data', async () => {
    const { service, serverDirectory, now } = await harness()
    await world(serverDirectory, 'world')
    await service.initialize()
    const automatic = join(serverDirectory, 'emberhost-backups', 'automatic')
    await mkdir(join(automatic, 'manual-keep'), { recursive: true })
    await writeFile(join(automatic, 'manual-keep', 'notes.txt'), 'keep', 'utf8')
    await mkdir(join(automatic, 'auto-malformed'))

    for (let index = 0; index < 4; index += 1) {
      now.value = new Date(now.value.getTime() + 1_000)
      await service.createBackupNow(INSTANCE_ID)
    }

    const entries = await automaticEntries(serverDirectory)
    expect(entries.filter((name) => name.startsWith('auto-') && name !== 'auto-malformed')).toHaveLength(3)
    expect(await readFile(join(automatic, 'manual-keep', 'notes.txt'), 'utf8')).toBe('keep')
    expect(entries).toContain('auto-malformed')
    service.beginShutdown()
  })

  it('protects the just-created backup from retention pruning when the system clock moves backward', async () => {
    const { service, serverDirectory, now } = await harness()
    await world(serverDirectory, 'world')
    await service.initialize()
    for (let index = 0; index < 3; index += 1) {
      now.value = new Date(now.value.getTime() + 1_000)
      await service.createBackupNow(INSTANCE_ID)
    }
    now.value = new Date('2026-01-01T00:00:00.000Z')

    await service.createBackupNow(INSTANCE_ID)

    const entries = (await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))
    expect(entries).toHaveLength(3)
    expect(entries.some((name) => name.startsWith('auto-2026-01-01T00-00-00-000Z-'))).toBe(true)
    service.beginShutdown()
  })

  it('does not count a manifest whose listed world directory is missing', async () => {
    const { service, serverDirectory } = await harness()
    await world(serverDirectory, 'world')
    await service.initialize()
    await service.createBackupNow(INSTANCE_ID)
    const [backupName] = (await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))
    if (!backupName) throw new Error('Expected a backup fixture.')
    await rm(join(serverDirectory, 'emberhost-backups', 'automatic', backupName, 'world'), { recursive: true })

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      backupCount: 0,
      lastSuccessfulAt: null
    })
    service.beginShutdown()
  })

  it('coalesces overdue scheduler checks into one globally queued backup', async () => {
    const { service, serverDirectory, now, intervalCallbacks, manager } = await harness()
    await world(serverDirectory, 'world')
    let enteredResolve!: () => void
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
    let releaseResolve!: () => void
    manager.maintenanceEntered = enteredResolve
    manager.maintenanceRelease = new Promise<void>((resolve) => { releaseResolve = resolve })
    await service.initialize()
    await service.awaitIdle()
    now.value = new Date(now.value.getTime() + 16 * 60 * 1000)

    intervalCallbacks[0]?.()
    intervalCallbacks[0]?.()
    await entered
    expect(manager.stopCalls).toBe(0)
    releaseResolve()
    await service.awaitIdle()

    expect((await automaticEntries(serverDirectory)).filter((name) => name.startsWith('auto-'))).toHaveLength(1)
    service.beginShutdown()
  })

  it('recovers owned staging before startup and restarts when the marker requests it', async () => {
    const { service, serverDirectory, manager } = await harness()
    const stagingName = '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8'
    const staging = join(serverDirectory, 'emberhost-backups', 'automatic', stagingName)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'partial'), 'partial', 'utf8')
    await writeFile(join(serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      stagingName,
      restartAfter: true,
      createdAt: '2026-07-31T11:00:00.000Z'
    })}\n`, 'utf8')

    await service.initialize()

    await expect(access(staging)).rejects.toThrow()
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    expect(manager.startCalls).toBe(1)
    service.beginShutdown()
  })

  it('retains the recovery marker and failed state when the requested restart cannot launch', async () => {
    const { service, serverDirectory, manager } = await harness()
    const stagingName = '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8'
    const staging = join(serverDirectory, 'emberhost-backups', 'automatic', stagingName)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'partial'), 'partial', 'utf8')
    await writeFile(join(serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      stagingName,
      restartAfter: true,
      createdAt: '2026-07-31T11:00:00.000Z'
    })}\n`, 'utf8')
    manager.failRestart = true

    await service.initialize()

    await expect(access(staging)).rejects.toThrow()
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).resolves.toBeUndefined()
    expect(manager.markerPresentAtRestart).toBe(true)
    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'failed',
      error: 'restart failed'
    })
    service.beginShutdown()
  })

  it('clears a persisted recovery failure only after a later relaunch completes recovery successfully', async () => {
    const { service, serverDirectory, runtimeDirectory, store, instance, manager, now } = await harness()
    const stagingName = '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8'
    const staging = join(serverDirectory, 'emberhost-backups', 'automatic', stagingName)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'partial'), 'partial', 'utf8')
    await writeFile(join(serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      stagingName,
      restartAfter: true,
      createdAt: '2026-07-31T11:00:00.000Z'
    })}\n`, 'utf8')
    manager.failRestart = true
    await service.initialize()
    service.beginShutdown()
    const failedPolicy = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(failedPolicy.lastError).toContain('could not restart safely')
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).resolves.toBeUndefined()

    const recoveredManager = new FakeManager(instance)
    const recoveredService = new BackupService(
      store,
      recoveredManager as unknown as ServerManager,
      runtimeDirectory,
      async (_instanceId, operation) => operation(),
      {
        now: () => new Date(now.value),
        setInterval: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
        clearInterval: () => undefined,
        statfs: async () => ({
          bavail: 200n,
          bsize: 1024n * 1024n * 1024n,
          blocks: 1_000n
        })
      }
    )

    await recoveredService.initialize()

    expect(recoveredManager.startCalls).toBe(1)
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).rejects.toThrow()
    const recoveredPolicy = JSON.parse(await readFile(join(serverDirectory, 'emberhost-backup-policy.json'), 'utf8'))
    expect(recoveredPolicy.lastError).toBeNull()
    await expect(recoveredService.getState(INSTANCE_ID)).resolves.toMatchObject({
      status: 'idle',
      error: null,
      nextBackupAt: '2026-07-31T12:15:00.000Z'
    })
    recoveredService.beginShutdown()
  })

  it('refuses recovery deletion through a linked backup-root parent and preserves external data', async () => {
    const { service, directory, serverDirectory } = await harness()
    const stagingName = '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8'
    const externalRoot = join(directory, 'external-backups')
    const externalStaging = join(externalRoot, 'automatic', stagingName)
    await mkdir(externalStaging, { recursive: true })
    await writeFile(join(externalStaging, 'keep.txt'), 'external', 'utf8')
    await symlink(externalRoot, join(serverDirectory, 'emberhost-backups'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      stagingName,
      restartAfter: false,
      createdAt: '2026-07-31T11:00:00.000Z'
    })}\n`, 'utf8')

    await service.initialize()

    expect(await readFile(join(externalStaging, 'keep.txt'), 'utf8')).toBe('external')
    await expect(access(join(serverDirectory, BACKUP_MARKER_FILE))).resolves.toBeUndefined()
    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({ status: 'failed' })
    service.beginShutdown()
  })

  it('restores a persisted backup failure as failed rather than a waiting warning', async () => {
    const { service, serverDirectory } = await harness()
    await writeFile(join(serverDirectory, 'emberhost-backup-policy.json'), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      enabled: true,
      intervalHours: 6,
      retentionCount: 3,
      enabledAt: '2026-07-31T10:00:00.000Z',
      lastSuccessfulAt: null,
      lastError: 'disk unavailable'
    })}\n`, 'utf8')

    await service.initialize()

    expect(await service.getState(INSTANCE_ID)).toMatchObject({ status: 'failed', error: 'disk unavailable' })
    service.beginShutdown()
  })

  it('ignores persisted success timestamps when no valid automatic backup exists', async () => {
    const { service, serverDirectory } = await harness()
    await writeFile(join(serverDirectory, 'emberhost-backup-policy.json'), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      enabled: true,
      intervalHours: 6,
      retentionCount: 3,
      enabledAt: '2026-07-31T12:00:00.000Z',
      lastSuccessfulAt: '2030-01-01T00:00:00.000Z',
      lastError: null
    })}\n`, 'utf8')

    await service.initialize()
    await service.awaitIdle()

    await expect(service.getState(INSTANCE_ID)).resolves.toMatchObject({
      lastSuccessfulAt: null,
      nextBackupAt: '2026-07-31T12:15:00.000Z'
    })
    service.beginShutdown()
  })
})
