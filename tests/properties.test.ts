import { describe, expect, it } from 'vitest'
import type { ServerInstance } from '../src/shared/contracts'
import {
  createServerProperties,
  getServerPropertyValue,
  mergeServerProperties,
  parseLevelName,
  setServerPropertyValue
} from '../src/main/services/properties'

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

  it('reads the last property value and safely replaces duplicate entries', () => {
    const existing = '# keep this\nlevel-seed=old\nplugin-setting=yes\nlevel-seed=newer\n'
    expect(getServerPropertyValue(existing, 'level-seed')).toBe('newer')

    const output = setServerPropertyValue(existing, 'level-seed', '8675309')
    expect(output).toContain('# keep this')
    expect(output).toContain('plugin-setting=yes')
    expect(output.match(/^level-seed=/gm)).toHaveLength(1)
    expect(getServerPropertyValue(output, 'level-seed')).toBe('8675309')
  })

  it('supports an intentionally blank seed without changing unknown properties', () => {
    const output = setServerPropertyValue('custom-setting=preserved\n', 'level-seed', '')
    expect(output).toBe('custom-setting=preserved\nlevel-seed=\n')
    expect(getServerPropertyValue(output, 'level-seed')).toBe('')
  })

  it('escapes backslashes using Java properties syntax and decodes them when read', () => {
    const output = setServerPropertyValue('', 'level-seed', 'folder\\seed')
    expect(output).toBe('level-seed=folder\\\\seed\n')
    expect(getServerPropertyValue(output, 'level-seed')).toBe('folder\\seed')
  })

  it('honors Java properties separators and continuations without trimming folder names', () => {
    expect(parseLevelName('level-name:custom_world\n')).toBe('custom_world')
    expect(parseLevelName('level-name custom_world\n')).toBe('custom_world')
    expect(parseLevelName('level-name=custom\\\n  _world\n')).toBe('custom_world')
    expect(parseLevelName('# comment ending in a slash \\\nlevel-name:custom_world\n')).toBe('custom_world')
    expect(() => parseLevelName('level-name:plugins\n')).toThrow()
    expect(() => parseLevelName('! comment ending in a slash \\\nlevel-name:plugins\n')).toThrow()
    expect(() => parseLevelName('level-name=world \n')).toThrow()
  })

  it('replaces every seed declaration regardless of Java properties separator', () => {
    const existing = 'level-seed=first\nlevel-seed:second\nlevel-seed third\n'
    const output = setServerPropertyValue(existing, 'level-seed', 'replacement')
    expect(output).toBe('level-seed=replacement\n')
    expect(getServerPropertyValue(output, 'level-seed')).toBe('replacement')
  })

  it('rejects property injection and unsafe or reserved world folder names', () => {
    expect(() => setServerPropertyValue('', 'level-seed', 'seed\nlevel-name=plugins')).toThrow()
    expect(() => getServerPropertyValue('', '../seed')).toThrow()
    expect(parseLevelName('level-name=custom_world\n')).toBe('custom_world')
    for (const levelName of ['../world', 'plugins', 'LOGS', 'emberhost-backups', '.paper']) {
      expect(() => parseLevelName(`level-name=${levelName}\n`)).toThrow()
    }
  })
})
