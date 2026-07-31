import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from 'electron'
import { cpus, homedir, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channels } from '../shared/channels'
import type { AppSettings, LatestVersion } from '../shared/contracts'
import { AppError, toPublicError } from './services/errors'
import { InstanceService } from './services/instance-service'
import { checkJava } from './services/java'
import { listOfficialReleases, resolveLatestRelease, resolveRelease } from './services/minecraft'
import { resolveLatestPaperBuild } from './services/paper'
import { getLanAddresses } from './services/network'
import { catalogPluginPageUrl, PluginCatalogService } from './services/plugin-catalog'
import { PluginService } from './services/plugin-service'
import { ServerManager } from './services/server-manager'
import { AppStore } from './services/store'
import { validateForceLoadedRegionInput, validateWorldPreparationInput, WorldService } from './services/world-service'
import {
  appSettingsSchema,
  catalogPluginInstallSchema,
  catalogProjectIdSchema,
  commandSchema,
  createInstanceSchema,
  deleteInstanceSchema,
  instanceIdSchema,
  minecraftVersionSchema,
  removeForceLoadedRegionSchema,
  removePaperPluginSchema,
  updateInstanceSchema,
  validationMessage
} from './services/validation'

const currentDirectory = fileURLToPath(new URL('.', import.meta.url))
if (process.env.EMBERHOST_USER_DATA && (!app.isPackaged || process.env.NODE_ENV === 'test')) {
  app.setPath('userData', process.env.EMBERHOST_USER_DATA)
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let shutdownStarted = false
let store: AppStore
let manager: ServerManager
let instanceService: InstanceService
let worldService: WorldService
let pluginService: PluginService
let pluginCatalogService: PluginCatalogService

if (!gotSingleInstanceLock) app.quit()

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    title: 'EmberHost',
    icon: createBrandImage(32),
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      if (store.getSettings().minimizeToTray) {
        event.preventDefault()
        mainWindow?.hide()
      } else {
        isQuitting = true
        app.quit()
      }
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }
}

function runtimeDataDirectory(): string {
  if (process.env.EMBERHOST_USER_DATA && (!app.isPackaged || process.env.NODE_ENV === 'test')) {
    return join(process.env.EMBERHOST_USER_DATA, 'runtime-data')
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'EmberHost')
  }
  if (process.platform === 'linux') {
    return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'EmberHost')
  }
  return join(app.getPath('userData'), 'runtime-data')
}

function createBrandImage(size: number): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <defs><linearGradient id="ember" x1="5" y1="3" x2="28" y2="30" gradientUnits="userSpaceOnUse"><stop stop-color="#78e69a"/><stop offset="1" stop-color="#45b968"/></linearGradient></defs>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="url(#ember)" stroke="#a9f4be" stroke-opacity=".42"/>
      <g fill="none" stroke="#0b1811" stroke-width="1.8">
        <ellipse cx="16" cy="16" rx="9.3" ry="3.8"/>
        <ellipse cx="16" cy="16" rx="9.3" ry="3.8" transform="rotate(60 16 16)"/>
        <ellipse cx="16" cy="16" rx="9.3" ry="3.8" transform="rotate(120 16 16)"/>
      </g>
      <circle cx="16" cy="16" r="1.65" fill="#0b1811"/>
    </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: size, height: size })
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const instanceItems: Electron.MenuItemConstructorOptions[] = manager.listViews().map((instance) => ({
    label: `${instance.runtime.status === 'online' ? '●' : '○'} ${instance.name}`,
    submenu: [
      {
        label: instance.runtime.status === 'offline' || instance.runtime.status === 'crashed' ? 'Start' : 'Stop',
        enabled: instance.runtime.status !== 'starting' && instance.runtime.status !== 'stopping',
        click: () => {
          if (isQuitting || shutdownStarted) return
          const action = instance.runtime.status === 'offline' || instance.runtime.status === 'crashed'
            ? manager.start(instance.id)
            : manager.stop(instance.id)
          void action.catch(() => undefined)
        }
      },
      {
        label: instance.software.kind === 'paper'
          ? `Paper ${instance.version} build ${instance.software.build}`
          : `Vanilla Minecraft ${instance.version}`,
        enabled: false
      }
    ]
  }))

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open EmberHost', click: showWindow },
      { type: 'separator' },
      ...(instanceItems.length ? instanceItems : [{ label: 'No servers yet', enabled: false }]),
      { type: 'separator' },
      {
        label: 'Quit EmberHost',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  tray = new Tray(createBrandImage(16))
  tray.setToolTip('EmberHost')
  tray.on('double-click', showWindow)
  rebuildTrayMenu()
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new AppError('This request did not come from the EmberHost window.', 'UNTRUSTED_SENDER')
  }
}

function assertCanMutate(): void {
  if (isQuitting || shutdownStarted) {
    throw new AppError('EmberHost is shutting down and is no longer accepting changes.', 'APP_SHUTTING_DOWN')
  }
}

function handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event)
      return await handler(event, ...args)
    } catch (error) {
      throw toPublicError(error)
    }
  })
}

