import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleEntry, InstanceRuntime, ServerInstance, StateEvent } from '../src/shared/contracts'
import { PERFORMANCE_PROFILES, matchingPerformancePreset, profileValues } from '../src/shared/performance'
import { AppStore } from '../src/main/services/store'
import type { ServerManager } from '../src/main/services/server-manager'
import {
  validateForceLoadedRegionInput,
  validateWorldPreparationInput,
  WorldService
} from '../src/main/services/world-service'

const INSTANCE_ID = '0497aa5e-ac48-4c67-bb1e-f742007f3679'
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function onlineRuntime(): InstanceRuntime {
  return {
    status: 'online',
    pid: 1234,
    startedAt: '2026-07-31T00:00:00.000Z',
    lastExitCode: null,
    playerCount: 0,
    players: [],
    health: { tps: 20, mspt: 10, memoryUsedMb: 1024, memoryMaxMb: 4096, cpuPercent: 20 }
  }
}

class FakeManager {
  readonly commands: string[] = []
  runtime = onlineRuntime()
  acknowledgeSaveOff = true
  failCommandContaining: string | null = null
  stopCalls = 0
  private chunkyWorld = 'world'
  private readonly consoleListeners = new Set<(entry: ConsoleEntry) => void>()
  private readonly stateListeners = new Set<(event: StateEvent) => void>()

  onConsole(listener: (entry: ConsoleEntry) => void): () => void {
    this.consoleListeners.add(listener)
    return () => this.consoleListeners.delete(listener)
  }

