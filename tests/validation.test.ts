import { describe, expect, it } from 'vitest'
import { commandSchema, createInstanceSchema, regenerateWorldSchema } from '../src/main/services/validation'

describe('IPC validation', () => {
  it('requires explicit EULA acceptance', () => {
    const result = createInstanceSchema.safeParse({
      name: 'World',
      version: '26.2',
      memoryMb: 4096,
      port: 25565,
      maxPlayers: 20,
      motd: 'Hello',
      javaPath: 'java',
      eulaAccepted: false
    })
    expect(result.success).toBe(false)
  })

  it('rejects unsafe server names', () => {
    const result = createInstanceSchema.safeParse({
      name: '../World',
      version: '26.2',
      memoryMb: 4096,
      port: 25565,
      maxPlayers: 20,
      motd: 'Hello',
      eulaAccepted: true
    })
    expect(result.success).toBe(false)
  })

  it('rejects privileged ports', () => {
    const result = createInstanceSchema.safeParse({
      name: 'World',
      version: '26.2',
      memoryMb: 4096,
      port: 80,
      maxPlayers: 20,
      motd: 'Hello',
      eulaAccepted: true
    })
    expect(result.success).toBe(false)
  })

  it('accepts one bounded console command', () => {
    expect(commandSchema.safeParse({ id: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1', command: 'time set day' }).success).toBe(true)
    expect(commandSchema.safeParse({ id: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1', command: 'list\nstop' }).success).toBe(false)
  })

  it('normalizes bounded world seeds and rejects control characters', () => {
    const valid = regenerateWorldSchema.safeParse({
      instanceId: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
      seed: '  Glacier Village  ',
      confirmationName: 'World'
    })
    expect(valid.success && valid.data.seed).toBe('Glacier Village')
    expect(regenerateWorldSchema.safeParse({
      instanceId: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
      seed: '',
      confirmationName: 'World'
    }).success).toBe(true)
    expect(regenerateWorldSchema.safeParse({
      instanceId: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
      seed: 'bad\u0007seed',
      confirmationName: 'World'
    }).success).toBe(false)
    expect(regenerateWorldSchema.safeParse({
      instanceId: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
      seed: '\tseed',
      confirmationName: 'World'
    }).success).toBe(false)
    expect(regenerateWorldSchema.safeParse({
      instanceId: 'a329da1a-18ad-4ba4-b3c6-afb6cbce70d1',
      seed: 'x'.repeat(129),
      confirmationName: 'World'
    }).success).toBe(false)
  })
})
