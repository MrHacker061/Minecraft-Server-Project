import { randomUUID } from 'node:crypto'
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConsoleEntry, StateEvent } from '../../shared/contracts'
import type {
  AddForceLoadedRegionInput,
  ForceLoadedRegion,
  ForceLoadedRegionsState,
  RemoveForceLoadedRegionInput,
  StartWorldPreparationInput,
  WorldDimension,
  WorldPreparationState
} from '../../shared/world-contracts'
import { parseChunkyConsoleLine } from './chunky'
import { AppError } from './errors'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'

const MIN_PREPARATION_RADIUS = 256
const MAX_PREPARATION_RADIUS = 20_000
const MAX_FORCE_REGIONS = 8
const MAX_FORCE_RADIUS = 7
const MAX_FORCE_CHUNKS = 256
const WORLD_BLOCK_LIMIT = 29_999_984

const worldDimensionSchema = z.enum(['overworld', 'nether', 'end'])
const instanceIdSchema = z.string().uuid()

const worldPreparationSchema = z.object({
  instanceId: instanceIdSchema,
  radius: z.number().int().min(MIN_PREPARATION_RADIUS).max(MAX_PREPARATION_RADIUS),
  dimensions: z.array(worldDimensionSchema).min(1).max(3)
})

const forceRegionSchema = z.object({
  instanceId: instanceIdSchema,
  dimension: worldDimensionSchema,
  centerX: z.number().int().min(-WORLD_BLOCK_LIMIT).max(WORLD_BLOCK_LIMIT),
  centerZ: z.number().int().min(-WORLD_BLOCK_LIMIT).max(WORLD_BLOCK_LIMIT),
  radius: z.number().int().min(1).max(MAX_FORCE_RADIUS)
})

interface PersistedPerformanceState {
  schemaVersion: 1
  preparation: WorldPreparationState
  forceRegions: ForceLoadedRegion[]
}

interface LoadedState {
  preparation: WorldPreparationState
  forceRegions: ForceLoadedRegion[]
}

type PreparationListener = (state: WorldPreparationState) => void
type ForceRegionsListener = (state: ForceLoadedRegionsState) => void

export function validateWorldPreparationInput(input: unknown): StartWorldPreparationInput {
  const result = worldPreparationSchema.safeParse(input)
  if (!result.success) {
    throw new AppError(
      `Choose one or more dimensions and a radius from ${MIN_PREPARATION_RADIUS.toLocaleString()} to ${MAX_PREPARATION_RADIUS.toLocaleString()} blocks.`,
      'VALIDATION_ERROR'
    )
  }
  const dimensions = [...new Set(result.data.dimensions)]
  if (dimensions.length !== result.data.dimensions.length) {
    throw new AppError('Each dimension can only be prepared once.', 'VALIDATION_ERROR')
  }
  return { ...result.data, dimensions }
}

export function validateForceLoadedRegionInput(input: unknown): AddForceLoadedRegionInput {
  const result = forceRegionSchema.safeParse(input)
  if (!result.success) {
    throw new AppError(
      `Use whole block coordinates and a radius from 1 to ${MAX_FORCE_RADIUS} chunks.`,
      'VALIDATION_ERROR'
    )
  }
  const bounds = regionBounds(result.data)
  const blockBounds = [
    bounds.minChunkX * 16,
    bounds.maxChunkX * 16 + 15,
    bounds.minChunkZ * 16,
    bounds.maxChunkZ * 16 + 15
  ]
  if (blockBounds.some((coordinate) => !Number.isSafeInteger(coordinate) || Math.abs(coordinate) > WORLD_BLOCK_LIMIT)) {
    throw new AppError('That radius would extend beyond Minecraft’s world boundary.', 'VALIDATION_ERROR')
  }
  return result.data
}

function emptyPreparation(instanceId: string): WorldPreparationState {
  return {
    instanceId,
    status: 'idle',
    radius: 5_000,
    dimensions: ['overworld'],
    currentDimension: null,
    completedChunks: 0,
    totalChunks: 0,
    percent: 0,
    rateCps: null,
    autoPaused: false,
    message: 'Choose a radius to prepare terrain before players explore.',
    error: null
  }
}

function clonePreparation(state: WorldPreparationState): WorldPreparationState {
  return { ...state, dimensions: [...state.dimensions] }
}

function dimensionWorldName(dimension: WorldDimension, levelName: string): string {
  if (dimension === 'nether') return levelName + '_nether'
  if (dimension === 'end') return levelName + '_the_end'
  return levelName
}

function dimensionId(dimension: WorldDimension): string {
  if (dimension === 'nether') return 'minecraft:the_nether'
  if (dimension === 'end') return 'minecraft:the_end'
  return 'minecraft:overworld'
}

function parseLevelName(properties: string): string {
  let levelName = 'world'
  for (const line of properties.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0 || line.slice(0, separator).trim() !== 'level-name') continue
    levelName = line.slice(separator + 1).trim()
  }
  if (
    !levelName ||
    levelName === '.' ||
    levelName === '..' ||
    levelName.length > 128 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(levelName) ||
    /[. ]$/.test(levelName)
  ) {
    throw new AppError('The level-name in server.properties is not a safe world-folder name.', 'INVALID_LEVEL_NAME')
  }
  return levelName
}

function consoleMessage(line: string): string {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9A-FK-OR]/gi, '')
  const loggerBoundary = plain.indexOf(']: ')
  return loggerBoundary >= 0 ? plain.slice(loggerBoundary + 3) : plain
}

function estimatedChunks(radius: number): number {
  const chunkRadius = Math.ceil(radius / 16)
  return (chunkRadius * 2 + 1) ** 2
}

