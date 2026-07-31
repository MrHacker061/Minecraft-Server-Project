import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'
import { z } from 'zod'
import type { PaperPluginInfo, ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'
import type { ServerManager } from './server-manager'
import type { AppStore } from './store'

const inflateRawAsync = promisify(inflateRaw)
const MANIFEST_FILE = '.emberhost-plugins.json'
const MANIFEST_SCHEMA_VERSION = 1
const BUILT_IN_PLUGIN = 'Chunky.jar'
const MAX_PLUGIN_BYTES = 256 * 1024 * 1024
const MAX_DESCRIPTOR_BYTES = 1024 * 1024
const MAX_COMPRESSED_DESCRIPTOR_BYTES = 4 * 1024 * 1024
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 100_000
const MAX_FILENAME_CHARACTERS = 160
const MAX_FILENAME_BYTES = 240
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

interface PluginManager {
  runExclusive<T>(instanceId: string, operation: () => Promise<T>): Promise<T>
  isActive(instanceId: string): boolean
}

interface PluginMetadata {
  sha256: string
  installedAt: string
  name: string | null
  version: string | null
}

interface PluginManifest {
  schemaVersion: 1
  plugins: Record<string, PluginMetadata>
}

interface InspectedPlugin {
  name: string | null
  version: string | null
  sizeBytes: number
  sha256: string
}

interface ZipDescriptor {
  entryName: string
  flags: number
  compression: number
  compressedSize: number
  uncompressedSize: number
  expectedCrc: number
  localHeaderOffset: number
}

export type TrashPluginFile = (filePath: string) => Promise<void>

const metadataSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string().min(1).max(64),
  name: z.string().min(1).max(256).nullable(),
  version: z.string().min(1).max(256).nullable()
})

const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  plugins: z.record(z.string(), metadataSchema)
})

