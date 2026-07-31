import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AppSettings, ServerInstance } from '../../shared/contracts'

interface PersistedData {
  schemaVersion: 1
  settings: AppSettings
  instances: ServerInstance[]
}

const initialData: PersistedData = {
  schemaVersion: 1,
  settings: {
    launchAtLogin: false,
    minimizeToTray: true
  },
  instances: []
}

const serverInstanceSchema = z.object({
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

const persistedDataSchema = z.object({
  schemaVersion: z.literal(1),
  settings: z.object({
    launchAtLogin: z.boolean(),
    minimizeToTray: z.boolean()
  }),
  instances: z.array(serverInstanceSchema)
})

export class AppStore {
  private readonly filePath: string
  private data: PersistedData = structuredClone(initialData)
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly dataDirectory: string) {
    this.filePath = join(dataDirectory, 'emberhost.json')
  }

  async load(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true })

    try {
      this.data = persistedDataSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
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
      await this.writeQueue
    } catch (error) {
      this.writeQueue = Promise.resolve()
      throw error
    }
  }

  getInstances(): ServerInstance[] {
    return this.data.instances.map((instance) => ({ ...instance }))
  }

  getInstance(id: string): ServerInstance | undefined {
    const instance = this.data.instances.find((item) => item.id === id)
    return instance ? { ...instance } : undefined
  }

  async addInstance(instance: ServerInstance): Promise<void> {
    this.data.instances.push({ ...instance })
    try {
      await this.persist()
    } catch (error) {
      this.data.instances = this.data.instances.filter((item) => item.id !== instance.id)
      throw error
    }
  }

  async updateInstance(instance: ServerInstance): Promise<void> {
    const index = this.data.instances.findIndex((item) => item.id === instance.id)
    if (index < 0) throw new Error('Server instance not found.')
    const previous = this.data.instances[index]
    this.data.instances[index] = { ...instance }
    try {
      await this.persist()
    } catch (error) {
      if (previous) this.data.instances[index] = previous
      throw error
    }
  }

  async updateSettings(settings: AppSettings): Promise<void> {
    const previous = this.data.settings
    this.data.settings = { ...settings }
    try {
      await this.persist()
    } catch (error) {
      this.data.settings = previous
      throw error
    }
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(this.dataDirectory, { recursive: true })
      const temporaryPath = `${this.filePath}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    })
    return this.writeQueue
  }
}