function regionBounds(region: Pick<ForceLoadedRegion, 'centerX' | 'centerZ' | 'radius'>): {
  minChunkX: number
  maxChunkX: number
  minChunkZ: number
  maxChunkZ: number
} {
  const centerChunkX = Math.floor(region.centerX / 16)
  const centerChunkZ = Math.floor(region.centerZ / 16)
  return {
    minChunkX: centerChunkX - region.radius,
    maxChunkX: centerChunkX + region.radius,
    minChunkZ: centerChunkZ - region.radius,
    maxChunkZ: centerChunkZ + region.radius
  }
}

function overlaps(left: ForceLoadedRegion, right: AddForceLoadedRegionInput): boolean {
  if (left.dimension !== right.dimension) return false
  const a = regionBounds(left)
  const b = regionBounds(right)
  return a.minChunkX <= b.maxChunkX && a.maxChunkX >= b.minChunkX && a.minChunkZ <= b.maxChunkZ && a.maxChunkZ >= b.minChunkZ
}

const persistedPreparationSchema = z.object({
  instanceId: instanceIdSchema,
  status: z.enum(['idle', 'running', 'paused', 'completed', 'cancelled', 'failed']),
  radius: z.number().int().min(MIN_PREPARATION_RADIUS).max(MAX_PREPARATION_RADIUS),
  dimensions: z.array(worldDimensionSchema).min(1).max(3),
  currentDimension: worldDimensionSchema.nullable(),
  completedChunks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalChunks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  percent: z.number().min(0).max(100),
  rateCps: z.number().nonnegative().finite().nullable(),
  autoPaused: z.boolean(),
  message: z.string().max(2_000).nullable(),
  error: z.string().max(2_000).nullable()
}).superRefine((state, context) => {
  if (new Set(state.dimensions).size !== state.dimensions.length) {
    context.addIssue({ code: 'custom', message: 'Preparation dimensions must be unique.' })
  }
  if (state.completedChunks > state.totalChunks) {
    context.addIssue({ code: 'custom', message: 'Preparation progress exceeds its total.' })
  }
  if (state.currentDimension && !state.dimensions.includes(state.currentDimension)) {
    context.addIssue({ code: 'custom', message: 'The current preparation dimension is invalid.' })
  }
  if (['running', 'paused'].includes(state.status) && !state.currentDimension) {
    context.addIssue({ code: 'custom', message: 'An active preparation must have a current dimension.' })
  }
})

const persistedForceRegionSchema = z.object({
  id: instanceIdSchema,
  dimension: worldDimensionSchema,
  centerX: z.number().int().min(-WORLD_BLOCK_LIMIT).max(WORLD_BLOCK_LIMIT),
  centerZ: z.number().int().min(-WORLD_BLOCK_LIMIT).max(WORLD_BLOCK_LIMIT),
  radius: z.number().int().min(1).max(MAX_FORCE_RADIUS),
  chunkCount: z.number().int().positive()
}).superRefine((region, context) => {
  if (region.chunkCount !== (region.radius * 2 + 1) ** 2) {
    context.addIssue({ code: 'custom', message: 'The force-loaded chunk count is invalid.' })
  }
  const bounds = regionBounds(region)
  const coordinates = [
    bounds.minChunkX * 16,
    bounds.maxChunkX * 16 + 15,
    bounds.minChunkZ * 16,
    bounds.maxChunkZ * 16 + 15
  ]
  if (coordinates.some((coordinate) => !Number.isSafeInteger(coordinate) || Math.abs(coordinate) > WORLD_BLOCK_LIMIT)) {
    context.addIssue({ code: 'custom', message: 'A force-loaded region extends outside the world.' })
  }
})

const persistedPerformanceStateSchema = z.object({
  schemaVersion: z.literal(1),
  preparation: persistedPreparationSchema,
  forceRegions: z.array(persistedForceRegionSchema).max(MAX_FORCE_REGIONS)
}).superRefine((state, context) => {
  if (new Set(state.forceRegions.map((region) => region.id)).size !== state.forceRegions.length) {
    context.addIssue({ code: 'custom', message: 'Force-loaded region identifiers must be unique.' })
  }
  if (state.forceRegions.reduce((sum, region) => sum + region.chunkCount, 0) > MAX_FORCE_CHUNKS) {
    context.addIssue({ code: 'custom', message: 'Too many chunks are force-loaded.' })
  }
  for (let leftIndex = 0; leftIndex < state.forceRegions.length; leftIndex += 1) {
    const left = state.forceRegions[leftIndex]
    if (!left) continue
    for (let rightIndex = leftIndex + 1; rightIndex < state.forceRegions.length; rightIndex += 1) {
      const right = state.forceRegions[rightIndex]
      if (right && overlaps(left, { ...right, instanceId: state.preparation.instanceId })) {
        context.addIssue({ code: 'custom', message: 'Saved force-loaded regions overlap.' })
      }
    }
  }
})

export class WorldService {
  private readonly states = new Map<string, LoadedState>()
  private readonly levelNames = new Map<string, string>()
  private readonly preparationListeners = new Set<PreparationListener>()
  private readonly forceListeners = new Set<ForceRegionsListener>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly deletingInstances = new Set<string>()
  private readonly pauseRequested = new Set<string>()
  private readonly cancelRequested = new Set<string>()
  private readonly backupsInProgress = new Set<string>()
  private readonly taintedBackups = new Set<string>()
  private readonly consoleWaiters = new Map<string, Set<{
    predicate: (line: string) => boolean
    resolve: (matched: boolean) => void
    timeout: NodeJS.Timeout
  }>>()

  constructor(
    private readonly store: AppStore,
    private readonly manager: ServerManager
  ) {
    manager.onConsole((entry) => this.handleConsole(entry))
    manager.onState((event) => this.handleRuntime(event))
  }

  onWorldPreparationChange(listener: PreparationListener): () => void {
    this.preparationListeners.add(listener)
    return () => this.preparationListeners.delete(listener)
  }

