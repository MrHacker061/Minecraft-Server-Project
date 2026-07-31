import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppSettings, ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'

interface PersistedData {
  schemaVersion: 2
  settings: AppSettings
  instances: ServerInstance[]
}

const initialData: PersistedData = {
  schemaVersion: 2,
  settings: {
    launchAtLogin: false,
    minimizeToTray: true
  },
  instances: []
}

const serverInstanceV1Schema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  serverDirectory: z.string(),
  jarSha1: z.string(),
  requiredJavaVersion: z.number().int().positive(),
  javaPath: z.string(),
  port: z.number().int().min(1).max(65535),
  memoryMb: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  motd: z.string(),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  onlineMode: z.boolean(),
  viewDistance: z.number().int(),
  simulationDistance: z.number().int(),
  eulaAcceptedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})

const settingsSchema = z.object({
  launchAtLogin: z.boolean(),
  minimizeToTray: z.boolean()
})

const persistedDataV1Schema = z.object({
  schemaVersion: z.literal(1),
  settings: settingsSchema,
  instances: z.array(serverInstanceV1Schema)
})

const softwareSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vanilla') }),
  z.object({
    kind: z.literal('paper'),
    build: z.number().int().positive(),
    channel: z.string().min(1).max(32)
  })
])

const serverInstanceSchema = serverInstanceV1Schema.extend({
  software: softwareSchema,
  launchArtifact: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+\.jar$/i),
  jarSha1: z.string().nullable(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  performancePreset: z.enum(['balanced', 'far-view', 'maximum-performance', 'custom'])
}).superRefine((instance, context) => {
  if (instance.software.kind === 'paper' && !instance.artifactSha256) {
    context.addIssue({ code: 'custom', message: 'Paper instances require a SHA-256.' })
  }
})

const persistedDataSchema = z.object({
  schemaVersion: z.literal(2),
  settings: settingsSchema,
  instances: z.array(serverInstanceSchema)
})

function cloneInstance(instance: ServerInstance): ServerInstance {
  return { ...instance, software: { ...instance.software } }
}

export class AppStore {
  private readonly filePath: string
  private data: PersistedData = structuredClone(initialData)
  private writeQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(readonly dataDirectory: string) {
    this.filePath = join(dataDirectory, 'emberhost.json')
  }

  async load(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true })

    try {
      const rawData: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (
        typeof rawData === 'object' &&
        rawData !== null &&
        'schemaVersion' in rawData &&
        typeof rawData.schemaVersion === 'number' &&
        rawData.schemaVersion > initialData.schemaVersion
      ) {
        throw new AppError(
          'EmberHost data was created by a newer app version. Upgrade EmberHost instead of overwriting it.',
          'UNSUPPORTED_STORE_VERSION'
        )
      }
      const current = persistedDataSchema.safeParse(rawData)
      if (current.success) {
        this.data = current.data
        return
      }

      const legacy = persistedDataV1Schema.safeParse(rawData)
      if (!legacy.success) throw current.error
      this.data = {
        schemaVersion: 2,
        settings: legacy.data.settings,
        instances: legacy.data.instances.map((instance) => ({
          ...instance,
          software: { kind: 'vanilla' as const },
          launchArtifact: 'server.jar',
          artifactSha256: null,
          performancePreset: 'custom' as const
        }))
      }
      await this.persist()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        await this.persist()
        return
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        const backupPath = join(this.dataDirectory, `emberhost.corrupt-${Date.now()}.json`)
        await rename(this.filePath, backupPath)
        this.data = structuredClone(initialData)
        await this.persist()
        return
      }
      throw error
    }
  }

  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  async awaitIdle(): Promise<void> {
    try {
      await this.mutationQueue
      await this.writeQueue
    } catch (error) {
      this.mutationQueue = Promise.resolve()
      this.writeQueue = Promise.resolve()
      throw error
    }
  }

  getInstances(): ServerInstance[] {
    return this.data.instances.map(cloneInstance)
  }

  getInstance(id: string): ServerInstance | undefined {
    const instance = this.data.instances.find((item) => item.id === id)
    return instance ? cloneInstance(instance) : undefined
  }

  async addInstance(instance: ServerInstance): Promise<void> {
    return this.serializeMutation(async () => {
      this.data.instances.push(cloneInstance(instance))
      try {
        await this.persist()
      } catch (error) {
        this.data.instances = this.data.instances.filter((item) => item.id !== instance.id)
        throw error
      }
    })
  }

  async updateInstance(instance: ServerInstance): Promise<void> {
    return this.serializeMutation(async () => {
      const index = this.data.instances.findIndex((item) => item.id === instance.id)
      if (index < 0) throw new Error('Server instance not found.')
      const previous = this.data.instances[index]
      this.data.instances[index] = cloneInstance(instance)
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.data.instances[index] = previous
        throw error
      }
    })
  }

  async updateSettings(settings: AppSettings): Promise<void> {
    return this.serializeMutation(async () => {
      const previous = this.data.settings
      this.data.settings = { ...settings }
      try {
        await this.persist()
      } catch (error) {
        this.data.settings = previous
        throw error
      }
    })
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.data)
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(this.dataDirectory, { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    })
    return this.writeQueue
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.catch(() => undefined).then(operation)
    this.mutationQueue = next
    return next
  }
}
