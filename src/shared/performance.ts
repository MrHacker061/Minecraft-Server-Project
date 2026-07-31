import type { PerformancePreset } from './contracts'

export interface PerformanceProfileValues {
  memoryMb: number
  viewDistance: number
  simulationDistance: number
  title: string
  description: string
}

export const PERFORMANCE_PROFILES: Record<Exclude<PerformancePreset, 'custom'>, PerformanceProfileValues> = {
  balanced: {
    memoryMb: 4096,
    viewDistance: 12,
    simulationDistance: 8,
    title: 'Balanced',
    description: 'Smooth everyday play with sensible terrain and simulation distance.'
  },
  'far-view': {
    memoryMb: 6144,
    viewDistance: 16,
    simulationDistance: 6,
    title: 'Far view',
    description: 'Sends more distant terrain while limiting expensive entity simulation.'
  },
  'maximum-performance': {
    memoryMb: 6144,
    viewDistance: 10,
    simulationDistance: 6,
    title: 'Maximum performance',
    description: 'Prioritizes stable tick time for exploration and additional players.'
  }
}

export function profileValues(preset: Exclude<PerformancePreset, 'custom'>, totalMemoryMb: number): PerformanceProfileValues {
  const profile = PERFORMANCE_PROFILES[preset]
  const safeCeiling = Math.max(2048, Math.min(12_288, Math.floor((totalMemoryMb - 4096) / 512) * 512))
  return { ...profile, memoryMb: Math.min(profile.memoryMb, safeCeiling) }
}

export function matchingPerformancePreset(
  memoryMb: number,
  viewDistance: number,
  simulationDistance: number
): PerformancePreset {
  const match = Object.entries(PERFORMANCE_PROFILES).find(([, values]) =>
    values.memoryMb === memoryMb &&
    values.viewDistance === viewDistance &&
    values.simulationDistance === simulationDistance
  )
  return (match?.[0] as PerformancePreset | undefined) ?? 'custom'
}
