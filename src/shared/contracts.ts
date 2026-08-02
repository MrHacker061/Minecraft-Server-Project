import type {
  AddForceLoadedRegionInput,
  ForceLoadedRegionsState,
  RemoveForceLoadedRegionInput,
  StartWorldPreparationInput,
  WorldPreparationState
} from './world-contracts'

export type {
  AddForceLoadedRegionInput,
  ForceLoadedRegion,
  ForceLoadedRegionsState,
  RemoveForceLoadedRegionInput,
  StartWorldPreparationInput,
  WorldDimension,
  WorldPreparationState,
  WorldPreparationStatus
} from './world-contracts'

export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping' | 'crashed'

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
export type PerformancePreset = 'balanced' | 'far-view' | 'maximum-performance' | 'custom'
export type ServerSoftwareKind = 'vanilla' | 'paper' | 'forge'

export type ServerLaunch =
  | { kind: 'jar'; path: string }
  | { kind: 'java-argfile'; windowsPath: string; unixPath: string }

export type ServerSoftware =
  | { kind: 'vanilla' }
  | { kind: 'paper'; build: number; channel: string }
  | {
      kind: 'forge'
      forgeVersion: string
      mavenVersion: string
      channel: 'recommended' | 'latest' | 'exact'
      installerSha1: string
    }

export type ServerSoftwareSelection =
  | { kind: 'vanilla' }
  | { kind: 'paper'; build: number }
  | { kind: 'forge'; forgeVersion: string; channel: 'recommended' | 'latest' | 'exact' }

export interface PaperBuildDownload {
  name: string
  sha256: string
  size: number
  url: string
}

export interface PaperBuildInfo {
  minecraftVersion: string
  build: number
  channel: string
  publishedAt: string
  download: PaperBuildDownload
}

export interface ForgeBuildInfo {
  minecraftVersion: string
  forgeVersion: string
  mavenVersion: string
  channel: 'recommended' | 'latest' | 'exact'
  installer: {
    name: string
    sha1: string
    url: string
  }
}

