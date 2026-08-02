import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModService, modLimits } from '../src/main/services/mod-service'
import type { AppStore } from '../src/main/services/store'
import type { ServerInstance, ServerSoftware } from '../src/shared/contracts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

class FakeManager {
  active = false
  exclusiveCalls = 0

  runExclusive<T>(_instanceId: string, operation: () => Promise<T>): Promise<T> {
    this.exclusiveCalls += 1
    return operation()
  }

  isActive(): boolean {
    return this.active
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function jarBuffer(contents = 'Forge mod test payload\n', entryName = 'META-INF/mods.toml'): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const data = Buffer.from(contents, 'utf8')
  const compressed = deflateRawSync(data)
  const checksum = crc32(data)

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(8, 8)
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(compressed.length, 18)
  localHeader.writeUInt32LE(data.length, 22)
  localHeader.writeUInt16LE(name.length, 26)

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(8, 10)
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(compressed.length, 20)
  centralHeader.writeUInt32LE(data.length, 24)
  centralHeader.writeUInt16LE(name.length, 28)
  centralHeader.writeUInt32LE(0, 42)

  const centralDirectoryOffset = localHeader.length + name.length + compressed.length
  const centralDirectorySize = centralHeader.length + name.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralDirectorySize, 12)
  end.writeUInt32LE(centralDirectoryOffset, 16)
  return Buffer.concat([localHeader, name, compressed, centralHeader, name, end])
}

async function writeJar(filePath: string, contents?: string): Promise<void> {
  await writeFile(filePath, jarBuffer(contents))
}

function serverInstance(
  id: string,
  serverDirectory: string,
  software: ServerSoftware = {
    kind: 'forge',
    forgeVersion: '47.4.0',
    mavenVersion: '1.20.1-47.4.0',
    channel: 'exact',
    installerSha1: 'a'.repeat(40)
  }
): ServerInstance {
  const now = new Date().toISOString()
  return {
    id,
    name: 'Forge test',
    version: '1.20.1',
    serverDirectory,
    software,
    launch: software.kind === 'forge'
      ? { kind: 'java-argfile', windowsPath: 'libraries\\win_args.txt', unixPath: 'libraries/unix_args.txt' }
      : { kind: 'jar', path: software.kind === 'paper' ? 'paper.jar' : 'server.jar' },
    jarSha1: software.kind === 'vanilla' ? 'b'.repeat(40) : null,
    artifactSha256: software.kind === 'paper' ? 'c'.repeat(64) : null,
    requiredJavaVersion: 17,
    javaPath: 'java',
    port: 25565,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'Mod tests',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 10,
    simulationDistance: 10,
    performancePreset: 'custom',
    eulaAcceptedAt: now,
    createdAt: now,
    updatedAt: now
  }
}

async function harness(software?: ServerSoftware): Promise<{
  directory: string
  dataDirectory: string
  server: ServerInstance
  manager: FakeManager
  service: ModService
  trashed: string[]
}> {
  const directory = await mkdtemp(join(tmpdir(), 'emberhost-mods-'))
  temporaryDirectories.push(directory)
  const dataDirectory = join(directory, 'runtime-data')
  const id = randomUUID()
  const serverDirectory = join(dataDirectory, 'servers', id)
  await mkdir(serverDirectory, { recursive: true })
  await writeFile(join(serverDirectory, 'emberhost-instance.json'), `${JSON.stringify({ id })}\n`, 'utf8')
  const server = serverInstance(id, serverDirectory, software)
  const store = {
    dataDirectory,
    getInstance: (candidate: string): ServerInstance | undefined => candidate === id ? server : undefined
  } as unknown as AppStore
  const manager = new FakeManager()
  const trashDirectory = join(directory, 'trash')
  const trashed: string[] = []
  const service = new ModService(store, manager, async (filePath) => {
    await mkdir(trashDirectory, { recursive: true })
    const destination = join(trashDirectory, `${trashed.length}-${filePath.split(/[\\/]/).at(-1)}`)
    await rename(filePath, destination)
    trashed.push(destination)
  })
  return { directory, dataDirectory, server, manager, service, trashed }
}

