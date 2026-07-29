import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fingerprintPreparedCommandAction,
  fingerprintPreparedMcpCall,
  fingerprintPreparedWriteAction,
  prepareMcpExecutionCall
} from './execution-binding'
import type { McpExposedTool } from './mcp-service'
import type { LaunchFileIdentity, ProcessLaunchEnvelope } from './process-launch'
import type { PreparedCommandAction, PreparedWriteAction } from './tools'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeAction(options: {
  content?: string
  canonicalTarget?: string
  extra?: string
} = {}): PreparedWriteAction {
  const content = options.content ?? 'approved contents\n'
  return Object.freeze({
    version: 1,
    workspaceRoot: '/private/workspace',
    relativePath: 'notes/approved.txt',
    canonicalTarget:
      options.canonicalTarget ?? '/private/workspace/notes/approved.txt',
    existed: true,
    baseSha256: sha256('prior contents\n'),
    newContentSha256: sha256(content),
    newContent: content,
    fileMode: 0o644,
    preview: 'private write preview',
    previewStatus: 'complete',
    ...(options.extra === undefined ? {} : { extra: options.extra })
  }) as PreparedWriteAction
}

function launchIdentity(
  overrides: Partial<LaunchFileIdentity> = {}
): LaunchFileIdentity {
  return Object.freeze({
    path: '/private/bin/node',
    sha256: '1'.repeat(64),
    size: 42,
    modifiedMs: 100,
    changedMs: 101,
    device: 7,
    inode: 11,
    ...overrides
  })
}

function commandAction(options: {
  args?: readonly string[]
  cwd?: string
  extra?: string
} = {}): PreparedCommandAction {
  const executable = launchIdentity()
  const launch: ProcessLaunchEnvelope = Object.freeze({
    version: 1,
    kind: 'direct',
    entry: executable,
    executable,
    argumentPrefix: Object.freeze([]),
    fingerprint: '2'.repeat(64)
  })
  return Object.freeze({
    version: 1,
    workspaceRoot: '/private/workspace',
    cwd: options.cwd ?? '/private/workspace',
    relativeCwd: '.',
    launch,
    executable: executable.path,
    executableSha256: executable.sha256,
    executableSize: executable.size,
    executableModifiedMs: executable.modifiedMs,
    args: Object.freeze([...(options.args ?? ['script.js', '--approved'])]),
    timeoutMs: 12_000,
    preview: 'private command preview',
    previewStatus: 'complete',
    ...(options.extra === undefined ? {} : { extra: options.extra })
  }) as PreparedCommandAction
}

function mcpTool(
  overrides: Partial<McpExposedTool['metadata']> = {}
): McpExposedTool {
  return {
    definition: {
      name: 'mcp__files__move',
      description: 'Move an item',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' }
        }
      }
    },
    metadata: {
      source: 'mcp',
      approvalRequired: true,
      serverId: 'files',
      serverName: 'Files',
      originalName: 'move',
      fingerprint: '3'.repeat(64),
      trustStatus: 'approved',
      ...overrides
    }
  }
}

