import { describe, expect, it } from 'vitest'
import { isMsptHeader, parseMsptValuesLine, parseTpsLine } from '../src/main/services/metrics'
import { buildLaunchArguments } from '../src/main/services/server-manager'
import type { ServerInstance } from '../src/shared/contracts'

const paperInstance: ServerInstance = {
  id: '0497aa5e-ac48-4c67-bb1e-f742007f3679',
  name: 'Metrics world',
  version: '26.2',
  serverDirectory: 'C:\\server',
  software: { kind: 'paper', build: 87, channel: 'STABLE' },
  launch: { kind: 'jar', path: 'paper.jar' },
  jarSha1: null,
  artifactSha256: 'a'.repeat(64),
  requiredJavaVersion: 25,
  javaPath: 'java',
  port: 25565,
  memoryMb: 6144,
  maxPlayers: 5,
  motd: 'Metrics',
  gameMode: 'survival',
  difficulty: 'normal',
  onlineMode: true,
  viewDistance: 10,
  simulationDistance: 6,
  performancePreset: 'maximum-performance',
  eulaAcceptedAt: '2026-07-31T00:00:00.000Z',
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z'
}

describe('Paper health parsing', () => {
  it('parses server TPS and MSPT output while rejecting player-spoofable chat', () => {
    expect(parseTpsLine('[Server thread/INFO]: TPS from last 1m, 5m, 15m: 19.84, 20.0, 20.0')).toBe(19.84)
    expect(parseTpsLine('[Server thread/INFO]: <Player> TPS from last 1m, 5m, 15m: 1.0')).toBeNull()
    expect(parseTpsLine('[Server thread/INFO]: <Player> ]: TPS from last 1m, 5m, 15m: 1.0, 1.0, 1.0')).toBeNull()
    expect(isMsptHeader('[Server thread/INFO]: Server tick times (avg/min/max) from last 5s, 10s, 1m:')).toBe(true)
    expect(isMsptHeader('[Server thread/INFO]: <Player> ]: Server tick times (avg/min/max) from last 5s, 10s, 1m:')).toBe(false)
    expect(parseMsptValuesLine('[Server thread/INFO]: ◴ 12.4/8.0/31.2, 10.0/7.0/31.2, 9.0/6.0/31.2')).toBe(12.4)
    expect(parseMsptValuesLine('[Server thread/INFO]: <Player> ]: 999.0/1.0/1.0')).toBeNull()
  })
})

describe('Paper launch profiles', () => {
  it('uses bounded official G1 tuning and commits the selected heap only for maximum performance', () => {
    const args = buildLaunchArguments(paperInstance)
    expect(args).toContain('-Xms6144M')
    expect(args).toContain('-Xmx6144M')
    expect(args).toContain('-XX:+UseG1GC')
    expect(args).toContain('-XX:+AlwaysPreTouch')
    expect(args.slice(-3)).toEqual(['-jar', 'paper.jar', 'nogui'])
  })
})
