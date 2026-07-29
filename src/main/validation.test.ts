import { describe, expect, it } from 'vitest'
import {
  parseLocalStateSnapshotId,
  parseProviderDraft,
  parseTaskPatch,
  parseWorkspaceGrantId
} from './validation'

const grantId = 'workspace_12345678-1234-4123-8123-123456789abc'

describe('workspace grant validation', () => {
  it('accepts only opaque workspace IDs in renderer task patches', () => {
    expect(parseTaskPatch({ workspaceGrantId: grantId })).toEqual({
      workspaceGrantId: grantId
    })
    expect(() =>
      parseTaskPatch({ workspacePath: '/Users/example/project' })
    ).toThrow()
    expect(() =>
      parseTaskPatch({ workspaceGrantId: '/Users/example/project' })
    ).toThrow(/workspace grant/i)
  })

  it('rejects malformed and oversized grant IDs', () => {
    expect(parseWorkspaceGrantId(grantId)).toBe(grantId)
    expect(() => parseWorkspaceGrantId('workspace_not-a-uuid')).toThrow(
      /workspace grant/i
    )
    expect(() => parseWorkspaceGrantId(`workspace_${'a'.repeat(500)}`)).toThrow(
      /workspace grant/i
    )
  })
})

describe('local state snapshot validation', () => {
  it('accepts only opaque snapshot IDs, never paths or traversal', () => {
    const snapshotId =
      'state_snapshot_12345678-1234-4123-8123-123456789abc'
    expect(parseLocalStateSnapshotId(snapshotId)).toBe(snapshotId)
    expect(() =>
      parseLocalStateSnapshotId('../../ground-state.json.bak')
    ).toThrow(/local state snapshot/i)
    expect(() =>
      parseLocalStateSnapshotId(
        'state_snapshot_12345678-1234-1123-8123-123456789abc'
      )
    ).toThrow(/local state snapshot/i)
  })
})

describe('CLI prompt transport validation', () => {
  it('rejects prompt tokens in argv when the prompt uses stdin', () => {
    expect(() =>
      parseProviderDraft({
        name: 'Private stdin bridge',
        kind: 'cli',
        model: '',
        command: '/usr/bin/example',
        args: ['run', '--prompt={prompt}'],
        promptMode: 'stdin',
        outputMode: 'plain',
        cliAdapter: 'generic'
      })
    ).toThrow(/standard-input.*process arguments/i)
  })

  it('allows prompt tokens with explicit argument transport', () => {
    expect(
      parseProviderDraft({
        name: 'Argument bridge',
        kind: 'cli',
        model: '',
        command: '/usr/bin/example',
        args: ['run', '--prompt={prompt}'],
        promptMode: 'argument',
        outputMode: 'plain',
        cliAdapter: 'generic'
      })
    ).toMatchObject({ promptMode: 'argument' })
  })

  it('uses the same 128,000-byte UTF-8 environment budget as vault serialization', () => {
    const draft = {
      name: 'Environment bridge',
      kind: 'cli' as const,
      model: '',
      command: '/usr/bin/example',
      args: [],
      promptMode: 'stdin' as const,
      outputMode: 'plain' as const,
      cliAdapter: 'generic' as const
    }
    const names = ['A', 'B', 'C', 'D']
    let remainingBytes = 128_000 - names.length
    const accepted = names.map((name, index) => {
      const characters = Math.floor(
        remainingBytes / (2 * (names.length - index))
      )
      remainingBytes -= characters * 2
      return { name, value: 'é'.repeat(characters) }
    })
    expect(remainingBytes).toBe(0)
    expect(
      parseProviderDraft({
        ...draft,
        cliEnvironment: accepted
      })
    ).toMatchObject({ kind: 'cli' })

    const oversized = structuredClone(accepted)
    oversized[0]!.value += 'é'
    expect(() =>
      parseProviderDraft({
        ...draft,
        cliEnvironment: oversized
      })
    ).toThrow(/too large/i)
  })
})
