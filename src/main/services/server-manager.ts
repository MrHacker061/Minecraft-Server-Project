import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import type {
  ConsoleEntry,
  InstanceRuntime,
  InstanceView,
  ServerInstance,
  StateEvent
} from '../../shared/contracts'
import { AppError } from './errors'
import { checkJava } from './java'
import { isMsptHeader, parseMsptValuesLine, parseTpsLine, sampleProcessHealth } from './metrics'
import type { AppStore } from './store'
import { assertNoInterruptedWorldRegeneration } from './world-regeneration-safety'
import { assertNoBackupInProgress } from './backup-safety'

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams
  runtime: InstanceRuntime
  logStream: WriteStream
  readinessTimer: NodeJS.Timeout
  readinessProbe: NodeJS.Timeout
  stopPromise: Promise<void> | null
  forcedStop: boolean
  inputFailed: boolean
  logWritable: boolean
  logBackpressured: boolean
  logBytes: number
  metricsTimer: NodeJS.Timeout | null
  metricsWindowUntil: number
  awaitingMsptValues: boolean
  metricsSampling: boolean
}

interface ServerManagerDependencies {
  checkJava: typeof checkJava
  sampleProcessHealth: typeof sampleProcessHealth
  gracefulStopTimeoutMs: number
  forcedStopTimeoutMs: number
  maintenanceReadinessTimeoutMs: number
  maintenanceInputWriteTimeoutMs: number
  writeMaintenanceInput: (
    child: ChildProcessWithoutNullStreams,
    value: string,
    callback: (error?: Error | null) => void
  ) => void
  spawnProcess: (
    command: string,
    args: string[],
    options: {
      cwd: string
      windowsHide: boolean
      shell: false
      stdio: ['pipe', 'pipe', 'pipe']
    }
  ) => ChildProcessWithoutNullStreams
}

type ConsoleListener = (entry: ConsoleEntry) => void
type StateListener = (event: StateEvent) => void

export interface OfflineMaintenanceContext {
  instance: ServerInstance
  restartAfter: boolean
}

export interface OfflineMaintenanceLifecycle {
  beforeStop?: (context: OfflineMaintenanceContext) => Promise<void>
  finalize?: () => Promise<void>
}

const offlineRuntime = (): InstanceRuntime => ({
  status: 'offline',
  pid: null,
  startedAt: null,
  lastExitCode: null,
  playerCount: 0,
  players: [],
  health: {
    tps: null,
    mspt: null,
    memoryUsedMb: null,
    memoryMaxMb: null,
    cpuPercent: null
  }
})

export function buildLaunchArguments(instance: ServerInstance): string[] {
  const maximumPerformance = instance.software.kind === 'paper' && instance.performancePreset === 'maximum-performance'
  const initialMemory = maximumPerformance
    ? instance.memoryMb
    : Math.min(instance.software.kind === 'paper' ? 2048 : 1024, instance.memoryMb)
  const args = [
    `-Demberhost.instanceId=${instance.id}`,
    `-Xms${initialMemory}M`,
    `-Xmx${instance.memoryMb}M`
  ]
  if (instance.software.kind === 'paper') {
    args.push(
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+DisableExplicitGC',
      '-XX:+PerfDisableSharedMem'
    )
    if (maximumPerformance) args.push('-XX:+AlwaysPreTouch')
  }
  args.push('-jar', instance.launchArtifact, 'nogui')
  return args
}

export class ServerManager {
  private readonly processes = new Map<string, ManagedProcess>()
  private readonly runtimes = new Map<string, InstanceRuntime>()
  private readonly logs = new Map<string, ConsoleEntry[]>()
  private readonly consoleListeners = new Set<ConsoleListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly markerCleanups = new Map<string, Promise<void>>()
  private readonly maintenanceInstances = new Set<string>()
  private shuttingDown = false
  private readonly dependencies: ServerManagerDependencies

  constructor(
    private readonly store: AppStore,
    dependencies: Partial<ServerManagerDependencies> = {}
  ) {
    this.dependencies = {
      checkJava,
      sampleProcessHealth,
      gracefulStopTimeoutMs: 30_000,
      forcedStopTimeoutMs: 5_000,
      maintenanceReadinessTimeoutMs: 120_000,
      maintenanceInputWriteTimeoutMs: 5_000,
      writeMaintenanceInput: (child, value, callback) => { child.stdin.write(value, callback) },
      spawnProcess: (command, args, options) => spawn(command, args, options),
      ...dependencies
    }
  }

