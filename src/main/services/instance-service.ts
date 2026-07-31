import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  CreateInstanceInput,
  DeleteInstanceInput,
  InstanceView,
  PaperBuildInfo,
  RegenerateWorldInput,
  ServerInstance,
  SetupProgress,
  UpdateInstanceInput,
  WorldSeedState
} from '../../shared/contracts'
import { PERFORMANCE_PROFILES } from '../../shared/performance'
import { downloadChunky, resolveChunkyForPaper, type ResolvedChunkyVersion } from './chunky'
import { AppError } from './errors'
import { checkJava } from './java'
import { downloadServerJar, resolveRelease } from './minecraft'
import { downloadPaperJar, resolvePaperBuild } from './paper'
import {
  createServerProperties,
  getServerPropertyValue,
  mergeServerProperties,
  parseLevelName,
  setServerPropertyValue
} from './properties'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'
import { assertNoInterruptedWorldRegeneration } from './world-regeneration-safety'

type ProgressListener = (progress: SetupProgress) => void
type TrashItem = (path: string) => Promise<void>

export class InstanceService {
  private readonly serversDirectory: string
  private readonly artifactsDirectory: string
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: AppStore,
    private readonly manager: ServerManager,
    runtimeDataDirectory = store.dataDirectory,
    private readonly trashItem: TrashItem = async () => {
      throw new AppError('This platform did not provide a recycle-bin service.', 'TRASH_UNAVAILABLE')
    }
  ) {
    this.serversDirectory = join(runtimeDataDirectory, 'servers')
    this.artifactsDirectory = join(runtimeDataDirectory, 'artifact-cache')
  }

  async create(input: CreateInstanceInput, onProgress: ProgressListener): Promise<InstanceView> {
    return this.serializeMutation(() => this.createUnlocked(input, onProgress))
  }

  private async createUnlocked(input: CreateInstanceInput, onProgress: ProgressListener): Promise<InstanceView> {
    if (this.store.getInstances().some((instance) => instance.port === input.port)) {
      throw new AppError(`Port ${input.port} is already assigned to another EmberHost server.`, 'PORT_IN_USE')
    }

    const softwareSelection = input.software ?? { kind: 'vanilla' as const }
    onProgress({ phase: 'version', percent: 5, message: `Resolving Minecraft ${input.version}…` })
    const version = await resolveRelease(input.version)
    let paperBuild: PaperBuildInfo | null = null
    let chunkyVersion: ResolvedChunkyVersion | null = null
    if (softwareSelection.kind === 'paper') {
      onProgress({
        phase: 'version',
        percent: 8,
        message: `Resolving Paper build ${softwareSelection.build} for Minecraft ${version.id}…`
      })
      paperBuild = await resolvePaperBuild(version.id, softwareSelection.build)
      onProgress({ phase: 'plugins', percent: 10, message: `Finding Chunky for Minecraft ${version.id}…` })
      chunkyVersion = await resolveChunkyForPaper(version.id)
    }

    const selectedJava = input.javaPath || 'java'
    onProgress({ phase: 'java', percent: 12, message: `Checking for Java ${version.requiredJavaVersion}…` })
    const java = await checkJava(selectedJava)
    if (!java.available || java.majorVersion === null) {
      throw new AppError(
        'Java was not found. Install the required Java version or enter the full path to the Java executable.',
        'JAVA_NOT_FOUND'
      )
    }
    if (java.majorVersion < version.requiredJavaVersion) {
      throw new AppError(
        `Minecraft ${version.id} requires Java ${version.requiredJavaVersion}; the selected runtime is Java ${java.majorVersion}.`,
        'JAVA_TOO_OLD'
      )
    }

    const id = randomUUID()
    const finalDirectory = join(this.serversDirectory, id)
    const stagingDirectory = join(this.serversDirectory, `.${id}.staging`)
    const launchArtifact = softwareSelection.kind === 'paper' ? 'paper.jar' : 'server.jar'
    const artifactHash = paperBuild?.download.sha256 ?? version.download.sha1
    const artifact = join(this.artifactsDirectory, `${artifactHash}.jar`)
    const now = new Date().toISOString()
    const performancePreset = input.performancePreset ?? (paperBuild ? 'balanced' : 'custom')
    const profile = performancePreset === 'custom' ? null : PERFORMANCE_PROFILES[performancePreset]
    const instance: ServerInstance = {
      id,
      name: input.name,
      version: version.id,
      serverDirectory: finalDirectory,
      software: paperBuild
        ? { kind: 'paper', build: paperBuild.build, channel: paperBuild.channel }
        : { kind: 'vanilla' },
      launchArtifact,
      jarSha1: paperBuild ? null : version.download.sha1,
      artifactSha256: paperBuild?.download.sha256 ?? null,
      requiredJavaVersion: version.requiredJavaVersion,
      javaPath: selectedJava,
      port: input.port,
      memoryMb: input.memoryMb,
      maxPlayers: input.maxPlayers,
      motd: input.motd,
      gameMode: 'survival',
      difficulty: 'normal',
      onlineMode: true,
      viewDistance: profile?.viewDistance ?? 10,
      simulationDistance: profile?.simulationDistance ?? 10,
      performancePreset,
      eulaAcceptedAt: now,
      createdAt: now,
      updatedAt: now
    }

    await mkdir(this.artifactsDirectory, { recursive: true })
    await mkdir(this.serversDirectory, { recursive: true })
    await rm(stagingDirectory, { recursive: true, force: true })
    await mkdir(stagingDirectory, { recursive: true })

    let promoted = false
    try {
      if (paperBuild) await downloadPaperJar(paperBuild, artifact, onProgress)
      else await downloadServerJar(version, artifact, onProgress)
      let chunkyArtifact: string | null = null
      if (chunkyVersion) {
        chunkyArtifact = join(this.artifactsDirectory, `chunky-${chunkyVersion.file.sha512}.jar`)
        onProgress({ phase: 'plugins', percent: 86, message: `Installing Chunky ${chunkyVersion.version}…` })
        await downloadChunky(chunkyVersion, chunkyArtifact, (received, total) => {
          onProgress({
            phase: 'plugins',
            percent: Math.round(86 + Math.min(received / total, 1) * 3),
            message: `Downloading Chunky ${chunkyVersion?.version ?? ''}…`,
            bytesReceived: received,
            totalBytes: total
          })
        })
        await mkdir(join(stagingDirectory, 'plugins'), { recursive: true })
        await copyFile(chunkyArtifact, join(stagingDirectory, 'plugins', 'Chunky.jar'))
      }
      onProgress({ phase: 'files', percent: 90, message: 'Creating your server files…' })
      await Promise.all([
        copyFile(artifact, join(stagingDirectory, launchArtifact)),
        writeFile(
          join(stagingDirectory, 'eula.txt'),
          `# Accepted through EmberHost on ${now}\n# ${'https://www.minecraft.net/en-us/eula'}\neula=true\n`,
          'utf8'
        ),
        writeFile(join(stagingDirectory, 'server.properties'), createServerProperties(instance), 'utf8'),
        writeFile(
          join(stagingDirectory, 'emberhost-instance.json'),
          `${JSON.stringify({
            id,
            version: version.id,
            software: instance.software,
            chunky: chunkyVersion ? {
              id: chunkyVersion.id,
              version: chunkyVersion.version,
              sha512: chunkyVersion.file.sha512
            } : null,
            eulaAcceptedAt: now
          }, null, 2)}\n`,
          'utf8'
        )
      ])
      await rename(stagingDirectory, finalDirectory)
      promoted = true
      await this.store.addInstance(instance)
      promoted = false
      onProgress({ phase: 'ready', percent: 100, message: `${input.name} is ready to start.` })
      return this.manager.getView(instance)
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true })
      if (promoted) await rm(finalDirectory, { recursive: true, force: true })
      throw error
    }
  }

  async update(input: UpdateInstanceInput): Promise<InstanceView> {
    return this.serializeMutation(() => this.manager.runExclusive(input.id, () => this.updateUnlocked(input)))
  }

  async delete(input: DeleteInstanceInput): Promise<void> {
    return this.serializeMutation(() => this.manager.runExclusive(input.id, () => this.deleteUnlocked(input)))
  }

  async getWorldSeed(instanceId: string): Promise<WorldSeedState> {
    return this.serializeMutation(() => this.manager.runExclusive(instanceId, async () => {
      const current = this.store.getInstance(instanceId)
      if (!current) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
      const managedDirectory = await this.assertManagedInstanceDirectory(current)
      const properties = await this.readManagedProperties(join(managedDirectory, 'server.properties'))
      return {
        instanceId,
        seed: (getServerPropertyValue(properties.contents, 'level-seed') ?? '').trim()
      }
    }))
  }

  async regenerateWorld(input: RegenerateWorldInput): Promise<WorldSeedState> {
    return this.serializeMutation(() => this.manager.runExclusive(
      input.instanceId,
      () => this.regenerateWorldUnlocked(input)
    ))
  }

  private async regenerateWorldUnlocked(input: RegenerateWorldInput): Promise<WorldSeedState> {
    const current = this.store.getInstance(input.instanceId)
    if (!current) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (input.confirmationName !== current.name) {
      throw new AppError('Enter the server name exactly to confirm world regeneration.', 'REGENERATE_CONFIRMATION_MISMATCH')
    }

    await this.manager.assertStoppedAndUnowned(input.instanceId)
    const managedDirectory = await this.assertManagedInstanceDirectory(current)
    await assertNoInterruptedWorldRegeneration(current)
    const propertiesPath = join(managedDirectory, 'server.properties')
    const properties = await this.readManagedProperties(propertiesPath)
    const levelName = parseLevelName(properties.contents)
    const candidates = [levelName, `${levelName}_nether`, `${levelName}_the_end`]
    const sources: Array<{ source: string; name: string }> = []

    for (const name of candidates) {
      const source = join(managedDirectory, name)
      if (await this.assertSafeWorldDirectoryIfPresent(source)) sources.push({ source, name })
    }
    const performancePath = join(managedDirectory, 'emberhost-performance.json')
    if (await this.assertSafeFileIfPresent(performancePath, 'World-performance metadata')) {
      sources.push({ source: performancePath, name: 'emberhost-performance.json' })
    }

    const quarantineDirectory = join(this.serversDirectory, `.${current.id}.world-regeneration-${randomUUID()}`)
    const moved: Array<{ source: string; destination: string }> = []
    let propertiesUpdated = false
    let quarantineCreated = false
    try {
      if (sources.length) {
        await mkdir(quarantineDirectory)
        quarantineCreated = true
        for (const item of sources) {
          const destination = join(quarantineDirectory, item.name)
          await rename(item.source, destination)
          moved.push({ source: item.source, destination })
        }
      }

      const baseProperties = properties.existed ? properties.contents : createServerProperties(current)
      await this.atomicWrite(propertiesPath, setServerPropertyValue(baseProperties, 'level-seed', input.seed))
      propertiesUpdated = true
      if (quarantineCreated) await this.trashItem(quarantineDirectory)
    } catch (error) {
      const rollbackFailures: string[] = []
      if (propertiesUpdated) {
        try {
          if (properties.existed) await this.atomicWrite(propertiesPath, properties.contents)
          else await rm(propertiesPath, { force: true })
        } catch (rollbackError) {
          rollbackFailures.push(`server.properties: ${this.errorMessage(rollbackError)}`)
        }
      }
      for (const item of moved.reverse()) {
        try {
          await rename(item.destination, item.source)
        } catch (rollbackError) {
          rollbackFailures.push(`${item.source}: ${this.errorMessage(rollbackError)}`)
        }
      }
      if (quarantineCreated && rollbackFailures.length === 0) {
        try {
          await rm(quarantineDirectory, { recursive: true, force: true })
        } catch (rollbackError) {
          rollbackFailures.push(`quarantine: ${this.errorMessage(rollbackError)}`)
        }
      }
      if (rollbackFailures.length) {
        throw new AppError(
          `World regeneration failed and EmberHost could not fully restore the previous world. Recovery data may remain at ${quarantineDirectory}.`,
          'WORLD_REGENERATION_ROLLBACK_FAILED',
          rollbackFailures.join('; ')
        )
      }
      throw new AppError(
        'EmberHost could not recycle the previous world, so the world and seed were restored.',
        'WORLD_REGENERATION_FAILED',
        this.errorMessage(error)
      )
    }

    return { instanceId: current.id, seed: input.seed }
  }

  private async deleteUnlocked(input: DeleteInstanceInput): Promise<void> {
    const current = this.store.getInstance(input.id)
    if (!current) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (input.confirmationName !== current.name) {
      throw new AppError('Enter the server name exactly to confirm deletion.', 'DELETE_CONFIRMATION_MISMATCH')
    }

    await this.manager.assertStoppedAndUnowned(input.id)
    const managedDirectory = await this.assertManagedInstanceDirectory(current)
    await assertNoInterruptedWorldRegeneration(current)
    const quarantinedDirectory = join(this.serversDirectory, `.${current.id}.deleting-${randomUUID()}`)
    await rename(managedDirectory, quarantinedDirectory)

    let metadataRemoved = false
    try {
      await this.store.removeInstance(current.id)
      metadataRemoved = true
      await this.trashItem(quarantinedDirectory)
    } catch (error) {
      const rollbackFailures: string[] = []
      let directoryRestored = false
      try {
        await rename(quarantinedDirectory, managedDirectory)
        directoryRestored = true
      } catch (rollbackError) {
        rollbackFailures.push(`folder: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }

      if (metadataRemoved && directoryRestored) {
        try {
          await this.store.addInstance(current)
        } catch (rollbackError) {
          rollbackFailures.push(`metadata: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }

      if (rollbackFailures.length) {
        throw new AppError(
          `EmberHost could not finish deleting “${current.name}” or fully restore it. The staged recovery path is ${quarantinedDirectory}.`,
          'DELETE_ROLLBACK_FAILED',
          rollbackFailures.join('; ')
        )
      }
      throw new AppError(
        `EmberHost could not move “${current.name}” to the recycle bin, so the server was restored.`,
        'SERVER_DELETE_FAILED',
        error instanceof Error ? error.message : String(error)
      )
    }

    this.manager.forgetInstance(current.id)
  }

  private async assertManagedInstanceDirectory(instance: ServerInstance): Promise<string> {
    const serversRoot = resolve(this.serversDirectory)
    const expectedDirectory = resolve(serversRoot, instance.id)
    const comparison = (value: string): string =>
      process.platform === 'win32' || process.platform === 'darwin' ? value.toLocaleLowerCase('en-US') : value
    if (comparison(resolve(instance.serverDirectory)) !== comparison(expectedDirectory)) {
      throw new AppError(
        'EmberHost refused to delete a server whose folder is outside its managed servers directory.',
        'UNMANAGED_SERVER_DIRECTORY'
      )
    }
    const childPath = relative(serversRoot, expectedDirectory)
    if (!childPath || childPath.startsWith('..') || isAbsolute(childPath) || childPath !== instance.id) {
      throw new AppError('The managed server path is invalid.', 'UNMANAGED_SERVER_DIRECTORY')
    }

    let directoryStats
    try {
      directoryStats = await lstat(expectedDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('The server folder is missing. EmberHost left its registry entry untouched.', 'SERVER_DIRECTORY_MISSING')
      }
      throw error
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new AppError('The managed server path is not a normal local directory.', 'UNSAFE_SERVER_DIRECTORY')
    }

    const [realServersRoot, realServerDirectory] = await Promise.all([
      realpath(serversRoot),
      realpath(expectedDirectory)
    ])
    if (comparison(realServerDirectory) !== comparison(resolve(realServersRoot, instance.id))) {
      throw new AppError('The server folder resolves outside EmberHost’s managed directory.', 'UNSAFE_SERVER_DIRECTORY')
    }

    const ownershipPath = join(expectedDirectory, 'emberhost-instance.json')
    try {
      const ownershipStats = await lstat(ownershipPath)
      if (!ownershipStats.isFile() || ownershipStats.isSymbolicLink() || ownershipStats.size > 1024 * 1024) {
        throw new AppError('The server ownership marker is invalid.', 'INVALID_INSTANCE_MARKER')
      }
      const marker = JSON.parse(await readFile(ownershipPath, 'utf8')) as { id?: unknown }
      if (marker.id !== instance.id) {
        throw new AppError('The server ownership marker does not match this instance.', 'INVALID_INSTANCE_MARKER')
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('The server ownership marker is missing.', 'INVALID_INSTANCE_MARKER')
      }
      if (error instanceof SyntaxError) {
        throw new AppError('The server ownership marker is unreadable.', 'INVALID_INSTANCE_MARKER')
      }
      throw error
    }
    return expectedDirectory
  }

  private async readManagedProperties(propertiesPath: string): Promise<{ contents: string; existed: boolean }> {
    try {
      const stats = await lstat(propertiesPath)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new AppError('server.properties is not a normal local file.', 'UNSAFE_SERVER_PROPERTIES')
      }
      return { contents: await readFile(propertiesPath, 'utf8'), existed: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { contents: '', existed: false }
      throw error
    }
  }

  private async assertSafeWorldDirectoryIfPresent(directory: string): Promise<boolean> {
    let stats
    try {
      stats = await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AppError(
        `EmberHost refused to remove ${directory} because it is not a normal local world directory.`,
        'UNSAFE_WORLD_DIRECTORY'
      )
    }
    const levelData = join(directory, 'level.dat')
    try {
      const levelDataStats = await lstat(levelData)
      if (!levelDataStats.isFile() || levelDataStats.isSymbolicLink()) {
        throw new AppError(
          `EmberHost refused to remove ${directory} because its level.dat is not a normal local file.`,
          'UNSAFE_WORLD_DIRECTORY'
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError(
          `EmberHost refused to remove ${directory} because it does not contain level.dat.`,
          'UNSAFE_WORLD_DIRECTORY'
        )
      }
      throw error
    }
    return true
  }

  private async assertSafeFileIfPresent(filePath: string, description: string): Promise<boolean> {
    try {
      const stats = await lstat(filePath)
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new AppError(`${description} is not a normal local file.`, 'UNSAFE_WORLD_METADATA')
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private async updateUnlocked(input: UpdateInstanceInput): Promise<InstanceView> {
    const current = this.store.getInstance(input.id)
    if (!current) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (this.manager.isActive(input.id)) {
      throw new AppError('Stop the server before changing its configuration.', 'SERVER_MUST_BE_STOPPED')
    }
    if (this.store.getInstances().some((instance) => instance.id !== input.id && instance.port === input.port)) {
      throw new AppError(`Port ${input.port} is already assigned to another EmberHost server.`, 'PORT_IN_USE')
    }

    const java = await checkJava(input.javaPath)
    if (!java.available || java.majorVersion === null) {
      throw new AppError('The selected Java executable could not be started.', 'JAVA_NOT_FOUND')
    }
    if (java.majorVersion < current.requiredJavaVersion) {
      throw new AppError(
        `Minecraft ${current.version} requires Java ${current.requiredJavaVersion}; the selected runtime is Java ${java.majorVersion}.`,
        'JAVA_TOO_OLD'
      )
    }

    const updated: ServerInstance = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString()
    }
    const propertiesPath = join(current.serverDirectory, 'server.properties')
    let existing = ''
    let propertiesExisted = true
    try {
      existing = await readFile(propertiesPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      propertiesExisted = false
    }
    const updatedProperties = propertiesExisted
      ? mergeServerProperties(existing, updated)
      : createServerProperties(updated)
    await this.atomicWrite(propertiesPath, updatedProperties)
    try {
      await this.store.updateInstance(updated)
    } catch (error) {
      try {
        if (propertiesExisted) await this.atomicWrite(propertiesPath, existing)
        else await rm(propertiesPath, { force: true })
      } catch (rollbackError) {
        throw new AppError(
          'Server settings could not be saved, and the properties rollback also failed. Inspect server.properties before starting.',
          'SETTINGS_ROLLBACK_FAILED',
          rollbackError instanceof Error ? rollbackError.message : undefined
        )
      }
      throw error
    }
    return this.manager.getView(updated)
  }

  private async atomicWrite(filePath: string, contents: string): Promise<void> {
    const temporaryPath = `${filePath}.emberhost.tmp`
    try {
      await writeFile(temporaryPath, contents, 'utf8')
      await rename(temporaryPath, filePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.catch(() => undefined).then(operation)
    this.mutationQueue = next
    return next
  }

  async awaitIdle(): Promise<void> {
    await this.mutationQueue.catch(() => undefined)
  }
}
