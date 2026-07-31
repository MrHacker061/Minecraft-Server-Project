export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed'

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

export interface ServerInstance {
  id: string
  name: string
  version: string
  serverDirectory: string
  jarSha1: string
  requiredJavaVersion: number
  javaPath: string
  port: number
  memoryMb: number
  maxPlayers: number
  motd: string
  gameMode: GameMode
  difficulty: Difficulty
  onlineMode: boolean
  viewDistance: number
  simulationDistance: number
  eulaAcceptedAt: string
  createdAt: string
  updatedAt: string
}

export interface InstanceRuntime {
  status: ServerStatus
  pid: number | null
  startedAt: string | null
  lastExitCode: number | null
  playerCount: number
  players: string[]
}

export interface InstanceView extends ServerInstance {
  runtime: InstanceRuntime
}

export interface AppSettings {
  launchAtLogin: boolean
  minimizeToTray: boolean
}

export interface JavaStatus {
  available: boolean
  command: string
  majorVersion: number | null
  versionText: string | null
  error: string | null
}

export interface LatestVersion {
  id: string
  type: 'release'
  requiredJavaVersion: number
}

export interface BootstrapData {
  instances: InstanceView[]
  settings: AppSettings
  java: JavaStatus
  latestVersion: LatestVersion | null
  versionLookupError: string | null
  platform: 'win32' | 'darwin' | 'linux' | string
  appVersion: string
  totalMemoryMb: number
  lanAddresses: string[]
}

export interface CreateInstanceInput {
  name: string
  version: string
  memoryMb: number
  port: number
  maxPlayers: number
  motd: string
  javaPath?: string
  eulaAccepted: true
}

export interface UpdateInstanceInput {
  id: string
  name: string
  memoryMb: number
  port: number
  maxPlayers: number
  motd: string
  gameMode: GameMode
  difficulty: Difficulty
  onlineMode: boolean
  viewDistance: number
  simulationDistance: number
  javaPath: string
}

export interface SetupProgress {
  phase: 'java' | 'version' | 'download' | 'files' | 'ready'
  percent: number
  message: string
  bytesReceived?: number
  totalBytes?: number
}

export interface ConsoleEntry {
  id: string
  instanceId: string
  timestamp: string
  stream: 'stdout' | 'stderr' | 'system'
  level: 'info' | 'warn' | 'error'
  line: string
}

export interface StateEvent {
  instanceId: string
  runtime: InstanceRuntime
}

export interface EmberHostApi {
  getBootstrap: () => Promise<BootstrapData>
  refreshInstances: () => Promise<InstanceView[]>
  getLatestVersion: () => Promise<LatestVersion>
  checkJava: (javaPath?: string) => Promise<JavaStatus>
  createInstance: (input: CreateInstanceInput) => Promise<InstanceView>
  updateInstance: (input: UpdateInstanceInput) => Promise<InstanceView>
  startInstance: (id: string) => Promise<InstanceView>
  stopInstance: (id: string) => Promise<InstanceView>
  sendCommand: (id: string, command: string) => Promise<void>
  getLogs: (id: string) => Promise<ConsoleEntry[]>
  openServerFolder: (id: string) => Promise<void>
  openEula: () => Promise<void>
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>
  onSetupProgress: (listener: (progress: SetupProgress) => void) => () => void
  onConsoleEntry: (listener: (entry: ConsoleEntry) => void) => () => void
  onStateChange: (listener: (event: StateEvent) => void) => () => void
}