  onConsole(listener: ConsoleListener): () => void {
    this.consoleListeners.add(listener)
    return () => this.consoleListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  runExclusive<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    return this.serialize(instanceId, operation)
  }

  async runOfflineMaintenance<T>(
    instanceId: string,
    operation: (context: OfflineMaintenanceContext) => Promise<T>,
    lifecycle: OfflineMaintenanceLifecycle = {}
  ): Promise<T> {
    if (this.maintenanceInstances.has(instanceId)) {
      throw new AppError('Offline maintenance is already in progress for this server.', 'SERVER_MAINTENANCE')
    }
    this.maintenanceInstances.add(instanceId)
    try {
      return await this.runExclusive(instanceId, async () => {
        const instance = this.requireInstance(instanceId)
        await this.markerCleanups.get(instanceId)
        const status = this.runtimes.get(instanceId)?.status ?? 'offline'
        if (status === 'starting') {
          throw new AppError(
            'Wait for the server to finish starting before beginning offline maintenance.',
            'SERVER_BUSY'
          )
        }
        if (status === 'stopping') {
          throw new AppError(
            'Wait for the server to finish stopping before beginning offline maintenance.',
            'SERVER_BUSY'
          )
        }
        if (status === 'crashed') {
          throw new AppError(
            'Restart the crashed server and let it reach a clean online state before creating a backup.',
            'SERVER_CRASHED'
          )
        }

        const restartAfter = status === 'online'
        if (restartAfter) {
          const runtime = this.runtimes.get(instanceId)
          if (runtime && runtime.playerCount > 0) {
            throw new AppError(
              'Wait until every player disconnects before beginning offline maintenance.',
              'PLAYERS_CONNECTED'
            )
          }
        }

        const context = { instance, restartAfter }
        let lifecyclePrepared = false
        let stoppedForMaintenance = false
        let operationCompleted = false
        let result: T | undefined
        let failure: unknown = null
        let restartFailure: unknown = null
        let canFinalize = !restartAfter

        if (!restartAfter) await this.assertStoppedAndUnowned(instanceId)
        if (lifecycle.beforeStop) {
          await lifecycle.beforeStop(context)
          lifecyclePrepared = true
        }

        const runtimeAfterPreparation = this.runtimes.get(instanceId)
        if (restartAfter && runtimeAfterPreparation?.status === 'online' && runtimeAfterPreparation.playerCount > 0) {
          failure = new AppError(
            'A player connected while maintenance was being prepared. Wait for everyone to disconnect and try again.',
            'PLAYERS_CONNECTED'
          )
          canFinalize = true
        }

        if (restartAfter && !failure) {
          stoppedForMaintenance = true
          try {
            await this.stopUnlocked(instanceId, true)
          } catch (error) {
            failure = error
          }
        }

        if (!failure) {
          try {
            await this.assertStoppedAndUnowned(instanceId)
            result = await operation(context)
            operationCompleted = true
          } catch (error) {
            failure = error
          }
        }

        if (stoppedForMaintenance) {
          if (this.shuttingDown || this.isActive(instanceId)) {
            canFinalize = true
          } else {
            try {
              await this.startUnlocked(instanceId, lifecyclePrepared || operationCompleted)
              if (lifecyclePrepared) await this.waitForMaintenanceReadiness(instanceId)
              canFinalize = true
            } catch (error) {
              restartFailure = error
              if (lifecyclePrepared && this.isActive(instanceId)) {
                try {
                  await this.stopUnlocked(instanceId)
                } catch {
                  // The recovery marker remains authoritative if the protective stop also fails.
                }
              }
            }
          }
        }

        if (lifecyclePrepared && canFinalize && lifecycle.finalize) {
          try {
            await lifecycle.finalize()
          } catch (error) {
            if (stoppedForMaintenance && this.isActive(instanceId)) {
              try {
                await this.stopUnlocked(instanceId)
              } catch {
                // The recovery marker remains authoritative if the protective stop also fails.
              }
            }
            failure = failure
              ? new AppError(
                  `${this.errorMessage(failure)} Maintenance recovery finalization also failed.`,
                  'MAINTENANCE_RECOVERY_REQUIRED',
                  this.errorMessage(error)
                )
              : error
          }
        }

        if (restartFailure) {
          if (failure) {
            throw new AppError(
              `${this.errorMessage(failure)} EmberHost also could not restart the server; its recovery marker was retained.`,
              'MAINTENANCE_RECOVERY_REQUIRED',
              this.errorMessage(restartFailure)
            )
          }
          throw lifecyclePrepared
            ? new AppError(
                'EmberHost could not restore the server to a ready state after maintenance; its recovery marker was retained.',
                'MAINTENANCE_RECOVERY_REQUIRED',
                this.errorMessage(restartFailure)
              )
            : restartFailure
        }
        if (failure) throw failure
        return result as T
      })
    } finally {
      this.maintenanceInstances.delete(instanceId)
    }
  }

