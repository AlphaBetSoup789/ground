export const ASSISTANT_OUTPUT_COPIED_STATUS = 'Assistant output copied.'
export const ASSISTANT_OUTPUT_COPY_FAILED_STATUS =
  'Assistant output copy was unavailable.'
export const ASSISTANT_OUTPUT_COPY_LABEL = 'Copy assistant output'

/**
 * Exact stored assistant message text is what leaves the app via the clipboard.
 * Presentation/rendering must not rewrite that payload.
 */
export function assistantOutputCopyText(content: string): string {
  return content
}

export function canCopyAssistantOutput(content: string | undefined): boolean {
  return typeof content === 'string' && content.length > 0
}

export function assistantOutputCopyStatus(
  state: 'idle' | 'copied' | 'failed'
): string {
  if (state === 'copied') return ASSISTANT_OUTPUT_COPIED_STATUS
  if (state === 'failed') return ASSISTANT_OUTPUT_COPY_FAILED_STATUS
  return ''
}
