import { describe, expect, it } from 'vitest'
import {
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
