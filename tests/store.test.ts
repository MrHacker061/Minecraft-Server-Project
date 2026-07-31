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
      software: { kind: 'vanilla' },
      launchArtifact: 'server.jar',
      jarSha1: 'abc',
      artifactSha256: null,
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
      performancePreset: 'balanced',
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
    expect(JSON.parse(await readFile(join(directory, 'emberhost.json'), 'utf8')).schemaVersion).toBe(2)
  })

  it('migrates schema v1 vanilla instances without quarantining or losing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-store-'))
    temporaryDirectories.push(directory)
    const id = 'f4bd352b-4d1e-4382-aacf-48eb31a5ac75'
    await writeFile(join(directory, 'emberhost.json'), `${JSON.stringify({
      schemaVersion: 1,
      settings: { launchAtLogin: true, minimizeToTray: false },
      instances: [{
        id,
        name: 'Legacy vanilla world',
        version: '26.2',
        serverDirectory: join(directory, 'servers', id),
        jarSha1: 'legacy-sha1-value',
        requiredJavaVersion: 25,
        javaPath: 'java',
        port: 25565,
        memoryMb: 4096,
        maxPlayers: 20,
        motd: 'Still here',
        gameMode: 'survival',
        difficulty: 'normal',
        onlineMode: true,
        viewDistance: 10,
        simulationDistance: 10,
        eulaAcceptedAt: '2026-07-31T00:00:00.000Z',
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:00:00.000Z'
      }]
    }, null, 2)}\n`, 'utf8')

    const store = new AppStore(directory)
    await store.load()

    expect(store.getInstance(id)).toMatchObject({
      name: 'Legacy vanilla world',
      software: { kind: 'vanilla' },
      launchArtifact: 'server.jar',
      jarSha1: 'legacy-sha1-value',
      artifactSha256: null,
      performancePreset: 'custom'
    })
    const persisted = JSON.parse(await readFile(join(directory, 'emberhost.json'), 'utf8'))
    expect(persisted.schemaVersion).toBe(2)
    expect((await readdir(directory)).some((name) => name.startsWith('emberhost.corrupt-'))).toBe(false)
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

  it('refuses a newer schema without quarantining or overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-store-'))
    temporaryDirectories.push(directory)
    const futureState = {
      schemaVersion: 3,
      settings: { launchAtLogin: true, minimizeToTray: false },
      instances: [],
      futureField: 'preserve me'
    }
    await writeFile(join(directory, 'emberhost.json'), `${JSON.stringify(futureState, null, 2)}\n`, 'utf8')

    const store = new AppStore(directory)
    await expect(store.load()).rejects.toMatchObject({ code: 'UNSUPPORTED_STORE_VERSION' })
    expect(JSON.parse(await readFile(join(directory, 'emberhost.json'), 'utf8'))).toEqual(futureState)
    expect((await readdir(directory)).some((name) => name.startsWith('emberhost.corrupt-'))).toBe(false)
  })
})