  onState(listener: (event: StateEvent) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  getView(instance: ServerInstance) {
    return { ...instance, runtime: this.runtime }
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    this.commands.push(command)
    if (this.failCommandContaining && command.includes(this.failCommandContaining)) {
      throw new Error(`Rejected test command: ${command}`)
    }
    if (command === 'save-all flush') {
      setTimeout(() => this.emitConsole(instanceId, '[Server thread/INFO]: Saved the game'), 0)
    } else if (command === 'save-off' && this.acknowledgeSaveOff) {
      setTimeout(() => this.emitConsole(instanceId, '[Server thread/INFO]: Automatic saving is now disabled'), 0)
    } else if (command === 'save-on') {
      this.emitConsole(instanceId, '[Server thread/INFO]: Automatic saving is now enabled')
    } else if (command.startsWith('chunky world ')) {
      this.chunkyWorld = command.slice('chunky world '.length)
    } else if (command === 'chunky start') {
      setTimeout(() => this.emitConsole(instanceId, `[Server thread/INFO]: [Chunky] Task started in ${this.chunkyWorld} for the square shape.`), 0)
    } else if (command === 'chunky continue') {
      setTimeout(() => this.emitConsole(instanceId, `[Server thread/INFO]: [Chunky] Task continuing for ${this.chunkyWorld}.`), 0)
    }
  }

  async stop(instanceId: string) {
    this.stopCalls += 1
    this.runtime = {
      ...this.runtime,
      status: 'offline',
      pid: null,
      startedAt: null,
      playerCount: 0,
      players: []
    }
    this.emitRuntime(instanceId)
    return { runtime: this.runtime }
  }

  emitConsole(instanceId: string, line: string): void {
    const entry: ConsoleEntry = {
      id: String(this.commands.length + 1),
      instanceId,
      timestamp: new Date().toISOString(),
      stream: 'stdout',
      level: 'info',
      line
    }
    for (const listener of this.consoleListeners) listener(entry)
  }

  emitRuntime(instanceId: string): void {
    const event = { instanceId, runtime: this.runtime }
    for (const listener of this.stateListeners) listener(event)
  }
}

async function harness(): Promise<{
  service: WorldService
  manager: FakeManager
  instance: ServerInstance
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-performance-'))
  temporaryDirectories.push(directory)
  const serverDirectory = join(directory, 'server')
  await mkdir(join(serverDirectory, 'world', 'region'), { recursive: true })
  await mkdir(join(serverDirectory, 'world_nether', 'region'), { recursive: true })
  await mkdir(join(serverDirectory, 'world_the_end', 'region'), { recursive: true })
  await writeFile(join(serverDirectory, 'world', 'level.dat'), 'world fixture', 'utf8')
  await writeFile(join(serverDirectory, 'world_nether', 'level.dat'), 'nether fixture', 'utf8')
  await writeFile(join(serverDirectory, 'world_the_end', 'level.dat'), 'end fixture', 'utf8')
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  const instance: ServerInstance = {
    id: INSTANCE_ID,
    name: 'Performance world',
    version: '26.2',
    serverDirectory,
    software: { kind: 'paper', build: 87, channel: 'STABLE' },
    launchArtifact: 'paper.jar',
    jarSha1: null,
    artifactSha256: 'a'.repeat(64),
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25565,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Performance test',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 12,
    simulationDistance: 8,
    performancePreset: 'balanced',
    eulaAcceptedAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  }
  await store.addInstance(instance)
  const manager = new FakeManager()
  const service = new WorldService(store, manager as unknown as ServerManager)
  return { service, manager, instance }
}

describe('performance profiles', () => {
  it('keeps every advertised simulation distance inside its view distance', () => {
    for (const profile of Object.values(PERFORMANCE_PROFILES)) {
      expect(profile.memoryMb).toBeGreaterThanOrEqual(2048)
      expect(profile.viewDistance).toBeGreaterThanOrEqual(3)
      expect(profile.viewDistance).toBeLessThanOrEqual(32)
      expect(profile.simulationDistance).toBeGreaterThanOrEqual(3)
      expect(profile.simulationDistance).toBeLessThanOrEqual(profile.viewDistance)
    }
  })

  it('reserves host memory and recognizes exact uncapped profile values', () => {
    expect(profileValues('far-view', 8192)).toMatchObject({ memoryMb: 4096, viewDistance: 16, simulationDistance: 6 })
    expect(profileValues('balanced', 32768).memoryMb).toBe(4096)
    expect(matchingPerformancePreset(6144, 16, 6)).toBe('far-view')
    expect(matchingPerformancePreset(6144, 15, 6)).toBe('custom')
  })
})

describe('world preparation validation and lifecycle', () => {
  it('accepts only a bounded radius and a unique, nonempty dimension selection', () => {
    expect(validateWorldPreparationInput({
      instanceId: INSTANCE_ID,
      radius: 256,
      dimensions: ['overworld', 'nether', 'end']
    })).toMatchObject({ radius: 256, dimensions: ['overworld', 'nether', 'end'] })

    for (const input of [
      { instanceId: INSTANCE_ID, radius: 255, dimensions: ['overworld'] },
      { instanceId: INSTANCE_ID, radius: 20_001, dimensions: ['overworld'] },
      { instanceId: INSTANCE_ID, radius: 5000, dimensions: [] },
      { instanceId: INSTANCE_ID, radius: 5000, dimensions: ['nether', 'nether'] },
      { instanceId: INSTANCE_ID, radius: 5000.5, dimensions: ['overworld'] }
    ]) {
      expect(() => validateWorldPreparationInput(input)).toThrow()
    }
  })

  it('waits for saved pause/cancel acknowledgments and advances dimensions on completion', async () => {
    const { service, manager } = await harness()
    const started = await service.startWorldPreparation({
      instanceId: INSTANCE_ID,
      radius: 256,
      dimensions: ['overworld', 'nether']
    })
    expect(started).toMatchObject({ status: 'running', currentDimension: 'overworld', percent: 0 })
    expect(manager.commands).toEqual([
      'save-all flush',
      'save-off',
      'save-on',
      'chunky world world',
      'chunky shape square',
      'chunky spawn',
      'chunky radius 256',
      'chunky start'
    ])

    manager.emitConsole(INSTANCE_ID, '[19:10:01 INFO]: [Chunky] Task running for world. Processed: 512 chunks (50.00%), ETA: 0:00:10, Rate: 51.2 cps, Current: -1, 2')
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({ status: 'running', percent: 25, rateCps: 51.2 })

    const pausing = service.pauseWorldPreparation(INSTANCE_ID)
    await vi.waitFor(() => expect(manager.commands).toContain('chunky pause'))
    manager.emitConsole(INSTANCE_ID, '[19:10:02 INFO]: [Chunky] Task paused for world.')
    manager.emitConsole(INSTANCE_ID, '[19:10:03 INFO]: [Chunky] Task stopped for world.')
    const requestedPause = await pausing
    expect(requestedPause.status).toBe('paused')
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({ status: 'paused', currentDimension: 'overworld' })

    await service.resumeWorldPreparation(INSTANCE_ID)
    expect((await service.getWorldPreparation(INSTANCE_ID)).status).toBe('running')
    manager.emitConsole(INSTANCE_ID, '[19:10:04 INFO]: [Chunky] Task finished for world. Processed: 1,089 chunks (100.00%), Total time: 0:01:00')
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({
      status: 'running',
      currentDimension: 'nether',
      percent: 50
    })
    expect(manager.commands.slice(-5)).toEqual([
      'chunky world world_nether',
      'chunky shape square',
      'chunky spawn',
      'chunky radius 256',
      'chunky start'
    ])

    manager.emitConsole(INSTANCE_ID, '[19:11:04 INFO]: [Chunky] Task finished for world_nether. Processed: 1,089 chunks (100.00%), Total time: 0:01:00')
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({
      status: 'completed',
      currentDimension: null,
      percent: 100,
      rateCps: null
    })
  })

  it('sends Chunky\'s required cancel confirmation and transitions only after acknowledgment', async () => {
    const { service, manager } = await harness()
    await service.startWorldPreparation({ instanceId: INSTANCE_ID, radius: 256, dimensions: ['overworld'] })

    const cancelling = service.cancelWorldPreparation(INSTANCE_ID)
    await vi.waitFor(() => expect(manager.commands).toContain('chunky confirm'))
    expect(manager.commands.slice(-3)).toEqual(['chunky world world', 'chunky cancel', 'chunky confirm'])

    manager.emitConsole(INSTANCE_ID, '[19:10:06 INFO]: [Chunky] Task cancelled for world.')
    const requestedCancel = await cancelling
    expect(requestedCancel.status).toBe('cancelled')
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({
      status: 'cancelled',
      currentDimension: null,
      percent: 0
    })
  })

  it('blocks regeneration while world preparation is running or paused and releases the barrier on refusal', async () => {
    const { service, manager } = await harness()
    await service.startWorldPreparation({ instanceId: INSTANCE_ID, radius: 256, dimensions: ['overworld'] })

    let backupRan = false
    await expect(service.runBackupOperation(INSTANCE_ID, async () => {
      backupRan = true
    })).rejects.toMatchObject({ code: 'WORLD_PREPARATION_BUSY' })
    expect(backupRan).toBe(false)

    await expect(service.beginWorldRegeneration(INSTANCE_ID)).rejects.toMatchObject({
      code: 'WORLD_PREPARATION_BUSY'
    })
    await expect(service.getWorldPreparation(INSTANCE_ID)).resolves.toMatchObject({ status: 'running' })

    const pausing = service.pauseWorldPreparation(INSTANCE_ID)
    await vi.waitFor(() => expect(manager.commands).toContain('chunky pause'))
    manager.emitConsole(INSTANCE_ID, '[19:10:02 INFO]: [Chunky] Task paused for world.')
    manager.emitConsole(INSTANCE_ID, '[19:10:03 INFO]: [Chunky] Task stopped for world.')
    await pausing
    await service.awaitIdle()

    await expect(service.beginWorldRegeneration(INSTANCE_ID)).rejects.toMatchObject({
      code: 'WORLD_PREPARATION_BUSY'
    })
    await expect(service.runBackupOperation(INSTANCE_ID, async () => {
      backupRan = true
    })).rejects.toMatchObject({ code: 'WORLD_PREPARATION_BUSY' })
    expect(backupRan).toBe(false)
    await expect(service.getWorldPreparation(INSTANCE_ID)).resolves.toMatchObject({ status: 'paused' })
  })

  it('uses a safe custom level-name for backups and Chunky world selection', async () => {
    const { service, manager, instance } = await harness()
    await rename(join(instance.serverDirectory, 'world'), join(instance.serverDirectory, 'custom_world'))
    await writeFile(join(instance.serverDirectory, 'server.properties'), 'level-name=custom_world\n', 'utf8')

    await service.startWorldPreparation({
      instanceId: INSTANCE_ID,
      radius: 256,
      dimensions: ['overworld']
    })

    expect(manager.commands).toContain('chunky world custom_world')
  })

  it('restores automatic saving and records failure when save-off is not acknowledged', async () => {
    vi.useFakeTimers()
    const { service, manager } = await harness()
    manager.acknowledgeSaveOff = false

    const starting = service.startWorldPreparation({
      instanceId: INSTANCE_ID,
      radius: 256,
      dimensions: ['overworld']
    })
    await vi.waitFor(() => expect(manager.commands).toContain('save-off'))
    await vi.advanceTimersByTimeAsync(10_001)

    await expect(starting).rejects.toMatchObject({ code: 'BACKUP_SAVE_OFF_TIMEOUT' })
    expect(manager.commands).toContain('save-on')
    expect(manager.commands).not.toContain('chunky start')
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({
      status: 'failed',
      currentDimension: null
    })
  })

  it('stops Paper when a safe Chunky pause cannot be confirmed', async () => {
    const { service, manager } = await harness()
    await service.startWorldPreparation({ instanceId: INSTANCE_ID, radius: 256, dimensions: ['overworld'] })
    vi.useFakeTimers()

    const pausing = service.pauseWorldPreparation(INSTANCE_ID)
    await vi.waitFor(() => expect(manager.commands).toContain('chunky pause'))
    await vi.advanceTimersByTimeAsync(15_001)

    await expect(pausing).rejects.toMatchObject({ code: 'CHUNKY_ACTION_UNCONFIRMED' })
    expect(manager.stopCalls).toBe(1)
    await service.awaitIdle()
    expect(await service.getWorldPreparation(INSTANCE_ID)).toMatchObject({
      status: 'paused',
      autoPaused: false
    })
  })
})

describe('managed force-loaded region bounds', () => {
  it('rejects invalid radii, unsafe coordinates, and regions whose expanded bounds leave the world', () => {
    expect(validateForceLoadedRegionInput({
      instanceId: INSTANCE_ID,
      dimension: 'overworld',
      centerX: 0,
      centerZ: 0,
      radius: 4
    })).toMatchObject({ centerX: 0, centerZ: 0, radius: 4 })

    for (const input of [
      { instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 0, centerZ: 0, radius: 0 },
      { instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 0, centerZ: 0, radius: 8 },
      { instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 0.5, centerZ: 0, radius: 1 },
      { instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 29_999_984, centerZ: 0, radius: 4 },
      { instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 0, centerZ: -29_999_984, radius: 4 }
    ]) {
      expect(() => validateForceLoadedRegionInput(input)).toThrow()
    }
  })

  it('uses exact chunk-boundary commands and refuses a cumulative selection above 256 chunks', async () => {
    const { service, manager } = await harness()
    const first = await service.addForceLoadedRegion({
      instanceId: INSTANCE_ID,
      dimension: 'overworld',
      centerX: 0,
      centerZ: 0,
      radius: 4
    })
    expect(first).toMatchObject({ totalChunks: 81, maxTotalChunks: 256, maxRadius: 7 })
    expect(manager.commands.at(-1)).toBe('execute in minecraft:overworld run forceload add -64 -64 79 79')

    await service.addForceLoadedRegion({ instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 160, centerZ: 0, radius: 4 })
    await service.addForceLoadedRegion({ instanceId: INSTANCE_ID, dimension: 'overworld', centerX: 320, centerZ: 0, radius: 4 })
    const bounded = await service.addForceLoadedRegion({
      instanceId: INSTANCE_ID,
      dimension: 'overworld',
      centerX: 480,
      centerZ: 0,
      radius: 1
    })
    expect(bounded.totalChunks).toBe(252)
    const commandCount = manager.commands.length

    await expect(service.addForceLoadedRegion({
      instanceId: INSTANCE_ID,
      dimension: 'overworld',
      centerX: 560,
      centerZ: 0,
      radius: 1
    })).rejects.toMatchObject({ code: 'FORCE_LOAD_LIMIT' })
    expect(manager.commands).toHaveLength(commandCount)
  })

  it('rejects overlaps before dispatch and removes only the recorded exact region', async () => {
    const { service, manager } = await harness()
    const added = await service.addForceLoadedRegion({
      instanceId: INSTANCE_ID,
      dimension: 'nether',
      centerX: -1,
      centerZ: -1,
      radius: 1
    })
    const region = added.regions[0]
    if (!region) throw new Error('Expected a force-loaded region')
    const commandCount = manager.commands.length

    await expect(service.addForceLoadedRegion({
      instanceId: INSTANCE_ID,
      dimension: 'nether',
      centerX: -16,
      centerZ: -16,
      radius: 1
    })).rejects.toMatchObject({ code: 'FORCE_LOAD_OVERLAP' })
    expect(manager.commands).toHaveLength(commandCount)

    const removed = await service.removeForceLoadedRegion({ instanceId: INSTANCE_ID, regionId: region.id })
    expect(removed).toMatchObject({ totalChunks: 0, regions: [] })
    expect(manager.commands.at(-1)).toBe('execute in minecraft:the_nether run forceload remove -32 -32 15 15')
  })

  it('changes persisted regions only after Minecraft accepts the force-load command', async () => {
    const { service, manager } = await harness()
    const input = {
      instanceId: INSTANCE_ID,
      dimension: 'overworld' as const,
      centerX: 0,
      centerZ: 0,
      radius: 1
    }
    manager.failCommandContaining = 'forceload add'

    await expect(service.addForceLoadedRegion(input)).rejects.toThrow('Rejected test command')
    expect(await service.getForceLoadedRegions(INSTANCE_ID)).toMatchObject({ totalChunks: 0, regions: [] })

    manager.failCommandContaining = null
    const added = await service.addForceLoadedRegion(input)
    const region = added.regions[0]
    if (!region) throw new Error('Expected a force-loaded region')
    manager.failCommandContaining = 'forceload remove'

    await expect(service.removeForceLoadedRegion({ instanceId: INSTANCE_ID, regionId: region.id })).rejects.toThrow('Rejected test command')
    expect(await service.getForceLoadedRegions(INSTANCE_ID)).toMatchObject({ totalChunks: 9 })
    expect((await service.getForceLoadedRegions(INSTANCE_ID)).regions).toHaveLength(1)
  })

  it('blocks new world operations while instance deletion owns the per-server barrier', async () => {
    const { service } = await harness()

    await service.beginInstanceDeletion(INSTANCE_ID)
    await expect(service.getWorldPreparation(INSTANCE_ID)).rejects.toMatchObject({ code: 'INSTANCE_DELETING' })

    service.abortInstanceDeletion(INSTANCE_ID)
    await expect(service.getWorldPreparation(INSTANCE_ID)).resolves.toMatchObject({ instanceId: INSTANCE_ID })

    await service.beginInstanceDeletion(INSTANCE_ID)
    service.completeInstanceDeletion(INSTANCE_ID)
    await expect(service.getForceLoadedRegions(INSTANCE_ID)).rejects.toMatchObject({ code: 'INSTANCE_DELETING' })
  })
})
