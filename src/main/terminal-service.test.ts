import { mkdtemp, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildTerminalEnvironment,
  resolveDefaultTerminalShell,
  TERMINAL_LIMITS,
  TerminalLaunchCancelledError,
  TerminalService,
  type TerminalDisposable,
  type TerminalExitEvent,
  type TerminalPty,
  type TerminalPtyFactory,
  type TerminalPtySpawnOptions
} from './terminal-service'

class FakePty implements TerminalPty {
  readonly pid: number
  readonly writes: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly killSignals: Array<string | undefined> = []
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >()

  constructor(pid: number) {
    this.pid = pid
  }

  readonly onData = (
    listener: (data: string) => void
  ): TerminalDisposable => {
    this.dataListeners.add(listener)
    return {
      dispose: () => {
        this.dataListeners.delete(listener)
      }
    }
  }

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void
  ): TerminalDisposable => {
    this.exitListeners.add(listener)
    return {
      dispose: () => {
        this.exitListeners.delete(listener)
      }
    }
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  kill(signal?: string): void {
    this.killSignals.push(signal)
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode, signal })
    }
  }
}

class FakePtyFactory implements TerminalPtyFactory {
  readonly calls: Array<{
    executable: string
    args: string[]
    options: TerminalPtySpawnOptions
  }> = []
  readonly ptys: FakePty[] = []

  spawn(
    executable: string,
    args: string[],
    options: TerminalPtySpawnOptions
  ): TerminalPty {
    const pty = new FakePty(4_000 + this.ptys.length)
    this.calls.push({ executable, args, options })
    this.ptys.push(pty)
    return pty
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ground-terminal-'))
}

function testService(
  root: string,
  factory: FakePtyFactory,
  overrides: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}
): TerminalService {
  let id = 0
  return new TerminalService({
    authorizeWorkspace: async () => root,
    ptyFactory: factory,
    shellResolver: async () => ({
      executable: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
      args: []
    }),
    environment: {
      HOME: '/Users/example',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'en_US.UTF-8'
    },
    createId: () => `terminal-${(id += 1)}`,
    now: () => 1_700_000_000_000,
    ...overrides
  })
}