describe('execution bindings', () => {
  it('returns stable lowercase SHA-256 values without renderer-facing details', () => {
    const write = fingerprintPreparedWriteAction(writeAction())
    const command = fingerprintPreparedCommandAction(commandAction())
    const call = prepareMcpExecutionCall(mcpTool(), {
      from: '/private/source',
      to: '/private/destination'
    })
    const mcp = fingerprintPreparedMcpCall(call)

    for (const fingerprint of [write, command, mcp]) {
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(fingerprint).not.toContain('/private')
    }
    expect(fingerprintPreparedWriteAction(writeAction())).toBe(write)
  })

  it('binds all execution-relevant write and command data using fixed fields', () => {
    expect(
      fingerprintPreparedWriteAction(
        writeAction({ content: 'different contents\n' })
      )
    ).not.toBe(fingerprintPreparedWriteAction(writeAction()))
    expect(
      fingerprintPreparedWriteAction(
        writeAction({ canonicalTarget: '/private/workspace/other.txt' })
      )
    ).not.toBe(fingerprintPreparedWriteAction(writeAction()))
    expect(
      fingerprintPreparedCommandAction(
        commandAction({ args: ['script.js', '--different'] })
      )
    ).not.toBe(fingerprintPreparedCommandAction(commandAction()))
    expect(
      fingerprintPreparedCommandAction(
        commandAction({ cwd: '/private/workspace/nested' })
      )
    ).not.toBe(fingerprintPreparedCommandAction(commandAction()))

    expect(
      fingerprintPreparedWriteAction(
        writeAction({ extra: 'ignored extension A' })
      )
    ).toBe(
      fingerprintPreparedWriteAction(
        writeAction({ extra: 'ignored extension B' })
      )
    )
    expect(
      fingerprintPreparedCommandAction(
        commandAction({ extra: 'ignored extension A' })
      )
    ).toBe(
      fingerprintPreparedCommandAction(
        commandAction({ extra: 'ignored extension B' })
      )
    )
  })

  it('canonicalizes, detaches, and deeply freezes prepared MCP arguments', () => {
    const firstInput = {
      z: [{ beta: 2, alpha: 1 }],
      a: { nested: true, values: [3, 2, 1] }
    }
    const secondInput = {
      a: { values: [3, 2, 1], nested: true },
      z: [{ alpha: 1, beta: 2 }]
    }
    const first = prepareMcpExecutionCall(mcpTool(), firstInput)
    const second = prepareMcpExecutionCall(mcpTool(), secondInput)

    expect(first.argumentsSha256).toBe(second.argumentsSha256)
    expect(fingerprintPreparedMcpCall(first)).toBe(
      fingerprintPreparedMcpCall(second)
    )
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.arguments)).toBe(true)
    expect(Object.isFrozen(first.arguments.z)).toBe(true)
    const nestedArray = first.arguments.z
    expect(Array.isArray(nestedArray) && Object.isFrozen(nestedArray[0])).toBe(
      true
    )

    firstInput.a.nested = false
    firstInput.z[0]!.alpha = 99
    expect(first.arguments).toEqual({
      a: { nested: true, values: [3, 2, 1] },
      z: [{ alpha: 1, beta: 2 }]
    })
  })

  it('binds the MCP tool identity and arguments', () => {
    const base = prepareMcpExecutionCall(mcpTool(), { value: 'approved' })
    const changedArguments = prepareMcpExecutionCall(mcpTool(), {
      value: 'changed'
    })
    const changedTool = prepareMcpExecutionCall(
      mcpTool({ fingerprint: '4'.repeat(64) }),
      { value: 'approved' }
    )
    const baseline = fingerprintPreparedMcpCall(base)

    expect(fingerprintPreparedMcpCall(changedArguments)).not.toBe(baseline)
    expect(fingerprintPreparedMcpCall(changedTool)).not.toBe(
      baseline
    )
  })

  it('rejects untrusted or unsafe MCP calls without echoing sensitive input', () => {
    expect(() =>
      prepareMcpExecutionCall(mcpTool({ trustStatus: 'pending' }), {
        secret: 'do-not-echo'
      })
    ).toThrow('Prepared execution binding failed integrity validation')

    try {
      prepareMcpExecutionCall(mcpTool(), {
        get secret() {
          throw new Error('do-not-echo')
        }
      })
      throw new Error('Expected unsafe input to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Prepared execution binding failed integrity validation'
      )
      expect((error as Error).message).not.toContain('do-not-echo')
    }

    const prepared = prepareMcpExecutionCall(mcpTool(), {
      nested: { value: 'approved' }
    })
    const shallowFrozen = Object.freeze({
      ...prepared,
      arguments: Object.freeze({ nested: { value: 'approved' } })
    })
    expect(() => fingerprintPreparedMcpCall(shallowFrozen)).toThrow(
      'Prepared execution binding failed integrity validation'
    )
  })
})
