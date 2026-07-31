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

vi.mock('../src/main/services/paper', () => ({
  resolvePaperBuild: vi.fn(async (minecraftVersion: string, build: number) => ({
    minecraftVersion,
    build,
    channel: 'STABLE',
    publishedAt: '2026-07-31T00:00:00.000Z',
    download: {
      name: `paper-${minecraftVersion}-${build}.jar`,
      sha256: 'a'.repeat(64),
      size: 14,
      url: `https://fill-data.papermc.io/v1/objects/${'a'.repeat(64)}/paper-${minecraftVersion}-${build}.jar`
    }
  })),
  downloadPaperJar: vi.fn(async (_build: unknown, destination: string) => {
    await writeFile(destination, 'fake paper jar', 'utf8')
  })
}))

vi.mock('../src/main/services/chunky', () => ({
  resolveChunkyForPaper: vi.fn(async () => ({
    id: 'chunky-version',
    version: '1.5.3',
    file: {
      name: 'Chunky-Bukkit-1.5.3.jar',
      sha512: 'b'.repeat(128),
      size: 11,
      url: 'https://cdn.modrinth.com/data/fALzjamp/versions/chunky-version/Chunky-Bukkit-1.5.3.jar'
    }
  })),
  downloadChunky: vi.fn(async (_version: unknown, destination: string) => {
    await writeFile(destination, 'fake chunky', 'utf8')
  })
}))

import type { CreateInstanceInput } from '../src/shared/contracts'
import { downloadChunky, resolveChunkyForPaper } from '../src/main/services/chunky'
import { InstanceService } from '../src/main/services/instance-service'
import { downloadServerJar, resolveRelease } from '../src/main/services/minecraft'
import { downloadPaperJar, resolvePaperBuild } from '../src/main/services/paper'
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
  vi.mocked(downloadPaperJar).mockClear()
  vi.mocked(resolvePaperBuild).mockClear()
  vi.mocked(downloadChunky).mockClear()
  vi.mocked(resolveChunkyForPaper).mockClear()
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

  it('pins and stages the selected Paper build as its launch artifact', async () => {
    const { store, service } = await harness()
    const instance = await service.create({
      ...input,
      name: 'Paper world',
      software: { kind: 'paper', build: 87 }
    }, () => undefined)

    expect(resolvePaperBuild).toHaveBeenCalledWith('26.2', 87)
    expect(downloadPaperJar).toHaveBeenCalledOnce()
    expect(await readFile(join(instance.serverDirectory, 'paper.jar'), 'utf8')).toBe('fake paper jar')
    expect(await readFile(join(instance.serverDirectory, 'plugins', 'Chunky.jar'), 'utf8')).toBe('fake chunky')
    expect(instance).toMatchObject({
      software: { kind: 'paper', build: 87, channel: 'STABLE' },
      launchArtifact: 'paper.jar',
      jarSha1: null,
      artifactSha256: 'a'.repeat(64)
    })
    expect(store.getInstance(instance.id)?.software).toEqual({ kind: 'paper', build: 87, channel: 'STABLE' })
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
      performancePreset: instance.performancePreset,
      javaPath: instance.javaPath
    })).rejects.toThrow('disk full')

    expect(await readFile(propertiesPath, 'utf8')).toBe(before)
    expect(store.getInstance(instance.id)?.onlineMode).toBe(true)
  })
})
