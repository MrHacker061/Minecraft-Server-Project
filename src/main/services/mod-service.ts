import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInflateRaw } from 'node:zlib'
import { z } from 'zod'
import type { ForgeModInfo, ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'

const MANIFEST_FILE = '.emberhost-mods.json'
const MANIFEST_SCHEMA_VERSION = 1
const INSTANCE_MARKER_FILE = 'emberhost-instance.json'
const MAX_MOD_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 100_000
const MAX_BATCH_MODS = 2_000
const MAX_BATCH_BYTES = 8 * 1024 * 1024 * 1024
const MAX_FILENAME_CHARACTERS = 160
const MAX_FILENAME_BYTES = 240
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_INSTANCE_MARKER_BYTES = 1024 * 1024
const IO_BUFFER_BYTES = 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface ModManager {
  runExclusive<T>(instanceId: string, operation: () => Promise<T>): Promise<T>
  isActive(instanceId: string): boolean
}

export type ForgeModSource = 'local' | 'curseforge' | 'modpack'

export interface ForgeModProvenance {
  source?: ForgeModSource
  projectId?: number
  fileId?: number
}

interface ModMetadata {
  sha256: string
  sizeBytes: number
  installedAt: string
  source: ForgeModSource
  projectId?: number
  fileId?: number
}

interface ModManifest {
  schemaVersion: 1
  mods: Record<string, ModMetadata>
}

interface InspectedMod {
  sizeBytes: number
  sha256: string
}

interface ZipEntry {
  flags: number
  compression: number
  expectedCrc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  name: Buffer
}

interface StagedMod extends InspectedMod {
  fileName: string
  temporaryPath: string
}

export type TrashModFile = (filePath: string) => Promise<void>

const metadataSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(22).max(MAX_MOD_BYTES),
  installedAt: z.string().min(1).max(64),
  source: z.enum(['local', 'curseforge', 'modpack']),
  projectId: z.number().int().positive().safe().optional(),
  fileId: z.number().int().positive().safe().optional()
}).superRefine((metadata, context) => {
  if ((metadata.projectId === undefined) !== (metadata.fileId === undefined)) {
    context.addIssue({ code: 'custom', message: 'CurseForge project and file IDs must be recorded together.' })
  }
  if (metadata.source === 'curseforge' && metadata.projectId === undefined) {
    context.addIssue({ code: 'custom', message: 'CurseForge provenance requires project and file IDs.' })
  }
})

const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  mods: z.record(z.string(), metadataSchema)
})

const CRC_TABLE = new Uint32Array(256)
for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  CRC_TABLE[value] = crc >>> 0
}

function modError(message: string, code = 'INVALID_MOD_JAR', details?: string): AppError {
  return new AppError(message, code, details)
}

function asMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined
}

function pathComparison(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLocaleLowerCase('en-US')
    : value
}

function assertSafeModFilename(fileName: string): void {
  if (
    fileName !== basename(fileName) ||
    extname(fileName).toLowerCase() !== '.jar' ||
    fileName.length > MAX_FILENAME_CHARACTERS ||
    Buffer.byteLength(fileName, 'utf8') > MAX_FILENAME_BYTES ||
    !/^[^<>:"/\\|?*\u0000-\u001f]+\.jar$/i.test(fileName) ||
    /[. ]\.jar$/i.test(fileName)
  ) {
    throw modError(
      'Choose a mod JAR with a safe filename of 160 characters or fewer.',
      'INVALID_MOD_FILENAME'
    )
  }
  const stem = fileName.slice(0, -4).split('.')[0]?.toUpperCase()
  if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw modError('That filename is reserved by Windows.', 'INVALID_MOD_FILENAME')
  }
}

function validateProvenance(provenance: ForgeModProvenance | undefined): Required<Pick<ForgeModProvenance, 'source'>> & ForgeModProvenance {
  const normalized = { ...provenance, source: provenance?.source ?? 'local' }
  if (!['local', 'curseforge', 'modpack'].includes(normalized.source)) {
    throw modError('The mod provenance source is invalid.', 'INVALID_MOD_PROVENANCE')
  }
  const hasProject = normalized.projectId !== undefined
  const hasFile = normalized.fileId !== undefined
  if (
    hasProject !== hasFile ||
    (normalized.source === 'curseforge' && !hasProject) ||
    (hasProject && (!Number.isSafeInteger(normalized.projectId) || normalized.projectId! <= 0)) ||
    (hasFile && (!Number.isSafeInteger(normalized.fileId) || normalized.fileId! <= 0))
  ) {
    throw modError('The CurseForge mod provenance is invalid.', 'INVALID_MOD_PROVENANCE')
  }
  return normalized
}

function crc32Update(crc: number, buffer: Buffer): number {
  let updated = crc
  for (const byte of buffer) updated = (updated >>> 8) ^ CRC_TABLE[(updated ^ byte) & 0xff]!
  return updated >>> 0
}

async function readExactly(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, position + bytesRead)
    if (result.bytesRead === 0) throw modError('The mod archive is unexpectedly truncated.')
    bytesRead += result.bytesRead
  }
}

