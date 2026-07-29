import type { RunStatus } from '../../../shared/types'

export const ASSISTANT_ANNOUNCEMENT_INTERVAL_MS = 3_000
export const ASSISTANT_ANNOUNCEMENT_MAX_RAW_CHARS = 1_200

export interface AssistantAnnouncementBatch {
  text: string
  nextOffset: number
  hasMore: boolean
}

export function normalizeAssistantAnnouncement(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function takeAssistantAnnouncementBatch(
  content: string,
  announcedOffset: number,
  maxRawChars = ASSISTANT_ANNOUNCEMENT_MAX_RAW_CHARS
): AssistantAnnouncementBatch | undefined {
  let offset = Math.max(0, Math.min(content.length, announcedOffset))
  const chunkSize = Math.max(1, maxRawChars)

  while (offset < content.length) {
    const hardEnd = Math.min(content.length, offset + chunkSize)
    let end = hardEnd

    if (hardEnd < content.length) {
      const candidate = content.slice(offset, hardEnd)
      const wordBoundary = Math.max(
        candidate.lastIndexOf(' '),
        candidate.lastIndexOf('\n'),
        candidate.lastIndexOf('\t')
      )
      if (wordBoundary >= Math.floor(chunkSize / 2)) {
        end = offset + wordBoundary + 1
      }
    }

    const text = normalizeAssistantAnnouncement(content.slice(offset, end))
    offset = end
    if (text) {
      return {
        text,
        nextOffset: offset,
        hasMore: offset < content.length
      }
    }
  }

  return undefined
}

export function assistantRunStartedAnnouncement(
  status: RunStatus
): string | undefined {
  if (status === 'running') return 'Ground is responding.'
  if (status === 'awaiting-approval') {
    return 'Ground is waiting for your approval.'
  }
  return undefined
}

export function assistantRunFinishedAnnouncement(
  status: RunStatus,
  pendingBatch?: AssistantAnnouncementBatch
): string {
  const prefix = pendingBatch ? `Ground says: ${pendingBatch.text} ` : ''
  const more =
    pendingBatch?.hasMore === true
      ? ' The full response is available in the conversation.'
      : ''

  if (status === 'failed') {
    return `${prefix}Ground stopped because the run failed.${more}`.trim()
  }

  return `${prefix}Ground finished responding.${more}`.trim()
}