  async restartAfterInterruptedMaintenance(
    instanceId: string,
    completeAfterLaunch: () => Promise<void>
  ): Promise<InstanceView> {
    if (this.maintenanceInstances.has(instanceId)) {
      throw new AppError('Offline maintenance is already in progress for this server.', 'SERVER_MAINTENANCE')
    }
    this.maintenanceInstances.add(instanceId)
    try {
      return await this.runExclusive(instanceId, async () => {
        await this.assertStoppedAndUnowned(instanceId)
        await this.startUnlocked(instanceId, true)
        try {
          await this.waitForMaintenanceReadiness(instanceId)
          await completeAfterLaunch()
        } catch (error) {
          if (this.isActive(instanceId)) {
            try {
              await this.stopUnlocked(instanceId)
            } catch {
              // The recovery marker remains authoritative if the protective stop also fails.
            }
          }
          throw error
        }
        return this.getView(this.requireInstance(instanceId))
      })
    } finally {
      this.maintenanceInstances.delete(instanceId)
    }
  }

  beginShutdown(): void {
    this.shuttingDown = true
  }

  cancelShutdown(): void {
    this.shuttingDown = false
  }

  getView(instance: ServerInstance): InstanceView {
    return {
      ...instance,
      runtime: this.cloneRuntime(this.runtimes.get(instance.id) ?? offlineRuntime())
    }
  }

  listViews(): InstanceView[] {
    return this.store.getInstances().map((instance) => this.getView(instance))
  }

  getLogs(instanceId: string): ConsoleEntry[] {
    return [...(this.logs.get(instanceId) ?? [])]
  }

  isActive(instanceId: string): boolean {
    const status = this.runtimes.get(instanceId)?.status
    return status === 'starting' || status === 'online' || status === 'stopping'
  }

  async assertStoppedAndUnowned(instanceId: string): Promise<void> {
    const instance = this.requireInstance(instanceId)
    await this.markerCleanups.get(instanceId)
    if (this.isActive(instanceId)) {
      throw new AppError('Stop the server before making this change.', 'SERVER_MUST_BE_STOPPED')
    }
    await this.assertNoOrphan(instance)
  }

  forgetInstance(instanceId: string): void {
    if (this.processes.has(instanceId) || this.isActive(instanceId)) {
      throw new AppError('A running server cannot be removed from EmberHost.', 'SERVER_MUST_BE_STOPPED')
    }
    this.runtimes.delete(instanceId)
    this.logs.delete(instanceId)
  }

  async start(instanceId: string): Promise<InstanceView> {
    return this.runExclusive(instanceId, () => this.startUnlocked(instanceId))
  }

