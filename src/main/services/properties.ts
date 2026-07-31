import type { ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'

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

const propertyKeyPattern = /^[A-Za-z0-9._-]+$/
const reservedLevelNames = new Set([
  'plugins',
  'logs',
  'emberhost-backups',
  'config',
  'libraries',
  'versions',
  'cache',
  'crash-reports',
  '.paper'
])

function assertSafePropertyKey(key: string): void {
  if (!propertyKeyPattern.test(key)) throw new Error('Invalid server.properties key.')
}

function assertSafePropertyValue(value: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('server.properties values cannot contain control characters.')
}

function encodePropertyValue(value: string): string {
  return value.replace(/\\/g, '\\\\')
}

function decodePropertyValue(value: string): string {
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '\\') {
      decoded += character
      continue
    }
    const escaped = value[index + 1]
    if (escaped === undefined) throw new Error('Continued server.properties values are not supported.')
    index += 1
    if (escaped === 'u') {
      const code = value.slice(index + 1, index + 5)
      if (!/^[0-9A-Fa-f]{4}$/.test(code)) throw new Error('Invalid Unicode escape in server.properties.')
      decoded += String.fromCharCode(Number.parseInt(code, 16))
      index += 4
    } else if (escaped === 't') decoded += '\t'
    else if (escaped === 'n') decoded += '\n'
    else if (escaped === 'r') decoded += '\r'
    else if (escaped === 'f') decoded += '\f'
    else decoded += escaped
  }
  return decoded
}

type PropertyRecord = {
  logicalLine: string
  physicalLines: string[]
}

type ParsedProperty = {
  key: string
  encodedValue: string
}

function isPropertyWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\f'
}

function endsWithContinuation(line: string): boolean {
  let backslashes = 0
  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index -= 1) backslashes += 1
  return backslashes % 2 === 1
}

function propertyRecords(properties: string): PropertyRecord[] {
  const lines = properties.split(/\r\n|\n|\r/)
  const records: PropertyRecord[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index] ?? ''
    const physicalLines = [firstLine]
    let logicalLine = firstLine
    const firstCharacter = logicalLine.replace(/^[ \t\f]+/, '')[0]
    const commentLine = firstCharacter === '#' || firstCharacter === '!'
    while (!commentLine && endsWithContinuation(logicalLine)) {
      if (index + 1 >= lines.length) throw new Error('server.properties ends with an incomplete continued value.')
      index += 1
      const nextLine = lines[index] ?? ''
      physicalLines.push(nextLine)
      logicalLine = `${logicalLine.slice(0, -1)}${nextLine.replace(/^[ \t\f]+/, '')}`
    }
    records.push({ logicalLine, physicalLines })
  }
  return records
}

function parsePropertyRecord(line: string): ParsedProperty | null {
  let cursor = 0
  while (cursor < line.length && isPropertyWhitespace(line[cursor])) cursor += 1
  if (cursor >= line.length || line[cursor] === '#' || line[cursor] === '!') return null

  const keyStart = cursor
  let escaped = false
  while (cursor < line.length) {
    const character = line[cursor]
    if (!escaped && (character === '=' || character === ':' || isPropertyWhitespace(character))) break
    if (character === '\\' && !escaped) escaped = true
    else escaped = false
    cursor += 1
  }
  const encodedKey = line.slice(keyStart, cursor)

  if (cursor < line.length && isPropertyWhitespace(line[cursor])) {
    while (cursor < line.length && isPropertyWhitespace(line[cursor])) cursor += 1
    if (line[cursor] === '=' || line[cursor] === ':') cursor += 1
  } else if (line[cursor] === '=' || line[cursor] === ':') {
    cursor += 1
  }
  while (cursor < line.length && isPropertyWhitespace(line[cursor])) cursor += 1

  return { key: decodePropertyValue(encodedKey), encodedValue: line.slice(cursor) }
}

export function getServerPropertyValue(properties: string, key: string): string | null {
  assertSafePropertyKey(key)
  let value: string | null = null
  for (const record of propertyRecords(properties)) {
    const parsed = parsePropertyRecord(record.logicalLine)
    if (!parsed || parsed.key !== key) continue
    value = decodePropertyValue(parsed.encodedValue)
  }
  return value
}

export function setServerPropertyValue(properties: string, key: string, value: string): string {
  assertSafePropertyKey(key)
  assertSafePropertyValue(value)
  let replaced = false
  const records = propertyRecords(properties)
  const lines: string[] = []
  for (const [index, record] of records.entries()) {
    if (index === records.length - 1 && record.physicalLines.length === 1 && record.physicalLines[0] === '') continue
    const parsed = parsePropertyRecord(record.logicalLine)
    if (!parsed || parsed.key !== key) {
      lines.push(...record.physicalLines)
      continue
    }
    if (!replaced) {
      lines.push(`${key}=${encodePropertyValue(value)}`)
      replaced = true
    }
  }

  if (!replaced) lines.push(`${key}=${encodePropertyValue(value)}`)
  return `${lines.join('\n')}\n`
}

export function parseLevelName(properties: string): string {
  const levelName = getServerPropertyValue(properties, 'level-name') ?? 'world'
  const normalizedName = levelName.toLocaleLowerCase('en-US')
  if (
    !levelName ||
    levelName === '.' ||
    levelName === '..' ||
    levelName.length > 128 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(levelName) ||
    /[. ]$/.test(levelName) ||
    reservedLevelNames.has(normalizedName) ||
    normalizedName.startsWith('.paper') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(levelName)
  ) {
    throw new AppError('The level-name in server.properties is not a safe world-folder name.', 'INVALID_LEVEL_NAME')
  }
  return levelName
}

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
