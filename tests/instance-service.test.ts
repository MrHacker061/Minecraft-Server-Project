import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/services/java', () => ({
  checkJava: vi.fn(async (command = 'java') => ({
    available: true,
    command,
    majorVersion: 25,
    versionText: 'java version "25"',
    error: null
  }))
}))

vi.mock('../src/main/services/minecraft', () => ({
  resolveRelease: vi.fn(async (id: string) => ({
    id,
    type: 'release',
    requiredJavaVersion: 25,
    download: {
      sha1: '0123456789012345678901234567890123456789',
      size: 8,
      url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar'
    }
  })),
  downloadServerJar: vi.fn(async (_version: unknown, destination: string) => {
    await writeFile(destination, 'fake jar', 'utf8')
  })
}))

import type { CreateInstanceInput } from '../src/shared/contracts'
import { InstanceService } from '../src/main/services/instance-service'
import { downloadServerJar, resolveRelease } from '../src/main/services/minecraft'
import { ServerManager } from '../src/main/services/server-manager'
import { AppStore } from '../src/main/services/store'

const temporaryDirectories: string[] = []
const input: CreateInstanceInput = {
  name: 'Integration world',
  version: '26.2',
  memoryMb: 4096,
  port: 25565,
  maxPlayers: 20,
  motd: 'Hello from a test',
  javaPath: 'java',
  eulaAccepted: true
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(downloadServerJar).mockClear()
  vi.mocked(resolveRelease).mockClear()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function harness(): Promise<{ directory: string; store: AppStore; service: InstanceService }> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-instance-'))
  temporaryDirectories.push(directory)
  const store = new AppStore(join(directory, 'config'))
  await store.load()
  const manager = new ServerManager(store)
  const service = new InstanceService(store, manager, join(directory, 'runtime'))
  return { directory, store, service }
}

describe('InstanceService', () => {
  it('stages an exact release and records explicit EULA acceptance', async () => {
    const { store, service } = await harness()
    const instance = await service.create(input, () => undefined)

    expect(resolveRelease).toHaveBeenCalledWith('26.2')
    expect(await readFile(join(instance.serverDirectory, 'server.jar'), 'utf8')).toBe('fake jar')
    expect(await readFile(join(instance.serverDirectory, 'eula.txt'), 'utf8')).toContain('eula=true')
    expect(await readFile(join(instance.serverDirectory, 'server.properties'), 'utf8')).toContain('online-mode=true')
    expect(store.getInstance(instance.id)?.eulaAcceptedAt).toBeTruthy()
  })

  it('removes staging data and does not persist an instance after setup failure', async () => {
    const { directory, store, service } = await harness()
    vi.mocked(downloadServerJar).mockRejectedValueOnce(new Error('download failed'))

    await expect(service.create(input, () => undefined)).rejects.toThrow('download failed')
    expect(store.getInstances()).toEqual([])
    const serversRoot = join(directory, 'runtime', 'servers')
    expect(await readdir(serversRoot)).toEqual([])
  })

  it('restores server.properties when metadata persistence fails', async () => {
    const { store, service } = await harness()
    const instance = await service.create(input, () => undefined)
    const propertiesPath = join(instance.serverDirectory, 'server.properties')
    const before = await readFile(propertiesPath, 'utf8')
    vi.spyOn(store, 'updateInstance').mockRejectedValueOnce(new Error('disk full'))

    await expect(service.update({
      id: instance.id,
      name: instance.name,
      memoryMb: instance.memoryMb,
      port: instance.port,
      maxPlayers: instance.maxPlayers,
      motd: instance.motd,
      gameMode: instance.gameMode,
      difficulty: instance.difficulty,
      onlineMode: false,
      viewDistance: instance.viewDistance,
      simulationDistance: instance.simulationDistance,
      javaPath: instance.javaPath
    })).rejects.toThrow('disk full')

    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(store.getInstance(instance.id)?.onlineMode).toBe(true)
  })
})
