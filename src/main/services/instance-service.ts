import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CreateInstanceInput,
  InstanceView,
  PaperBuildInfo,
  ServerInstance,
  SetupProgress,
  UpdateInstanceInput
} from '../../shared/contracts'
import { PERFORMANCE_PROFILES } from '../../shared/performance'
import { downloadChunky, resolveChunkyForPaper, type ResolvedChunkyVersion } from './chunky'
import { AppError } from './errors'
import { checkJava } from './java'
import { downloadServerJar, resolveRelease } from './minecraft'
import { downloadPaperJar, resolvePaperBuild } from './paper'
import { createServerProperties, mergeServerProperties } from './properties'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'

type ProgressListener = (progress: SetupProgress) => void

export class InstanceService {
  private readonly serversDirectory: string
  private readonly artifactsDirectory: string
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: AppStore,
    private readonly manager: ServerManager,
    runtimeDataDirectory = store.dataDirectory
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