  private async startUnlocked(instanceId: string, allowOwnedBackupRecovery = false): Promise<InstanceView> {
      if (this.shuttingDown) throw new AppError('EmberHost is shutting down and cannot start another server.', 'APP_SHUTTING_DOWN')
      const instance = this.requireInstance(instanceId)
      await this.markerCleanups.get(instanceId)
      if (this.isActive(instanceId)) {
        throw new AppError('This server is already running or changing state.', 'SERVER_BUSY')
      }
      await this.assertNoOrphan(instance)
      if (!allowOwnedBackupRecovery) await assertNoBackupInProgress(instance)
      await assertNoInterruptedWorldRegeneration(instance)

      const java = await this.dependencies.checkJava(instance.javaPath)
      if (!java.available || java.majorVersion === null) {
        throw new AppError(
          `Java could not be started from “${instance.javaPath}”. Update the Java path in server settings.`,
          'JAVA_NOT_FOUND'
        )
      }
      if (java.majorVersion < instance.requiredJavaVersion) {
        throw new AppError(
          `Minecraft ${instance.version} needs Java ${instance.requiredJavaVersion}, but Java ${java.majorVersion} was found.`,
          'JAVA_TOO_OLD'
        )
      }

      await mkdir(instance.serverDirectory, { recursive: true })
      if (!/^[A-Za-z0-9._-]+\.jar$/i.test(instance.launchArtifact)) {
        throw new AppError('The configured server launch artifact is invalid.', 'INVALID_LAUNCH_ARTIFACT')
      }
      const logPath = join(instance.serverDirectory, 'emberhost-console.log')
      await this.rotateLog(logPath)
      if (await this.probePort(instance.port)) {
        throw new AppError('Port ' + instance.port + ' is already in use by another process.', 'PORT_IN_USE')
      }
      const args = buildLaunchArguments(instance)
      const startedAt = new Date().toISOString()
      await this.writeRuntimeMarker(instance, { instanceId, pid: null, startedAt, status: 'launching' })
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.dependencies.spawnProcess(instance.javaPath, args, {
          cwd: instance.serverDirectory,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        await rm(this.runtimeMarkerPath(instance), { force: true })
        throw error
      }

      const runtime: InstanceRuntime = {
        status: 'starting',
        pid: child.pid ?? null,
        startedAt,
        lastExitCode: null,
        playerCount: 0,
        players: [],
        health: {
          tps: null,
          mspt: null,
          memoryUsedMb: null,
          memoryMaxMb: instance.memoryMb,
          cpuPercent: null
        }
      }
      const logStream = createWriteStream(logPath, { flags: 'a' })
      const readinessTimer = setTimeout(() => {
        const managed = this.processes.get(instanceId)
        if (managed?.runtime.status === 'starting') {
          this.emitConsole(instanceId, 'system', 'Startup is taking longer than expected. The Java process is still active, but readiness has not been confirmed.', 'warn')
        }
      }, 90_000)
      const readinessProbe = setInterval(() => {
        const current = this.processes.get(instanceId)
        if (current?.runtime.status !== 'starting') return
        void this.probePort(instance.port).then((ready) => {
          if (ready && this.processes.get(instanceId) === current && current.runtime.status === 'starting') {
            this.confirmReady(instanceId, current)
          }
        })
      }, 1_000)

      const managed: ManagedProcess = {
        child,
        runtime,
        logStream,
        readinessTimer,
        readinessProbe,
        stopPromise: null,
        forcedStop: false,
        inputFailed: false,
        logWritable: true,
        logBackpressured: false,
        logBytes: 0,
        metricsTimer: null,
        metricsWindowUntil: 0,
        awaitingMsptValues: false,
        metricsSampling: false
      }
      this.processes.set(instanceId, managed)
      this.runtimes.set(instanceId, runtime)
      logStream.on('error', (error) => {
        managed.logWritable = false
        if (managed.logBackpressured) {
          managed.child.stdout.resume()
          managed.child.stderr.resume()
          managed.logBackpressured = false
        }
        this.emitConsole(instanceId, 'system', `Console log file error: ${error.message}`, 'error')
      })
      this.emitState(instanceId, runtime)
      this.emitConsole(instanceId, 'system', `Starting Minecraft ${instance.version} with ${instance.memoryMb} MB of memory.`)

      this.attachOutput(instanceId, managed, 'stdout')
      this.attachOutput(instanceId, managed, 'stderr')
      child.stdin.on('error', (error) => {
        managed.inputFailed = true
        if (this.processes.get(instanceId) === managed) {
          this.emitConsole(instanceId, 'system', `Server input closed: ${error.message}`, 'warn')
        }
      })
      child.once('error', (error) => {
        this.emitConsole(instanceId, 'system', `Java process error: ${error.message}`, 'error')
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
          this.handleExit(instanceId, managed, null)
        }
      })
      child.once('exit', (code) => this.handleExit(instanceId, managed, code))

      try {
        await this.writeRuntimeMarker(instance, { instanceId, pid: child.pid, startedAt: runtime.startedAt, status: 'running' })
      } catch (error) {
        try {
          managed.child.kill()
        } catch {
          // The process may already have exited; the original marker error is more actionable.
        }
        throw new AppError(
          'EmberHost could not record ownership of the Java process, so startup was cancelled.',
          'RUNTIME_MARKER_FAILED',
          error instanceof Error ? error.message : undefined
        )
      }
      if (this.processes.get(instanceId) !== managed) {
        await rm(this.runtimeMarkerPath(instance), { force: true })
      }

      return this.getView(instance)
  }