function parseOrThrow<T>(result: { success: boolean; data?: T; error?: Parameters<typeof validationMessage>[0] }): T {
  if (!result.success || result.data === undefined) {
    throw new AppError(result.error ? validationMessage(result.error) : 'Invalid request.', 'VALIDATION_ERROR')
  }
  return result.data
}

function registerIpc(): void {
  handle(channels.getBootstrap, async () => {
    const [java, versionResult] = await Promise.all([
      checkJava(),
      resolveLatestRelease()
        .then((version) => ({ version, error: null }))
        .catch((error: unknown) => ({ version: null, error: error instanceof Error ? error.message : 'Version lookup failed.' }))
    ])
    const latestVersion: LatestVersion | null = versionResult.version
      ? {
          id: versionResult.version.id,
          type: 'release',
          requiredJavaVersion: versionResult.version.requiredJavaVersion
        }
      : null
    const paperResult = latestVersion
      ? await resolveLatestPaperBuild(latestVersion.id)
          .then((build) => ({ build, error: null }))
          .catch((error: unknown) => ({ build: null, error: error instanceof Error ? error.message : 'Paper lookup failed.' }))
      : { build: null, error: 'Paper requires a resolved Minecraft release.' }
    return {
      instances: manager.listViews(),
      settings: store.getSettings(),
      java,
      latestVersion,
      versionLookupError: versionResult.error,
      latestPaperBuild: paperResult.build,
      paperLookupError: paperResult.error,
      platform: process.platform,
      appVersion: app.getVersion(),
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      lanAddresses: getLanAddresses(),
      cpuCount: cpus().length
    }
  })

  handle(channels.getLanAddresses, () => getLanAddresses())
  handle(channels.refreshInstances, () => manager.listViews())
  handle(channels.latestVersion, async () => {
    const version = await resolveLatestRelease()
    return { id: version.id, type: 'release', requiredJavaVersion: version.requiredJavaVersion } satisfies LatestVersion
  })
  handle(channels.minecraftReleases, () => listOfficialReleases())
  handle(channels.minecraftRelease, async (_event, minecraftVersion) => {
    const id = parseOrThrow(minecraftVersionSchema.safeParse(minecraftVersion))
    const version = await resolveRelease(id)
    return { id: version.id, type: 'release', requiredJavaVersion: version.requiredJavaVersion } satisfies LatestVersion
  })
  handle(channels.latestPaperBuild, async (_event, minecraftVersion) => {
    if (typeof minecraftVersion !== 'string') throw new AppError('Invalid Minecraft version.', 'VALIDATION_ERROR')
    return resolveLatestPaperBuild(minecraftVersion)
  })
  handle(channels.checkJava, async (_event, javaPath) => {
    if (javaPath !== undefined && typeof javaPath !== 'string') throw new AppError('Invalid Java path.', 'VALIDATION_ERROR')
    return checkJava(javaPath || 'java')
  })
  handle(channels.createInstance, async (event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(createInstanceSchema.safeParse(input))
    const result = await instanceService.create(parsed, (progress) => event.sender.send(channels.setupProgress, progress))
    rebuildTrayMenu()
    return result
  })
  handle(channels.updateInstance, async (_event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(updateInstanceSchema.safeParse(input))
    const result = await instanceService.update(parsed)
    rebuildTrayMenu()
    return result
  })
  handle(channels.deleteInstance, async (_event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(deleteInstanceSchema.safeParse(input))
    await worldService.beginInstanceDeletion(parsed.id)
    try {
      await instanceService.delete(parsed)
    } catch (error) {
      worldService.abortInstanceDeletion(parsed.id)
      throw error
    }
    worldService.completeInstanceDeletion(parsed.id)
    try {
      rebuildTrayMenu()
    } catch (error) {
      console.error('Could not refresh the tray after deleting a server.', error)
    }
  })
  handle(channels.startInstance, async (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return manager.start(parsedId)
  })
  handle(channels.stopInstance, async (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return manager.stop(parsedId)
  })
  handle(channels.command, async (_event, payload) => {
    assertCanMutate()
    const parsed = parseOrThrow(commandSchema.safeParse(payload))
    await manager.sendCommand(parsed.id, parsed.command)
  })
  handle(channels.getLogs, (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return manager.getLogs(parsedId)
  })
  handle(channels.openFolder, async (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    const instance = store.getInstance(parsedId)
    if (!instance) throw new AppError('That server no longer exists.', 'INSTANCE_NOT_FOUND')
    const result = await shell.openPath(instance.serverDirectory)
    if (result) throw new AppError(result, 'OPEN_FOLDER_FAILED')
  })
  handle(channels.openEula, () => shell.openExternal('https://www.minecraft.net/en-us/eula'))
  handle(channels.updateAppSettings, async (_event, value) => {
    assertCanMutate()
    const settings = parseOrThrow(appSettingsSchema.safeParse(value)) as AppSettings
    await store.updateSettings(settings)
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    return settings
  })
  handle(channels.getWorldPreparation, (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return worldService.getWorldPreparation(parsedId)
  })
  handle(channels.startWorldPreparation, (_event, input) => {
    assertCanMutate()
    return worldService.startWorldPreparation(validateWorldPreparationInput(input))
  })
  handle(channels.pauseWorldPreparation, (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return worldService.pauseWorldPreparation(parsedId)
  })
  handle(channels.resumeWorldPreparation, (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return worldService.resumeWorldPreparation(parsedId)
  })
  handle(channels.cancelWorldPreparation, (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return worldService.cancelWorldPreparation(parsedId)
  })
  handle(channels.getForceLoadedRegions, (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return worldService.getForceLoadedRegions(parsedId)
  })
  handle(channels.addForceLoadedRegion, (_event, input) => {
    assertCanMutate()
    return worldService.addForceLoadedRegion(validateForceLoadedRegionInput(input))
  })
  handle(channels.removeForceLoadedRegion, (_event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(removeForceLoadedRegionSchema.safeParse(input))
    return worldService.removeForceLoadedRegion(parsed)
  })
  handle(channels.getPaperPlugins, (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return pluginService.list(parsedId)
  })
  handle(channels.choosePaperPlugin, async (_event, id) => {
    assertCanMutate()
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    const plugins = await pluginService.list(parsedId)
    if (manager.isActive(parsedId)) {
      throw new AppError('Stop the Paper server before changing its plugins.', 'SERVER_MUST_BE_STOPPED')
    }
    if (!mainWindow || mainWindow.isDestroyed()) throw new AppError('The EmberHost window is unavailable.', 'WINDOW_UNAVAILABLE')
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Paper plugin JAR',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft plugin JAR', extensions: ['jar'] }]
    })
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true, installed: null, plugins }
    assertCanMutate()
    const sourcePath = choice.filePaths[0]
    const updated = await pluginService.installFromPath(parsedId, sourcePath)
    const sourceName = basename(sourcePath)
    const installed = updated.find((plugin) => plugin.fileName.toLowerCase() === sourceName.toLowerCase()) ?? null
    return { canceled: false, installed, plugins: updated }
  })
  handle(channels.removePaperPlugin, (_event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(removePaperPluginSchema.safeParse(input))
    return pluginService.remove(parsed.instanceId, parsed.fileName)
  })
  handle(channels.getPaperPluginCatalog, (_event, id) => {
    const parsedId = parseOrThrow(instanceIdSchema.safeParse(id))
    return pluginCatalogService.list(parsedId)
  })
  handle(channels.installCatalogPaperPlugin, (_event, input) => {
    assertCanMutate()
    const parsed = parseOrThrow(catalogPluginInstallSchema.safeParse(input))
    return pluginCatalogService.install(parsed.instanceId, parsed.projectId)
  })
  handle(channels.openPaperPluginPage, (_event, projectId) => {
    const parsedProjectId = parseOrThrow(catalogProjectIdSchema.safeParse(projectId))
    return shell.openExternal(catalogPluginPageUrl(parsedProjectId))
  })
}

