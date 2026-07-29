import { describe, expect, it } from 'vitest'
import type { PendingAgentApproval } from './run-manager'
import {
  agentApprovalDialogOptions,
  agentApprovalFingerprint
} from './native-agent-approval'

function approval(
  overrides: Partial<PendingAgentApproval> = {}
): PendingAgentApproval {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    approvalId: 'approval-1',
    title: 'Edit src/index.ts',
    detail: '@@ -1 +1 @@\n-old\n+new',
    toolName: 'edit_file',
    provider: {
      id: 'provider-1',
      name: 'Local model',
      kind: 'openai-compatible',
      model: 'example'
    },
    ...overrides
  }
}

describe('native agent approval', () => {
  it('binds the native prompt to the complete immutable approval envelope', () => {
    const request = approval()
    const options = agentApprovalDialogOptions(request)

    expect(options).toMatchObject({
      buttons: ['Cancel', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      message: 'Allow this workspace change once?'
    })
    expect(options.detail).toContain(request.detail)
    expect(options.detail).toContain(
      `Approval envelope SHA-256: ${agentApprovalFingerprint(request)}`
    )
  })

  it.each([
    ['run_command', 'Allow this command once?'],
    ['mcp__search__query', 'Allow this MCP tool call once?'],
    ['custom_tool', 'Allow this agent tool once?']
  ])('uses a consequence-specific prompt for %s', (toolName, message) => {
    expect(
      agentApprovalDialogOptions(approval({ toolName })).message
    ).toBe(message)
  })

  it('renders control and bidirectional characters visibly in reviewed text', () => {
    const options = agentApprovalDialogOptions(
      approval({
        title: 'Safe\u0000title',
        detail: 'before\u202eafter',
        toolName: 'run_\u0001command'
      })
    )

    expect(options.detail).toContain('Safe\\u{0000}title')
    expect(options.detail).toContain('before\\u{202e}after')
    expect(options.detail).toContain('run_\\u{0001}command')
    expect(options.detail).not.toContain('\u202e')
  })

  it('changes identity when any reviewed action field changes', () => {
    const original = approval()
    const changed = approval({ detail: `${original.detail}\n+another line` })

    expect(agentApprovalFingerprint(changed)).not.toBe(
      agentApprovalFingerprint(original)
    )
  })
})
