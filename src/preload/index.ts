import { contextBridge, ipcRenderer } from 'electron'
import { channels } from '../shared/channels'
import type {
  AppSettings,
  ConsoleEntry,
  CreateInstanceInput,
  EmberHostApi,
  SetupProgress,
  StateEvent,
  UpdateInstanceInput
} from '../shared/contracts'

const api: EmberHostApi = {
  getBootstrap: () => ipcRenderer.invoke(channels.getBootstrap),
  refreshInstances: () => ipcRenderer.invoke(channels.refreshInstances),
  getLatestVersion: () => ipcRenderer.invoke(channels.latestVersion),
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
  }
}

contextBridge.exposeInMainWorld('emberHost', api)