async function writeAll(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let bytesWritten = 0
  while (bytesWritten < buffer.length) {
    const result = await file.write(buffer, bytesWritten, buffer.length - bytesWritten, position + bytesWritten)
    if (result.bytesWritten === 0) throw modError('The staged mod file could not be written.', 'MOD_STAGE_WRITE_FAILED')
    bytesWritten += result.bytesWritten
  }
}

async function openRegularFile(filePath: string, missingCode = 'MOD_FILE_NOT_FOUND'): Promise<{ file: FileHandle; size: number }> {
  let pathStats
  try {
    pathStats = await lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw modError('The selected mod file no longer exists.', missingCode)
    }
    throw error
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw modError('The mod path must be a normal, non-linked file.', 'INVALID_MOD_PATH')
  }

  let file: FileHandle
  try {
    file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw modError('EmberHost refused to follow a linked mod path.', 'INVALID_MOD_PATH')
    }
    throw error
  }
  try {
    const stats = await file.stat()
    if (!stats.isFile()) throw modError('The mod path must be a normal file.', 'INVALID_MOD_PATH')
    return { file, size: stats.size }
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
}

async function hashHandle(file: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash('sha256')
  let position = 0
  while (position < expectedSize) {
    const length = Math.min(IO_BUFFER_BYTES, expectedSize - position)
    const buffer = Buffer.allocUnsafe(length)
    const result = await file.read(buffer, 0, length, position)
    if (result.bytesRead === 0) throw modError('The mod file changed while EmberHost was reading it.', 'MOD_FILE_CHANGED')
    hash.update(buffer.subarray(0, result.bytesRead))
    position += result.bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  if ((await file.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
    throw modError('The mod file changed while EmberHost was reading it.', 'MOD_FILE_CHANGED')
  }
  return hash.digest('hex')
}

async function hashRegularFile(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const { file, size } = await openRegularFile(filePath)
  try {
    return { sizeBytes: size, sha256: await hashHandle(file, size) }
  } finally {
    await file.close()
  }
}

function assertExtraFieldsAreNonZip64(extra: Buffer): void {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw modError('The mod archive contains a truncated ZIP extra field.')
    const fieldId = extra.readUInt16LE(cursor)
    const fieldSize = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + fieldSize > extra.length) throw modError('The mod archive contains a malformed ZIP extra field.')
    if (fieldId === 0x0001) throw modError('ZIP64 mod archives are not supported.', 'UNSUPPORTED_MOD_ARCHIVE')
    cursor += fieldSize
  }
}

async function* readFileRange(file: FileHandle, start: number, length: number): AsyncGenerator<Buffer> {
  let position = start
  let remaining = length
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(IO_BUFFER_BYTES, remaining))
    await readExactly(file, buffer, position)
    position += buffer.length
    remaining -= buffer.length
    yield buffer
  }
}

async function verifyEntryContents(file: FileHandle, entry: ZipEntry, dataOffset: number): Promise<void> {
  const input = Readable.from(readFileRange(file, dataOffset, entry.compressedSize))
  const output = entry.compression === 8 ? input.pipe(createInflateRaw()) : input
  let outputBytes = 0
  let crc = 0xffffffff
  try {
    for await (const value of output) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      outputBytes += chunk.length
      if (outputBytes > entry.uncompressedSize || outputBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw modError('A mod archive entry expands beyond its declared safe size.')
      }
      crc = crc32Update(crc, chunk)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw modError('A mod archive entry is corrupt or cannot be decompressed.', 'INVALID_MOD_JAR', asMessage(error))
  } finally {
    output.destroy()
    if (output !== input) input.destroy()
  }
  if (outputBytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.expectedCrc) {
    throw modError('A mod archive entry failed its integrity check.')
  }
}

