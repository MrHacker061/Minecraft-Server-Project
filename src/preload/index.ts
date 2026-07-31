import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type {
  AppSettings,
  AddForceLoadedRegionInput,
  ConsoleEntry,
  CreateInstanceInput,
  EmberHostApi,
  ForceLoadedRegionsState,
  RemoveForceLoadedRegionInput,
  SetupProgress,
  StartWorldPreparationInput,
  StateEvent,
  UpdateInstanceInput,
  WorldPreparationState
} from '../shared/contracts'

const api: EmberHostApi = {
  getBootstrap: () => ipcRenderer.invoke(channels.getBootstrap),
  refreshInstances: () => ipcRenderer.invoke(channels.refreshInstances),
  getLatestVersion: () => ipcRenderer.invoke(channels.latestVersion),
  getLatestPaperBuild: (minecraftVersion: string) => ipcRenderer.invoke(channels.latestPaperBuild, minecraftVersion),
  checkJava: (javaPath?: string) => ipcRenderer.invoke(channels.checkJava, javaPath),
  createInstance: (input: CreateInstanceInput) => ipcRenderer.invoke(channels.createInstance, input),
  updateInstance: (input: UpdateInstanceInput) => ipcRenderer.invoke(channels.updateInstance, input),
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
  }
}

contextBridge.exposeInMainWorld('emberHost', api)
