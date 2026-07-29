import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseWindowsNodeShim,
  processLaunchArguments,
  safeChildEnvironment,
  safeWindowsPathExt,
  windowsCommandCandidates,
  type LaunchFileIdentity,
  type ProcessLaunchEnvelope
} from './process-launch'

function identity(filePath: string): LaunchFileIdentity {
  return Object.freeze({
    path: filePath,
    sha256: 'a'.repeat(64),
    size: 1,
    modifiedMs: 1,
    changedMs: 1,
    device: 1,
    inode: 1
  })
}

describe('portable Windows process launch policy', () => {
  it('uses only reviewed PATHEXT executable and shim types', () => {
    expect(
      safeWindowsPathExt('.EXE;.CMD;.PS1;.;.BAT;& calc;.COM;.CMD')
    ).toEqual(['.EXE', '.CMD', '.BAT', '.COM'])
    expect(windowsCommandCandidates('npm', '.CMD;.EXE')).toEqual([
      'npm.CMD',
      'npm.EXE'
    ])
    expect(windowsCommandCandidates('npm.cmd', '.EXE;.CMD')).toEqual(['npm.cmd'])
  })

  it.each([
    ['codex', String.raw`node_modules\@openai\codex\bin\codex.js`],
    ['gemini', String.raw`node_modules\@google\gemini-cli\dist\index.js`],
    ['claude', String.raw`node_modules\@anthropic-ai\claude-code\cli.js`],
    ['npm', String.raw`node_modules\npm\bin\npm-cli.js`]
  ])('recognizes the standard npm-installed %s command shim', (name, relativeScript) => {
    const shimPath = String.raw`C:\Users\Ada\AppData\Roaming\npm\${name}.cmd`
    const shim = [
      '@ECHO off',
      'SETLOCAL',
      String.raw`IF EXIST "%dp0%\node.exe" SET "_prog=%dp0%\node.exe"`,
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeScript}" %*`
    ].join('\r\n')

    expect(parseWindowsNodeShim(shim, shimPath)).toBe(
      path.win32.resolve(path.win32.dirname(shimPath), relativeScript)
    )
  })

  it('recognizes the older npm shim shape with a local Node branch', () => {
    const shimPath = String.raw`C:\project\node_modules\.bin\codex.cmd`
    const shim = [
      '@IF EXIST "%~dp0\\node.exe" (',
      String.raw`  "%~dp0\node.exe" "%~dp0\..\@openai\codex\bin\codex.js" %*`,
      ') ELSE (',
      String.raw`  node "%~dp0\..\@openai\codex\bin\codex.js" %*`,
      ')'
    ].join('\r\n')

    expect(parseWindowsNodeShim(shim, shimPath)).toBe(
      String.raw`C:\project\node_modules\@openai\codex\bin\codex.js`
    )
  })

  it('rejects generic batch programs instead of passing them through cmd.exe', () => {
    expect(() =>
      parseWindowsNodeShim(
        '@echo off\r\npowershell -Command "Invoke-WebRequest %1"\r\n',
        String.raw`C:\tools\unsafe.cmd`
      )
    ).toThrow(/recognized Node package-manager/i)
  })

  it('keeps metacharacters as exact Node argv without constructing a command string', () => {
    const executable = identity(String.raw`C:\Program Files\nodejs\node.exe`)
    const script = identity(String.raw`C:\Users\Ada\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js`)
    const shim = identity(String.raw`C:\Users\Ada\AppData\Roaming\npm\npm.cmd`)
    const launch = Object.freeze({
      version: 1 as const,
      kind: 'windows-node-shim' as const,
      entry: shim,
      executable,
      argumentPrefix: Object.freeze([script.path]),
      shim,
      script,
      fingerprint: 'b'.repeat(64)
    }) satisfies ProcessLaunchEnvelope
    const exactArgs = ['test', 'a&b', '%PATH%', '!value!', '$(touch nope)', '^caret']

    expect(processLaunchArguments(launch, exactArgs)).toEqual([
      script.path,
      ...exactArgs
    ])
    expect(launch.executable.path.toLowerCase()).not.toContain('cmd.exe')
  })

  it('preserves Windows runtime variables needed by Node and npm subprocesses', () => {
    const source: NodeJS.ProcessEnv = {
      Path: String.raw`C:\Program Files\nodejs;C:\Windows\System32`,
      SystemRoot: String.raw`C:\Windows`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: String.raw`C:\Users\Ada\AppData\Local\Temp`,
      TMP: String.raw`C:\Users\Ada\AppData\Local\Temp`,
      USERPROFILE: String.raw`C:\Users\Ada`,
      APPDATA: String.raw`C:\Users\Ada\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local`,
      SECRET_TOKEN: 'must-not-leak'
    }

    expect(safeChildEnvironment([], source, 'win32')).toMatchObject({
      PATH: source.Path,
      SystemRoot: source.SystemRoot,
      ComSpec: source.ComSpec,
      PATHEXT: source.PATHEXT,
      TEMP: source.TEMP,
      TMP: source.TMP,
      USERPROFILE: source.USERPROFILE,
      APPDATA: source.APPDATA,
      LOCALAPPDATA: source.LOCALAPPDATA,
      NO_COLOR: '1',
      TERM: 'dumb'
    })
    expect(safeChildEnvironment([], source, 'win32')).not.toHaveProperty('SECRET_TOKEN')
  })
})