  async stop(instanceId: string): Promise<InstanceView> {
    return this.runExclusive(instanceId, () => this.stopUnlocked(instanceId))
  }

  private async stopUnlocked(instanceId: string, requireGraceful = false): Promise<InstanceView> {
      const instance = this.requireInstance(instanceId)
      const managed = this.processes.get(instanceId)
      if (!managed) {
        if (requireGraceful) {
          throw new AppError(
            'Minecraft exited before EmberHost could prove a clean graceful maintenance stop, so the world was not copied.',
            'MAINTENANCE_STOP_UNCLEAN'
          )
        }
        this.runtimes.set(instanceId, offlineRuntime())
        return this.getView(instance)
      }
      if (managed.stopPromise) {
        await managed.stopPromise
        return this.getView(instance)
      }

      managed.forcedStop = false
      managed.runtime.status = 'stopping'
      this.emitState(instanceId, managed.runtime)
      this.emitConsole(instanceId, 'system', 'Sending Minecraft a graceful stop command…')
      const stopCommandWritten = requireGraceful
        ? await this.writeMaintenanceStop(instanceId, managed)
        : this.writeInput(instanceId, managed, 'stop\n')

      const stopOperation = this.waitForExit(managed.child, this.dependencies.gracefulStopTimeoutMs).then(async (exited) => {
        if (!exited && this.processes.get(instanceId) === managed) {
          this.emitConsole(instanceId, 'system', 'Graceful shutdown timed out; terminating the server process.', 'warn')
          try {
            managed.forcedStop = true
            managed.child.kill()
          } catch (error) {
            this.emitConsole(instanceId, 'system', `Could not terminate Java: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
          const forcedExit = await this.waitForExit(managed.child, this.dependencies.forcedStopTimeoutMs)
          if (!forcedExit && this.processes.get(instanceId) === managed) {
            managed.runtime.status = 'online'
            this.emitState(instanceId, managed.runtime)
            throw new AppError('Java did not exit after the graceful and forced stop attempts. EmberHost kept running so it does not orphan the process.', 'STOP_TIMEOUT')
          }
        }
      })
      managed.stopPromise = stopOperation
      try {
        await stopOperation
      } finally {
        if (this.processes.get(instanceId) === managed) managed.stopPromise = null
      }
      const stoppedRuntime = this.runtimes.get(instanceId)
      if (requireGraceful && (
        !stopCommandWritten ||
        managed.inputFailed ||
        managed.forcedStop ||
        stoppedRuntime?.lastExitCode !== 0
      )) {
        throw new AppError(
          'Minecraft did not confirm a clean graceful stop, so EmberHost aborted offline maintenance without copying the world.',
          'MAINTENANCE_STOP_UNCLEAN'
        )
      }
      return this.getView(instance)
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private async writeMaintenanceStop(instanceId: string, managed: ManagedProcess): Promise<boolean> {
    if (managed.child.stdin.destroyed || !managed.child.stdin.writable) {
      managed.inputFailed = true
      return false
    }
    return new Promise<boolean>((resolvePromise) => {
      let settled = false
      const finish = (written: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolvePromise(written)
      }
      const timeout = setTimeout(() => {
        managed.inputFailed = true
        if (this.processes.get(instanceId) === managed) {
          this.emitConsole(instanceId, 'system', 'Timed out while writing the maintenance stop command.', 'warn')
        }
        finish(false)
      }, this.dependencies.maintenanceInputWriteTimeoutMs)
      try {
        this.dependencies.writeMaintenanceInput(managed.child, 'stop\n', (error) => {
          if (error) {
            managed.inputFailed = true
            if (this.processes.get(instanceId) === managed) {
              this.emitConsole(instanceId, 'system', `Could not write to the server console: ${error.message}`, 'warn')
            }
            finish(false)
          } else {
            finish(true)
          }
        })
      } catch (error) {
        managed.inputFailed = true
        if (this.processes.get(instanceId) === managed) {
          this.emitConsole(
            instanceId,
            'system',
            `Could not write to the server console: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
          )
        }
        finish(false)
      }
    })
  }

