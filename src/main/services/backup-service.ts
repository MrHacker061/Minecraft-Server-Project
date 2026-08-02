import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type {
  BackupPolicy,
  BackupState,
  ServerInstance,
  StateEvent,
  UpdateBackupPolicyInput
} from '../../shared/contracts'
import { AppError } from './errors'
import { parseLevelName } from './properties'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'
import {
  assertNoBackupInProgress,
  BACKUP_MARKER_FILE,
  readBackupInProgressMarker,
  type BackupInProgressMarker
} from './backup-safety'
import { assertNoInterruptedWorldRegeneration } from './world-regeneration-safety'

const POLICY_FILE = 'emberhost-backup-policy.json'
const BACKUP_ROOT = 'emberhost-backups'
const AUTOMATIC_DIRECTORY = 'automatic'
const MANIFEST_FILE = 'emberhost-backup.json'
const FIRST_BACKUP_DELAY_MS = 15 * 60 * 1000
const FAILURE_RETRY_MS = 15 * 60 * 1000
const BUSY_RETRY_MS = 5 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 1000
const MAX_POLICY_BYTES = 32 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const MIN_FREE_RESERVE_BYTES = 2n * 1024n * 1024n * 1024n
const AUTO_NAME_PATTERN = /^auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const STAGING_NAME_PATTERN = /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const intervalSchema = z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)])
const retentionSchema = z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7), z.literal(14)])
const persistedPolicySchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  enabled: z.boolean(),
  intervalHours: intervalSchema,
  retentionCount: retentionSchema,
  enabledAt: z.string().datetime({ offset: true }),
  lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
  lastError: z.string().max(2_000).nullable()
})

const manifestWorldSchema = z.object({
  name: z.string().min(1).max(160),
  fileCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

const automaticManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('automatic'),
  backupId: z.string().uuid(),
  instanceId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  captureMode: z.enum(['offline', 'offline-maintenance']),
  minecraftVersion: z.string().min(1).max(64),
  software: z.enum(['vanilla', 'paper', 'forge']),
  levelName: z.string().min(1).max(128),
  worlds: z.array(manifestWorldSchema).min(1).max(3),
  fileCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  scope: z.literal('active-world-only')
})

type PersistedPolicy = z.infer<typeof persistedPolicySchema>
type AutomaticManifest = z.infer<typeof automaticManifestSchema>
type BackupOperationExecutor = <T>(instanceId: string, operation: () => Promise<T>) => Promise<T>
type BackupListener = (state: BackupState) => void

interface TreeSummary {
  fileCount: number
  totalBytes: number
}

interface BackupTransaction {
  backupId: string
  stagingName: string
  createdAt: string
  restartAfter: boolean
  safeToFinalize: boolean
}

interface ValidBackup {
  path: string
  name: string
  manifest: AutomaticManifest
}

interface DiskStats {
  bavail: bigint
  bsize: bigint
  blocks: bigint
}

interface BackupServiceDependencies {
  now: () => Date
  setInterval: (callback: () => void, milliseconds: number) => NodeJS.Timeout
  clearInterval: (timer: NodeJS.Timeout) => void
  statfs: (path: string) => Promise<DiskStats>
  copyDirectory: (source: string, destination: string) => Promise<void>
}

const defaultDependencies: BackupServiceDependencies = {
  now: () => new Date(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
  statfs: async (path) => {
    const value = await statfs(path, { bigint: true })
    return { bavail: value.bavail, bsize: value.bsize, blocks: value.blocks }
  },
  copyDirectory: (source, destination) => cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
    verbatimSymlinks: true
  })
}

function clonePolicy(policy: BackupPolicy): BackupPolicy {
  return { ...policy }
}

function cloneState(state: BackupState): BackupState {
  return { ...state, policy: clonePolicy(state.policy) }
}

