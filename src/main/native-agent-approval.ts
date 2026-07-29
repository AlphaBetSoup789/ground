import { createHash } from 'node:crypto'
import type { MessageBoxOptions } from 'electron'
import type { PendingAgentApproval } from './run-manager'

const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u

function reviewedText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      if (
        codePoint === undefined ||
        character === '\n' ||
        character === '\t' ||
        (codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          !BIDI_CONTROL_PATTERN.test(character))
      ) {
        return character
      }
      return `\\u{${codePoint.toString(16).padStart(4, '0')}}`
    })
    .join('')
}

function actionKind(
  toolName: string
): 'command' | 'workspace-write' | 'mcp' | 'tool' {
  if (toolName === 'run_command') return 'command'
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return 'workspace-write'
  }
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'tool'
}

export function agentApprovalFingerprint(
  approval: Readonly<PendingAgentApproval>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: approval.runId,
        taskId: approval.taskId,
        approvalId: approval.approvalId,
        title: approval.title,
        detail: approval.detail,
        toolName: approval.toolName,
        provider: approval.provider
      })
    )
    .digest('hex')
}

export function agentApprovalDialogOptions(
  approval: Readonly<PendingAgentApproval>
): MessageBoxOptions {
  const kind = actionKind(approval.toolName)
  const message =
    kind === 'command'
      ? 'Allow this command once?'
      : kind === 'workspace-write'
        ? 'Allow this workspace change once?'
        : kind === 'mcp'
          ? 'Allow this MCP tool call once?'
          : 'Allow this agent tool once?'
  const consequence =
    kind === 'mcp'
      ? 'The selected MCP server may make external changes or disclose the supplied arguments.'
      : kind === 'command'
        ? 'The command runs as your user inside the selected workspace and is not sandboxed by Ground.'
        : kind === 'workspace-write'
          ? 'Ground will revalidate and apply only the reviewed workspace change below.'
          : 'This tool may change your workspace or external state.'

  return {
    type: 'warning',
    buttons: ['Cancel', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Authorize agent action',
    message,
    detail: [
      `Provider: ${reviewedText(approval.provider?.name ?? 'Unknown provider')}`,
      `Action: ${reviewedText(approval.title)}`,
      `Tool identifier: ${reviewedText(approval.toolName)}`,
      '',
      'Exact reviewed action:',
      reviewedText(approval.detail) || '(no detail supplied)',
      '',
      consequence,
      'This confirmation applies only to this pending action.',
      `Approval envelope SHA-256: ${agentApprovalFingerprint(approval)}`
    ].join('\n')
  }
}
