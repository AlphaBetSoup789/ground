import type { DesktopApi } from '../../shared/types'

declare global {
  interface Window {
    ground?: DesktopApi
  }

  interface ImportMetaEnv {
    readonly VITE_GROUND_BROWSER_PREVIEW?: 'true' | 'false'
  }
}

export {}
