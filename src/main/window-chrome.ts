import type { BrowserWindowConstructorOptions } from 'electron'

export type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition'
>

export function resolveWindowChromeOptions(
  platform: NodeJS.Platform
): WindowChromeOptions {
  if (platform !== 'darwin') return {}

  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }
  }
}