async function inspectModJar(filePath: string): Promise<InspectedMod> {
  const { file, size } = await openRegularFile(filePath)
  try {
    if (size < 22) throw modError('The selected file is not a valid JAR archive.')
    if (size > MAX_MOD_BYTES) {
      throw modError('Mod JARs must be 512 MiB or smaller.', 'MOD_TOO_LARGE')
    }

    const tailSize = Math.min(size, 65_557)
    const tail = Buffer.allocUnsafe(tailSize)
    await readExactly(file, tail, size - tailSize)
    let eocdOffsetInTail = -1
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== 0x06054b50) continue
      const commentLength = tail.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength === tail.length) {
        eocdOffsetInTail = offset
        break
      }
    }
    if (eocdOffsetInTail < 0) throw modError('The selected file is not a complete ZIP/JAR archive.')

    const eocd = tail.subarray(eocdOffsetInTail, eocdOffsetInTail + 22)
    const diskNumber = eocd.readUInt16LE(4)
    const centralDirectoryDisk = eocd.readUInt16LE(6)
    const entriesOnDisk = eocd.readUInt16LE(8)
    const totalEntries = eocd.readUInt16LE(10)
    const centralDirectorySize = eocd.readUInt32LE(12)
    const centralDirectoryOffset = eocd.readUInt32LE(16)
    const eocdAbsoluteOffset = size - tailSize + eocdOffsetInTail
    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      totalEntries === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw modError('Multi-disk and ZIP64 mod archives are not supported.', 'UNSUPPORTED_MOD_ARCHIVE')
    }
    if (totalEntries < 1 || totalEntries > MAX_ZIP_ENTRIES) {
      throw modError('The mod archive must contain a bounded, non-zero number of entries.')
    }
    if (centralDirectorySize < 46 || centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw modError('The mod archive central directory has an unsafe size.')
    }
    if (centralDirectoryOffset + centralDirectorySize !== eocdAbsoluteOffset) {
      throw modError('The mod archive central directory is malformed.')
    }
    if (eocdOffsetInTail >= 20 && tail.readUInt32LE(eocdOffsetInTail - 20) === 0x07064b50) {
      throw modError('ZIP64 mod archives are not supported.', 'UNSUPPORTED_MOD_ARCHIVE')
    }

    const centralDirectory = Buffer.allocUnsafe(centralDirectorySize)
    await readExactly(file, centralDirectory, centralDirectoryOffset)
    const entries: ZipEntry[] = []
    let cursor = 0
    let totalUncompressedBytes = 0
    for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
      if (cursor + 46 > centralDirectory.length || centralDirectory.readUInt32LE(cursor) !== 0x02014b50) {
        throw modError('The mod archive contains a malformed central-directory entry.')
      }
      const flags = centralDirectory.readUInt16LE(cursor + 8)
      const compression = centralDirectory.readUInt16LE(cursor + 10)
      const expectedCrc = centralDirectory.readUInt32LE(cursor + 16)
      const compressedSize = centralDirectory.readUInt32LE(cursor + 20)
      const uncompressedSize = centralDirectory.readUInt32LE(cursor + 24)
      const fileNameLength = centralDirectory.readUInt16LE(cursor + 28)
      const extraLength = centralDirectory.readUInt16LE(cursor + 30)
      const commentLength = centralDirectory.readUInt16LE(cursor + 32)
      const startingDisk = centralDirectory.readUInt16LE(cursor + 34)
      const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42)
      const entryLength = 46 + fileNameLength + extraLength + commentLength
      if (cursor + entryLength > centralDirectory.length || fileNameLength < 1) {
        throw modError('The mod archive contains a truncated central-directory entry.')
      }
      if (
        startingDisk !== 0 ||
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        throw modError('Multi-disk and ZIP64 mod entries are not supported.', 'UNSUPPORTED_MOD_ARCHIVE')
      }
      if ((flags & 1) !== 0 || (compression !== 0 && compression !== 8)) {
        throw modError('Encrypted or unusually compressed mod entries are not supported.', 'UNSUPPORTED_MOD_ARCHIVE')
      }
      if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw modError('A mod archive entry has an unsafe expanded size.')
      }
      totalUncompressedBytes += uncompressedSize
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw modError('The mod archive has an unsafe total expanded size.')
      }
      const name = centralDirectory.subarray(cursor + 46, cursor + 46 + fileNameLength)
      if (name.includes(0)) throw modError('The mod archive contains an invalid entry name.')
      const extra = centralDirectory.subarray(
        cursor + 46 + fileNameLength,
        cursor + 46 + fileNameLength + extraLength
      )
      assertExtraFieldsAreNonZip64(extra)
      entries.push({
        flags,
        compression,
        expectedCrc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        name
      })
      cursor += entryLength
    }
    if (cursor !== centralDirectory.length) {
      throw modError('The mod archive central directory has unexpected trailing data.')
    }

    const occupiedRanges: Array<{ start: number; end: number }> = []
    for (const entry of entries) {
      if (entry.localHeaderOffset + 30 > centralDirectoryOffset) {
        throw modError('A mod archive entry points outside its local-file area.')
      }
      const localHeader = Buffer.allocUnsafe(30)
      await readExactly(file, localHeader, entry.localHeaderOffset)
      if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw modError('A mod archive entry points to an invalid local header.')
      }
      const localFlags = localHeader.readUInt16LE(6)
      const localCompression = localHeader.readUInt16LE(8)
      const localCrc = localHeader.readUInt32LE(14)
      const localCompressedSize = localHeader.readUInt32LE(18)
      const localUncompressedSize = localHeader.readUInt32LE(22)
      const localNameLength = localHeader.readUInt16LE(26)
      const localExtraLength = localHeader.readUInt16LE(28)
      if (localFlags !== entry.flags || localCompression !== entry.compression) {
        throw modError('A local mod entry header does not match the central directory.')
      }
      const localVariableLength = localNameLength + localExtraLength
      if (entry.localHeaderOffset + 30 + localVariableLength > centralDirectoryOffset) {
        throw modError('A local mod entry header is truncated.')
      }
      const localVariable = Buffer.allocUnsafe(localVariableLength)
      await readExactly(file, localVariable, entry.localHeaderOffset + 30)
      if (!localVariable.subarray(0, localNameLength).equals(entry.name)) {
        throw modError('A local mod entry filename does not match the central directory.')
      }
      assertExtraFieldsAreNonZip64(localVariable.subarray(localNameLength))
      if ((entry.flags & 8) === 0 && (
        localCrc !== entry.expectedCrc ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize
      )) {
        throw modError('A local mod entry size or checksum does not match the central directory.')
      }
      if ((entry.flags & 8) !== 0 && (
        ![0, entry.expectedCrc].includes(localCrc) ||
        ![0, entry.compressedSize].includes(localCompressedSize) ||
        ![0, entry.uncompressedSize].includes(localUncompressedSize)
      )) {
        throw modError('A streamed local mod entry has inconsistent size metadata.')
      }
      if (entry.compression === 0 && entry.compressedSize !== entry.uncompressedSize) {
        throw modError('A stored mod entry has inconsistent compressed and expanded sizes.')
      }

      const dataOffset = entry.localHeaderOffset + 30 + localVariableLength
      const dataEnd = dataOffset + entry.compressedSize
      if (dataEnd > centralDirectoryOffset) throw modError('A mod archive entry is truncated.')
      let recordEnd = dataEnd
      if ((entry.flags & 8) !== 0) {
        const available = centralDirectoryOffset - dataEnd
        if (available < 12) throw modError('A streamed mod entry is missing its data descriptor.')
        const prefix = Buffer.allocUnsafe(4)
        await readExactly(file, prefix, dataEnd)
        const hasSignature = prefix.readUInt32LE(0) === 0x08074b50
        const descriptor = Buffer.allocUnsafe(hasSignature ? 16 : 12)
        await readExactly(file, descriptor, dataEnd)
        const fieldOffset = hasSignature ? 4 : 0
        if (
          descriptor.readUInt32LE(fieldOffset) !== entry.expectedCrc ||
          descriptor.readUInt32LE(fieldOffset + 4) !== entry.compressedSize ||
          descriptor.readUInt32LE(fieldOffset + 8) !== entry.uncompressedSize
        ) {
          throw modError('A streamed mod entry has a malformed data descriptor.')
        }
        recordEnd += descriptor.length
      }
      if (recordEnd > centralDirectoryOffset) throw modError('A mod archive entry overlaps its directory.')
      occupiedRanges.push({ start: entry.localHeaderOffset, end: recordEnd })
      await verifyEntryContents(file, entry, dataOffset)
    }
    occupiedRanges.sort((left, right) => left.start - right.start)
    for (let index = 1; index < occupiedRanges.length; index += 1) {
      if (occupiedRanges[index]!.start < occupiedRanges[index - 1]!.end) {
        throw modError('The mod archive contains overlapping local entries.')
      }
    }

    return { sizeBytes: size, sha256: await hashHandle(file, size) }
  } finally {
    await file.close()
  }
}

