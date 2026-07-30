import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_OUTPUT_COPIED_STATUS,
  ASSISTANT_OUTPUT_COPY_FAILED_STATUS,
  ASSISTANT_OUTPUT_COPY_LABEL,
  assistantOutputCopyStatus,
  assistantOutputCopyText,
  canCopyAssistantOutput
} from './copy-assistant-output'

describe('copy assistant output', () => {
  it('copies the exact stored message bytes, including whitespace and controls', () => {
    const content = 'Plan:\n\t- keep exact bytes\u0007\n'
    expect(assistantOutputCopyText(content)).toBe(content)
    expect(canCopyAssistantOutput(content)).toBe(true)
  })

  it('refuses empty or missing assistant content', () => {
    expect(canCopyAssistantOutput('')).toBe(false)
    expect(canCopyAssistantOutput(undefined)).toBe(false)
  })

  it('exposes stable labels and polite status copy', () => {
    expect(ASSISTANT_OUTPUT_COPY_LABEL).toBe('Copy assistant output')
    expect(assistantOutputCopyStatus('idle')).toBe('')
    expect(assistantOutputCopyStatus('copied')).toBe(
      ASSISTANT_OUTPUT_COPIED_STATUS
    )
    expect(assistantOutputCopyStatus('failed')).toBe(
      ASSISTANT_OUTPUT_COPY_FAILED_STATUS
    )
  })
})
