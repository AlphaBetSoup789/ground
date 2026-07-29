import { describe, expect, it } from 'vitest'
import { resolveWindowChromeOptions } from './window-chrome'

describe('resolveWindowChromeOptions', () => {
  it('keeps Ground chrome inset beneath native macOS traffic lights', () => {
    expect(resolveWindowChromeOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 }
    })
  })

  it.each(['win32', 'linux'] satisfies NodeJS.Platform[])(
    'uses the native title bar and window controls on %s',
    (platform) => {
      const options = resolveWindowChromeOptions(platform)

      expect(options).toEqual({})
      expect(options).not.toHaveProperty('titleBarStyle')
      expect(options).not.toHaveProperty('trafficLightPosition')
    }
  )
})