describe('ModService', () => {
  it('validates and atomically installs a Forge mod with local manifest provenance', async () => {
    const { directory, server, manager, service } = await harness()
    const source = join(directory, 'ExampleMod-1.0.jar')
    await writeJar(source)

    const mods = await service.installFromPath(server.id, source, {
      source: 'curseforge',
      projectId: 238222,
      fileId: 5412345
    })

    expect(manager.exclusiveCalls).toBe(1)
    expect(mods).toEqual([expect.objectContaining({
      fileName: 'ExampleMod-1.0.jar',
      sizeBytes: jarBuffer().length,
      sha256: createHash('sha256').update(jarBuffer()).digest('hex'),
      managed: true
    })])
    expect(mods[0]?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const installed = join(server.serverDirectory, 'mods', 'ExampleMod-1.0.jar')
    expect(await readFile(installed)).toEqual(await readFile(source))
    const manifest = await readFile(join(server.serverDirectory, 'mods', '.emberhost-mods.json'), 'utf8')
    expect(manifest).toContain('"projectId": 238222')
    expect(manifest).toContain('"fileId": 5412345')
    expect(manifest).toContain('"source": "curseforge"')
  })

  it('lists root JARs not installed by EmberHost as unmanaged and detects replacements', async () => {
    const { directory, server, service } = await harness()
    const source = join(directory, 'Managed.jar')
    await writeJar(source, 'original')
    await service.installFromPath(server.id, source)
    await writeJar(join(server.serverDirectory, 'mods', 'Managed.jar'), 'replaced')
    await writeJar(join(server.serverDirectory, 'mods', 'Manual.jar'), 'manual')
    await mkdir(join(server.serverDirectory, 'mods', 'nested'))
    await writeJar(join(server.serverDirectory, 'mods', 'nested', 'Nested.jar'), 'nested')

    await expect(service.list(server.id)).resolves.toEqual([
      expect.objectContaining({ fileName: 'Managed.jar', installedAt: null, managed: false }),
      expect.objectContaining({ fileName: 'Manual.jar', installedAt: null, managed: false })
    ])
  })

  it('rejects malformed, empty, ZIP64, and oversized archives before installing them', async () => {
    const { directory, server, service } = await harness()
    const malformed = join(directory, 'Malformed.jar')
    const empty = join(directory, 'Empty.jar')
    const zip64 = join(directory, 'Zip64.jar')
    const huge = join(directory, 'Huge.jar')
    await writeFile(malformed, 'not a zip')
    const emptyEnd = Buffer.alloc(22)
    emptyEnd.writeUInt32LE(0x06054b50, 0)
    await writeFile(empty, emptyEnd)
    const zip64Contents = jarBuffer()
    zip64Contents.writeUInt16LE(0xffff, zip64Contents.length - 12)
    await writeFile(zip64, zip64Contents)
    await writeFile(huge, '')
    await truncate(huge, modLimits.maxModBytes + 1)

    await expect(service.installFromPath(server.id, malformed)).rejects.toMatchObject({ code: 'INVALID_MOD_JAR' })
    await expect(service.installFromPath(server.id, empty)).rejects.toMatchObject({ code: 'INVALID_MOD_JAR' })
    await expect(service.installFromPath(server.id, zip64)).rejects.toMatchObject({ code: 'UNSUPPORTED_MOD_ARCHIVE' })
    await expect(service.installFromPath(server.id, huge)).rejects.toMatchObject({ code: 'MOD_TOO_LARGE' })
    await expect(readdir(join(server.serverDirectory, 'mods'))).resolves.toEqual([])
  })

  it('requires a safe filename and never overwrites a case-insensitive collision', async () => {
    const { directory, server, service } = await harness()
    const wrongExtension = join(directory, 'Example.zip')
    const source = join(directory, 'Example.jar')
    const collision = join(directory, 'example.jar')
    await writeJar(wrongExtension)
    await writeJar(source)
    await writeJar(collision, 'other')

    await expect(service.installFromPath(server.id, wrongExtension)).rejects.toMatchObject({
      code: 'INVALID_MOD_FILENAME'
    })
    await service.installFromPath(server.id, source)
    const before = await readFile(join(server.serverDirectory, 'mods', 'Example.jar'))
    await expect(service.installFromPath(server.id, collision)).rejects.toMatchObject({ code: 'MOD_ALREADY_EXISTS' })
    expect(await readFile(join(server.serverDirectory, 'mods', 'Example.jar'))).toEqual(before)
  })

  it('only mutates stopped Forge servers', async () => {
    const forge = await harness()
    const source = join(forge.directory, 'Example.jar')
    await writeJar(source)
    forge.manager.active = true
    await expect(forge.service.installFromPath(forge.server.id, source)).rejects.toMatchObject({
      code: 'SERVER_MUST_BE_STOPPED'
    })

    const vanilla = await harness({ kind: 'vanilla' })
    const vanillaSource = join(vanilla.directory, 'Example.jar')
    await writeJar(vanillaSource)
    await expect(vanilla.service.installFromPath(vanilla.server.id, vanillaSource)).rejects.toMatchObject({
      code: 'FORGE_REQUIRED'
    })
  })

  it('validates the UUID-managed server root, ownership marker, and non-linked mods folder', async () => {
    const unmanaged = await harness()
    const source = join(unmanaged.directory, 'Example.jar')
    await writeJar(source)
    unmanaged.server.serverDirectory = join(unmanaged.directory, 'outside')
    await expect(unmanaged.service.installFromPath(unmanaged.server.id, source)).rejects.toMatchObject({
      code: 'UNMANAGED_SERVER_DIRECTORY'
    })

    const mismatched = await harness()
    await writeFile(
      join(mismatched.server.serverDirectory, 'emberhost-instance.json'),
      `${JSON.stringify({ id: randomUUID() })}\n`,
      'utf8'
    )
    await expect(mismatched.service.list(mismatched.server.id)).rejects.toMatchObject({
      code: 'INVALID_INSTANCE_MARKER'
    })

    const linked = await harness()
    const outside = join(linked.directory, 'outside-mods')
    await mkdir(outside)
    await symlink(outside, join(linked.server.serverDirectory, 'mods'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(linked.service.list(linked.server.id)).rejects.toMatchObject({ code: 'UNSAFE_MOD_DIRECTORY' })
  })

  it('uses Trash for removal and restores the mod and manifest if persistence fails', async () => {
    const { directory, server, service, trashed } = await harness()
    const source = join(directory, 'Example.jar')
    await writeJar(source)
    await service.installFromPath(server.id, source)
    vi.spyOn(service as unknown as { writeManifest: () => Promise<void> }, 'writeManifest')
      .mockRejectedValueOnce(new Error('disk full'))

    await expect(service.remove(server.id, 'Example.jar')).rejects.toMatchObject({
      code: 'MOD_REMOVE_ROLLED_BACK'
    })
    expect(trashed).toHaveLength(1)
    expect(await readFile(join(server.serverDirectory, 'mods', 'Example.jar'))).toEqual(await readFile(source))
    await expect(service.list(server.id)).resolves.toEqual([
      expect.objectContaining({ fileName: 'Example.jar', managed: true })
    ])

    await expect(service.remove(server.id, 'Example.jar')).resolves.toEqual([])
    expect(trashed).toHaveLength(2)
    await expect(access(join(server.serverDirectory, 'mods', 'Example.jar'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the mod after Trash when damaged metadata is discovered during removal', async () => {
    const { directory, server, service, trashed } = await harness()
    const source = join(directory, 'Example.jar')
    await writeJar(source)
    await service.installFromPath(server.id, source)
    await writeFile(join(server.serverDirectory, 'mods', '.emberhost-mods.json'), '{ damaged', 'utf8')

    await expect(service.remove(server.id, 'Example.jar')).rejects.toMatchObject({
      code: 'MOD_REMOVE_ROLLED_BACK'
    })
    expect(trashed).toHaveLength(1)
    expect(await readFile(join(server.serverDirectory, 'mods', 'Example.jar'))).toEqual(await readFile(source))
  })

  it('transactionally imports every root JAR from an extracted modpack directory', async () => {
    const { directory, server, service } = await harness()
    const extracted = join(directory, 'extracted')
    await mkdir(join(extracted, 'nested'), { recursive: true })
    await writeJar(join(extracted, 'Alpha.jar'), 'alpha')
    await writeJar(join(extracted, 'Beta.jar'), 'beta')
    await writeJar(join(extracted, 'nested', 'Ignored.jar'), 'ignored')
    await writeFile(join(extracted, 'manifest.json'), '{}')

    const mods = await service.importFromDirectory(server.id, extracted)

    expect(mods.map((mod) => mod.fileName)).toEqual(['Alpha.jar', 'Beta.jar'])
    expect(mods.every((mod) => mod.managed && mod.installedAt)).toBe(true)
    const manifest = await readFile(join(server.serverDirectory, 'mods', '.emberhost-mods.json'), 'utf8')
    expect(manifest.match(/"source": "modpack"/g)).toHaveLength(2)
    await expect(access(join(server.serverDirectory, 'mods', 'Ignored.jar'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves no installed JARs when any root modpack JAR fails validation', async () => {
    const { directory, server, service } = await harness()
    const extracted = join(directory, 'extracted')
    await mkdir(extracted)
    await writeJar(join(extracted, 'Good.jar'))
    await writeFile(join(extracted, 'Bad.jar'), 'broken')

    await expect(service.importFromDirectory(server.id, extracted)).rejects.toMatchObject({ code: 'INVALID_MOD_JAR' })
    expect((await readdir(join(server.serverDirectory, 'mods')))
      .filter((name) => name.toLowerCase().endsWith('.jar'))).toEqual([])
    expect((await readdir(join(server.serverDirectory, 'mods')))
      .filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