function publicPolicy(record: PersistedPolicy): BackupPolicy {
  return {
    enabled: record.enabled,
    intervalHours: record.intervalHours,
    retentionCount: record.retentionCount,
    enabledAt: record.enabledAt
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkedAdd(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw new AppError('The world is too large to verify safely.', 'BACKUP_TOO_LARGE')
  return value
}

function isDeferredError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  return ['PLAYERS_CONNECTED', 'SERVER_BUSY', 'SERVER_CRASHED', 'WORLD_PREPARATION_BUSY', 'INSTANCE_DELETING', 'WORLD_REGENERATING'].includes(error.code)
}

export class BackupService {
  private readonly serversDirectory: string
  private readonly dependencies: BackupServiceDependencies
  private readonly policies = new Map<string, PersistedPolicy>()
  private readonly states = new Map<string, BackupState>()
  private readonly listeners = new Set<BackupListener>()
  private readonly retryNotBefore = new Map<string, number>()
  private readonly automaticRetryBlocked = new Set<string>()
  private readonly pending = new Map<string, Promise<BackupState>>()
  private readonly policyQueues = new Map<string, Promise<unknown>>()
  private readonly scheduledPolicyLocks = new Set<string>()
  private globalQueue: Promise<unknown> = Promise.resolve()
  private scheduleCheck: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private initialized = false
  private shuttingDown = false

  constructor(
    private readonly store: AppStore,
    private readonly manager: ServerManager,
    runtimeDataDirectory: string,
    private readonly runWorldOperation: BackupOperationExecutor,
    dependencies: Partial<BackupServiceDependencies> = {}
  ) {
    this.serversDirectory = join(runtimeDataDirectory, 'servers')
    this.dependencies = { ...defaultDependencies, ...dependencies }
    manager.onState((event) => this.handleRuntime(event))
  }

  onStateChange(listener: BackupListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    for (const instance of this.store.getInstances()) {
      try {
        const policy = await this.loadPolicy(instance)
        if (policy.lastError) this.automaticRetryBlocked.add(instance.id)
        const recovered = await this.recoverInterruptedBackup(instance)
        if (recovered) await this.clearRecoveredFailure(instance)
        await this.refreshState(instance, null)
      } catch (error) {
        await this.recordInitializationFailure(instance, error)
      }
    }
    this.initialized = true
    if (!this.shuttingDown) {
      this.timer = this.dependencies.setInterval(() => { void this.checkSchedules() }, CHECK_INTERVAL_MS)
      void this.checkSchedules()
    }
  }

  async getState(instanceId: string): Promise<BackupState> {
    const instance = this.requireInstance(instanceId)
    try {
      await this.loadPolicy(instance)
      return await this.refreshState(instance, this.states.get(instanceId) ?? null)
    } catch (error) {
      const cached = this.states.get(instanceId)
      if (cached?.status === 'failed') return cloneState(cached)
      throw error
    }
  }

  async updatePolicy(input: UpdateBackupPolicyInput): Promise<BackupState> {
    if (this.scheduledPolicyLocks.has(input.instanceId)) {
      throw new AppError('Wait for the committed automatic backup to finish before changing its schedule.', 'BACKUP_RUNNING')
    }
    return this.serializePolicy(input.instanceId, async () => {
      if (this.scheduledPolicyLocks.has(input.instanceId)) {
        throw new AppError('Wait for the committed automatic backup to finish before changing its schedule.', 'BACKUP_RUNNING')
      }
      const instance = this.requireInstance(input.instanceId)
      const current = await this.loadPolicy(instance)
      const now = this.dependencies.now().toISOString()
      const resetAnchor = (!current.enabled && input.enabled) || current.intervalHours !== input.intervalHours
      const next: PersistedPolicy = {
        ...current,
        enabled: input.enabled,
        intervalHours: input.intervalHours,
        retentionCount: input.retentionCount,
        enabledAt: resetAnchor ? now : current.enabledAt,
        lastError: null
      }
      await this.writePolicy(instance, next)
      this.policies.set(instance.id, next)
      this.retryNotBefore.delete(instance.id)
      this.automaticRetryBlocked.delete(instance.id)
      const state = await this.refreshState(instance, {
        ...(this.states.get(instance.id) ?? this.emptyState(instance.id, next)),
        status: 'idle',
        message: next.enabled ? 'Automatic world backups are scheduled.' : 'Automatic world backups are disabled.',
        error: null
      })
      this.emit(state)
      if (next.enabled) void this.checkSchedules()
      return state
    })
  }

  async createBackupNow(instanceId: string): Promise<BackupState> {
    const instance = this.requireInstance(instanceId)
    const baselineIds = new Set((await this.listValidBackups(instance)).map((backup) => backup.manifest.backupId))
    const existing = this.pending.get(instanceId)
    if (existing) {
      const state = await existing
      if (await this.hasBackupCreatedAfter(instance, baselineIds)) return state
      if (this.pending.get(instanceId) === existing) this.pending.delete(instanceId)
    }

    const state = await this.enqueue(instanceId, true)
    if (!await this.hasBackupCreatedAfter(instance, baselineIds)) {
      throw new AppError('The manual backup finished without committing a new automatic backup.', 'BACKUP_NOT_CREATED')
    }
    return state
  }

  private async hasBackupCreatedAfter(instance: ServerInstance, baselineIds: Set<string>): Promise<boolean> {
    return (await this.listValidBackups(instance)).some((backup) => !baselineIds.has(backup.manifest.backupId))
  }

  async getBackupsDirectory(instanceId: string): Promise<string> {
    const instance = this.requireInstance(instanceId)
    return this.ensureAutomaticDirectory(instance)
  }

  forgetInstance(instanceId: string): void {
    this.policies.delete(instanceId)
    this.states.delete(instanceId)
    this.retryNotBefore.delete(instanceId)
    this.automaticRetryBlocked.delete(instanceId)
    this.policyQueues.delete(instanceId)
    this.scheduledPolicyLocks.delete(instanceId)
  }

  beginShutdown(): void {
    this.shuttingDown = true
    if (this.timer) {
      this.dependencies.clearInterval(this.timer)
      this.timer = null
    }
  }

  cancelShutdown(): void {
    if (!this.shuttingDown) return
    this.shuttingDown = false
    if (this.initialized && !this.timer) {
      this.timer = this.dependencies.setInterval(() => { void this.checkSchedules() }, CHECK_INTERVAL_MS)
      void this.checkSchedules()
    }
  }

  async awaitIdle(): Promise<void> {
    await this.scheduleCheck?.catch(() => undefined)
    await this.globalQueue.catch(() => undefined)
    await Promise.allSettled([...this.policyQueues.values()])
  }

  private requireInstance(instanceId: string): ServerInstance {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    return instance
  }

  private defaultPolicy(instanceId: string): PersistedPolicy {
    return {
      schemaVersion: 1,
      instanceId,
      enabled: true,
      intervalHours: 6,
      retentionCount: 3,
      enabledAt: this.dependencies.now().toISOString(),
      lastSuccessfulAt: null,
      lastError: null
    }
  }

  private emptyState(instanceId: string, policy: PersistedPolicy): BackupState {
    return {
      instanceId,
      policy: publicPolicy(policy),
      status: policy.lastError ? 'failed' : 'idle',
      lastSuccessfulAt: policy.lastSuccessfulAt,
      nextBackupAt: null,
      backupCount: 0,
      totalBytes: 0,
      message: policy.lastError
        ? null
        : policy.enabled ? 'Automatic world backups are scheduled.' : 'Automatic world backups are disabled.',
      error: policy.lastError
    }
  }

  private async loadPolicy(instance: ServerInstance): Promise<PersistedPolicy> {
    const cached = this.policies.get(instance.id)
    if (cached) return { ...cached }
    const managedDirectory = await this.assertManagedInstanceDirectory(instance)
    const path = join(managedDirectory, POLICY_FILE)
    let policy: PersistedPolicy
    try {
      const stats = await lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_POLICY_BYTES) {
        throw new AppError('The automatic-backup policy file is unsafe.', 'BACKUP_POLICY_INVALID')
      }
      const parsed = persistedPolicySchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      if (!parsed.success || parsed.data.instanceId !== instance.id) {
        throw new AppError('The automatic-backup policy file is invalid.', 'BACKUP_POLICY_INVALID')
      }
      policy = parsed.data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof AppError) throw error
        throw new AppError('The automatic-backup policy could not be read.', 'BACKUP_POLICY_INVALID', asMessage(error))
      }
      policy = this.defaultPolicy(instance.id)
      await this.writePolicy(instance, policy)
    }
    this.policies.set(instance.id, policy)
    return { ...policy }
  }

  private async writePolicy(instance: ServerInstance, policy: PersistedPolicy): Promise<void> {
    const parsed = persistedPolicySchema.parse(policy)
    const path = join(instance.serverDirectory, POLICY_FILE)
    try {
      const stats = await lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new AppError('The automatic-backup policy file is unsafe.', 'BACKUP_POLICY_INVALID')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporaryPath = `${path}.tmp-${randomUUID()}`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, path)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private serializePolicy<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.policyQueues.get(instanceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.policyQueues.set(instanceId, next)
    const cleanup = (): void => {
      if (this.policyQueues.get(instanceId) === next) this.policyQueues.delete(instanceId)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  private handleRuntime(event: StateEvent): void {
    if (!this.initialized || this.shuttingDown) return
    if (event.runtime.status === 'offline' ||
      (event.runtime.status === 'online' && event.runtime.playerCount === 0)) {
      void this.checkSchedules()
    }
  }

  private checkSchedules(): Promise<void> {
    if (this.scheduleCheck) return this.scheduleCheck
    this.scheduleCheck = this.checkSchedulesUnlocked().finally(() => { this.scheduleCheck = null })
    return this.scheduleCheck
  }

  private async checkSchedulesUnlocked(): Promise<void> {
    if (!this.initialized || this.shuttingDown) return
    const now = this.dependencies.now().getTime()
    for (const instance of this.store.getInstances()) {
      try {
        const policy = await this.loadPolicy(instance)
        if (!policy.enabled || this.pending.has(instance.id) || this.automaticRetryBlocked.has(instance.id)) continue
        const inventory = await this.listValidBackups(instance)
        const lastSuccessfulAt = this.latestSuccessfulAt(inventory)
        const due = this.nextDueAt(policy, lastSuccessfulAt)
        const retry = this.retryNotBefore.get(instance.id) ?? 0
        if (now < Math.max(due, retry)) continue
        const runtime = this.manager.getView(instance).runtime
        if (runtime.status === 'crashed') {
          const state = await this.refreshState(instance, {
            ...(this.states.get(instance.id) ?? this.emptyState(instance.id, policy)),
            status: 'waiting',
            message: 'Restart this crashed server and let it reach a clean online state before automatic backups resume.',
            error: null
          })
          this.emit(state)
          continue
        }
        if (runtime.status === 'starting' || runtime.status === 'stopping' ||
          (runtime.status === 'online' && runtime.playerCount > 0)) {
          this.retryNotBefore.set(instance.id, now + BUSY_RETRY_MS)
          const state = await this.refreshState(instance, {
            ...(this.states.get(instance.id) ?? this.emptyState(instance.id, policy)),
            status: 'waiting',
            message: runtime.playerCount > 0
              ? 'Waiting for all players to disconnect before the maintenance backup.'
              : 'Waiting for the server to finish changing state.',
            error: null
          })
          this.emit(state)
          continue
        }
        void this.enqueue(instance.id, false).catch(() => undefined)
      } catch (error) {
        await this.recordInitializationFailure(instance, error)
      }
    }
  }

  private enqueue(instanceId: string, manual: boolean): Promise<BackupState> {
    const existing = this.pending.get(instanceId)
    if (existing) return existing
    const operation = this.globalQueue.catch(() => undefined).then(() => this.executeBackup(instanceId, manual))
    this.globalQueue = operation.then(() => undefined, () => undefined)
    this.pending.set(instanceId, operation)
    void operation.finally(() => {
      if (this.pending.get(instanceId) === operation) this.pending.delete(instanceId)
    }).catch(() => undefined)
    return operation
  }

  private async executeBackup(instanceId: string, manual: boolean): Promise<BackupState> {
    if (this.shuttingDown) throw new AppError('EmberHost is shutting down and cannot start another backup.', 'APP_SHUTTING_DOWN')
    const instance = this.requireInstance(instanceId)
    const policy = await this.loadPolicy(instance)
    if (!manual) {
      if (!policy.enabled || this.automaticRetryBlocked.has(instance.id)) {
        return this.refreshState(instance, this.states.get(instance.id) ?? this.emptyState(instance.id, policy))
      }
      const inventory = await this.listValidBackups(instance)
      const due = this.nextDueAt(policy, this.latestSuccessfulAt(inventory))
      const retry = this.retryNotBefore.get(instance.id) ?? 0
      if (this.dependencies.now().getTime() < Math.max(due, retry)) {
        return this.refreshState(instance, this.states.get(instance.id) ?? this.emptyState(instance.id, policy))
      }
    }
    const runtime = this.manager.getView(instance).runtime
    if (runtime.status === 'crashed') {
      const error = new AppError(
        'Restart this crashed server and let it reach a clean online state before creating a backup.',
        'SERVER_CRASHED'
      )
      const waiting = await this.refreshState(instance, {
        ...(this.states.get(instance.id) ?? this.emptyState(instance.id, policy)),
        status: 'waiting',
        message: error.message,
        error: null
      })
      this.emit(waiting)
      if (manual) throw error
      return waiting
    }
    const running = await this.refreshState(instance, {
      ...(this.states.get(instance.id) ?? this.emptyState(instance.id, policy)),
      status: 'running',
      message: 'Briefly stopping the server and creating an offline world snapshot…',
      error: null
    })
    this.emit(running)

    const transaction: BackupTransaction = {
      backupId: randomUUID(),
      stagingName: `.staging-${randomUUID()}`,
      createdAt: this.dependencies.now().toISOString(),
      restartAfter: false,
      safeToFinalize: true
    }
    let scheduledPolicyCommitted = false
    try {
      await this.runWorldOperation(instance.id, () => this.manager.runOfflineMaintenance(
        instance.id,
        () => this.captureOffline(instance, transaction),
        {
          beforeStop: async (context) => {
            if (!manual) {
              await this.commitScheduledEligibility(instance)
              scheduledPolicyCommitted = true
            }
            await this.assertManagedInstanceDirectory(instance)
            await assertNoInterruptedWorldRegeneration(instance)
            await assertNoBackupInProgress(instance)
            transaction.restartAfter = context.restartAfter
            await this.writeMarker(instance, {
              schemaVersion: 1,
              instanceId: instance.id,
              stagingName: transaction.stagingName,
              restartAfter: transaction.restartAfter,
              createdAt: transaction.createdAt
            })
          },
          finalize: async () => {
            if (transaction.safeToFinalize) await this.removeMarker(instance)
          }
        }
      ))
      const completedAt = this.dependencies.now().toISOString()
      let retentionWarning: string | null = null
      let retentionCount = policy.retentionCount
      try {
        const updatedPolicy = await this.serializePolicy(instance.id, async () => {
          const current = await this.loadPolicy(instance)
          const next: PersistedPolicy = {
            ...current,
            lastSuccessfulAt: completedAt,
            lastError: null
          }
          retentionCount = next.retentionCount
          await this.writePolicy(instance, next)
          this.policies.set(instance.id, next)
          return next
        })
        retentionCount = updatedPolicy.retentionCount
      } catch (error) {
        retentionWarning = `Backup completed, but its policy status could not be saved: ${asMessage(error)}`
      }
      if (this.manager.getView(instance).runtime.status === 'crashed') {
        retentionWarning = `${retentionWarning ? retentionWarning + ' ' : ''}Retention cleanup was deferred because the server entered a crashed state.`
      } else {
        try {
          const cleanupWarning = await this.pruneRetention(instance, retentionCount, transaction.backupId)
          if (cleanupWarning) retentionWarning = `${retentionWarning ? retentionWarning + ' ' : ''}${cleanupWarning}`
        } catch (error) {
          retentionWarning = `${retentionWarning ? retentionWarning + ' ' : ''}Backup completed, but retention cleanup failed: ${asMessage(error)}`
        }
      }
      this.retryNotBefore.delete(instance.id)
      this.automaticRetryBlocked.delete(instance.id)
      const state = await this.refreshState(instance, {
        ...running,
        status: 'idle',
        lastSuccessfulAt: completedAt,
        message: retentionWarning ?? 'Automatic world backup completed successfully.',
        error: null
      })
      this.emit(state)
      return state
    } catch (error) {
      const scheduleChanged = !manual && error instanceof AppError && error.code === 'BACKUP_SCHEDULE_CHANGED'
      if (scheduleChanged) {
        const current = await this.loadPolicy(instance)
        const state = await this.refreshState(instance, {
          ...running,
          status: 'idle',
          message: current.enabled ? 'Automatic world backups are scheduled.' : 'Automatic world backups are disabled.',
          error: null
        })
        this.emit(state)
        return state
      }
      const awaitingInitialWorld = !manual && error instanceof AppError && error.code === 'BACKUP_WORLD_NOT_FOUND'
      const deferred = awaitingInitialWorld || isDeferredError(error)
      const retryAt = this.dependencies.now().getTime() + (deferred ? BUSY_RETRY_MS : FAILURE_RETRY_MS)
      this.retryNotBefore.set(instance.id, retryAt)
      if (!deferred) this.automaticRetryBlocked.add(instance.id)
      if (!deferred) {
        try {
          await this.serializePolicy(instance.id, async () => {
            const current = await this.loadPolicy(instance)
            const next = { ...current, lastError: asMessage(error) }
            await this.writePolicy(instance, next)
            this.policies.set(instance.id, next)
            return next
          })
        } catch {
          // The original backup error remains the actionable failure.
        }
      }
      const state = await this.refreshState(instance, {
        ...running,
        status: deferred ? 'waiting' : 'failed',
        message: deferred
          ? awaitingInitialWorld
            ? 'Start the server once to create its world. Automatic backups will wait until the world exists.'
            : asMessage(error)
          : null,
        error: deferred ? null : asMessage(error)
      })
      this.emit(state)
      if (manual) throw error
      return state
    } finally {
      if (scheduledPolicyCommitted) this.scheduledPolicyLocks.delete(instance.id)
    }
  }

  private async commitScheduledEligibility(instance: ServerInstance): Promise<void> {
    await this.serializePolicy(instance.id, async () => {
      const policy = await this.loadPolicy(instance)
      const backups = await this.listValidBackups(instance)
      const due = this.nextDueAt(policy, this.latestSuccessfulAt(backups))
      const retry = this.retryNotBefore.get(instance.id) ?? 0
      if (!policy.enabled || this.automaticRetryBlocked.has(instance.id) ||
        this.dependencies.now().getTime() < Math.max(due, retry)) {
        throw new AppError(
          'The automatic-backup schedule changed before maintenance began.',
          'BACKUP_SCHEDULE_CHANGED'
        )
      }
      this.scheduledPolicyLocks.add(instance.id)
    })
  }

  private async captureOffline(instance: ServerInstance, transaction: BackupTransaction): Promise<void> {
    const managedDirectory = await this.assertManagedInstanceDirectory(instance)
    await assertNoInterruptedWorldRegeneration(instance)
    const properties = await this.readNormalFileIfPresent(join(managedDirectory, 'server.properties'), 'server.properties')
    const levelName = parseLevelName(properties ?? '')
    const worldNames = [levelName, `${levelName}_nether`, `${levelName}_the_end`]
    const sources: Array<{ name: string; path: string; summary: TreeSummary }> = []
    for (const [index, name] of worldNames.entries()) {
      const path = join(managedDirectory, name)
      const exists = await this.pathExists(path)
      if (!exists) {
        if (index === 0) throw new AppError(`The active world folder “${name}” does not exist.`, 'BACKUP_WORLD_NOT_FOUND')
        continue
      }
      await this.assertWorldDirectory(path)
      sources.push({ name, path, summary: await this.summarizeTree(path) })
    }
    const sourceBytes = sources.reduce((sum, item) => checkedAdd(sum, item.summary.totalBytes), 0)
    await this.assertFreeSpace(managedDirectory, sourceBytes)
    const automaticDirectory = await this.ensureAutomaticDirectory(instance)
    const stagingDirectory = join(automaticDirectory, transaction.stagingName)
    const finalName = `auto-${transaction.createdAt.replace(/[:.]/g, '-')}-${transaction.backupId}`
    const finalDirectory = join(automaticDirectory, finalName)
    let stagingCreated = false
    try {
      await mkdir(stagingDirectory)
      stagingCreated = true
      transaction.safeToFinalize = false
      const worlds: AutomaticManifest['worlds'] = []
      for (const source of sources) {
        const destination = join(stagingDirectory, source.name)
        await this.dependencies.copyDirectory(source.path, destination)
        const copied = await this.summarizeTree(destination)
        if (copied.fileCount !== source.summary.fileCount || copied.totalBytes !== source.summary.totalBytes) {
          throw new AppError(`Verification failed for the copied world “${source.name}”.`, 'BACKUP_VERIFICATION_FAILED')
        }
        worlds.push({ name: source.name, ...copied })
      }
      const fileCount = worlds.reduce((sum, world) => checkedAdd(sum, world.fileCount), 0)
      const totalBytes = worlds.reduce((sum, world) => checkedAdd(sum, world.totalBytes), 0)
      const manifest: AutomaticManifest = {
        schemaVersion: 1,
        kind: 'automatic',
        backupId: transaction.backupId,
        instanceId: instance.id,
        createdAt: transaction.createdAt,
        captureMode: transaction.restartAfter ? 'offline-maintenance' : 'offline',
        minecraftVersion: instance.version,
        software: instance.software.kind,
        levelName,
        worlds,
        fileCount,
        totalBytes,
        scope: 'active-world-only'
      }
      automaticManifestSchema.parse(manifest)
      await writeFile(join(stagingDirectory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await rename(stagingDirectory, finalDirectory)
      transaction.safeToFinalize = true
    } catch (error) {
      if (!stagingCreated) throw error
      try {
        const validatedAutomatic = await this.requireAutomaticDirectory(instance)
        await this.assertDirectOwnedDirectory(validatedAutomatic, stagingDirectory, transaction.stagingName)
        await this.summarizeTree(stagingDirectory)
        await rm(stagingDirectory, { recursive: true, force: true })
        transaction.safeToFinalize = true
      } catch (cleanupError) {
        transaction.safeToFinalize = false
        throw new AppError(
          'The backup failed and its staging data could not be removed. EmberHost left recovery markers in place.',
          'BACKUP_RECOVERY_REQUIRED',
          `${asMessage(error)}; cleanup: ${asMessage(cleanupError)}`
        )
      }
      throw error
    }
  }

  private async assertManagedInstanceDirectory(instance: ServerInstance): Promise<string> {
    const serversRoot = resolve(this.serversDirectory)
    const expectedDirectory = resolve(serversRoot, instance.id)
    const comparison = (value: string): string =>
      process.platform === 'win32' || process.platform === 'darwin' ? value.toLocaleLowerCase('en-US') : value
    if (comparison(resolve(instance.serverDirectory)) !== comparison(expectedDirectory)) {
      throw new AppError('The server folder is outside EmberHost’s managed directory.', 'UNMANAGED_SERVER_DIRECTORY')
    }
    const child = relative(serversRoot, expectedDirectory)
    if (!child || child.startsWith('..') || isAbsolute(child) || child !== instance.id) {
      throw new AppError('The managed server path is invalid.', 'UNMANAGED_SERVER_DIRECTORY')
    }
    const stats = await lstat(expectedDirectory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppError('The managed server path is not a normal local directory.', 'UNSAFE_SERVER_DIRECTORY')
    }
    const [realRoot, realDirectory] = await Promise.all([realpath(serversRoot), realpath(expectedDirectory)])
    if (comparison(realDirectory) !== comparison(resolve(realRoot, instance.id))) {
      throw new AppError('The server folder resolves outside EmberHost’s managed directory.', 'UNSAFE_SERVER_DIRECTORY')
    }
    const markerPath = join(expectedDirectory, 'emberhost-instance.json')
    const markerStats = await lstat(markerPath)
    if (!markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.size > 1024 * 1024) {
      throw new AppError('The server ownership marker is invalid.', 'INVALID_INSTANCE_MARKER')
    }
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { id?: unknown }
      if (marker.id !== instance.id) throw new Error('ownership mismatch')
    } catch (error) {
      throw new AppError('The server ownership marker does not match this instance.', 'INVALID_INSTANCE_MARKER', asMessage(error))
    }
    return expectedDirectory
  }

  private async ensureAutomaticDirectory(instance: ServerInstance): Promise<string> {
    const automatic = await this.validateAutomaticDirectory(instance, true)
    if (!automatic) throw new AppError('The automatic backup directory could not be created.', 'UNSAFE_BACKUP_DIRECTORY')
    return automatic
  }

  private async requireAutomaticDirectory(instance: ServerInstance): Promise<string> {
    const automatic = await this.validateAutomaticDirectory(instance, false)
    if (!automatic) {
      throw new AppError('The automatic backup directory disappeared during a managed operation.', 'BACKUP_RECOVERY_REQUIRED')
    }
    return automatic
  }

  private async validateAutomaticDirectory(instance: ServerInstance, create: boolean): Promise<string | null> {
    const managedDirectory = await this.assertManagedInstanceDirectory(instance)
    const root = join(managedDirectory, BACKUP_ROOT)
    const automatic = join(root, AUTOMATIC_DIRECTORY)
    if (create) {
      await this.ensureNormalDirectory(root)
      await this.ensureNormalDirectory(automatic)
    } else {
      for (const path of [root, automatic]) {
        try {
          const stats = await lstat(path)
          if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new AppError('A managed backup path is not a normal local directory.', 'UNSAFE_BACKUP_DIRECTORY')
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }
    }
    const [realManaged, realRoot, realAutomatic] = await Promise.all([
      realpath(managedDirectory),
      realpath(root),
      realpath(automatic)
    ])
    if (!this.pathsEqual(realRoot, resolve(realManaged, BACKUP_ROOT)) ||
      !this.pathsEqual(realAutomatic, resolve(realRoot, AUTOMATIC_DIRECTORY))) {
      throw new AppError('A managed backup path resolves outside the server directory.', 'UNSAFE_BACKUP_DIRECTORY')
    }
    return automatic
  }

  private async assertDirectOwnedDirectory(parent: string, path: string, name: string): Promise<void> {
    if (!name || name === '.' || name === '..' || relative(parent, resolve(parent, name)) !== name ||
      !this.pathsEqual(resolve(path), resolve(parent, name))) {
      throw new AppError('A managed backup child path is unsafe.', 'UNSAFE_BACKUP_DIRECTORY')
    }
    const stats = await lstat(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppError('A managed backup child is not a normal local directory.', 'UNSAFE_BACKUP_DIRECTORY')
    }
    const [realParent, realChild] = await Promise.all([realpath(parent), realpath(path)])
    if (!this.pathsEqual(realChild, resolve(realParent, name))) {
      throw new AppError('A managed backup child resolves outside its automatic-backup directory.', 'UNSAFE_BACKUP_DIRECTORY')
    }
  }

  private pathsEqual(left: string, right: string): boolean {
    const normalize = (value: string): string =>
      process.platform === 'win32' || process.platform === 'darwin' ? value.toLocaleLowerCase('en-US') : value
    return normalize(resolve(left)) === normalize(resolve(right))
  }

  private async ensureNormalDirectory(path: string): Promise<void> {
    try {
      const stats = await lstat(path)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new AppError('A managed backup path is not a normal local directory.', 'UNSAFE_BACKUP_DIRECTORY')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(path)
      const stats = await lstat(path)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new AppError('A managed backup directory could not be created safely.', 'UNSAFE_BACKUP_DIRECTORY')
      }
    }
  }

  private async assertWorldDirectory(path: string): Promise<void> {
    const stats = await lstat(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppError('A world path is not a normal local directory.', 'UNSAFE_WORLD_DIRECTORY')
    }
    let levelData
    try {
      levelData = await lstat(join(path, 'level.dat'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('A world folder is missing its required level.dat file.', 'UNSAFE_WORLD_DIRECTORY')
      }
      throw error
    }
    if (!levelData.isFile() || levelData.isSymbolicLink()) {
      throw new AppError('A world level.dat is not a normal local file.', 'UNSAFE_WORLD_DIRECTORY')
    }
  }

  private async summarizeTree(root: string): Promise<TreeSummary> {
    const rootStats = await lstat(root)
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new AppError('A backup tree is not a normal local directory.', 'UNSAFE_BACKUP_TREE')
    }
    let fileCount = 0
    let totalBytes = 0
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
          throw new AppError(`Symbolic links and junctions are not allowed in world backups: ${entry.name}`, 'UNSAFE_BACKUP_TREE')
        }
        if (stats.isDirectory()) pending.push(path)
        else if (stats.isFile()) {
          fileCount = checkedAdd(fileCount, 1)
          totalBytes = checkedAdd(totalBytes, stats.size)
        } else {
          throw new AppError(`Unsupported filesystem entry in world backup: ${entry.name}`, 'UNSAFE_BACKUP_TREE')
        }
      }
    }
    return { fileCount, totalBytes }
  }

  private async assertFreeSpace(path: string, sourceBytes: number): Promise<void> {
    const disk = await this.dependencies.statfs(path)
    const available = disk.bavail * disk.bsize
    const total = disk.blocks * disk.bsize
    const reserve = total / 10n > MIN_FREE_RESERVE_BYTES ? total / 10n : MIN_FREE_RESERVE_BYTES
    if (available < BigInt(sourceBytes) + reserve) {
      throw new AppError(
        'There is not enough free disk space to create a verified world backup while preserving a safety reserve.',
        'BACKUP_DISK_SPACE'
      )
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async readNormalFileIfPresent(path: string, description: string): Promise<string | null> {
    try {
      const stats = await lstat(path)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024) {
        throw new AppError(`${description} is not a normal local file.`, 'UNSAFE_SERVER_PROPERTIES')
      }
      return readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeMarker(instance: ServerInstance, marker: BackupInProgressMarker): Promise<void> {
    const path = join(instance.serverDirectory, BACKUP_MARKER_FILE)
    const temporary = `${path}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private async removeMarker(instance: ServerInstance): Promise<void> {
    await rm(join(instance.serverDirectory, BACKUP_MARKER_FILE), { force: true })
  }

  private async listValidBackups(instance: ServerInstance): Promise<ValidBackup[]> {
    const automatic = await this.validateAutomaticDirectory(instance, false)
    if (!automatic) return []
    const backups: ValidBackup[] = []
    for (const entry of await readdir(automatic, { withFileTypes: true })) {
      const match = AUTO_NAME_PATTERN.exec(entry.name)
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(automatic, entry.name)
      try {
        await this.assertDirectOwnedDirectory(automatic, path, entry.name)
        const manifestPath = join(path, MANIFEST_FILE)
        const manifestStats = await lstat(manifestPath)
        if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > MAX_MANIFEST_BYTES) continue
        const parsed = automaticManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')))
        if (!parsed.success || parsed.data.instanceId !== instance.id || parsed.data.backupId !== match[1]) continue
        const worldNames = new Set<string>()
        for (const world of parsed.data.worlds) {
          if (worldNames.has(world.name)) throw new Error('duplicate world directory')
          worldNames.add(world.name)
          await this.assertDirectOwnedDirectory(path, join(path, world.name), world.name)
        }
        backups.push({ path, name: entry.name, manifest: parsed.data })
      } catch {
        // Unknown or malformed backup entries are intentionally never managed or pruned.
      }
    }
    return backups.sort((left, right) => Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt))
  }

  private async pruneRetention(
    instance: ServerInstance,
    retentionCount: number,
    protectedBackupId: string
  ): Promise<string | null> {
    const backups = await this.listValidBackups(instance)
    const protectedBackup = backups.find((backup) => backup.manifest.backupId === protectedBackupId)
    const retained = new Set<string>()
    if (protectedBackup) retained.add(protectedBackup.path)
    for (const backup of backups) {
      if (retained.size >= retentionCount) break
      retained.add(backup.path)
    }
    const failures: string[] = []
    for (const backup of backups.filter((candidate) => !retained.has(candidate.path))) {
      try {
        const automatic = await this.requireAutomaticDirectory(instance)
        await this.assertDirectOwnedDirectory(automatic, backup.path, backup.name)
        await this.summarizeTree(backup.path)
        await rm(backup.path, { recursive: true })
      } catch (error) {
        failures.push(`${backup.name}: ${asMessage(error)}`)
      }
    }
    return failures.length ? `Backup completed, but some expired backups were retained: ${failures.join('; ')}` : null
  }

  private latestSuccessfulAt(backups: ValidBackup[]): string | null {
    return backups[0]?.manifest.createdAt ?? null
  }

  private nextDueAt(policy: PersistedPolicy, lastSuccessfulAt: string | null): number {
    if (lastSuccessfulAt) return Date.parse(lastSuccessfulAt) + policy.intervalHours * 60 * 60 * 1000
    return Date.parse(policy.enabledAt) + FIRST_BACKUP_DELAY_MS
  }

  private async refreshState(instance: ServerInstance, preferred: BackupState | null): Promise<BackupState> {
    const policy = await this.loadPolicy(instance)
    const backups = await this.listValidBackups(instance)
    const lastSuccessfulAt = this.latestSuccessfulAt(backups)
    const next = policy.enabled && !this.automaticRetryBlocked.has(instance.id)
      ? Math.max(this.nextDueAt(policy, lastSuccessfulAt), this.retryNotBefore.get(instance.id) ?? 0)
      : null
    const state: BackupState = {
      ...(preferred ?? this.emptyState(instance.id, policy)),
      instanceId: instance.id,
      policy: publicPolicy(policy),
      lastSuccessfulAt,
      nextBackupAt: next === null ? null : new Date(next).toISOString(),
      backupCount: backups.length,
      totalBytes: backups.reduce((sum, backup) => checkedAdd(sum, backup.manifest.totalBytes), 0)
    }
    this.states.set(instance.id, state)
    return cloneState(state)
  }

  private emit(state: BackupState): void {
    const cloned = cloneState(state)
    this.states.set(state.instanceId, cloned)
    for (const listener of this.listeners) {
      try {
        listener(cloneState(cloned))
      } catch {
        // A renderer notification must not change backup transaction results.
      }
    }
  }

  private async recoverInterruptedBackup(instance: ServerInstance): Promise<boolean> {
    const marker = await readBackupInProgressMarker(instance)
    if (!marker) return false
    await this.manager.assertStoppedAndUnowned(instance.id)
    await this.assertManagedInstanceDirectory(instance)
    await assertNoInterruptedWorldRegeneration(instance)
    if (!STAGING_NAME_PATTERN.test(marker.stagingName)) {
      throw new AppError('The backup recovery marker names an unsafe staging folder.', 'BACKUP_RECOVERY_REQUIRED')
    }
    const automatic = await this.validateAutomaticDirectory(instance, false)
    if (automatic) {
      const staging = join(automatic, marker.stagingName)
      if (await this.pathExists(staging)) {
        const validatedAutomatic = await this.requireAutomaticDirectory(instance)
        await this.assertDirectOwnedDirectory(validatedAutomatic, staging, marker.stagingName)
        await this.summarizeTree(staging)
        await rm(staging, { recursive: true })
      }
    }
    if (marker.restartAfter && !this.shuttingDown) {
      try {
        await this.manager.restartAfterInterruptedMaintenance(instance.id, () => this.removeMarker(instance))
      } catch (error) {
        await this.serializePolicy(instance.id, async () => {
          const current = await this.loadPolicy(instance)
          const failed = {
            ...current,
            lastError: `Backup recovery completed, but the server could not restart safely: ${asMessage(error)}`
          }
          await this.writePolicy(instance, failed)
          this.policies.set(instance.id, failed)
        })
        throw error
      }
    } else {
      await this.removeMarker(instance)
    }
    return true
  }

  private async clearRecoveredFailure(instance: ServerInstance): Promise<void> {
    await this.serializePolicy(instance.id, async () => {
      const current = await this.loadPolicy(instance)
      if (current.lastError) {
        const recovered = { ...current, lastError: null }
        await this.writePolicy(instance, recovered)
        this.policies.set(instance.id, recovered)
      }
    })
    this.retryNotBefore.delete(instance.id)
    this.automaticRetryBlocked.delete(instance.id)
  }

  private async recordInitializationFailure(instance: ServerInstance, error: unknown): Promise<void> {
    this.automaticRetryBlocked.add(instance.id)
    const cached = this.policies.get(instance.id) ?? this.defaultPolicy(instance.id)
    const state: BackupState = {
      ...this.emptyState(instance.id, cached),
      status: 'failed',
      message: null,
      error: asMessage(error)
    }
    this.states.set(instance.id, state)
    this.emit(state)
  }
}
