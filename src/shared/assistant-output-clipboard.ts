import { fromMarkdown } from 'mdast-util-from-markdown'
import { z } from 'zod'
import type {
  CopyAssistantOutputInput,
  DesktopTask,
  MessageItem,
  Task
} from './types'

export const MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS = 2_000_000

const copyAssistantOutputTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response') }).strict(),
  z
    .object({
      kind: z.literal('code'),
      startOffset: z
        .number()
        .int()
        .min(0)
        .max(MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS),
      endOffset: z
        .number()
        .int()
        .min(1)
        .max(MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS)
    })
    .strict()
    .refine((value) => value.endOffset > value.startOffset, {
      message: 'Code block offsets are invalid'
    })
])

const copyAssistantOutputInputSchema = z
  .object({
    taskId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
    expectedContent: z
      .string()
      .max(MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS),
    target: copyAssistantOutputTargetSchema
  })
  .strict()

export interface FencedAssistantCodeBlock {
  startOffset: number
  endOffset: number
  text: string
}

type AssistantOutputTaskSource = Pick<
  Task | DesktopTask,
  'id' | 'runStatus' | 'items'
>

function isAssistantMessage(
  item: AssistantOutputTaskSource['items'][number]
): item is MessageItem {
  return item.kind === 'message' && item.role === 'assistant'
}

export function parseCopyAssistantOutputInput(
  value: unknown
): CopyAssistantOutputInput {
  return copyAssistantOutputInputSchema.parse(value)
}

/**
 * Uses the same pinned mdast parser for renderer placement and privileged
 * source resolution. Offsets identify the complete Markdown code node, while
 * `text` is the plain-text value represented by React Markdown's `<code>`
 * child, including its represented terminal newline.
 */
export function fencedAssistantCodeBlocks(
  content: string
): FencedAssistantCodeBlock[] {
  if (content.length > MAX_ASSISTANT_OUTPUT_COPY_CHARACTERS) return []

  const tree = fromMarkdown(content)
  const blocks: FencedAssistantCodeBlock[] = []
  const pending: unknown[] = [tree]

  while (pending.length > 0) {
    const candidate = pending.pop()
    if (!candidate || typeof candidate !== 'object') continue
    const node = candidate as {
      type?: unknown
      value?: unknown
      position?: {
        start?: { offset?: unknown }
        end?: { offset?: unknown }
      }
      children?: unknown
    }

    if (Array.isArray(node.children)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index])
      }
    }
    if (node.type !== 'code' || typeof node.value !== 'string') continue

    const startOffset = node.position?.start?.offset
    const endOffset = node.position?.end?.offset
    if (
      typeof startOffset !== 'number' ||
      typeof endOffset !== 'number' ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      startOffset < 0 ||
      endOffset <= startOffset ||
      endOffset > content.length
    ) {
      continue
    }

    // mdast positions begin on the actual fence marker, even when the block
    // is nested in a list/quote or preceded by up to three spaces. Indented
    // code therefore cannot satisfy this marker check.
    const opening = content.slice(startOffset, endOffset)
    if (!/^(?:`{3,}|~{3,})/u.test(opening)) continue

    blocks.push({
      startOffset,
      endOffset,
      // Match mdast-util-to-hast's pinned fenced-code handler exactly:
      // non-empty code gains one represented terminal LF, while an empty
      // fenced block remains empty.
      text: node.value ? `${node.value}\n` : ''
    })
  }

  return blocks
}

export function resolveAssistantOutputCopyText(
  task: AssistantOutputTaskSource,
  input: CopyAssistantOutputInput
): string | undefined {
  if (task.id !== input.taskId) return undefined
  let message: MessageItem | undefined
  let latestAssistant: MessageItem | undefined
  for (const item of task.items) {
    if (!isAssistantMessage(item)) continue
    latestAssistant = item
    if (item.id === input.messageId) message = item
  }
  if (
    !message ||
    message.content.length === 0 ||
    message.content !== input.expectedContent
  ) {
    return undefined
  }

  const runActive =
    task.runStatus === 'running' ||
    task.runStatus === 'awaiting-approval'
  if (runActive && latestAssistant?.id === message.id) return undefined

  if (input.target.kind === 'response') return message.content
  const target = input.target
  return fencedAssistantCodeBlocks(message.content).find(
    (block) =>
      block.startOffset === target.startOffset &&
      block.endOffset === target.endOffset
  )?.text
}