  onForceLoadedRegionsChange(listener: ForceRegionsListener): () => void {
    this.forceListeners.add(listener)
    return () => this.forceListeners.delete(listener)
  }

  async beginInstanceDeletion(instanceId: string): Promise<void> {
    const id = instanceIdSchema.parse(instanceId)
    if (this.deletingInstances.has(id)) {
      throw new AppError('That server is already being deleted.', 'INSTANCE_DELETING')
    }
    this.deletingInstances.add(id)
    try {
      await (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined)
    } catch (error) {
      this.deletingInstances.delete(id)
      throw error
    }
  }

  abortInstanceDeletion(instanceId: string): void {
    this.deletingInstances.delete(instanceId)
  }

  completeInstanceDeletion(instanceId: string): void {
    this.states.delete(instanceId)
    this.levelNames.delete(instanceId)
    this.pauseRequested.delete(instanceId)
    this.cancelRequested.delete(instanceId)
    this.backupsInProgress.delete(instanceId)
    this.taintedBackups.delete(instanceId)
    const waiters = this.consoleWaiters.get(instanceId)
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.resolve(false)
      }
      this.consoleWaiters.delete(instanceId)
    }
  }

  async getWorldPreparation(instanceId: string): Promise<WorldPreparationState> {
    const id = instanceIdSchema.parse(instanceId)
    return this.serialize(id, async () => {
      this.requirePaper(id)
      const state = await this.load(id)
      return clonePreparation(state.preparation)
    })
  }

  async startWorldPreparation(input: StartWorldPreparationInput): Promise<WorldPreparationState> {
    const parsed = validateWorldPreparationInput(input)
    return this.serialize(parsed.instanceId, async () => {
      const instance = this.requireOnlinePaper(parsed.instanceId)
      if (this.manager.getView(instance).runtime.playerCount > 0) {
        throw new AppError('World preparation can only start while no players are connected.', 'PLAYERS_CONNECTED')
      }
      const loaded = await this.load(parsed.instanceId)
      if (['running', 'paused'].includes(loaded.preparation.status)) {
        throw new AppError('Resume or cancel the current world preparation before starting another.', 'WORLD_PREPARATION_BUSY')
      }
      const totalChunks = estimatedChunks(parsed.radius) * parsed.dimensions.length
      loaded.preparation = {
        instanceId: parsed.instanceId,
        status: 'running',
        radius: parsed.radius,
        dimensions: [...parsed.dimensions],
        currentDimension: parsed.dimensions[0] ?? null,
        completedChunks: 0,
        totalChunks,
        percent: 0,
        rateCps: null,
        autoPaused: false,
        message: 'Starting controlled chunk preparation…',
        error: null
      }
      this.pauseRequested.delete(parsed.instanceId)
      this.cancelRequested.delete(parsed.instanceId)
      await this.persist(parsed.instanceId, loaded)
      this.emitPreparation(loaded.preparation)
      loaded.preparation.message = 'Flushing the world and creating a safety backup…'
      await this.persist(parsed.instanceId, loaded)
      this.emitPreparation(loaded.preparation)
      try {
        await this.createBackup(parsed.instanceId, parsed.dimensions)
        if (this.manager.getView(instance).runtime.playerCount > 0) {
          throw new AppError('A player joined before preparation could start.', 'PLAYERS_CONNECTED')
        }
        loaded.preparation.message = 'Backup complete. Starting controlled chunk preparation…'
        await this.persist(parsed.instanceId, loaded)
        this.emitPreparation(loaded.preparation)
        await this.configureAndStart(parsed.instanceId, loaded.preparation.currentDimension, parsed.radius)
      } catch (error) {
        loaded.preparation.status = 'failed'
        loaded.preparation.currentDimension = null
        loaded.preparation.message = null
        loaded.preparation.error = error instanceof Error ? error.message : 'World preparation could not start.'
        await this.persist(parsed.instanceId, loaded)
        this.emitPreparation(loaded.preparation)
        throw error
      }
      return clonePreparation(loaded.preparation)
    })
  }

  async pauseWorldPreparation(instanceId: string): Promise<WorldPreparationState> {
    const id = instanceIdSchema.parse(instanceId)
    return this.serialize(id, () => this.requestPause(id, false, 'Pausing safely after the current chunk operations finish…'))
  }

  async resumeWorldPreparation(instanceId: string): Promise<WorldPreparationState> {
    const id = instanceIdSchema.parse(instanceId)
    return this.serialize(id, async () => {
      const instance = this.requireOnlinePaper(id)
      const loaded = await this.load(id)
      if (loaded.preparation.status !== 'paused' || !loaded.preparation.currentDimension) {
        throw new AppError('There is no paused world preparation task to resume.', 'WORLD_PREPARATION_NOT_PAUSED')
      }
      const runtime = this.manager.getView(instance).runtime
      if (runtime.playerCount > 0) {
        throw new AppError('World preparation can only resume while no players are connected.', 'PLAYERS_CONNECTED')
      }
      const unhealthy = (runtime.health.tps !== null && runtime.health.tps < 18) ||
        (runtime.health.mspt !== null && runtime.health.mspt > 48)
      if (unhealthy) {
        throw new AppError('Wait for server tick health to recover before resuming preparation.', 'SERVER_UNHEALTHY')
      }
      const world = await this.worldName(id, loaded.preparation.currentDimension)
      const acknowledgment = { event: null as ReturnType<typeof parseChunkyConsoleLine> }
      const confirmation = this.waitForConsole(id, (line) => {
        const event = parseChunkyConsoleLine(line)
        const matches = event?.kind === 'no-tasks' ||
          (event?.kind === 'continuing' && event.world.toLowerCase() === world.toLowerCase())
        if (matches) acknowledgment.event = event
        return matches
      }, 15_000)
      await this.manager.sendCommand(id, `chunky world ${world}`)
      let continueSent = false
      try {
        await this.manager.sendCommand(id, 'chunky continue')
        continueSent = true
        if (!(await confirmation)) {
          return await this.stopForUnconfirmedChunkyAction(id, loaded, 'resume')
        }
      } catch (error) {
        if (continueSent) {
          if (error instanceof AppError && error.code === 'CHUNKY_ACTION_UNCONFIRMED') throw error
          return await this.stopForUnconfirmedChunkyAction(id, loaded, 'resume', error)
        }
        throw error
      }
      if (acknowledgment.event?.kind === 'no-tasks') {
        loaded.preparation.status = 'failed'
        loaded.preparation.currentDimension = null
        loaded.preparation.rateCps = null
        loaded.preparation.message = null
        loaded.preparation.error = 'Chunky could not find the saved preparation task.'
        await this.persist(id, loaded)
        this.emitPreparation(loaded.preparation)
        throw new AppError(loaded.preparation.error, 'CHUNKY_TASK_NOT_FOUND')
      }
      loaded.preparation.status = 'running'
      loaded.preparation.autoPaused = false
      loaded.preparation.message = `Resuming ${loaded.preparation.currentDimension} preparation…`
      loaded.preparation.error = null
      this.pauseRequested.delete(id)
      await this.persist(id, loaded)
      this.emitPreparation(loaded.preparation)
      return clonePreparation(loaded.preparation)
    })
  }

  async cancelWorldPreparation(instanceId: string): Promise<WorldPreparationState> {
    const id = instanceIdSchema.parse(instanceId)
    return this.serialize(id, async () => {
      this.requireOnlinePaper(id)
      const loaded = await this.load(id)
      if (!['running', 'paused'].includes(loaded.preparation.status) || !loaded.preparation.currentDimension) {
        throw new AppError('There is no world preparation task to cancel.', 'WORLD_PREPARATION_NOT_RUNNING')
      }
      const world = await this.worldName(id, loaded.preparation.currentDimension)
      const acknowledgment = { event: null as ReturnType<typeof parseChunkyConsoleLine> }
      const confirmation = this.waitForConsole(id, (line) => {
        const event = parseChunkyConsoleLine(line)
        const matches = event?.kind === 'no-tasks' ||
          ((event?.kind === 'cancelled' || event?.kind === 'stopped') && event.world.toLowerCase() === world.toLowerCase())
        if (matches) acknowledgment.event = event
        return matches
      }, 15_000)
      this.cancelRequested.add(id)
      loaded.preparation.message = 'Cancelling the saved task safely…'
      try {
        await this.persist(id, loaded)
        this.emitPreparation(loaded.preparation)
        await this.manager.sendCommand(id, `chunky world ${world}`)
        await this.manager.sendCommand(id, 'chunky cancel')
        await this.manager.sendCommand(id, 'chunky confirm')
        if (!(await confirmation)) {
          return await this.stopForUnconfirmedChunkyAction(id, loaded, 'cancel')
        }
      } catch (error) {
        this.cancelRequested.delete(id)
        if (error instanceof AppError && error.code === 'CHUNKY_ACTION_UNCONFIRMED') throw error
        return await this.stopForUnconfirmedChunkyAction(id, loaded, 'cancel', error)
      }
      this.cancelRequested.delete(id)
      this.pauseRequested.delete(id)
      loaded.preparation.status = acknowledgment.event?.kind === 'no-tasks' ? 'failed' : 'cancelled'
      loaded.preparation.currentDimension = null
      loaded.preparation.rateCps = null
      loaded.preparation.autoPaused = false
      loaded.preparation.message = acknowledgment.event?.kind === 'no-tasks'
        ? null
        : 'World preparation was cancelled. Already-generated chunks were kept.'
      loaded.preparation.error = acknowledgment.event?.kind === 'no-tasks'
        ? 'Chunky could not find the saved preparation task.'
        : null
      await this.persist(id, loaded)
      this.emitPreparation(loaded.preparation)
      return clonePreparation(loaded.preparation)
    })
  }

  async getForceLoadedRegions(instanceId: string): Promise<ForceLoadedRegionsState> {
    const id = instanceIdSchema.parse(instanceId)
    return this.serialize(id, async () => {
      this.requirePaper(id)
      const loaded = await this.load(id)
      return this.forceState(id, loaded.forceRegions)
    })
  }

  async addForceLoadedRegion(input: AddForceLoadedRegionInput): Promise<ForceLoadedRegionsState> {
    const parsed = validateForceLoadedRegionInput(input)
    return this.serialize(parsed.instanceId, async () => {
      this.requireOnlinePaper(parsed.instanceId)
      const loaded = await this.load(parsed.instanceId)
      if (loaded.forceRegions.length >= MAX_FORCE_REGIONS) {
        throw new AppError(`A server can have at most ${MAX_FORCE_REGIONS} EmberHost-managed force-loaded regions.`, 'FORCE_LOAD_LIMIT')
      }
      if (loaded.forceRegions.some((region) => overlaps(region, parsed))) {
        throw new AppError('That region overlaps another EmberHost-managed force-loaded region.', 'FORCE_LOAD_OVERLAP')
      }
      const chunkCount = (parsed.radius * 2 + 1) ** 2
      const totalChunks = loaded.forceRegions.reduce((sum, region) => sum + region.chunkCount, 0) + chunkCount
      if (totalChunks > MAX_FORCE_CHUNKS) {
        throw new AppError(`Force-loaded regions are limited to ${MAX_FORCE_CHUNKS} total chunks.`, 'FORCE_LOAD_LIMIT')
      }
      const region: ForceLoadedRegion = {
        id: randomUUID(),
        dimension: parsed.dimension,
        centerX: parsed.centerX,
        centerZ: parsed.centerZ,
        radius: parsed.radius,
        chunkCount
      }
      const bounds = regionBounds(region)
      await this.manager.sendCommand(parsed.instanceId, this.forceLoadCommand('add', region.dimension, bounds))
      loaded.forceRegions.push(region)
      try {
        await this.persist(parsed.instanceId, loaded)
      } catch (error) {
        loaded.forceRegions = loaded.forceRegions.filter((candidate) => candidate.id !== region.id)
        try {
          await this.manager.sendCommand(parsed.instanceId, this.forceLoadCommand('remove', region.dimension, bounds))
        } catch (compensationError) {
          throw new AppError(
            'The region was force-loaded, but its metadata and rollback could not be saved. Remove it from the server console before continuing.',
            'FORCE_LOAD_RECONCILIATION_FAILED',
            compensationError instanceof Error ? compensationError.message : undefined
          )
        }
        throw error
      }
      const state = this.forceState(parsed.instanceId, loaded.forceRegions)
      this.emitForceRegions(state)
      return state
    })
  }

  async removeForceLoadedRegion(input: RemoveForceLoadedRegionInput): Promise<ForceLoadedRegionsState> {
    const instanceId = instanceIdSchema.parse(input.instanceId)
    const regionId = instanceIdSchema.parse(input.regionId)
    return this.serialize(instanceId, async () => {
      this.requireOnlinePaper(instanceId)
      const loaded = await this.load(instanceId)
      const index = loaded.forceRegions.findIndex((region) => region.id === regionId)
      const region = loaded.forceRegions[index]
      if (!region) throw new AppError('That force-loaded region no longer exists.', 'FORCE_LOAD_NOT_FOUND')
      const bounds = regionBounds(region)
      await this.manager.sendCommand(instanceId, this.forceLoadCommand('remove', region.dimension, bounds))
      loaded.forceRegions.splice(index, 1)
      try {
        await this.persist(instanceId, loaded)
      } catch (error) {
        loaded.forceRegions.splice(index, 0, region)
        try {
          await this.manager.sendCommand(instanceId, this.forceLoadCommand('add', region.dimension, bounds))
        } catch (compensationError) {
          throw new AppError(
            'The region was unmarked, but its metadata and rollback could not be saved. Re-add it from the server console before continuing.',
            'FORCE_LOAD_RECONCILIATION_FAILED',
            compensationError instanceof Error ? compensationError.message : undefined
          )
        }
        throw error
      }
      const state = this.forceState(instanceId, loaded.forceRegions)
      this.emitForceRegions(state)
      return state
    })
  }

  async awaitIdle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled([...this.queues.values()])
      await Promise.resolve()
    }
  }

  private async configureAndStart(instanceId: string, dimension: WorldDimension | null, radius: number): Promise<void> {
    if (!dimension) throw new AppError('Choose at least one dimension.', 'VALIDATION_ERROR')
    const world = await this.worldName(instanceId, dimension)
    await this.manager.sendCommand(instanceId, `chunky world ${world}`)
    await this.manager.sendCommand(instanceId, 'chunky shape square')
    await this.manager.sendCommand(instanceId, 'chunky spawn')
    await this.manager.sendCommand(instanceId, `chunky radius ${radius}`)
    const instance = this.requireOnlinePaper(instanceId)
    if (this.manager.getView(instance).runtime.playerCount > 0) {
      throw new AppError('A player joined before preparation could start.', 'PLAYERS_CONNECTED')
    }
    const started = this.waitForConsole(instanceId, (line) => {
      const event = parseChunkyConsoleLine(line)
      return event?.kind === 'started' && event.world.toLowerCase() === world.toLowerCase()
    }, 15_000)
    let startSent = false
    try {
      await this.manager.sendCommand(instanceId, 'chunky start')
      startSent = true
      if (!(await started)) {
        throw new AppError('Chunky did not confirm that world preparation started.', 'CHUNKY_START_TIMEOUT')
      }
    } catch (error) {
      if (startSent) {
        await this.manager.sendCommand(instanceId, 'chunky cancel').catch(() => undefined)
        await this.manager.sendCommand(instanceId, 'chunky confirm').catch(() => undefined)
        try {
          await this.manager.stop(instanceId)
        } catch (stopError) {
          throw new AppError(
            'Chunky start could not be confirmed and Paper could not be stopped. Stop the Java process before continuing.',
            'CHUNKY_ACTION_UNCONFIRMED',
            stopError instanceof Error ? stopError.message : undefined
          )
        }
      }
      throw error
    }
  }

  private async requestPause(instanceId: string, automatic: boolean, message: string): Promise<WorldPreparationState> {
    this.requireOnlinePaper(instanceId)
    const loaded = await this.load(instanceId)
    if (loaded.preparation.status !== 'running' || !loaded.preparation.currentDimension) {
      throw new AppError('World preparation is not currently running.', 'WORLD_PREPARATION_NOT_RUNNING')
    }
    const world = await this.worldName(instanceId, loaded.preparation.currentDimension)
    const acknowledgment = { event: null as ReturnType<typeof parseChunkyConsoleLine> }
    const confirmation = this.waitForConsole(instanceId, (line) => {
      const event = parseChunkyConsoleLine(line)
      const matches = event?.kind === 'no-tasks' ||
        (event?.kind === 'stopped' && event.world.toLowerCase() === world.toLowerCase())
      if (matches) acknowledgment.event = event
      return matches
    }, 15_000)
    this.pauseRequested.add(instanceId)
    loaded.preparation.autoPaused = automatic
    loaded.preparation.message = message
    try {
      await this.persist(instanceId, loaded)
      this.emitPreparation(loaded.preparation)
      await this.manager.sendCommand(instanceId, `chunky world ${world}`)
      await this.manager.sendCommand(instanceId, 'chunky pause')
      if (!(await confirmation)) {
        return await this.stopForUnconfirmedChunkyAction(instanceId, loaded, 'pause')
      }
    } catch (error) {
      this.pauseRequested.delete(instanceId)
      if (error instanceof AppError && error.code === 'CHUNKY_ACTION_UNCONFIRMED') throw error
      return await this.stopForUnconfirmedChunkyAction(instanceId, loaded, 'pause', error)
    }
    this.pauseRequested.delete(instanceId)
    if (acknowledgment.event?.kind === 'no-tasks') {
      loaded.preparation.status = 'failed'
      loaded.preparation.currentDimension = null
      loaded.preparation.rateCps = null
      loaded.preparation.message = null
      loaded.preparation.error = 'Chunky could not find the saved preparation task.'
      await this.persist(instanceId, loaded)
      this.emitPreparation(loaded.preparation)
      throw new AppError(loaded.preparation.error, 'CHUNKY_TASK_NOT_FOUND')
    }
    loaded.preparation.status = 'paused'
    loaded.preparation.rateCps = null
    loaded.preparation.message = automatic
      ? 'Automatically paused to protect active players and tick health.'
      : 'Preparation paused safely.'
    await this.persist(instanceId, loaded)
    this.emitPreparation(loaded.preparation)
    return clonePreparation(loaded.preparation)
  }

  private async stopForUnconfirmedChunkyAction(
    instanceId: string,
    loaded: LoadedState,
    action: 'pause' | 'cancel' | 'resume',
    cause?: unknown
  ): Promise<never> {
    this.pauseRequested.delete(instanceId)
    this.cancelRequested.delete(instanceId)
    let stopped = true
    let stopError: unknown = null
    try {
      await this.manager.stop(instanceId)
    } catch (error) {
      stopped = false
      stopError = error
    }

    const label = action === 'cancel' ? 'Cancellation' : action === 'resume' ? 'Resume' : 'Pause'
    if (stopped) {
      loaded.preparation.status = 'paused'
      loaded.preparation.autoPaused = false
      loaded.preparation.rateCps = null
      loaded.preparation.message = label + ' could not be confirmed, so EmberHost stopped Paper to prevent unmanaged generation.'
    } else {
      loaded.preparation.message = label + ' could not be confirmed and Paper could not be stopped. Stop the Java process before continuing.'
    }
    loaded.preparation.error = loaded.preparation.message
    await this.persist(instanceId, loaded)
    this.emitPreparation(loaded.preparation)
    throw new AppError(
      loaded.preparation.message,
      'CHUNKY_ACTION_UNCONFIRMED',
      stopError instanceof Error
        ? stopError.message
        : cause instanceof Error
          ? cause.message
          : undefined
    )
  }

  private handleConsole(entry: ConsoleEntry): void {
    const waiters = this.consoleWaiters.get(entry.instanceId)
    if (waiters) {
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(entry.line)) continue
        clearTimeout(waiter.timeout)
        waiters.delete(waiter)
        waiter.resolve(true)
      }
      if (!waiters.size) this.consoleWaiters.delete(entry.instanceId)
    }
    const parsed = parseChunkyConsoleLine(entry.line)
    if (!parsed || !this.states.has(entry.instanceId)) return
    void this.serialize(entry.instanceId, async () => {
      const loaded = await this.load(entry.instanceId)
      const state = loaded.preparation
      if (!['running', 'paused'].includes(state.status)) return
      const dimension = state.currentDimension
      if ('world' in parsed && dimension) {
        const expectedWorld = await this.worldName(entry.instanceId, dimension)
        if (parsed.world.toLowerCase() !== expectedWorld.toLowerCase()) return
      }

      if (parsed.kind === 'progress') {
        const index = Math.max(0, state.dimensions.indexOf(state.currentDimension ?? 'overworld'))
        state.percent = Math.min(100, ((index + parsed.percent / 100) / state.dimensions.length) * 100)
        state.completedChunks = Math.min(state.totalChunks, Math.round(state.totalChunks * state.percent / 100))
        state.rateCps = parsed.rate
        state.message = `Preparing ${state.currentDimension ?? 'world'} at ${parsed.rate.toFixed(1)} chunks/sec.`
      } else if (parsed.kind === 'complete') {
        const index = state.dimensions.indexOf(state.currentDimension ?? 'overworld')
        const next = state.dimensions[index + 1]
        if (next) {
          state.percent = ((index + 1) / state.dimensions.length) * 100
          state.completedChunks = Math.round(state.totalChunks * state.percent / 100)
          state.currentDimension = next
          state.message = `Finished ${dimension}; starting ${next}…`
          await this.persist(entry.instanceId, loaded)
          this.emitPreparation(state)
          try {
            await this.configureAndStart(entry.instanceId, next, state.radius)
          } catch (error) {
            state.status = 'failed'
            state.currentDimension = null
            state.rateCps = null
            state.message = null
            state.error = error instanceof Error ? error.message : 'The next dimension could not start.'
            await this.persist(entry.instanceId, loaded)
            this.emitPreparation(state)
          }
          return
        }
        state.status = 'completed'
        state.currentDimension = null
        state.completedChunks = state.totalChunks
        state.percent = 100
        state.rateCps = null
        state.autoPaused = false
        state.message = 'Selected dimensions are prepared and ready for smooth exploration.'
      } else if (parsed.kind === 'stopped' && this.pauseRequested.has(entry.instanceId)) {
        this.pauseRequested.delete(entry.instanceId)
        state.status = 'paused'
        state.rateCps = null
        state.message = state.autoPaused ? 'Automatically paused to protect active players and tick health.' : 'Preparation paused safely.'
      } else if (parsed.kind === 'cancelled' || (parsed.kind === 'stopped' && this.cancelRequested.has(entry.instanceId))) {
        this.cancelRequested.delete(entry.instanceId)
        this.pauseRequested.delete(entry.instanceId)
        state.status = 'cancelled'
        state.currentDimension = null
        state.rateCps = null
        state.autoPaused = false
        state.message = 'World preparation was cancelled. Already-generated chunks were kept.'
      } else if (parsed.kind === 'no-tasks' && ['running', 'paused'].includes(state.status)) {
        state.status = 'failed'
        state.currentDimension = null
        state.rateCps = null
        state.error = 'Chunky could not find the saved preparation task.'
        state.message = null
      }
      await this.persist(entry.instanceId, loaded)
      this.emitPreparation(state)
    }).catch(() => undefined)
  }

  private handleRuntime(event: StateEvent): void {
    if (['offline', 'crashed'].includes(event.runtime.status)) this.levelNames.delete(event.instanceId)
    if (this.backupsInProgress.has(event.instanceId) && event.runtime.playerCount > 0) {
      this.taintedBackups.add(event.instanceId)
    }
    const loaded = this.states.get(event.instanceId)
    if (!loaded) return
    const state = loaded.preparation
    if (state.status === 'running' && event.runtime.status === 'online') {
      const unhealthy = (event.runtime.health.tps !== null && event.runtime.health.tps < 18) ||
        (event.runtime.health.mspt !== null && event.runtime.health.mspt > 48)
      if ((event.runtime.playerCount > 0 || unhealthy) && !this.pauseRequested.has(event.instanceId)) {
        const reason = event.runtime.playerCount > 0
          ? 'Automatically pausing because a player joined…'
          : 'Automatically pausing because server tick health dropped…'
        void this.serialize(event.instanceId, () => this.requestPause(event.instanceId, true, reason)).catch(() => undefined)
      }
    } else if (state.status === 'paused' && state.autoPaused && event.runtime.status === 'online' && event.runtime.playerCount === 0) {
      const healthy = (event.runtime.health.tps === null || event.runtime.health.tps >= 19) &&
        (event.runtime.health.mspt === null || event.runtime.health.mspt <= 45)
      if (healthy) void this.resumeWorldPreparation(event.instanceId).catch(() => undefined)
    } else if (state.status === 'running' && ['offline', 'crashed'].includes(event.runtime.status)) {
      void this.serialize(event.instanceId, async () => {
        const current = await this.load(event.instanceId)
        if (current.preparation.status !== 'running') return
        current.preparation.status = 'paused'
        current.preparation.autoPaused = false
        current.preparation.rateCps = null
        current.preparation.message = 'Preparation paused because the server stopped. Start the server, then resume.'
        await this.persist(event.instanceId, current)
        this.emitPreparation(current.preparation)
      }).catch(() => undefined)
    }
  }

  private forceLoadCommand(
    action: 'add' | 'remove',
    dimension: WorldDimension,
    bounds: ReturnType<typeof regionBounds>
  ): string {
    const minX = bounds.minChunkX * 16
    const minZ = bounds.minChunkZ * 16
    const maxX = bounds.maxChunkX * 16 + 15
    const maxZ = bounds.maxChunkZ * 16 + 15
    return `execute in ${dimensionId(dimension)} run forceload ${action} ${minX} ${minZ} ${maxX} ${maxZ}`
  }

  private async createBackup(instanceId: string, dimensions: WorldDimension[]): Promise<void> {
    const instance = this.requireOnlinePaper(instanceId)
    const flushed = this.waitForConsole(instanceId, (line) => /^Saved the game\b/i.test(consoleMessage(line)), 15_000)
    await this.manager.sendCommand(instanceId, 'save-all flush')
    if (!(await flushed)) {
      throw new AppError('Minecraft did not confirm that the world was flushed, so preparation was cancelled.', 'BACKUP_FLUSH_TIMEOUT')
    }
    const savingDisabled = this.waitForConsole(
      instanceId,
      (line) => /^Automatic saving is now disabled\b/i.test(consoleMessage(line)),
      10_000
    )
    await this.manager.sendCommand(instanceId, 'save-off')
    const backupRoot = join(instance.serverDirectory, 'emberhost-backups')
    const name = `world-prep-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const finalDirectory = join(backupRoot, name)
    const stagingDirectory = `${finalDirectory}.staging`
    try {
      if (!(await savingDisabled)) {
        throw new AppError('Minecraft did not confirm that saving was paused, so preparation was cancelled.', 'BACKUP_SAVE_OFF_TIMEOUT')
      }
      if (this.manager.getView(instance).runtime.playerCount > 0) {
        throw new AppError('A player joined before the backup began, so preparation was cancelled.', 'PLAYERS_CONNECTED')
      }
      this.backupsInProgress.add(instanceId)
      this.taintedBackups.delete(instanceId)
      await mkdir(stagingDirectory, { recursive: true })
      const levelName = await this.levelName(instanceId)
      const candidates = new Set<string>([levelName])
      if (dimensions.includes('nether')) candidates.add(levelName + '_nether')
      if (dimensions.includes('end')) candidates.add(levelName + '_the_end')
      const copied: string[] = []
      for (const folder of candidates) {
        const source = join(instance.serverDirectory, folder)
        try {
          await access(source)
        } catch {
          throw new AppError(
            'The expected world folder "' + folder + '" does not exist, so no incomplete backup was accepted.',
            'BACKUP_WORLD_NOT_FOUND'
          )
        }
        await cp(source, join(stagingDirectory, folder), {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true
        })
        copied.push(folder)
      }
      if (this.taintedBackups.has(instanceId) || this.manager.getView(instance).runtime.playerCount > 0) {
        throw new AppError(
          'A player was active while the backup was being copied, so the incomplete backup was discarded.',
          'PLAYERS_CONNECTED'
        )
      }
      await writeFile(
        join(stagingDirectory, 'emberhost-backup.json'),
        `${JSON.stringify({ instanceId, createdAt: new Date().toISOString(), levelName, dimensions, copied }, null, 2)}\n`,
        'utf8'
      )
      await mkdir(backupRoot, { recursive: true })
      await rename(stagingDirectory, finalDirectory)
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      if (error instanceof AppError) throw error
      throw new AppError(
        'EmberHost could not create the world backup. Check free disk space and folder permissions.',
        'BACKUP_FAILED',
        error instanceof Error ? error.message : undefined
      )
    } finally {
      this.backupsInProgress.delete(instanceId)
      this.taintedBackups.delete(instanceId)
      await this.restoreAutomaticSaving(instanceId)
    }
  }

  private async restoreAutomaticSaving(instanceId: string): Promise<void> {
    const enabled = this.waitForConsole(
      instanceId,
      (line) => /^Automatic saving is now enabled\b/i.test(consoleMessage(line)),
      10_000
    )
    let commandError: unknown = null
    try {
      await this.manager.sendCommand(instanceId, 'save-on')
    } catch (error) {
      commandError = error
    }
    if (!commandError && await enabled) return

    let stopped = true
    try {
      await this.manager.stop(instanceId)
    } catch {
      stopped = false
    }
    throw new AppError(
      stopped
        ? 'Minecraft did not confirm that automatic saving was restored, so EmberHost stopped the server to protect the world.'
        : 'Minecraft did not confirm that automatic saving was restored, and the server could not be stopped. Stop Java before continuing.',
      'BACKUP_SAVE_ON_TIMEOUT',
      commandError instanceof Error ? commandError.message : undefined
    )
  }

  private waitForConsole(instanceId: string, predicate: (line: string) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiters = this.consoleWaiters.get(instanceId) ?? new Set()
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          if (!waiters.size) this.consoleWaiters.delete(instanceId)
          resolve(false)
        }, timeoutMs)
      }
      waiters.add(waiter)
      this.consoleWaiters.set(instanceId, waiters)
    })
  }

  private forceState(instanceId: string, regions: ForceLoadedRegion[]): ForceLoadedRegionsState {
    return {
      instanceId,
      regions: regions.map((region) => ({ ...region })),
      maxRegions: MAX_FORCE_REGIONS,
      maxRadius: MAX_FORCE_RADIUS,
      maxTotalChunks: MAX_FORCE_CHUNKS,
      totalChunks: regions.reduce((sum, region) => sum + region.chunkCount, 0)
    }
  }

  private async levelName(instanceId: string): Promise<string> {
    const cached = this.levelNames.get(instanceId)
    if (cached) return cached
    const instance = this.requirePaper(instanceId)
    let properties = ''
    try {
      properties = await readFile(join(instance.serverDirectory, 'server.properties'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const value = parseLevelName(properties)
    this.levelNames.set(instanceId, value)
    return value
  }

  private async worldName(instanceId: string, dimension: WorldDimension): Promise<string> {
    return dimensionWorldName(dimension, await this.levelName(instanceId))
  }

  private async load(instanceId: string): Promise<LoadedState> {
    const existing = this.states.get(instanceId)
    if (existing) return existing
    const instance = this.requirePaper(instanceId)
    let state: LoadedState = { preparation: emptyPreparation(instanceId), forceRegions: [] }
    try {
      const raw = persistedPerformanceStateSchema.parse(
        JSON.parse(await readFile(join(instance.serverDirectory, 'emberhost-performance.json'), 'utf8'))
      )
      if (raw.preparation.instanceId !== instanceId) throw new Error('Performance metadata belongs to another server.')
      state = {
        preparation: clonePreparation(raw.preparation),
        forceRegions: raw.forceRegions.map((region) => ({ ...region }))
      }
      if (state.preparation.status === 'running') {
        state.preparation.status = 'paused'
        state.preparation.autoPaused = false
        state.preparation.rateCps = null
        state.preparation.message = 'Preparation was interrupted when EmberHost closed. Start the server, then resume.'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        state.preparation.message = 'Saved performance-task metadata could not be read; server world data was left untouched.'
      }
    }
    this.states.set(instanceId, state)
    return state
  }

  private async persist(instanceId: string, state: LoadedState): Promise<void> {
    const instance = this.requirePaper(instanceId)
    const filePath = join(instance.serverDirectory, 'emberhost-performance.json')
    const temporaryPath = `${filePath}.tmp`
    const value: PersistedPerformanceState = {
      schemaVersion: 1,
      preparation: clonePreparation(state.preparation),
      forceRegions: state.forceRegions.map((region) => ({ ...region }))
    }
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private requirePaper(instanceId: string) {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (instance.software.kind !== 'paper') {
      throw new AppError('World preparation and managed force-loading require a Paper server.', 'PAPER_REQUIRED')
    }
    return instance
  }

  private requireOnlinePaper(instanceId: string) {
    const instance = this.requirePaper(instanceId)
    if (this.manager.getView(instance).runtime.status !== 'online') {
      throw new AppError('Start the Paper server before changing world operations.', 'SERVER_OFFLINE')
    }
    return instance
  }

  private emitPreparation(state: WorldPreparationState): void {
    const cloned = clonePreparation(state)
    for (const listener of this.preparationListeners) listener(cloned)
  }

  private emitForceRegions(state: ForceLoadedRegionsState): void {
    const cloned = { ...state, regions: state.regions.map((region) => ({ ...region })) }
    for (const listener of this.forceListeners) listener(cloned)
  }

  private serialize<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(instanceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => {
      if (this.deletingInstances.has(instanceId)) {
        throw new AppError('That server is being deleted.', 'INSTANCE_DELETING')
      }
      return operation()
    })
    this.queues.set(instanceId, next)
    const cleanup = (): void => {
      if (this.queues.get(instanceId) === next) this.queues.delete(instanceId)
    }
    void next.then(cleanup, cleanup)
    return next
  }
}