describe('terminal workspace and process boundary', () => {
  it('spawns only after main-owned authorization and uses its canonical workspace', async () => {
    const root = await workspace()
    const canonical = await realpath(root)
    const factory = new FakePtyFactory()
    const authorizeWorkspace = vi.fn(async (candidate: string) => {
      expect(candidate).toBe('/renderer/candidate')
      return root
    })
    const service = testService(root, factory, { authorizeWorkspace })

    const session = await service.createForWorkspace('/renderer/candidate', {
      cols: 120,
      rows: 40
    })

    expect(authorizeWorkspace).toHaveBeenCalledOnce()
    expect(session).toMatchObject({
      id: 'terminal-1',
      pid: 4_000,
      cols: 120,
      rows: 40
    })
    expect(factory.calls).toHaveLength(1)
    expect(factory.calls[0]).toMatchObject({
      executable: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh',
      args: [],
      options: {
        cwd: canonical,
        cols: 120,
        rows: 40,
        name: 'xterm-256color'
      }
    })
    if (process.platform === 'win32') {
      expect(factory.calls[0]?.options).not.toHaveProperty('encoding')
    } else {
      expect(factory.calls[0]?.options.encoding).toBe('utf8')
    }
  })

  it.each([
    { platform: 'win32' as const, expectedEncoding: undefined },
    { platform: 'linux' as const, expectedEncoding: 'utf8' as const }
  ])(
    'uses supported PTY encoding options on $platform',
    async ({ platform, expectedEncoding }) => {
      const root = await workspace()
      const factory = new FakePtyFactory()
      const service = testService(root, factory, { platform })

      await service.createForWorkspace(root)

      if (expectedEncoding === undefined) {
        expect(factory.calls[0]?.options).not.toHaveProperty('encoding')
      } else {
        expect(factory.calls[0]?.options.encoding).toBe(expectedEncoding)
      }
    }
  )

  it('does not spawn when the workspace authorizer rejects the renderer path', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const service = testService(root, factory, {
      authorizeWorkspace: async () => {
        throw new Error('Choose this workspace through Ground')
      }
    })

    await expect(
      service.createForWorkspace('/not/authorized')
    ).rejects.toThrow(/choose this workspace/i)
    expect(factory.calls).toHaveLength(0)
  })

  it('exposes the exact canonical launch to a user-presence gate before loading a PTY', async () => {
    const root = await workspace()
    const canonical = await realpath(root)
    const factory = new FakePtyFactory()
    const loadFactory = vi.fn(async () => factory)
    const authorizeLaunch = vi.fn(async () => false)
    const service = testService(root, factory, {
      ptyFactory: loadFactory,
      shellResolver: async () => ({
        executable: process.platform === 'win32'
          ? 'C:\\Windows\\System32\\cmd.exe'
          : '/bin/sh',
        args: process.platform === 'win32' ? ['/d'] : ['-l']
      })
    })

    await expect(
      service.createForWorkspace(root, {}, authorizeLaunch)
    ).rejects.toBeInstanceOf(TerminalLaunchCancelledError)
    expect(authorizeLaunch).toHaveBeenCalledWith({
      executable:
        process.platform === 'win32'
          ? 'C:\\Windows\\System32\\cmd.exe'
          : '/bin/sh',
      args: process.platform === 'win32' ? ['/d'] : ['-l'],
      cwd: canonical
    })
    expect(loadFactory).not.toHaveBeenCalled()
    expect(factory.calls).toHaveLength(0)
    expect(service.listSessions()).toEqual([])
  })

  it('selects fixed system shells without trusting SHELL or COMSPEC', async () => {
    const checked: string[] = []
    const macShell = await resolveDefaultTerminalShell(
      'darwin',
      { SHELL: '/tmp/renderer-shell' },
      async (candidate) => {
        checked.push(candidate)
        return candidate === '/bin/bash'
      }
    )
    expect(checked).toEqual(['/bin/zsh', '/bin/bash'])
    expect(macShell).toEqual({ executable: '/bin/bash', args: [] })

    const windowsShell = await resolveDefaultTerminalShell(
      'win32',
      {
        SystemRoot: 'D:\\Windows',
        COMSPEC: 'C:\\Users\\example\\malicious.exe'
      },
      async (candidate) => candidate.endsWith('powershell.exe')
    )
    expect(windowsShell).toEqual({
      executable:
        'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo']
    })
  })

  it('passes a minimal usable environment and drops credential or injection variables', () => {
    const environment = buildTerminalEnvironment(
      {
        HOME: '/Users/example',
        PATH: '/opt/bin:/usr/bin',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'UTF-8',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        OPENAI_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        NODE_OPTIONS: '--require /tmp/inject.js',
        ELECTRON_RUN_AS_NODE: '1',
        SHELL: '/tmp/untrusted',
        TERM: 'untrusted'
      },
      'darwin',
      '/bin/zsh',
      '/workspace'
    )

    expect(environment).toMatchObject({
      HOME: '/Users/example',
      PATH: '/opt/bin:/usr/bin',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      SHELL: '/bin/zsh',
      PWD: '/workspace',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GROUND_TERMINAL: '1'
    })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('keeps the Windows command processor fixed when PowerShell is selected', () => {
    const environment = buildTerminalEnvironment(
      {
        SystemRoot: 'D:\\Windows',
        COMSPEC: 'C:\\Users\\example\\malicious.exe',
        Path: 'D:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\example',
        OPENAI_API_KEY: 'secret',
        NODE_OPTIONS: '--require C:\\Users\\example\\inject.js'
      },
      'win32',
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\workspace'
    )

    expect(environment).toMatchObject({
      SystemRoot: 'D:\\Windows',
      Path: 'D:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\example',
      ComSpec: 'D:\\Windows\\System32\\cmd.exe',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GROUND_TERMINAL: '1'
    })
    expect(environment).not.toHaveProperty('COMSPEC')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })
})