function pluginError(message: string, code = 'INVALID_PLUGIN_JAR', details?: string): AppError {
  return new AppError(message, code, details)
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function normalizeYamlScalar(value: string | undefined): string | null {
  if (!value) return null
  let scalar = value.trim()
  if (!scalar || scalar === '|' || scalar === '>') return null
  if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
    scalar = scalar.slice(1, -1).trim()
  } else {
    scalar = scalar.replace(/\s+#.*$/, '').trim()
  }
  return scalar && scalar.length <= 256 ? scalar : null
}

function descriptorField(contents: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = contents.match(new RegExp(`^${escaped}\\s*:\\s*(.*?)\\s*$`, 'im'))
  return normalizeYamlScalar(match?.[1])
}

function assertSafePluginFilename(fileName: string): void {
  if (
    fileName !== basename(fileName) ||
    extname(fileName).toLowerCase() !== '.jar' ||
    fileName.length > MAX_FILENAME_CHARACTERS ||
    Buffer.byteLength(fileName, 'utf8') > MAX_FILENAME_BYTES ||
    !/^[^<>:"/\\|?*\u0000-\u001f]+\.jar$/i.test(fileName) ||
    /[. ]\.jar$/i.test(fileName)
  ) {
    throw pluginError(
      'Choose a plugin JAR with a safe filename of 160 characters or fewer.',
      'INVALID_PLUGIN_FILENAME'
    )
  }
  const stem = fileName.slice(0, -4).split('.')[0]?.toUpperCase()
  if (stem && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw pluginError('That filename is reserved by Windows.', 'INVALID_PLUGIN_FILENAME')
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function readExactly(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number
): Promise<void> {
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, position + bytesRead)
    if (result.bytesRead === 0) throw pluginError('The plugin archive is unexpectedly truncated.')
    bytesRead += result.bytesRead
  }
}

async function inspectPluginJar(filePath: string): Promise<InspectedPlugin> {
  const file = await open(filePath, 'r')
  try {
    const fileStats = await file.stat()
    if (!fileStats.isFile()) throw pluginError('The selected item is not a regular file.')
    if (fileStats.size < 22) throw pluginError('The selected file is not a valid JAR archive.')
    if (fileStats.size > MAX_PLUGIN_BYTES) {
      throw pluginError('Plugin JARs must be 256 MiB or smaller.', 'PLUGIN_TOO_LARGE')
    }

    const tailSize = Math.min(fileStats.size, 65_557)
    const tail = Buffer.allocUnsafe(tailSize)
    await readExactly(file, tail, fileStats.size - tailSize)
    let eocdOffsetInTail = -1
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== 0x06054b50) continue
      const commentLength = tail.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength === tail.length) {
        eocdOffsetInTail = offset
        break
      }
    }
    if (eocdOffsetInTail < 0) throw pluginError('The selected file is not a complete ZIP/JAR archive.')

    const eocd = tail.subarray(eocdOffsetInTail, eocdOffsetInTail + 22)
    const diskNumber = eocd.readUInt16LE(4)
    const centralDirectoryDisk = eocd.readUInt16LE(6)
    const entriesOnDisk = eocd.readUInt16LE(8)
    const totalEntries = eocd.readUInt16LE(10)
    const centralDirectorySize = eocd.readUInt32LE(12)
    const centralDirectoryOffset = eocd.readUInt32LE(16)
    const eocdAbsoluteOffset = fileStats.size - tailSize + eocdOffsetInTail
    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      totalEntries === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw pluginError('Multi-disk and ZIP64 plugin archives are not supported.')
    }
    if (totalEntries < 1 || totalEntries > MAX_ZIP_ENTRIES) {
      throw pluginError('The plugin archive has an invalid number of entries.')
    }
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw pluginError('The plugin archive directory is unreasonably large.')
    }
    if (centralDirectoryOffset + centralDirectorySize !== eocdAbsoluteOffset) {
      throw pluginError('The plugin archive central directory is malformed.')
    }

    const centralDirectory = Buffer.allocUnsafe(centralDirectorySize)
    await readExactly(file, centralDirectory, centralDirectoryOffset)
    let cursor = 0
    let descriptor: ZipDescriptor | null = null
    for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
      if (cursor + 46 > centralDirectory.length || centralDirectory.readUInt32LE(cursor) !== 0x02014b50) {
        throw pluginError('The plugin archive contains a malformed directory entry.')
      }
      const flags = centralDirectory.readUInt16LE(cursor + 8)
      const compression = centralDirectory.readUInt16LE(cursor + 10)
      const expectedCrc = centralDirectory.readUInt32LE(cursor + 16)
      const compressedSize = centralDirectory.readUInt32LE(cursor + 20)
      const uncompressedSize = centralDirectory.readUInt32LE(cursor + 24)
      const fileNameLength = centralDirectory.readUInt16LE(cursor + 28)
      const extraLength = centralDirectory.readUInt16LE(cursor + 30)
      const commentLength = centralDirectory.readUInt16LE(cursor + 32)
      const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42)
      const entryLength = 46 + fileNameLength + extraLength + commentLength
      if (cursor + entryLength > centralDirectory.length) {
        throw pluginError('The plugin archive contains a truncated directory entry.')
      }
      const entryName = centralDirectory.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8')
      if (entryName.includes('\u0000')) throw pluginError('The plugin archive contains an invalid entry name.')
      if (entryName === 'plugin.yml' || entryName === 'paper-plugin.yml') {
        if (descriptor?.entryName === entryName) {
          throw pluginError(`The plugin archive contains multiple root ${entryName} descriptors.`)
        }
        if ((flags & 1) !== 0 || (compression !== 0 && compression !== 8)) {
          throw pluginError('The plugin descriptor uses unsupported ZIP features.')
        }
        if (
          uncompressedSize < 1 ||
          uncompressedSize > MAX_DESCRIPTOR_BYTES ||
          compressedSize > MAX_COMPRESSED_DESCRIPTOR_BYTES
        ) {
          throw pluginError('The plugin descriptor has an unsafe size.')
        }
        const candidate: ZipDescriptor = {
          entryName,
          flags,
          compression,
          compressedSize,
          uncompressedSize,
          expectedCrc,
          localHeaderOffset
        }
        // Hybrid plugins can include both descriptors. Paper's native descriptor is authoritative.
        if (!descriptor || entryName === 'paper-plugin.yml') descriptor = candidate
      }
      cursor += entryLength
    }
    if (cursor !== centralDirectory.length) {
      throw pluginError('The plugin archive central directory has unexpected trailing data.')
    }
    if (!descriptor) {
      throw pluginError('This JAR does not contain a root plugin.yml or paper-plugin.yml descriptor.')
    }

    const localHeader = Buffer.allocUnsafe(30)
    await readExactly(file, localHeader, descriptor.localHeaderOffset)
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
      throw pluginError('The plugin descriptor points to an invalid ZIP entry.')
    }
    if (
      localHeader.readUInt16LE(6) !== descriptor.flags ||
      localHeader.readUInt16LE(8) !== descriptor.compression
    ) {
      throw pluginError('The local plugin descriptor header does not match the archive directory.')
    }
    const localFileNameLength = localHeader.readUInt16LE(26)
    const localExtraLength = localHeader.readUInt16LE(28)
    const dataOffset = descriptor.localHeaderOffset + 30 + localFileNameLength + localExtraLength
    if (dataOffset + descriptor.compressedSize > centralDirectoryOffset) {
      throw pluginError('The plugin descriptor data is truncated or overlaps the archive directory.')
    }
    const localFileName = Buffer.allocUnsafe(localFileNameLength)
    await readExactly(file, localFileName, descriptor.localHeaderOffset + 30)
    if (localFileName.toString('utf8') !== descriptor.entryName) {
      throw pluginError('The local plugin descriptor filename does not match the archive directory.')
    }
    const compressed = Buffer.allocUnsafe(descriptor.compressedSize)
    await readExactly(file, compressed, dataOffset)
    let contents: Buffer
    try {
      contents = descriptor.compression === 0
        ? compressed
        : await inflateRawAsync(compressed, { maxOutputLength: MAX_DESCRIPTOR_BYTES })
    } catch (error) {
      throw pluginError(
        'The plugin descriptor could not be decompressed.',
        'INVALID_PLUGIN_JAR',
        error instanceof Error ? error.message : undefined
      )
    }
    if (contents.length !== descriptor.uncompressedSize || crc32(contents) !== descriptor.expectedCrc) {
      throw pluginError('The plugin descriptor failed its archive integrity check.')
    }
    const descriptorText = contents.toString('utf8')
    if (descriptorText.includes('\u0000') || descriptorText.includes('\ufffd')) {
      throw pluginError('The plugin descriptor is not valid UTF-8 text.')
    }
    return {
      name: descriptorField(descriptorText, 'name'),
      version: descriptorField(descriptorText, 'version'),
      sizeBytes: fileStats.size,
      sha256: await sha256(filePath)
    }
  } finally {
    await file.close()
  }
}