async function copyToExclusiveStage(sourcePath: string, temporaryPath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const { file: source, size } = await openRegularFile(sourcePath)
  let destination: FileHandle | null = null
  try {
    if (size > MAX_MOD_BYTES) throw modError('Mod JARs must be 512 MiB or smaller.', 'MOD_TOO_LARGE')
    destination = await open(temporaryPath, 'wx', 0o600)
    const hash = createHash('sha256')
    let position = 0
    while (position < size) {
      const length = Math.min(IO_BUFFER_BYTES, size - position)
      const buffer = Buffer.allocUnsafe(length)
      await readExactly(source, buffer, position)
      await writeAll(destination, buffer, position)
      hash.update(buffer)
      position += length
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await source.read(extra, 0, 1, size)).bytesRead !== 0) {
      throw modError('The mod file changed while EmberHost was copying it.', 'MOD_FILE_CHANGED')
    }
    await destination.sync()
    return { sizeBytes: size, sha256: hash.digest('hex') }
  } finally {
    await destination?.close().catch(() => undefined)
    await source.close().catch(() => undefined)
  }
}

export class ModService {
  private readonly serversDirectory: string

  constructor(
    private readonly store: AppStore,
    private readonly manager: ModManager | ServerManager,
    private readonly trashFile: TrashModFile,
    private readonly cleanupTemporaryFile: (filePath: string) => Promise<void> =
      (filePath) => rm(filePath, { force: true })
  ) {
    this.serversDirectory = join(store.dataDirectory, 'servers')
  }

  async list(instanceId: string): Promise<ForgeModInfo[]> {
    return this.manager.runExclusive(instanceId, () => this.listWithinExclusive(instanceId))
  }