describe('terminal limits and streaming', () => {
  it('enforces dimensions, input chunk size, resizing, and the session cap', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const service = testService(root, factory, { maxSessions: 1 })

    await expect(
      service.createForWorkspace(root, {
        cols: TERMINAL_LIMITS.minCols - 1,
        rows: 30
      })
    ).rejects.toThrow(/cols/i)

    const session = await service.createForWorkspace(root)
    await expect(service.createForWorkspace(root)).rejects.toThrow(
      /session limit/i
    )

    service.sendInput(
      session.id,
      'x'.repeat(TERMINAL_LIMITS.maxInputBytes)
    )
    expect(factory.ptys[0]?.writes).toHaveLength(1)
    expect(() =>
      service.sendInput(
        session.id,
        'x'.repeat(TERMINAL_LIMITS.maxInputBytes + 1)
      )
    ).toThrow(/exceeds/i)

    expect(
      service.resize(session.id, {
        cols: TERMINAL_LIMITS.maxCols,
        rows: TERMINAL_LIMITS.maxRows
      })
    ).toMatchObject({
      cols: TERMINAL_LIMITS.maxCols,
      rows: TERMINAL_LIMITS.maxRows
    })
    expect(factory.ptys[0]?.resizes).toEqual([
      {
        cols: TERMINAL_LIMITS.maxCols,
        rows: TERMINAL_LIMITS.maxRows
      }
    ])
    expect(() =>
      service.resize(session.id, {
        cols: TERMINAL_LIMITS.maxCols + 1,
        rows: 30
      })
    ).toThrow(/cols/i)
  })

  it('counts pending creation reservations against the session limit', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    let releaseAuthorization: ((value: string) => void) | undefined
    const authorization = new Promise<string>((resolve) => {
      releaseAuthorization = resolve
    })
    const service = testService(root, factory, {
      maxSessions: 1,
      authorizeWorkspace: async () => authorization
    })

    const first = service.createForWorkspace(root)
    await expect(service.createForWorkspace(root)).rejects.toThrow(
      /session limit/i
    )
    releaseAuthorization?.(root)
    await expect(first).resolves.toMatchObject({ id: 'terminal-1' })
  })

  it('replays only capped scrollback and then delivers structured live data', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const service = testService(root, factory, { scrollbackBytes: 8 })
    const session = await service.createForWorkspace(root)
    const pty = factory.ptys[0]
    if (!pty) throw new Error('PTY was not created')

    pty.emitData('abcde')
    pty.emitData('fghij')

    const events: Array<{
      sequence: number
      data: string
      replayed: boolean
      type: string
    }> = []
    const subscription = service.subscribe(session.id, {
      onData: (event) => events.push(event)
    })
    pty.emitData('k')

    expect(events.map(({ sequence, data, replayed, type }) => ({
      sequence,
      data,
      replayed,
      type
    }))).toEqual([
      { sequence: 1, data: 'cde', replayed: true, type: 'data' },
      { sequence: 2, data: 'fghij', replayed: true, type: 'data' },
      { sequence: 3, data: 'k', replayed: false, type: 'data' }
    ])

    subscription.dispose()
    subscription.dispose()
    pty.emitData('not delivered')
    expect(events).toHaveLength(3)
  })
})

describe('terminal lifecycle', () => {
  it('reports a structured process exit and removes the session exactly once', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const service = testService(root, factory)
    const session = await service.createForWorkspace(root)
    const exits: TerminalExitEvent[] = []
    service.subscribe(session.id, {
      onExit: (event) => exits.push(event)
    })

    factory.ptys[0]?.emitExit(7, 15)
    factory.ptys[0]?.emitExit(7, 15)

    expect(exits).toEqual([
      {
        type: 'exit',
        sessionId: session.id,
        exitCode: 7,
        signal: 15,
        reason: 'process-exit',
        timestamp: 1_700_000_000_000
      }
    ])
    expect(service.listSessions()).toEqual([])
    expect(service.kill(session.id)).toBe(false)
    expect(() => service.sendInput(session.id, 'x')).toThrow(/not found/i)
    expect(factory.ptys[0]?.killSignals).toEqual([])
  })

  it('kills sessions and disposes the whole service idempotently', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const service = testService(root, factory, { maxSessions: 2 })
    const first = await service.createForWorkspace(root)
    const second = await service.createForWorkspace(root)
    const firstExits: TerminalExitEvent[] = []
    const secondExits: TerminalExitEvent[] = []
    service.subscribe(first.id, {
      onExit: (event) => firstExits.push(event)
    })
    service.subscribe(second.id, {
      onExit: (event) => secondExits.push(event)
    })

    expect(service.disposeSession(first.id)).toBe(true)
    expect(service.disposeSession(first.id)).toBe(false)
    service.dispose()
    service.dispose()

    expect(factory.ptys[0]?.killSignals).toEqual([undefined])
    expect(factory.ptys[1]?.killSignals).toEqual([undefined])
    expect(firstExits).toHaveLength(1)
    expect(firstExits[0]?.reason).toBe('disposed')
    expect(secondExits).toHaveLength(1)
    expect(secondExits[0]?.reason).toBe('service-disposed')
    await expect(service.createForWorkspace(root)).rejects.toThrow(/disposed/i)
  })

  it('contains subscriber failures and continues delivering to other subscribers', async () => {
    const root = await workspace()
    const factory = new FakePtyFactory()
    const callbackErrors: unknown[] = []
    const service = testService(root, factory, {
      onCallbackError: (error) => callbackErrors.push(error)
    })
    const session = await service.createForWorkspace(root)
    const received: string[] = []
    service.subscribe(session.id, {
      onData: () => {
        throw new Error('broken subscriber')
      }
    })
    service.subscribe(session.id, {
      onData: ({ data }) => received.push(data)
    })

    factory.ptys[0]?.emitData('still delivered')

    expect(callbackErrors).toHaveLength(1)
    expect(received).toEqual(['still delivered'])
  })
})
