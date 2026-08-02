import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type {
  AppSettings,
  AddForceLoadedRegionInput,
  BackupState,
  CatalogPluginInstallInput,
  ConsoleEntry,
  CreateInstanceInput,
  DeleteInstanceInput,
  EmberHostApi,
  ForceLoadedRegionsState,
  RegenerateWorldInput,
  RemoveForceLoadedRegionInput,
  RemovePaperPluginInput,
  SetupProgress,
  StartWorldPreparationInput,
  StateEvent,
  UpdateInstanceInput,
  UpdateBackupPolicyInput,
  WorldPreparationState
} from '../shared/contracts'

const api: EmberHostApi = {
  getBootstrap: () => ipcRenderer.invoke(channels.getBootstrap),
  getLanAddresses: () => ipcRenderer.invoke(channels.getLanAddresses),
  refreshInstances: () => ipcRenderer.invoke(channels.refreshInstances),
  getLatestVersion: () => ipcRenderer.invoke(channels.latestVersion),
  getMinecraftReleases: () => ipcRenderer.invoke(channels.minecraftReleases),
  getMinecraftRelease: (minecraftVersion: string) => ipcRenderer.invoke(channels.minecraftRelease, minecraftVersion),
  getLatestPaperBuild: (minecraftVersion: string) => ipcRenderer.invoke(channels.latestPaperBuild, minecraftVersion),
  checkJava: (javaPath?: string) => ipcRenderer.invoke(channels.checkJava, javaPath),
  createInstance: (input: CreateInstanceInput) => ipcRenderer.invoke(channels.createInstance, input),
  updateInstance: (input: UpdateInstanceInput) => ipcRenderer.invoke(channels.updateInstance, input),
  deleteInstance: (input: DeleteInstanceInput) => ipcRenderer.invoke(channels.deleteInstance, input),
  getWorldSeed: (id: string) => ipcRenderer.invoke(channels.getWorldSeed, id),
  regenerateWorld: (input: RegenerateWorldInput) => ipcRenderer.invoke(channels.regenerateWorld, input),
  getBackupState: (id: string) => ipcRenderer.invoke(channels.getBackupState, id),
  updateBackupPolicy: (input: UpdateBackupPolicyInput) => ipcRenderer.invoke(channels.updateBackupPolicy, input),
  createBackupNow: (id: string) => ipcRenderer.invoke(channels.createBackupNow, id),
  openBackupsFolder: (id: string) => ipcRenderer.invoke(channels.openBackupsFolder, id),
  startInstance: (id: string) => ipcRenderer.invoke(channels.startInstance, id),
  stopInstance: (id: string) => ipcRenderer.invoke(channels.stopInstance, id),
  sendCommand: (id: string, command: string) => ipcRenderer.invoke(channels.command, { id, command }),
  getLogs: (id: string) => ipcRenderer.invoke(channels.getLogs, id),
  openServerFolder: (id: string) => ipcRenderer.invoke(channels.openFolder, id),
  openEula: () => ipcRenderer.invoke(channels.openEula),
  updateAppSettings: (settings: AppSettings) => ipcRenderer.invoke(channels.updateAppSettings, settings),
  getWorldPreparation: (id: string) => ipcRenderer.invoke(channels.getWorldPreparation, id),
  startWorldPreparation: (input: StartWorldPreparationInput) => ipcRenderer.invoke(channels.startWorldPreparation, input),
  pauseWorldPreparation: (id: string) => ipcRenderer.invoke(channels.pauseWorldPreparation, id),
  resumeWorldPreparation: (id: string) => ipcRenderer.invoke(channels.resumeWorldPreparation, id),
  cancelWorldPreparation: (id: string) => ipcRenderer.invoke(channels.cancelWorldPreparation, id),
  getForceLoadedRegions: (id: string) => ipcRenderer.invoke(channels.getForceLoadedRegions, id),
  addForceLoadedRegion: (input: AddForceLoadedRegionInput) => ipcRenderer.invoke(channels.addForceLoadedRegion, input),
  removeForceLoadedRegion: (input: RemoveForceLoadedRegionInput) => ipcRenderer.invoke(channels.removeForceLoadedRegion, input),
  getPaperPlugins: (id: string) => ipcRenderer.invoke(channels.getPaperPlugins, id),
  choosePaperPlugin: (id: string) => ipcRenderer.invoke(channels.choosePaperPlugin, id),
  removePaperPlugin: (input: RemovePaperPluginInput) => ipcRenderer.invoke(channels.removePaperPlugin, input),
  getPaperPluginCatalog: (id: string) => ipcRenderer.invoke(channels.getPaperPluginCatalog, id),
  installCatalogPaperPlugin: (input: CatalogPluginInstallInput) => ipcRenderer.invoke(channels.installCatalogPaperPlugin, input),
  openPaperPluginPage: (projectId: string) => ipcRenderer.invoke(channels.openPaperPluginPage, projectId),
  onSetupProgress: (listener: (progress: SetupProgress) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, progress: SetupProgress): void => listener(progress)
    ipcRenderer.on(channels.setupProgress, callback)
    return () => ipcRenderer.removeListener(channels.setupProgress, callback)
  },
  onConsoleEntry: (listener: (entry: ConsoleEntry) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, entry: ConsoleEntry): void => listener(entry)
    ipcRenderer.on(channels.consoleEntry, callback)
    return () => ipcRenderer.removeListener(channels.consoleEntry, callback)
  },
  onStateChange: (listener: (event: StateEvent) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: StateEvent): void => listener(state)
    ipcRenderer.on(channels.stateChange, callback)
    return () => ipcRenderer.removeListener(channels.stateChange, callback)
  },
  onWorldPreparationChange: (listener: (state: WorldPreparationState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: WorldPreparationState): void => listener(state)
    ipcRenderer.on(channels.worldPreparationChange, callback)
    return () => ipcRenderer.removeListener(channels.worldPreparationChange, callback)
  },
  onForceLoadedRegionsChange: (listener: (state: ForceLoadedRegionsState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: ForceLoadedRegionsState): void => listener(state)
    ipcRenderer.on(channels.forceLoadedRegionsChange, callback)
    return () => ipcRenderer.removeListener(channels.forceLoadedRegionsChange, callback)
  },
  onBackupStateChange: (listener: (state: BackupState) => void) => {
    const callback = (_event: Electron.IpcRendererEvent, state: BackupState): void => listener(state)
    ipcRenderer.on(channels.backupStateChange, callback)
    return () => ipcRenderer.removeListener(channels.backupStateChange, callback)
  }
}

contextBridge.exposeInMainWorld('emberHost', api)
