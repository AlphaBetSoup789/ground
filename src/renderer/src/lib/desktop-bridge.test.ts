import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../../shared/types'
import { resolveDesktopBridge } from './desktop-bridge'

function api(label: string): DesktopApi {
  return { label } as unknown as DesktopApi
}

describe('desktop bridge resolution', () => {
  it('uses the secure preload bridge whenever it is present', () => {
    const bridge = api('preload')
    const createPreview = vi.fn(() => api('preview'))

    expect(resolveDesktopBridge(bridge, true, createPreview)).toEqual({
      status: 'ready',
      mode: 'desktop',
      api: bridge
    })
    expect(createPreview).not.toHaveBeenCalled()
  })

  it('creates the mock API only for an explicit preview build', () => {
    const preview = api('preview')
    const createPreview = vi.fn(() => preview)

    expect(resolveDesktopBridge(undefined, true, createPreview)).toEqual({
      status: 'ready',
      mode: 'preview',
      api: preview
    })
    expect(createPreview).toHaveBeenCalledOnce()
  })

  it('reports a fatal unavailable state without constructing a mock', () => {
    const createPreview = vi.fn(() => api('preview'))

    expect(resolveDesktopBridge(undefined, false, createPreview)).toEqual({
      status: 'unavailable'
    })
    expect(createPreview).not.toHaveBeenCalled()
  })
})
