import { describe, expect, it } from 'vitest'
import { windowsTaskkillCommand } from './process-tree'

describe('Windows process-tree termination', () => {
  it('builds a shell-free taskkill invocation for an exact PID', () => {
    expect(
      windowsTaskkillCommand(42, {
        SystemRoot: String.raw`C:\Windows`,
        PATH: String.raw`C:\untrusted`
      })
    ).toEqual({
      executable: String.raw`C:\Windows\System32\taskkill.exe`,
      args: ['/PID', '42', '/T', '/F'],
      environment: {
        SystemRoot: String.raw`C:\Windows`,
        WINDIR: String.raw`C:\Windows`
      }
    })
  })

  it('accepts case-insensitive Windows environment keys and normalizes the root', () => {
    expect(
      windowsTaskkillCommand(7, {
        windir: String.raw`C:\Windows\\`
      })?.executable
    ).toBe(String.raw`C:\Windows\System32\taskkill.exe`)
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid PID (%s)',
    (pid) => {
      expect(
        windowsTaskkillCommand(pid, {
          SystemRoot: String.raw`C:\Windows`
        })
      ).toBeUndefined()
    }
  )

  it('refuses a relative or missing Windows root', () => {
    expect(windowsTaskkillCommand(42, {})).toBeUndefined()
    expect(
      windowsTaskkillCommand(42, {
        SystemRoot: String.raw`Windows`
      })
    ).toBeUndefined()
  })
})
