import type { ServerInstance } from '../../shared/contracts'

const controlledKeys = [
  'server-port',
  'max-players',
  'motd',
  'gamemode',
  'difficulty',
  'online-mode',
  'view-distance',
  'simulation-distance',
  'white-list'
] as const

function safeValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim()
}

export function controlledProperties(instance: ServerInstance): Record<string, string> {
  return {
    'server-port': String(instance.port),
    'max-players': String(instance.maxPlayers),
    motd: safeValue(instance.motd),
    gamemode: instance.gameMode,
    difficulty: instance.difficulty,
    'online-mode': String(instance.onlineMode),
    'view-distance': String(instance.viewDistance),
    'simulation-distance': String(instance.simulationDistance),
    'white-list': 'false'
  }
}

export function mergeServerProperties(existing: string, instance: ServerInstance): string {
  const values = controlledProperties(instance)
  const seen = new Set<string>()
  const nextLines = existing
    .split(/\r?\n/)
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return line
      const separator = line.indexOf('=')
      if (separator < 0) return line
      const key = line.slice(0, separator).trim()
      if (!controlledKeys.includes(key as (typeof controlledKeys)[number])) return line
      seen.add(key)
      return `${key}=${values[key]}`
    })

  for (const key of controlledKeys) {
    if (!seen.has(key)) nextLines.push(`${key}=${values[key]}`)
  }

  return `${nextLines.join('\n')}\n`
}

export function createServerProperties(instance: ServerInstance): string {
  const header = [
    '# Minecraft server properties',
    '# Managed by EmberHost. Unknown properties are preserved when settings are saved.',
    '# Only settings managed by EmberHost are written here.',
    '# Minecraft supplies version-appropriate defaults for all other settings.'
  ].join('\n')

  return mergeServerProperties(`${header}\n`, instance)
}
