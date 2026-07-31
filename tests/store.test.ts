import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerInstance } from '../src/shared/contracts'
import { AppStore } from '../src/main/services/store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AppStore', () => {
  it('persists settings and instances across reloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-store-'))
    temporaryDirectories.push(directory)
    const store = new AppStore(directory)
    await store.load()

    const instance: ServerInstance = {
      id: 'b1514450-bddf-463b-b915-8c3c79540cba',
      name: 'Persistent world',
      version: '26.2',
      serverDirectory: join(directory, 'servers', 'b1514450-bddf-463b-b915-8c3c79540cba'),
      jarSha1: 'abc',
      requiredJavaVersion: 25,
      javaPath: 'java',
      port: 25565,
      memoryMb: 4096,
      maxPlayers: 20,
      motd: 'Hello',
      gameMode: 'survival',
      difficulty: 'normal',
      onlineMode: true,
      viewDistance: 10,
      simulationDistance: 10,
      eulaAcceptedAt: '2026-07-31T00:00:00.000Z',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z'
    }

    await store.addInstance(instance)
    await store.updateSettings({ launchAtLogin: true, minimizeToTray: false })

    const reloaded = new AppStore(directory)
    await reloaded.load()
    expect(reloaded.getInstance(instance.id)?.name).toBe('Persistent world')
    expect(reloaded.getSettings()).toEqual({ launchAtLogin: true, minimizeToTray: false })
    expect(JSON.parse(await readFile(join(directory, 'emberhost.json'), 'utf8')).schemaVersion).toBe(1)
  })

  it('backs up malformed state and recovers with safe defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-store-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'emberhost.json'), '{not valid json', 'utf8')

    const store = new AppStore(directory)
    await store.load()

    expect(store.getInstances()).toEqual([])
    expect(store.getSettings()).toEqual({ launchAtLogin: false, minimizeToTray: true })
    expect((await readdir(directory)).some((name) => name.startsWith('emberhost.corrupt-'))).toBe(true)
  })
})