export class PluginService {
  constructor(
    private readonly store: AppStore,
    private readonly manager: PluginManager | ServerManager,
    private readonly trashFile: TrashPluginFile
  ) {}

  async list(instanceId: string): Promise<PaperPluginInfo[]> {
    return this.manager.runExclusive(instanceId, () => this.listUnlocked(instanceId))
  }

  private async listUnlocked(instanceId: string): Promise<PaperPluginInfo[]> {
    const instance = this.requirePaper(instanceId)
    const pluginDirectory = await this.safePluginDirectory(instance, false)
    if (!pluginDirectory) return []
    const manifest = await this.readManifest(pluginDirectory)
    const entries = await readdir(pluginDirectory, { withFileTypes: true })

    const plugins = await Promise.all(entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.jar')
      .map(async (entry): Promise<PaperPluginInfo> => {
        const filePath = join(pluginDirectory, entry.name)
        const fileStats = await stat(filePath)
        const builtIn = entry.name.toLowerCase() === BUILT_IN_PLUGIN.toLowerCase()
        const metadata = manifest.plugins[entry.name]
        const managed = builtIn || Boolean(
          metadata && fileStats.size <= MAX_PLUGIN_BYTES && metadata.sha256 === await sha256(filePath)
        )
        return {
          fileName: entry.name,
          name: builtIn ? 'Chunky' : managed ? metadata?.name ?? null : null,
          version: managed && !builtIn ? metadata?.version ?? null : null,
          sizeBytes: fileStats.size,
          installedAt: managed && !builtIn ? metadata?.installedAt ?? null : null,
          managed,
          builtIn
        }
      }))
    return plugins.sort((left, right) => Number(right.builtIn) - Number(left.builtIn) || left.fileName.localeCompare(right.fileName))
  }

