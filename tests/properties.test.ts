import { describe, expect, it } from 'vitest'
import type { ServerInstance } from '../src/shared/contracts'
import { createServerProperties, mergeServerProperties } from '../src/main/services/properties'

const instance: ServerInstance = {
  id: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
  name: 'Test server',
  version: '26.2',
  serverDirectory: 'C:\\servers\\test',
  software: { kind: 'vanilla' },
  launchArtifact: 'server.jar',
  jarSha1: 'abc',
  artifactSha256: null,
  requiredJavaVersion: 25,
  javaPath: 'java',
  port: 25565,
  memoryMb: 4096,
  maxPlayers: 20,
  motd: 'Hello world',
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

describe('server.properties', () => {
  it('creates a minimal version-safe configuration', () => {
    const output = createServerProperties(instance)
    expect(output).toContain('server-port=25565')
    expect(output).toContain('online-mode=true')
    expect(output).not.toContain('enable-command-block=')
    expect(output.endsWith('\n')).toBe(true)
  })

  it('preserves comments and unknown settings while replacing controlled values', () => {
    const existing = '# custom comment\ncustom-plugin-setting=keep-me\nserver-port=24444\nmotd=Old\n'
    const output = mergeServerProperties(existing, { ...instance, port: 25570, motd: 'New world' })
    expect(output).toContain('# custom comment')
    expect(output).toContain('custom-plugin-setting=keep-me')
    expect(output).toContain('server-port=25570')
    expect(output).toContain('motd=New world')
    expect(output).not.toContain('server-port=24444')
  })

  it('strips newlines from property values', () => {
    const output = createServerProperties({ ...instance, motd: 'Hello\noperator=true' })
    expect(output).toContain('motd=Hello operator=true')
    expect(output).not.toContain('\noperator=true\n')
  })
})
