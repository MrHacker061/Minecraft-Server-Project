import type { EmberHostApi } from '../shared/contracts'

declare global {
  interface Window {
    emberHost: EmberHostApi
  }
}

export {}