  async listWithinExclusive(instanceId: string): Promise<ForgeModInfo[]> {
    const instance = this.requireForge(instanceId)
    const serverDirectory = await this.assertManagedInstanceDirectory(instance)
    const modsDirectory = await this.safeModsDirectory(serverDirectory, false)
    if (!modsDirectory) return []
    const manifest = await this.readManifest(modsDirectory)
    const entries = await readdir(modsDirectory, { withFileTypes: true })
    const mods: ForgeModInfo[] = []
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.jar') continue
      const filePath = join(modsDirectory, entry.name)
      const inspected = await hashRegularFile(filePath)
      const metadata = manifest.mods[entry.name]
      const managed = Boolean(
        metadata &&
        metadata.sizeBytes === inspected.sizeBytes &&
        metadata.sha256 === inspected.sha256
      )
      mods.push({
        fileName: entry.name,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        installedAt: managed ? metadata?.installedAt ?? null : null,
        managed
      })
    }
    return this.sortMods(mods)
  }

  async installFromPath(
    instanceId: string,
    sourcePath: string,
    provenance?: ForgeModProvenance
  ): Promise<ForgeModInfo[]> {
    return this.manager.runExclusive(instanceId, () =>
      this.installFromPathWithinExclusive(instanceId, sourcePath, provenance))
  }

  async installFromPathWithinExclusive(
    instanceId: string,
    sourcePath: string,
    provenance?: ForgeModProvenance
  ): Promise<ForgeModInfo[]> {
    const instance = this.requireForge(instanceId)
    this.assertStopped(instanceId)
    const normalizedProvenance = validateProvenance(provenance)
    const serverDirectory = await this.assertManagedInstanceDirectory(instance)
    const fileName = basename(sourcePath)
    assertSafeModFilename(fileName)
    const modsDirectory = await this.safeModsDirectory(serverDirectory, true)
    if (!modsDirectory) throw modError('The mods folder could not be created.', 'MOD_DIRECTORY_MISSING')
    await this.assertNoCollision(modsDirectory, fileName)
    const modsBeforeInstall = await this.listWithinExclusive(instanceId)

    const temporaryPath = join(modsDirectory, `.emberhost-mod-${randomUUID()}.tmp`)
    const targetPath = join(modsDirectory, fileName)
    let linkedByUs = false
    let committed: ForgeModInfo | null = null
    try {
      const copied = await copyToExclusiveStage(sourcePath, temporaryPath)
      const inspected = await inspectModJar(temporaryPath)
      if (copied.sizeBytes !== inspected.sizeBytes || copied.sha256 !== inspected.sha256) {
        throw modError('The staged mod changed during validation.', 'MOD_FILE_CHANGED')
      }
      try {
        await link(temporaryPath, targetPath)
        linkedByUs = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw modError(
            `A mod named ${fileName} was added while EmberHost was installing it.`,
            'MOD_ALREADY_EXISTS'
          )
        }
        throw error
      }

      const manifest = await this.readManifest(modsDirectory)
      const installedAt = new Date().toISOString()
      manifest.mods[fileName] = this.createMetadata(inspected, installedAt, normalizedProvenance)
      await this.writeManifest(modsDirectory, manifest)
      committed = {
        fileName,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        installedAt,
        managed: true
      }
    } catch (error) {
      if (linkedByUs) {
        try {
          await rm(targetPath)
        } catch (rollbackError) {
          throw modError(
            'The mod install failed, and EmberHost could not remove the uncommitted JAR.',
            'MOD_INSTALL_ROLLBACK_FAILED',
            asMessage(rollbackError)
          )
        }
      }
      throw error
    } finally {
      await this.cleanupTemporaryFile(temporaryPath).catch(() => undefined)
    }
    if (!committed) throw modError('The mod install did not commit.', 'MOD_INSTALL_FAILED')
    return this.sortMods([...modsBeforeInstall, committed])
  }

  async importFromDirectory(instanceId: string, sourceDirectory: string): Promise<ForgeModInfo[]> {
    return this.manager.runExclusive(instanceId, () =>
      this.importFromDirectoryWithinExclusive(instanceId, sourceDirectory))
  }

  async importFromDirectoryWithinExclusive(instanceId: string, sourceDirectory: string): Promise<ForgeModInfo[]> {
    const instance = this.requireForge(instanceId)
    this.assertStopped(instanceId)
    const serverDirectory = await this.assertManagedInstanceDirectory(instance)
    const sourceStats = await lstat(sourceDirectory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw modError('The selected extracted modpack folder no longer exists.', 'MOD_IMPORT_DIRECTORY_NOT_FOUND')
      }
      throw error
    })
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw modError('Choose a normal, non-linked extracted modpack directory.', 'UNSAFE_MOD_IMPORT_DIRECTORY')
    }
    await realpath(sourceDirectory)
    const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true })
    const jarEntries = sourceEntries.filter((entry) => extname(entry.name).toLowerCase() === '.jar')
    if (jarEntries.some((entry) => !entry.isFile())) {
      throw modError('The selected folder contains a linked or non-regular root JAR.', 'UNSAFE_MOD_IMPORT_FILE')
    }
    if (jarEntries.length > MAX_BATCH_MODS) {
      throw modError(`An extracted modpack may contain at most ${MAX_BATCH_MODS} root mod JARs.`, 'MOD_IMPORT_TOO_LARGE')
    }
    for (const entry of jarEntries) assertSafeModFilename(entry.name)
    const foldedNames = new Set<string>()
    for (const entry of jarEntries) {
      const folded = entry.name.toLocaleLowerCase('en-US')
      if (foldedNames.has(folded)) {
        throw modError('The extracted modpack contains colliding mod filenames.', 'MOD_IMPORT_NAME_COLLISION')
      }
      foldedNames.add(folded)
    }

    const modsDirectory = await this.safeModsDirectory(serverDirectory, true)
    if (!modsDirectory) throw modError('The mods folder could not be created.', 'MOD_DIRECTORY_MISSING')
    const installedNames = (await readdir(modsDirectory)).map((name) => name.toLocaleLowerCase('en-US'))
    const collision = jarEntries.find((entry) => installedNames.includes(entry.name.toLocaleLowerCase('en-US')))
    if (collision) {
      throw modError(
        `A mod named ${collision.name} is already installed. The modpack import made no changes.`,
        'MOD_ALREADY_EXISTS'
      )
    }
    const modsBeforeImport = await this.listWithinExclusive(instanceId)
    if (jarEntries.length === 0) return modsBeforeImport

    const staged: StagedMod[] = []
    const temporaryPaths: string[] = []
    const linkedTargets: string[] = []
    let totalBytes = 0
    try {
      for (const entry of jarEntries) {
        const temporaryPath = join(modsDirectory, `.emberhost-mod-import-${randomUUID()}.tmp`)
        temporaryPaths.push(temporaryPath)
        const sourcePath = join(sourceDirectory, entry.name)
        const copied = await copyToExclusiveStage(sourcePath, temporaryPath)
        totalBytes += copied.sizeBytes
        if (totalBytes > MAX_BATCH_BYTES) {
          throw modError('The extracted modpack exceeds the safe total import size.', 'MOD_IMPORT_TOO_LARGE')
        }
        const inspected = await inspectModJar(temporaryPath)
        if (copied.sizeBytes !== inspected.sizeBytes || copied.sha256 !== inspected.sha256) {
          throw modError('A staged mod changed during validation.', 'MOD_FILE_CHANGED')
        }
        staged.push({ fileName: entry.name, temporaryPath, ...inspected })
      }

      const manifest = await this.readManifest(modsDirectory)
      const installedAt = new Date().toISOString()
      for (const mod of staged) {
        const targetPath = join(modsDirectory, mod.fileName)
        try {
          await link(mod.temporaryPath, targetPath)
          linkedTargets.push(targetPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw modError(
              `A mod named ${mod.fileName} was added while EmberHost was importing the modpack.`,
              'MOD_ALREADY_EXISTS'
            )
          }
          throw error
        }
        manifest.mods[mod.fileName] = this.createMetadata(mod, installedAt, { source: 'modpack' })
      }
      await this.writeManifest(modsDirectory, manifest)
      const imported: ForgeModInfo[] = staged.map((mod) => ({
        fileName: mod.fileName,
        sizeBytes: mod.sizeBytes,
        sha256: mod.sha256,
        installedAt,
        managed: true
      }))
      return this.sortMods([...modsBeforeImport, ...imported])
    } catch (error) {
      const failures: string[] = []
      for (const targetPath of linkedTargets.reverse()) {
        await rm(targetPath).catch((rollbackError: unknown) => failures.push(`${targetPath}: ${asMessage(rollbackError)}`))
      }
      if (failures.length) {
        throw modError(
          'The modpack import failed, and one or more uncommitted mod JARs could not be removed.',
          'MOD_IMPORT_ROLLBACK_FAILED',
          failures.join('; ')
        )
      }
      throw error
    } finally {
      await Promise.all(temporaryPaths.map((filePath) =>
        this.cleanupTemporaryFile(filePath).catch(() => undefined)))
    }
  }

  async remove(instanceId: string, fileName: string): Promise<ForgeModInfo[]> {
    return this.manager.runExclusive(instanceId, async () => {
      const instance = this.requireForge(instanceId)
      this.assertStopped(instanceId)
      assertSafeModFilename(fileName)
      const serverDirectory = await this.assertManagedInstanceDirectory(instance)
      const modsDirectory = await this.safeModsDirectory(serverDirectory, false)
      if (!modsDirectory) throw modError('That mod is no longer installed.', 'MOD_NOT_FOUND')
      const entries = await readdir(modsDirectory)
      const actualFileName = entries.find((entry) => entry === fileName)
      if (!actualFileName || extname(actualFileName).toLowerCase() !== '.jar') {
        throw modError('That mod is no longer installed.', 'MOD_NOT_FOUND')
      }
      const targetPath = join(modsDirectory, actualFileName)
      const targetStats = await lstat(targetPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw modError('That mod is no longer installed.', 'MOD_NOT_FOUND')
        }
        throw error
      })
      if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
        throw modError('The mod path is not a normal file.', 'INVALID_MOD_PATH')
      }
      const rollbackPath = join(modsDirectory, `.emberhost-mod-remove-${randomUUID()}.rollback`)
      try {
        await link(targetPath, rollbackPath)
      } catch (error) {
        throw modError(
          'EmberHost could not create the safety link required for recoverable removal.',
          'MOD_REMOVE_SAFETY_FAILED',
          asMessage(error)
        )
      }
      let keepRollback = false
      let trashCompleted = false
      let originalManifest: ModManifest | null = null
      let manifestUpdateAttempted = false
      try {
        await this.trashFile(targetPath)
        trashCompleted = true
        originalManifest = await this.readManifest(modsDirectory)
        const updatedManifest: ModManifest = structuredClone(originalManifest)
        delete updatedManifest.mods[actualFileName]
        manifestUpdateAttempted = true
        await this.writeManifest(modsDirectory, updatedManifest)
      } catch (error) {
        const rollbackFailures: string[] = []
        const targetExists = await lstat(targetPath).then(() => true).catch((statError: unknown) => {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return false
          rollbackFailures.push(`target check: ${asMessage(statError)}`)
          return false
        })
        if (!targetExists) {
          try {
            await link(rollbackPath, targetPath)
          } catch (rollbackError) {
            keepRollback = true
            rollbackFailures.push(`file restore: ${asMessage(rollbackError)}`)
          }
        }
        if (trashCompleted && originalManifest && manifestUpdateAttempted) {
          await this.writeManifest(modsDirectory, originalManifest)
            .catch((manifestError: unknown) => rollbackFailures.push(`metadata restore: ${asMessage(manifestError)}`))
        }
        if (rollbackFailures.length) {
          throw modError(
            'The mod removal failed, and EmberHost could not completely restore it.',
            'MOD_REMOVE_ROLLBACK_FAILED',
            `${rollbackFailures.join('; ')}${keepRollback ? `; safety copy: ${rollbackPath}` : ''}`
          )
        }
        throw modError(
          'Mod removal was rolled back because the recycle-bin or metadata operation failed.',
          'MOD_REMOVE_ROLLED_BACK',
          asMessage(error)
        )
      } finally {
        if (!keepRollback) await rm(rollbackPath, { force: true })
      }
      return this.listWithinExclusive(instanceId)
    })
  }

  private requireForge(instanceId: string): ServerInstance {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (instance.software.kind !== 'forge') {
      throw new AppError('Mods can only be managed for Forge servers.', 'FORGE_REQUIRED')
    }
    return instance
  }

  private assertStopped(instanceId: string): void {
    if (this.manager.isActive(instanceId)) {
      throw new AppError('Stop the Forge server before changing its mods.', 'SERVER_MUST_BE_STOPPED')
    }
  }

  private async assertManagedInstanceDirectory(instance: ServerInstance): Promise<string> {
    if (!UUID_PATTERN.test(instance.id)) {
      throw new AppError('The registered Forge server ID is invalid.', 'UNMANAGED_SERVER_DIRECTORY')
    }
    const serversRoot = resolve(this.serversDirectory)
    const expectedDirectory = resolve(serversRoot, instance.id)
    if (pathComparison(resolve(instance.serverDirectory)) !== pathComparison(expectedDirectory)) {
      throw new AppError(
        'EmberHost refused to manage mods outside its registered servers directory.',
        'UNMANAGED_SERVER_DIRECTORY'
      )
    }
    const child = relative(serversRoot, expectedDirectory)
    if (!child || child !== instance.id || child.startsWith('..') || isAbsolute(child)) {
      throw new AppError('The managed Forge server path is invalid.', 'UNMANAGED_SERVER_DIRECTORY')
    }

    let rootStats
    let serverStats
    try {
      ;[rootStats, serverStats] = await Promise.all([lstat(serversRoot), lstat(expectedDirectory)])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('The registered Forge server folder is missing.', 'SERVER_DIRECTORY_MISSING')
      }
      throw error
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new AppError('The managed servers root is not a normal local directory.', 'UNSAFE_SERVER_DIRECTORY')
    }
    if (!serverStats.isDirectory() || serverStats.isSymbolicLink()) {
      throw new AppError('The Forge server folder is not a normal local directory.', 'UNSAFE_SERVER_DIRECTORY')
    }
    const [realRoot, realServer] = await Promise.all([realpath(serversRoot), realpath(expectedDirectory)])
    if (pathComparison(realServer) !== pathComparison(resolve(realRoot, instance.id))) {
      throw new AppError('The Forge server folder resolves outside EmberHost storage.', 'UNSAFE_SERVER_DIRECTORY')
    }

    const markerPath = join(expectedDirectory, INSTANCE_MARKER_FILE)
    let markerFile: FileHandle | null = null
    try {
      const markerStats = await lstat(markerPath)
      if (
        !markerStats.isFile() ||
        markerStats.isSymbolicLink() ||
        markerStats.size > MAX_INSTANCE_MARKER_BYTES
      ) {
        throw new AppError('The server ownership marker is invalid.', 'INVALID_INSTANCE_MARKER')
      }
      markerFile = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const openedStats = await markerFile.stat()
      if (!openedStats.isFile() || openedStats.size > MAX_INSTANCE_MARKER_BYTES) {
        throw new AppError('The server ownership marker is invalid.', 'INVALID_INSTANCE_MARKER')
      }
      const contents = Buffer.alloc(openedStats.size)
      await readExactly(markerFile, contents, 0)
      const marker = JSON.parse(contents.toString('utf8')) as { id?: unknown }
      if (marker.id !== instance.id) {
        throw new AppError('The server ownership marker does not match this instance.', 'INVALID_INSTANCE_MARKER')
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('The server ownership marker is missing.', 'INVALID_INSTANCE_MARKER')
      }
      if (error instanceof SyntaxError) {
        throw new AppError('The server ownership marker is unreadable.', 'INVALID_INSTANCE_MARKER')
      }
      throw new AppError('The server ownership marker could not be verified.', 'INVALID_INSTANCE_MARKER', asMessage(error))
    } finally {
      await markerFile?.close().catch(() => undefined)
    }
    return expectedDirectory
  }

  private async safeModsDirectory(serverDirectory: string, create: boolean): Promise<string | null> {
    const modsDirectory = join(serverDirectory, 'mods')
    let modsStats
    try {
      modsStats = await lstat(modsDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return null
      try {
        await mkdir(modsDirectory)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      modsStats = await lstat(modsDirectory)
    }
    if (!modsStats.isDirectory() || modsStats.isSymbolicLink()) {
      throw new AppError(
        'EmberHost refused to use a mods folder that is linked or not a normal directory.',
        'UNSAFE_MOD_DIRECTORY'
      )
    }
    const [realServer, realMods] = await Promise.all([realpath(serverDirectory), realpath(modsDirectory)])
    if (pathComparison(realMods) !== pathComparison(join(realServer, 'mods'))) {
      throw new AppError('The mods folder resolves outside the Forge server directory.', 'UNSAFE_MOD_DIRECTORY')
    }
    return modsDirectory
  }

  private async assertNoCollision(modsDirectory: string, fileName: string): Promise<void> {
    const folded = fileName.toLocaleLowerCase('en-US')
    if ((await readdir(modsDirectory)).some((entry) => entry.toLocaleLowerCase('en-US') === folded)) {
      throw modError(
        `A mod named ${fileName} is already installed. Remove it before installing a replacement.`,
        'MOD_ALREADY_EXISTS'
      )
    }
  }

  private createMetadata(
    inspected: InspectedMod,
    installedAt: string,
    provenance: Required<Pick<ForgeModProvenance, 'source'>> & ForgeModProvenance
  ): ModMetadata {
    return {
      sha256: inspected.sha256,
      sizeBytes: inspected.sizeBytes,
      installedAt,
      source: provenance.source,
      ...(provenance.projectId === undefined ? {} : { projectId: provenance.projectId }),
      ...(provenance.fileId === undefined ? {} : { fileId: provenance.fileId })
    }
  }

  private async readManifest(modsDirectory: string): Promise<ModManifest> {
    const manifestPath = join(modsDirectory, MANIFEST_FILE)
    let file: FileHandle | null = null
    try {
      const manifestStats = await lstat(manifestPath)
      if (
        !manifestStats.isFile() ||
        manifestStats.isSymbolicLink() ||
        manifestStats.size > MAX_MANIFEST_BYTES
      ) {
        throw new AppError('EmberHost mod metadata is not a safe local file.', 'MOD_METADATA_CORRUPT')
      }
      file = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const openedStats = await file.stat()
      if (!openedStats.isFile() || openedStats.size > MAX_MANIFEST_BYTES) {
        throw new AppError('EmberHost mod metadata is not a safe local file.', 'MOD_METADATA_CORRUPT')
      }
      const contents = Buffer.alloc(openedStats.size)
      await readExactly(file, contents, 0)
      const parsed: unknown = JSON.parse(contents.toString('utf8'))
      const result = manifestSchema.safeParse(parsed)
      if (!result.success) throw result.error
      return result.data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: MANIFEST_SCHEMA_VERSION, mods: {} }
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new AppError(
          'EmberHost mod metadata is damaged. Back up the mods folder before repairing it.',
          'MOD_METADATA_CORRUPT'
        )
      }
      throw error
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  private async writeManifest(modsDirectory: string, manifest: ModManifest): Promise<void> {
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new AppError('EmberHost mod metadata exceeded its safe size.', 'MOD_METADATA_TOO_LARGE')
    }
    const temporaryPath = join(modsDirectory, `.emberhost-mods-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, join(modsDirectory, MANIFEST_FILE))
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private sortMods(mods: ForgeModInfo[]): ForgeModInfo[] {
    return mods.sort((left, right) => left.fileName.localeCompare(right.fileName))
  }
}

export const modLimits = {
  maxModBytes: MAX_MOD_BYTES,
  maxEntryUncompressedBytes: MAX_ENTRY_UNCOMPRESSED_BYTES,
  maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxCentralDirectoryBytes: MAX_CENTRAL_DIRECTORY_BYTES,
  maxZipEntries: MAX_ZIP_ENTRIES,
  maxBatchMods: MAX_BATCH_MODS,
  maxBatchBytes: MAX_BATCH_BYTES,
  maxFilenameCharacters: MAX_FILENAME_CHARACTERS
} as const