  private async waitForMaintenanceReadiness(instanceId: string): Promise<void> {
    const current = this.runtimes.get(instanceId)?.status
    if (current === 'online') return
    if (current !== 'starting') {
      throw new AppError('The server process exited before readiness was confirmed.', 'MAINTENANCE_RESTART_FAILED')
    }
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false
      const finish = (error?: AppError): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.stateListeners.delete(listener)
        if (error) reject(error)
        else resolvePromise()
      }
      const listener: StateListener = (event) => {
        if (event.instanceId !== instanceId) return
        if (event.runtime.status === 'online') finish()
        else if (event.runtime.status === 'offline' || event.runtime.status === 'crashed') {
          finish(new AppError('The server process exited before readiness was confirmed.', 'MAINTENANCE_RESTART_FAILED'))
        }
      }
      const timeout = setTimeout(() => {
        finish(new AppError(
          'The server did not become ready after its maintenance restart.',
          'MAINTENANCE_RESTART_TIMEOUT'
        ))
      }, this.dependencies.maintenanceReadinessTimeoutMs)
      this.stateListeners.add(listener)
      const status = this.runtimes.get(instanceId)?.status
      if (status === 'online') finish()
      else if (status !== 'starting') {
        finish(new AppError('The server process exited before readiness was confirmed.', 'MAINTENANCE_RESTART_FAILED'))
      }
    })
  }

  async sendCommand(instanceId: string, command: string): Promise<void> {
    if (this.maintenanceInstances.has(instanceId)) {
      throw new AppError(
        'Offline maintenance is in progress. Wait for it to finish before sending console commands.',
        'SERVER_MAINTENANCE'
      )
    }
    const managed = this.processes.get(instanceId)
    if (!managed || (managed.runtime.status !== 'online' && managed.runtime.status !== 'starting')) {
      throw new AppError('Start the server before sending a command.', 'SERVER_OFFLINE')
    }
    if (!this.writeInput(instanceId, managed, `${command.replace(/^\//, '')}\n`)) {
      throw new AppError('The server console closed before the command could be sent.', 'SERVER_INPUT_CLOSED')
    }
    this.emitConsole(instanceId, 'system', `> ${command.replace(/^\//, '')}`)
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true
    await Promise.allSettled([...this.operations.values()])
    const ids = [...this.processes.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.stop(id)))
    await Promise.allSettled([...this.markerCleanups.values()])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  private writeInput(instanceId: string, managed: ManagedProcess, value: string): boolean {
    if (managed.child.stdin.destroyed || !managed.child.stdin.writable) return false
    try {
      managed.child.stdin.write(value, (error) => {
        if (error && this.processes.get(instanceId) === managed) {
          managed.inputFailed = true
          this.emitConsole(instanceId, 'system', `Could not write to the server console: ${error.message}`, 'warn')
        }
      })
      return true
    } catch (error) {
      managed.inputFailed = true
      this.emitConsole(instanceId, 'system', `Could not write to the server console: ${error instanceof Error ? error.message : String(error)}`, 'warn')
      return false
    }
  }

  private attachOutput(instanceId: string, managed: ManagedProcess, stream: 'stdout' | 'stderr'): void {
    const reader = createInterface({ input: managed.child[stream], crlfDelay: Infinity })
    reader.on('line', (line) => {
      if (this.processes.get(instanceId) !== managed) return
      if (stream === 'stdout' && this.consumeHealthOutput(instanceId, managed, line)) return
      if (managed.logWritable) {
        const persistedLine = `[${new Date().toISOString()}] [${stream}] ${line}\n`
        managed.logBytes += Buffer.byteLength(persistedLine)
        if (managed.logBytes > 50 * 1024 * 1024) {
          managed.logWritable = false
          managed.logStream.end()
          this.emitConsole(instanceId, 'system', 'The EmberHost console log reached its 50 MB session cap. Minecraft continues writing its own rotated logs.', 'warn')
        } else if (!managed.logStream.write(persistedLine) && !managed.logBackpressured) {
          managed.logBackpressured = true
          managed.child.stdout.pause()
          managed.child.stderr.pause()
          managed.logStream.once('drain', () => {
            if (managed.logWritable) {
              managed.child.stdout.resume()
              managed.child.stderr.resume()
            }
            managed.logBackpressured = false
          })
        }
      }
      const lower = line.toLowerCase()
      const level = stream === 'stderr' || lower.includes('/error]') ? 'error' : lower.includes('/warn]') ? 'warn' : 'info'
      this.emitConsole(instanceId, stream, line, level)

      if (managed.runtime.status === 'starting' && /Done \([^)]+\)!/i.test(line)) {
        this.confirmReady(instanceId, managed)
      }

      const joined = line.match(/:\s+([A-Za-z0-9_]{1,16}) joined the game/)
      const left = line.match(/:\s+([A-Za-z0-9_]{1,16}) left the game/)
      if (joined?.[1] && !managed.runtime.players.includes(joined[1])) {
        managed.runtime.players.push(joined[1])
        managed.runtime.playerCount = managed.runtime.players.length
        this.emitState(instanceId, managed.runtime)
      }
      if (left?.[1]) {
        managed.runtime.players = managed.runtime.players.filter((player) => player !== left[1])
        managed.runtime.playerCount = managed.runtime.players.length
        this.emitState(instanceId, managed.runtime)
      }
    })
  }

  private handleExit(instanceId: string, managed: ManagedProcess, code: number | null): void {
    if (this.processes.get(instanceId) !== managed) return
    clearTimeout(managed.readinessTimer)
    clearInterval(managed.readinessProbe)
    if (managed.metricsTimer) clearInterval(managed.metricsTimer)
    if (!managed.logStream.destroyed) managed.logStream.end()
    const wasStopping = managed.runtime.status === 'stopping'
    const next: InstanceRuntime = {
      ...offlineRuntime(),
      status: wasStopping || code === 0 ? 'offline' : 'crashed',
      lastExitCode: code
    }
    this.processes.delete(instanceId)
    this.runtimes.set(instanceId, next)
    const instance = this.store.getInstance(instanceId)
    if (instance) {
      const cleanup = rm(this.runtimeMarkerPath(instance), { force: true }).catch(() => undefined)
      this.markerCleanups.set(instanceId, cleanup)
      void cleanup.finally(() => {
        if (this.markerCleanups.get(instanceId) === cleanup) this.markerCleanups.delete(instanceId)
      })
    }
    this.emitState(instanceId, next)
    this.emitConsole(
      instanceId,
      'system',
      managed.forcedStop
        ? 'The server had to be terminated after its graceful shutdown timed out. Check the world before restarting.'
        : next.status === 'crashed'
        ? `The server process exited unexpectedly${code === null ? '' : ` with code ${code}`}.`
        : 'Server stopped cleanly.',
      managed.forcedStop ? 'warn' : next.status === 'crashed' ? 'error' : 'info'
    )
  }

  private async rotateLog(logPath: string): Promise<void> {
    try {
      const details = await stat(logPath)
      if (details.size < 10 * 1024 * 1024) return
      const previous = `${logPath}.1`
      await rm(previous, { force: true })
      await rename(logPath, previous)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private confirmReady(instanceId: string, managed: ManagedProcess): void {
    if (this.processes.get(instanceId) !== managed || managed.runtime.status !== 'starting') return
    clearTimeout(managed.readinessTimer)
    clearInterval(managed.readinessProbe)
    managed.runtime.status = 'online'
    const instance = this.store.getInstance(instanceId)
    if (instance && !managed.metricsTimer) {
      managed.metricsTimer = setInterval(() => this.collectHealth(instanceId, managed, instance), 10_000)
    }
    this.emitState(instanceId, managed.runtime)
  }

  private consumeHealthOutput(instanceId: string, managed: ManagedProcess, line: string): boolean {
    if (Date.now() > managed.metricsWindowUntil) {
      managed.awaitingMsptValues = false
      return false
    }
    const tps = parseTpsLine(line)
    if (tps !== null) {
      managed.runtime.health.tps = tps
      this.emitState(instanceId, managed.runtime)
      return true
    }
    if (isMsptHeader(line)) {
      managed.awaitingMsptValues = true
      return true
    }
    if (managed.awaitingMsptValues) {
      const mspt = parseMsptValuesLine(line)
      if (mspt !== null) {
        managed.awaitingMsptValues = false
        managed.runtime.health.mspt = mspt
        this.emitState(instanceId, managed.runtime)
        return true
      }
    }
    return false
  }

  private collectHealth(instanceId: string, managed: ManagedProcess, instance: ServerInstance): void {
    if (this.processes.get(instanceId) !== managed || managed.runtime.status !== 'online') return
    if (instance.software.kind === 'paper') {
      managed.metricsWindowUntil = Date.now() + 5_000
      this.writeInput(instanceId, managed, 'tps\n')
      this.writeInput(instanceId, managed, 'mspt\n')
    }
    if (managed.metricsSampling || managed.runtime.pid === null) return
    managed.metricsSampling = true
    void this.dependencies.sampleProcessHealth(managed.runtime.pid).then((sample) => {
      if (this.processes.get(instanceId) !== managed) return
      managed.runtime.health.cpuPercent = sample.cpuPercent
      managed.runtime.health.memoryUsedMb = sample.memoryUsedMb
      managed.runtime.health.memoryMaxMb = instance.memoryMb
      this.emitState(instanceId, managed.runtime)
    }).finally(() => {
      managed.metricsSampling = false
    })
  }

  private probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(ready)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(500, () => finish(false))
    })
  }

  private runtimeMarkerPath(instance: ServerInstance): string {
    return join(instance.serverDirectory, '.emberhost-runtime.json')
  }

  private async writeRuntimeMarker(instance: ServerInstance, marker: Record<string, unknown>): Promise<void> {
    const markerPath = this.runtimeMarkerPath(instance)
    const temporaryPath = markerPath + '.tmp'
    try {
      await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, markerPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private async assertNoOrphan(instance: ServerInstance): Promise<void> {
    const markerPath = this.runtimeMarkerPath(instance)
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        instanceId?: unknown
        pid?: unknown
        status?: unknown
      }
      if (marker.instanceId !== instance.id) {
        throw new AppError('The server has an invalid runtime ownership marker. Inspect running Java processes before removing it.', 'INVALID_RUNTIME_MARKER')
      }
      if (typeof marker.pid !== 'number' || !Number.isInteger(marker.pid)) {
        if (marker.status === 'launching') {
          throw new AppError(
            'An earlier EmberHost launch was interrupted before Java ownership could be confirmed. Inspect running Java processes before removing .emberhost-runtime.json.',
            'INCOMPLETE_RUNTIME_MARKER'
          )
        }
        throw new AppError('The server has an invalid runtime ownership marker. Inspect running Java processes before removing it.', 'INVALID_RUNTIME_MARKER')
      }
      try {
        process.kill(marker.pid, 0)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ESRCH') {
          await rm(markerPath, { force: true })
          return
        }
        if (code !== 'EPERM') throw error
      }
      throw new AppError(
        `A process from an earlier EmberHost session may still own this server (PID ${marker.pid}). Stop that Java process before starting another copy.`,
        'ORPHAN_PROCESS'
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new AppError(
          'The server runtime marker is unreadable. Inspect running Java processes before removing .emberhost-runtime.json.',
          'INVALID_RUNTIME_MARKER'
        )
      }
      throw error
    }
  }

  private emitConsole(
    instanceId: string,
    stream: ConsoleEntry['stream'],
    line: string,
    level: ConsoleEntry['level'] = 'info'
  ): void {
    const entry: ConsoleEntry = {
      id: randomUUID(),
      instanceId,
      timestamp: new Date().toISOString(),
      stream,
      level,
      line
    }
    const entries = this.logs.get(instanceId) ?? []
    entries.push(entry)
    if (entries.length > 1_000) entries.splice(0, entries.length - 1_000)
    this.logs.set(instanceId, entries)
    for (const listener of this.consoleListeners) listener(entry)
  }

  private emitState(instanceId: string, runtime: InstanceRuntime): void {
    const event: StateEvent = { instanceId, runtime: this.cloneRuntime(runtime) }
    for (const listener of this.stateListeners) listener(event)
  }

  private requireInstance(id: string): ServerInstance {
    const instance = this.store.getInstance(id)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    return instance
  }

  private cloneRuntime(runtime: InstanceRuntime): InstanceRuntime {
    return { ...runtime, players: [...runtime.players], health: { ...runtime.health } }
  }

  private serialize<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(instanceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.operations.set(instanceId, next)
    const cleanup = (): void => {
      if (this.operations.get(instanceId) === next) this.operations.delete(instanceId)
    }
    void next.then(cleanup, cleanup)
    return next
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }
}