  async installFromPath(instanceId: string, sourcePath: string): Promise<PaperPluginInfo[]> {
    return this.manager.runExclusive(instanceId, async () => {
      const instance = this.requirePaper(instanceId)
      this.assertStopped(instanceId)
      const fileName = basename(sourcePath)
      assertSafePluginFilename(fileName)
      const sourceStats = await lstat(sourcePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw pluginError('The selected plugin file no longer exists.', 'PLUGIN_FILE_NOT_FOUND')
        }
        throw error
      })
      if (!sourceStats.isFile()) throw pluginError('The selected item is not a regular file.')
      await inspectPluginJar(sourcePath)

      const pluginDirectory = await this.safePluginDirectory(instance, true)
      if (!pluginDirectory) throw new AppError('The plugins folder could not be created.', 'PLUGIN_DIRECTORY_MISSING')
      const existing = await readdir(pluginDirectory)
      if (existing.some((entry) => entry.toLowerCase() === fileName.toLowerCase())) {
        throw pluginError(
          `A plugin named ${fileName} is already installed. Remove it before installing a replacement.`,
          'PLUGIN_ALREADY_EXISTS'
        )
      }

      const targetPath = join(pluginDirectory, fileName)
      const temporaryPath = join(pluginDirectory, `.emberhost-plugin-${randomUUID()}.tmp`)
      let linkedByUs = false
      try {
        await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL)
        const inspected = await inspectPluginJar(temporaryPath)
        try {
          await link(temporaryPath, targetPath)
          linkedByUs = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw pluginError(
              `A plugin named ${fileName} was added while EmberHost was installing it.`,
              'PLUGIN_ALREADY_EXISTS'
            )
          }
          throw error
        }

