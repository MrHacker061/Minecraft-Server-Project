import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleEntry, ServerInstance, StateEvent } from '../src/shared/contracts'
import { ServerManager } from '../src/main/services/server-manager'
import { AppStore } from '../src/main/services/store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function waitFor<T>(register: (resolve: (value: T) => void) => void, timeoutMs = 3_000): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for server event.')), timeoutMs)
    register((value) => {
      clearTimeout(timeout)
      resolvePromise(value)
    })
  })
}

describe('ServerManager', () => {
  it('starts, reaches readiness, sends a command, and stops gracefully', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emberhost-manager-'))
    temporaryDirectories.push(directory)
    const serverDirectory = join(directory, 'server')
    await mkdir(serverDirectory, { recursive: true })
    const store = new AppStore(join(directory, 'config'))
    await store.load()
    const instance: ServerInstance = {
      id: '0497aa5e-ac48-4c67-bb1e-f742007f3679',
      name: 'Fake world',
      version: '26.2',
      serverDirectory,
      software: { kind: 'paper', build: 87, channel: 'STABLE' },
      launchArtifact: 'paper.jar',
      jarSha1: null,
      artifactSha256: 'a'.repeat(64),
      requiredJavaVersion: 25,
      javaPath: 'java',
      port: 25565,
      memoryMb: 4096,
      maxPlayers: 20,
      motd: 'Fake',
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

    let capturedArgs: string[] = []
    let capturedShell: boolean | undefined
    const manager = new ServerManager(store, {
      checkJava: async (command = 'java') => ({
        available: true,
        command,
        majorVersion: 25,
        versionText: 'java version "25"',
        error: null
      }),
      spawnProcess: (_command, args, options) => {
        capturedArgs = args
        capturedShell = options.shell
        return spawn(process.execPath, [resolve('tests/fixtures/fake-server.mjs')], options)
      }
    })

    const online = waitFor<StateEvent>((resolveEvent) => {
      manager.onState((event) => {
        if (event.runtime.status === 'online') resolveEvent(event)
      })
    })
    await manager.start(instance.id)
    expect((await online).runtime.status).toBe('online')
    expect(capturedArgs).toContain('-Xmx4096M')
    expect(capturedArgs.slice(-2)).toEqual(['paper.jar', 'nogui'])
    expect(capturedShell).toBe(false)

    const commandOutput = waitFor<ConsoleEntry>((resolveEntry) => {
      manager.onConsole((entry) => {
        if (entry.line.includes('Executed list')) resolveEntry(entry)
      })
    })
    await manager.sendCommand(instance.id, 'list')
    expect((await commandOutput).line).toContain('Executed list')

    const stopped = await manager.stop(instance.id)
    expect(stopped.runtime.status).toBe('offline')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
    await expect(access(join(serverDirectory, '.emberhost-runtime.json'))).rejects.toThrow()
  })
})
