export type WorldDimension = 'overworld' | 'nether' | 'end'
export type WorldPreparationStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface WorldPreparationState {
  instanceId: string
  status: WorldPreparationStatus
  radius: number
  dimensions: WorldDimension[]
  currentDimension: WorldDimension | null
  completedChunks: number
  totalChunks: number
  percent: number
  rateCps: number | null
  autoPaused: boolean
  message: string | null
  error: string | null
}

export interface StartWorldPreparationInput {
  instanceId: string
  radius: number
  dimensions: WorldDimension[]
}

export interface ForceLoadedRegion {
  id: string
  dimension: WorldDimension
  centerX: number
  centerZ: number
  radius: number
  chunkCount: number
}

export interface ForceLoadedRegionsState {
  instanceId: string
  regions: ForceLoadedRegion[]
  maxRegions: number
  maxRadius: number
  maxTotalChunks: number
  totalChunks: number
}

export interface AddForceLoadedRegionInput {
  instanceId: string
  dimension: WorldDimension
  centerX: number
  centerZ: number
  radius: number
}

export interface RemoveForceLoadedRegionInput {
  instanceId: string
  regionId: string
}
