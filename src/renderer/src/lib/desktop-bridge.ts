import type { DesktopApi } from '../../../shared/types'

export type DesktopBridgeResolution =
  | {
      status: 'ready'
      mode: 'desktop' | 'preview'
      api: DesktopApi
    }
  | {
      status: 'unavailable'
    }

export function resolveDesktopBridge(
  bridge: DesktopApi | undefined,
  previewBuild: boolean,
  createPreviewApi: () => DesktopApi
): DesktopBridgeResolution {
  if (bridge) {
    return {
      status: 'ready',
      mode: 'desktop',
      api: bridge
    }
  }
  if (previewBuild) {
    return {
      status: 'ready',
      mode: 'preview',
      api: createPreviewApi()
    }
  }
  return { status: 'unavailable' }
}