async function initialize(): Promise<void> {
  const dataDirectory = runtimeDataDirectory()
  store = new AppStore(dataDirectory)
  await store.load()
  manager = new ServerManager(store)
  instanceService = new InstanceService(store, manager, dataDirectory, (itemPath) => shell.trashItem(itemPath))
  worldService = new WorldService(store, manager)
  pluginService = new PluginService(store, manager, (itemPath) => shell.trashItem(itemPath))
  pluginCatalogService = new PluginCatalogService(store, manager, pluginService)
  manager.onConsole((entry) => mainWindow?.webContents.send(channels.consoleEntry, entry))
  manager.onState((event) => {
    mainWindow?.webContents.send(channels.stateChange, event)
    rebuildTrayMenu()
  })
  worldService.onWorldPreparationChange((state) => mainWindow?.webContents.send(channels.worldPreparationChange, state))
  worldService.onForceLoadedRegionsChange((state) => mainWindow?.webContents.send(channels.forceLoadedRegionsChange, state))
  registerIpc()
  createMainWindow()
  createTray()
}

app.on('second-instance', showWindow)
app.on('activate', showWindow)
app.on('window-all-closed', () => {
  // The tray owns the application lifetime, including while servers are running.
})
app.on('before-quit', (event) => {
  if (shutdownStarted) return
  if (manager && instanceService && worldService && store) {
    event.preventDefault()
    isQuitting = true
    shutdownStarted = true
    manager.beginShutdown()
    void worldService.awaitIdle()
      .then(() => instanceService.awaitIdle())
      .then(() => manager.shutdownAll())
      .then(() => worldService.awaitIdle())
      .then(() => store.awaitIdle())
      .then(() => app.quit())
      .catch((error: unknown) => {
      shutdownStarted = false
      isQuitting = false
      manager.cancelShutdown()
      showWindow()
      dialog.showErrorBox(
        'A server is still running',
        error instanceof Error ? error.message : 'EmberHost could not stop every Java process, so it stayed open.'
      )
      })
  }
})

if (gotSingleInstanceLock) {
  void app.whenReady().then(initialize).catch((error: unknown) => {
    dialog.showErrorBox('EmberHost could not start', error instanceof Error ? error.message : 'An unexpected startup error occurred.')
    app.quit()
  })
}
