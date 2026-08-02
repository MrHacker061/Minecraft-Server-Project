import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleEntry, ServerInstance, StateEvent } from '../src/shared/contracts'
import { BACKUP_MARKER_FILE } from '../src/main/services/backup-safety'
import { buildLaunchArguments, ServerManager } from '../src/main/services/server-manager'
import { AppStore } from '../src/main/services/store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function waitFor<T>(register: (resolve: (value: T) => void) => void, timeoutMs = 3_000): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for server event.')), timeoutMs)
    register((value) => {
      clearTimeout(timeout)
      resolvePromise(value)
    })
  })
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function createHarness(readinessDelayMs = 50, harnessOptions: {
  ignoreStop?: boolean
  stopMode?: 'ignore-stop' | 'nonzero-stop' | 'closed-stdin'
  gracefulStopTimeoutMs?: number
  forcedStopTimeoutMs?: number
  maintenanceReadinessTimeoutMs?: number
  delayedMaintenanceWriteErrorMs?: number
  autoJoinDelayMs?: number
} = {}): Promise<{
  directory: string
  instance: ServerInstance
  manager: ServerManager
  launches: Array<{ args: string[]; shell: boolean }>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-manager-maintenance-'))
  temporaryDirectories.push(directory)
  const serverDirectory = join(directory, 'server')
  await mkdir(serverDirectory, { recursive: true })
  await writeFile(join(serverDirectory, 'paper.jar'), 'test launch artifact', 'utf8')
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  const instance: ServerInstance = {
    id: '6a2d5f16-c865-4a44-a155-5dd538a18201',
    name: 'Maintenance world',
    version: '26.2',
    serverDirectory,
    software: { kind: 'paper', build: 87, channel: 'STABLE' },
    launch: { kind: 'jar', path: 'paper.jar' },
    jarSha1: null,
    artifactSha256: 'b'.repeat(64),
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25566,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Maintenance',
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
  await store.addInstance(instance)

  const launches: Array<{ args: string[]; shell: boolean }> = []
  const manager = new ServerManager(store, {
    checkJava: async (command = 'java') => ({
      available: true,
      command,
      majorVersion: 25,
      versionText: 'java version "25"',
      error: null
    }),
    spawnProcess: (_command, args, options) => {
      launches.push({ args, shell: options.shell })
      return spawn(
        process.execPath,
        [
          resolve('tests/fixtures/fake-server.mjs'),
          String(readinessDelayMs),
          ...(harnessOptions.stopMode || harnessOptions.ignoreStop || harnessOptions.autoJoinDelayMs !== undefined
            ? [harnessOptions.stopMode ?? (harnessOptions.ignoreStop ? 'ignore-stop' : 'clean-stop')]
            : []),
          ...(harnessOptions.autoJoinDelayMs === undefined ? [] : [String(harnessOptions.autoJoinDelayMs)])
        ],
        options
      )
    },
    ...(harnessOptions.gracefulStopTimeoutMs === undefined
      ? {}
      : { gracefulStopTimeoutMs: harnessOptions.gracefulStopTimeoutMs }),
    ...(harnessOptions.forcedStopTimeoutMs === undefined
      ? {}
      : { forcedStopTimeoutMs: harnessOptions.forcedStopTimeoutMs }),
    ...(harnessOptions.maintenanceReadinessTimeoutMs === undefined
      ? {}
      : { maintenanceReadinessTimeoutMs: harnessOptions.maintenanceReadinessTimeoutMs }),
    ...(harnessOptions.delayedMaintenanceWriteErrorMs === undefined
      ? {}
      : {
          maintenanceInputWriteTimeoutMs: 1_000,
          writeMaintenanceInput: (
            _child: unknown,
            _value: string,
            callback: (error?: Error | null) => void
          ) => {
            setTimeout(
              () => callback(new Error('delayed stdin write failure')),
              harnessOptions.delayedMaintenanceWriteErrorMs
            )
          }
        })
  })
  return { directory, instance, manager, launches }
}

async function startOnline(manager: ServerManager, instanceId: string): Promise<StateEvent> {
  const online = waitFor<StateEvent>((resolveEvent) => {
    manager.onState((event) => {
      if (event.instanceId === instanceId && event.runtime.status === 'online') resolveEvent(event)
    })
  })
  await manager.start(instanceId)
  return online
}

describe('ServerManager', () => {
  it('launches modern Forge through the platform argument file without executing generated scripts', () => {
    const forgeInstance: ServerInstance = {
      id: '6387e349-33aa-4c29-a6a9-f5d76fdf8b4f',
      name: 'Modded world',
      version: '1.21.1',
      serverDirectory: 'C:\\server',
      software: {
        kind: 'forge',
        forgeVersion: '52.1.16',
        mavenVersion: '1.21.1-52.1.16',
        channel: 'latest',
        installerSha1: 'a'.repeat(40)
      },
      launch: {
        kind: 'java-argfile',
        windowsPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/win_args.txt',
        unixPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/unix_args.txt'
      },
      jarSha1: null,
      artifactSha256: null,
      requiredJavaVersion: 21,
      javaPath: 'java',
      port: 25565,
      memoryMb: 6144,
      maxPlayers: 20,
      motd: 'Forge',
      gameMode: 'survival',
      difficulty: 'normal',
      onlineMode: true,
      viewDistance: 10,
      simulationDistance: 10,
      performancePreset: 'custom',
      eulaAcceptedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }

    const windowsArgs = buildLaunchArguments(forgeInstance, 'win32')
    const unixArgs = buildLaunchArguments(forgeInstance, 'linux')
    expect(windowsArgs).toContain('-Xms2048M')
    expect(windowsArgs.slice(-2)).toEqual([
      '@libraries/net/minecraftforge/forge/1.21.1-52.1.16/win_args.txt',
      'nogui'
    ])
    expect(unixArgs.slice(-2)).toEqual([
      '@libraries/net/minecraftforge/forge/1.21.1-52.1.16/unix_args.txt',
      'nogui'
    ])
    expect(windowsArgs.join(' ')).not.toContain('run.bat')
    expect(unixArgs.join(' ')).not.toContain('run.sh')
  })

  it('starts, reaches readiness, sends a command, and stops gracefully', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-manager-'))
    temporaryDirectories.push(directory)
    const serverDirectory = join(directory, 'server')
    await mkdir(serverDirectory, { recursive: true })
    await writeFile(join(serverDirectory, 'paper.jar'), 'test launch artifact', 'utf8')
    const store = new AppStore(join(directory, 'config'))
    await store.load()
    const instance: ServerInstance = {
      id: '0497aa5e-ac48-4c67-bb1e-f742007f3679',
      name: 'Fake world',
      version: '26.2',
      serverDirectory,
      software: { kind: 'paper', build: 87, channel: 'STABLE' },
      launch: { kind: 'jar', path: 'paper.jar' },
      jarSha1: null,
      artifactSha256: 'a'.repeat(64),
      requiredJavaVersion: 25,
      javaPath: 'java',
      port: 25565,
      memoryMb: 4096,
      maxPlayers: 20,
      motd: 'Fake',
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
    await store.addInstance(instance)

    let capturedArgs: string[] = []
    let capturedShell: boolean | undefined
    const manager = new ServerManager(store, {
      checkJava: async (command = 'java') => ({
        available: true,
        command,
        majorVersion: 25,
        versionText: 'java version "25"',
        error: null
      }),
      spawnProcess: (_command, args, options) => {
        capturedArgs = args
        capturedShell = options.shell
        return spawn(process.execPath, [resolve('tests/fixtures/fake-server.mjs')], options)
      }
    })

    const online = waitFor<StateEvent>((resolveEvent) => {
      manager.onState((event) => {
        if (event.runtime.status === 'online') resolveEvent(event)
      })
    })
    await writeFile(join(serverDirectory, BACKUP_MARKER_FILE), `${JSON.stringify({
      schemaVersion: 1,
      instanceId: instance.id,
      stagingName: '.staging-28db97f9-3398-47b5-92c4-aa961d514ca8',
      restartAfter: false,
      createdAt: '2026-07-31T00:00:00.000Z'
    })}\n`, 'utf8')
    await expect(manager.start(instance.id)).rejects.toMatchObject({ code: 'BACKUP_RECOVERY_REQUIRED' })
    await rm(join(serverDirectory, BACKUP_MARKER_FILE))
    const interruptedRegeneration = join(directory, `.${instance.id}.world-regeneration-interrupted`)
    await mkdir(interruptedRegeneration)
    await expect(manager.start(instance.id)).rejects.toMatchObject({ code: 'WORLD_REGENERATION_RECOVERY_REQUIRED' })
    await rm(interruptedRegeneration, { recursive: true })
    await manager.start(instance.id)
    expect((await online).runtime.status).toBe('online')
    expect(capturedArgs).toContain('-Xmx4096M')
    expect(capturedArgs.slice(-2)).toEqual(['paper.jar', 'nogui'])
    expect(capturedShell).toBe(false)

    const commandOutput = waitFor<ConsoleEntry>((resolveEntry) => {
      manager.onConsole((entry) => {
        if (entry.line.includes('Executed list')) resolveEntry(entry)
      })
    })
    await manager.sendCommand(instance.id, 'list')
    expect((await commandOutput).line).toContain('Executed list')

    const stopped = await manager.stop(instance.id)
    expect(stopped.runtime.status).toBe('offline')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
    await expect(access(join(serverDirectory, '.emberhost-runtime.json'))).rejects.toThrow()
  })

  it('runs offline maintenance under the lifecycle queue and lets a requested start wait', async () => {
    const { instance, manager, launches } = await createHarness()
    const entered = deferred()
    const release = deferred()

    const maintenance = manager.runOfflineMaintenance(instance.id, async (context) => {
      expect(context.instance).toEqual(instance)
      expect(context.restartAfter).toBe(false)
      expect(manager.getView(instance).runtime.status).toBe('offline')
      entered.resolve()
      await release.promise
      return 'snapshot-created'
    })
    await entered.promise

    const queuedStart = manager.start(instance.id)
    await expect(manager.sendCommand(instance.id, 'list')).rejects.toMatchObject({ code: 'SERVER_MAINTENANCE' })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
    expect(launches).toHaveLength(0)

    release.resolve()
    await expect(maintenance).resolves.toBe('snapshot-created')
    expect((await queuedStart).runtime.status).toBe('starting')
    expect(launches).toHaveLength(1)
    await manager.stop(instance.id)
  })

  it('stops an empty online server for maintenance, restarts it, then runs a queued stop', async () => {
    const { instance, manager, launches } = await createHarness()
    await startOnline(manager, instance.id)
    const entered = deferred()
    const release = deferred()

    const maintenance = manager.runOfflineMaintenance(instance.id, async (context) => {
      expect(context.instance.id).toBe(instance.id)
      expect(context.restartAfter).toBe(true)
      expect(manager.getView(instance).runtime.status).toBe('offline')
      entered.resolve()
      await release.promise
      return 42
    })
    await entered.promise
    const queuedStop = manager.stop(instance.id)
    release.resolve()

    await expect(maintenance).resolves.toBe(42)
    expect((await queuedStop).runtime.status).toBe('offline')
    expect(launches).toHaveLength(2)
  })

  it('rejects console commands as soon as maintenance is queued', async () => {
    const { instance, manager } = await createHarness()
    await startOnline(manager, instance.id)
    const blockerEntered = deferred()
    const releaseBlocker = deferred()
    const blocker = manager.runExclusive(instance.id, async () => {
      blockerEntered.resolve()
      await releaseBlocker.promise
    })
    await blockerEntered.promise

    const maintenance = manager.runOfflineMaintenance(instance.id, async ({ restartAfter }) => {
      expect(restartAfter).toBe(true)
    })
    await expect(manager.sendCommand(instance.id, 'list')).rejects.toMatchObject({
      code: 'SERVER_MAINTENANCE',
      message: expect.stringContaining('maintenance')
    })

    releaseBlocker.resolve()
    await blocker
    await maintenance
    await manager.stop(instance.id)
  })

  it('refuses to stop an online server while players are connected', async () => {
    const { instance, manager, launches } = await createHarness()
    await startOnline(manager, instance.id)
    const playerJoined = waitFor<StateEvent>((resolveEvent) => {
      manager.onState((event) => {
        if (event.instanceId === instance.id && event.runtime.playerCount === 1) resolveEvent(event)
      })
    })
    await manager.sendCommand(instance.id, 'join Alex')
    await playerJoined
    let called = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      called = true
    })).rejects.toMatchObject({
      code: 'PLAYERS_CONNECTED',
      message: expect.stringContaining('every player disconnects')
    })
    expect(called).toBe(false)
    expect(manager.getView(instance).runtime.status).toBe('online')
    expect(launches).toHaveLength(1)
    await manager.stop(instance.id)
  })

  it('finalizes prepared maintenance without stopping when a player joins during beforeStop', async () => {
    const { instance, manager, launches } = await createHarness(10, { autoJoinDelayMs: 50 })
    await startOnline(manager, instance.id)
    const joined = waitFor<StateEvent>((resolveEvent) => {
      manager.onState((event) => {
        if (event.instanceId === instance.id && event.runtime.playerCount === 1) resolveEvent(event)
      })
    })
    let snapshotRan = false
    let finalized = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      snapshotRan = true
    }, {
      beforeStop: async () => { await joined },
      finalize: async () => { finalized = true }
    })).rejects.toMatchObject({ code: 'PLAYERS_CONNECTED' })

    expect(snapshotRan).toBe(false)
    expect(finalized).toBe(true)
    expect(launches).toHaveLength(1)
    expect(manager.getView(instance).runtime.status).toBe('online')
    await manager.stop(instance.id)
  })

  it('reports an actionable error when the server is still starting', async () => {
    const { instance, manager } = await createHarness(10_000)
    expect((await manager.start(instance.id)).runtime.status).toBe('starting')

    await expect(manager.runOfflineMaintenance(instance.id, async () => undefined)).rejects.toMatchObject({
      code: 'SERVER_BUSY',
      message: expect.stringContaining('finish starting')
    })
    await manager.stop(instance.id)
  })

  it('does not restart a server when shutdown begins during maintenance', async () => {
    const { instance, manager, launches } = await createHarness()
    await startOnline(manager, instance.id)
    const entered = deferred()
    const release = deferred()
    const maintenance = manager.runOfflineMaintenance(instance.id, async ({ restartAfter }) => {
      expect(restartAfter).toBe(true)
      entered.resolve()
      await release.promise
    })
    await entered.promise

    manager.beginShutdown()
    release.resolve()
    await maintenance
    expect(manager.getView(instance).runtime.status).toBe('offline')
    expect(launches).toHaveLength(1)
    manager.cancelShutdown()
  })

  it('restarts an originally online server when the maintenance callback fails', async () => {
    const { instance, manager, launches } = await createHarness()
    await startOnline(manager, instance.id)
    const restarted = waitFor<StateEvent>((resolveEvent) => {
      manager.onState((event) => {
        if (event.instanceId === instance.id && event.runtime.status === 'online') resolveEvent(event)
      })
    })

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      throw new Error('The backup copy failed.')
    })).rejects.toThrow('The backup copy failed.')
    await restarted
    expect(launches).toHaveLength(2)
    await manager.stop(instance.id)
  })

  it('aborts maintenance after a forced stop, restores readiness, and never invokes the snapshot callback', async () => {
    const { instance, manager, launches } = await createHarness(10, {
      ignoreStop: true,
      gracefulStopTimeoutMs: 20,
      forcedStopTimeoutMs: 1_000,
      maintenanceReadinessTimeoutMs: 1_000
    })
    await startOnline(manager, instance.id)
    let prepared = false
    let finalized = false
    let snapshotRan = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      snapshotRan = true
    }, {
      beforeStop: async () => { prepared = true },
      finalize: async () => { finalized = true }
    })).rejects.toMatchObject({ code: 'MAINTENANCE_STOP_UNCLEAN' })

    expect(prepared).toBe(true)
    expect(snapshotRan).toBe(false)
    expect(finalized).toBe(true)
    expect(launches).toHaveLength(2)
    expect(manager.getView(instance).runtime.status).toBe('online')
    await manager.stop(instance.id)
  })

  it('rejects when Java exits during marker preparation, then restores readiness before finalizing', async () => {
    const { instance, manager, launches } = await createHarness(10, {
      maintenanceReadinessTimeoutMs: 1_000
    })
    await startOnline(manager, instance.id)
    let snapshotRan = false
    let finalized = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      snapshotRan = true
    }, {
      beforeStop: async () => {
        const pid = manager.getView(instance).runtime.pid
        if (pid === null) throw new Error('Expected the fake Java process to be running.')
        const exited = waitFor<StateEvent>((resolveEvent) => {
          manager.onState((event) => {
            if (event.instanceId === instance.id &&
              (event.runtime.status === 'offline' || event.runtime.status === 'crashed')) {
              resolveEvent(event)
            }
          })
        })
        process.kill(pid)
        await exited
      },
      finalize: async () => { finalized = true }
    })).rejects.toMatchObject({ code: 'MAINTENANCE_STOP_UNCLEAN' })

    expect(snapshotRan).toBe(false)
    expect(finalized).toBe(true)
    expect(launches).toHaveLength(2)
    expect(manager.getView(instance).runtime.status).toBe('online')
    await manager.stop(instance.id)
  })

  it.each(['nonzero-stop', 'closed-stdin'] as const)(
    'rejects %s as an unclean maintenance stop while preserving ordinary stop semantics',
    async (stopMode) => {
      const { instance, manager, launches } = await createHarness(10, {
        stopMode,
        gracefulStopTimeoutMs: 20,
        forcedStopTimeoutMs: 1_000,
        maintenanceReadinessTimeoutMs: 1_000
      })
      await startOnline(manager, instance.id)
      let snapshotRan = false

      await expect(manager.runOfflineMaintenance(instance.id, async () => {
        snapshotRan = true
      }, {
        beforeStop: async () => undefined,
        finalize: async () => undefined
      })).rejects.toMatchObject({ code: 'MAINTENANCE_STOP_UNCLEAN' })

      expect(snapshotRan).toBe(false)
      expect(launches).toHaveLength(2)
      expect(manager.getView(instance).runtime.status).toBe('online')
      await expect(manager.stop(instance.id)).resolves.toMatchObject({ runtime: { status: 'offline' } })
    }
  )

  it('awaits and rejects a delayed stdin callback error before entering maintenance', async () => {
    const { instance, manager, launches } = await createHarness(10, {
      gracefulStopTimeoutMs: 20,
      forcedStopTimeoutMs: 1_000,
      maintenanceReadinessTimeoutMs: 1_000,
      delayedMaintenanceWriteErrorMs: 10
    })
    await startOnline(manager, instance.id)
    let snapshotRan = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      snapshotRan = true
    }, {
      beforeStop: async () => undefined,
      finalize: async () => undefined
    })).rejects.toMatchObject({ code: 'MAINTENANCE_STOP_UNCLEAN' })

    expect(snapshotRan).toBe(false)
    expect(launches).toHaveLength(2)
    expect(manager.getView(instance).runtime.status).toBe('online')
    await manager.stop(instance.id)
  })

  it('validates offline ownership before invoking maintenance', async () => {
    const { instance, manager } = await createHarness()
    await writeFile(
      join(instance.serverDirectory, '.emberhost-runtime.json'),
      `${JSON.stringify({ instanceId: instance.id, pid: process.pid, status: 'running' })}\n`,
      'utf8'
    )
    let called = false

    await expect(manager.runOfflineMaintenance(instance.id, async () => {
      called = true
    })).rejects.toMatchObject({ code: 'ORPHAN_PROCESS' })
    expect(called).toBe(false)
  })
})