export interface ServerInstance {
  id: string
  name: string
  version: string
  serverDirectory: string
  software: ServerSoftware
  launch: ServerLaunch
  jarSha1: string | null
  artifactSha256: string | null
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
  performancePreset: PerformancePreset
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
  health: {
    tps: number | null
    mspt: number | null
    memoryUsedMb: number | null
    memoryMaxMb: number | null
    cpuPercent: number | null
  }
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

export interface MinecraftReleaseInfo {
  id: string
  type: 'release'
  releaseTime: string
}

export interface BootstrapData {
  instances: InstanceView[]
  settings: AppSettings
  java: JavaStatus
  latestVersion: LatestVersion | null
  versionLookupError: string | null
  latestPaperBuild: PaperBuildInfo | null
  paperLookupError: string | null
  preferredForgeBuild: ForgeBuildInfo | null
  forgeLookupError: string | null
  platform: 'win32' | 'darwin' | 'linux' | string
  appVersion: string
  totalMemoryMb: number
  lanAddresses: string[]
  cpuCount: number
}

export interface CreateInstanceInput {
  name: string
  version: string
  memoryMb: number
  port: number
  maxPlayers: number
  motd: string
  javaPath?: string
  software?: ServerSoftwareSelection
  performancePreset?: PerformancePreset
  eulaAccepted: true
}

export interface DeleteInstanceInput {
  id: string
  confirmationName: string
}

export interface WorldSeedState {
  instanceId: string
  seed: string
}

export interface RegenerateWorldInput {
  instanceId: string
  seed: string
  confirmationName: string
}

export type BackupIntervalHours = 1 | 3 | 6 | 12 | 24
export type BackupRetentionCount = 1 | 3 | 5 | 7 | 14
export type BackupStatus = 'idle' | 'waiting' | 'running' | 'failed'

export interface BackupPolicy {
  enabled: boolean
  intervalHours: BackupIntervalHours
  retentionCount: BackupRetentionCount
  enabledAt: string
}

export interface BackupState {
  instanceId: string
  policy: BackupPolicy
  status: BackupStatus
  lastSuccessfulAt: string | null
  nextBackupAt: string | null
  backupCount: number
  totalBytes: number
  message: string | null
  error: string | null
}

export interface UpdateBackupPolicyInput {
  instanceId: string
  enabled: boolean
  intervalHours: BackupIntervalHours
  retentionCount: BackupRetentionCount
}

export interface PaperPluginInfo {
  fileName: string
  name: string | null
  version: string | null
  sizeBytes: number
  installedAt: string | null
  managed: boolean
  builtIn: boolean
  catalogProjectId?: string | null
  catalogVersionId?: string | null
}

export interface ForgeModInfo {
  fileName: string
  sizeBytes: number
  sha256: string
  installedAt: string | null
  managed: boolean
}

export interface ForgeModInstallResult {
  canceled: boolean
  installed: ForgeModInfo | null
  mods: ForgeModInfo[]
}

export interface ForgeModDirectoryImportResult {
  canceled: boolean
  importedCount: number
  mods: ForgeModInfo[]
}

export interface RemoveForgeModInput {
  instanceId: string
  fileName: string
}

export interface PluginInstallResult {
  canceled: boolean
  installed: PaperPluginInfo | null
  plugins: PaperPluginInfo[]
}

export interface RemovePaperPluginInput {
  instanceId: string
  fileName: string
}

export interface CatalogPaperPlugin {
  projectId: string
  slug: string
  name: string
  description: string
  category: string
  author: string
  iconUrl: string | null
  downloads: number
  compatible: boolean
  installed: boolean
  latestVersion: string | null
  license: string
  sourceUrl: string
  unavailableReason: string | null
  requirements: string[]
}

export interface CatalogPluginInstallInput {
  instanceId: string
  projectId: string
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
  performancePreset: PerformancePreset
  javaPath: string
}

export interface SetupProgress {
  phase: 'java' | 'version' | 'download' | 'loader' | 'plugins' | 'mods' | 'files' | 'ready'
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
  getLanAddresses: () => Promise<string[]>
  refreshInstances: () => Promise<InstanceView[]>
  getLatestVersion: () => Promise<LatestVersion>
  getMinecraftReleases: () => Promise<MinecraftReleaseInfo[]>
  getMinecraftRelease: (minecraftVersion: string) => Promise<LatestVersion>
  getLatestPaperBuild: (minecraftVersion: string) => Promise<PaperBuildInfo>
  getPreferredForgeBuild: (minecraftVersion: string) => Promise<ForgeBuildInfo>
  checkJava: (javaPath?: string) => Promise<JavaStatus>
  createInstance: (input: CreateInstanceInput) => Promise<InstanceView>
  updateInstance: (input: UpdateInstanceInput) => Promise<InstanceView>
  deleteInstance: (input: DeleteInstanceInput) => Promise<void>
  getWorldSeed: (id: string) => Promise<WorldSeedState>
  regenerateWorld: (input: RegenerateWorldInput) => Promise<WorldSeedState>
  getBackupState: (id: string) => Promise<BackupState>
  updateBackupPolicy: (input: UpdateBackupPolicyInput) => Promise<BackupState>
  createBackupNow: (id: string) => Promise<BackupState>
  openBackupsFolder: (id: string) => Promise<void>
  startInstance: (id: string) => Promise<InstanceView>
  stopInstance: (id: string) => Promise<InstanceView>
  sendCommand: (id: string, command: string) => Promise<void>
  getLogs: (id: string) => Promise<ConsoleEntry[]>
  openServerFolder: (id: string) => Promise<void>
  openEula: () => Promise<void>
  updateAppSettings: (settings: AppSettings) => Promise<AppSettings>
  getWorldPreparation: (id: string) => Promise<WorldPreparationState>
  startWorldPreparation: (input: StartWorldPreparationInput) => Promise<WorldPreparationState>
  pauseWorldPreparation: (id: string) => Promise<WorldPreparationState>
  resumeWorldPreparation: (id: string) => Promise<WorldPreparationState>
  cancelWorldPreparation: (id: string) => Promise<WorldPreparationState>
  getForceLoadedRegions: (id: string) => Promise<ForceLoadedRegionsState>
  addForceLoadedRegion: (input: AddForceLoadedRegionInput) => Promise<ForceLoadedRegionsState>
  removeForceLoadedRegion: (input: RemoveForceLoadedRegionInput) => Promise<ForceLoadedRegionsState>
  getPaperPlugins: (id: string) => Promise<PaperPluginInfo[]>
  choosePaperPlugin: (id: string) => Promise<PluginInstallResult>
  removePaperPlugin: (input: RemovePaperPluginInput) => Promise<PaperPluginInfo[]>
  getPaperPluginCatalog: (id: string) => Promise<CatalogPaperPlugin[]>
  installCatalogPaperPlugin: (input: CatalogPluginInstallInput) => Promise<PaperPluginInfo[]>
  openPaperPluginPage: (projectId: string) => Promise<void>
  getForgeMods: (id: string) => Promise<ForgeModInfo[]>
  chooseForgeMod: (id: string) => Promise<ForgeModInstallResult>
  chooseForgeModsDirectory: (id: string) => Promise<ForgeModDirectoryImportResult>
  removeForgeMod: (input: RemoveForgeModInput) => Promise<ForgeModInfo[]>
  openForgeModsFolder: (id: string) => Promise<void>
  openCurseForge: () => Promise<void>
  onSetupProgress: (listener: (progress: SetupProgress) => void) => () => void
  onConsoleEntry: (listener: (entry: ConsoleEntry) => void) => () => void
  onStateChange: (listener: (event: StateEvent) => void) => () => void
  onWorldPreparationChange: (listener: (state: WorldPreparationState) => void) => () => void
  onForceLoadedRegionsChange: (listener: (state: ForceLoadedRegionsState) => void) => () => void
  onBackupStateChange: (listener: (state: BackupState) => void) => () => void
}