        const manifest = await this.readManifest(pluginDirectory)
        manifest.plugins[fileName] = {
          sha256: inspected.sha256,
          installedAt: new Date().toISOString(),
          name: inspected.name,
          version: inspected.version
        }
        await this.writeManifest(pluginDirectory, manifest)
      } catch (error) {
        if (linkedByUs) {
          try {
            await rm(targetPath)
          } catch (rollbackError) {
            throw new AppError(
              'The plugin install failed, and EmberHost could not remove the uncommitted JAR.',
              'PLUGIN_INSTALL_ROLLBACK_FAILED',
              rollbackError instanceof Error ? rollbackError.message : undefined
            )
          }
        }
        throw error
      } finally {
        await rm(temporaryPath, { force: true })
      }
      return this.listUnlocked(instanceId)
    })
  }

  async remove(instanceId: string, fileName: string): Promise<PaperPluginInfo[]> {
    return this.manager.runExclusive(instanceId, async () => {
      const instance = this.requirePaper(instanceId)
      this.assertStopped(instanceId)
      assertSafePluginFilename(fileName)
      if (fileName.toLowerCase() === BUILT_IN_PLUGIN.toLowerCase()) {
        throw pluginError(
          'Chunky is managed by EmberHost and is required for world preparation.',
          'BUILT_IN_PLUGIN'
        )
      }
      const pluginDirectory = await this.safePluginDirectory(instance, false)
      if (!pluginDirectory) throw pluginError('That plugin is no longer installed.', 'PLUGIN_NOT_FOUND')
      let actualFileName: string
      try {
        const entries = await readdir(pluginDirectory)
        actualFileName = entries.find((entry) => entry === fileName) ?? ''
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw pluginError('That plugin is no longer installed.', 'PLUGIN_NOT_FOUND')
        }
        throw error
      }
      if (!actualFileName || extname(actualFileName).toLowerCase() !== '.jar') {
        throw pluginError('That plugin is no longer installed.', 'PLUGIN_NOT_FOUND')
      }
      const targetPath = join(pluginDirectory, actualFileName)
      const targetStats = await lstat(targetPath)
      if (!targetStats.isFile()) throw pluginError('The plugin path is not a regular file.', 'INVALID_PLUGIN_PATH')

      // Keep a same-volume hard-link until both Trash and metadata operations commit. This lets
      // EmberHost restore the original plugin path if the metadata write fails after Trash succeeds.
      const rollbackPath = join(pluginDirectory, `.emberhost-plugin-remove-${randomUUID()}.rollback`)
      try {
        await link(targetPath, rollbackPath)
      } catch (error) {
        throw pluginError(
          'EmberHost could not create the safety link required for recoverable removal.',
          'PLUGIN_REMOVE_SAFETY_FAILED',
          error instanceof Error ? error.message : undefined
        )
      }
      let keepRollback = false
      try {
        await this.trashFile(targetPath)
        try {
          const manifest = await this.readManifest(pluginDirectory)
          delete manifest.plugins[actualFileName]
          await this.writeManifest(pluginDirectory, manifest)
        } catch (error) {
          try {
            await link(rollbackPath, targetPath)
          } catch (rollbackError) {
            keepRollback = true
            throw pluginError(
              'The plugin is in Trash and its safety copy could not be restored automatically.',
              'PLUGIN_REMOVE_ROLLBACK_FAILED',
              rollbackError instanceof Error ? `${rollbackError.message}; safety copy: ${rollbackPath}` : rollbackPath
            )
          }
          throw pluginError(
            'Plugin removal was rolled back because EmberHost could not update its metadata.',
            'PLUGIN_REMOVE_ROLLED_BACK',
            error instanceof Error ? error.message : undefined
          )
        }
      } catch (error) {
        throw error
      } finally {
        if (!keepRollback) await rm(rollbackPath, { force: true })
      }
      return this.listUnlocked(instanceId)
    })
  }

  private requirePaper(instanceId: string): ServerInstance {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    if (instance.software.kind !== 'paper') {
      throw new AppError('Plugins can only be managed for Paper servers.', 'PAPER_REQUIRED')
    }
    return instance
  }

  private assertStopped(instanceId: string): void {
    if (this.manager.isActive(instanceId)) {
      throw new AppError('Stop the Paper server before changing its plugins.', 'SERVER_MUST_BE_STOPPED')
    }
  }

  private async safePluginDirectory(instance: ServerInstance, create: boolean): Promise<string | null> {
    let serverStats
    try {
      serverStats = await lstat(instance.serverDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError(
          'The server folder is missing. EmberHost refused to recreate only its plugins folder.',
          'SERVER_DIRECTORY_MISSING'
        )
      }
      throw error
    }
    if (!serverStats.isDirectory() || serverStats.isSymbolicLink()) {
      throw new AppError('The server folder is not a safe local directory.', 'UNSAFE_SERVER_DIRECTORY')
    }

    const pluginDirectory = join(instance.serverDirectory, 'plugins')
    let pluginStats
    try {
      pluginStats = await lstat(pluginDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return null
      try {
        await mkdir(pluginDirectory)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      pluginStats = await lstat(pluginDirectory)
    }
    if (!pluginStats.isDirectory() || pluginStats.isSymbolicLink()) {
      throw new AppError(
        'EmberHost refused to use a plugins folder that is a link or not a normal directory.',
        'UNSAFE_PLUGIN_DIRECTORY'
      )
    }

    const [realServerDirectory, realPluginDirectory] = await Promise.all([
      realpath(instance.serverDirectory),
      realpath(pluginDirectory)
    ])
    const normalize = (value: string): string =>
      process.platform === 'win32' || process.platform === 'darwin' ? value.toLocaleLowerCase('en-US') : value
    if (normalize(realPluginDirectory) !== normalize(join(realServerDirectory, 'plugins'))) {
      throw new AppError('The plugins folder resolves outside the server directory.', 'UNSAFE_PLUGIN_DIRECTORY')
    }
    return pluginDirectory
  }

  private async readManifest(pluginDirectory: string): Promise<PluginManifest> {
    try {
      const manifestPath = join(pluginDirectory, MANIFEST_FILE)
      const manifestStats = await lstat(manifestPath)
      if (
        !manifestStats.isFile() ||
        manifestStats.isSymbolicLink() ||
        manifestStats.size > MAX_MANIFEST_BYTES
      ) {
        throw new AppError(
          'EmberHost plugin metadata is not a safe local file.',
          'PLUGIN_METADATA_CORRUPT'
        )
      }
      const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
      const result = manifestSchema.safeParse(parsed)
      if (!result.success) throw result.error
      return result.data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: MANIFEST_SCHEMA_VERSION, plugins: {} }
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new AppError(
          'EmberHost plugin metadata is damaged. Back up the plugins folder before repairing it.',
          'PLUGIN_METADATA_CORRUPT'
        )
      }
      throw error
    }
  }

  private async writeManifest(pluginDirectory: string, manifest: PluginManifest): Promise<void> {
    await mkdir(pluginDirectory, { recursive: true })
    const temporaryPath = join(pluginDirectory, `.emberhost-plugins-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporaryPath, join(pluginDirectory, MANIFEST_FILE))
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

export const pluginLimits = {
  maxPluginBytes: MAX_PLUGIN_BYTES,
  maxFilenameCharacters: MAX_FILENAME_CHARACTERS
} as const
