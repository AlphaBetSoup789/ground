import {
  parseCopyAssistantOutputInput,
  resolveAssistantOutputCopyText
} from '../shared/assistant-output-clipboard'
import { IPC } from '../shared/ipc'
import type { Task } from '../shared/types'

export interface AssistantOutputClipboardTaskSource {
  getTask(taskId: string): Task
}

export interface PlainTextClipboardWriter {
  writeText(text: string): void | Promise<void>
}

/**
 * The only privileged clipboard operation exposed to the renderer. The
 * renderer supplies a retained source identity, never arbitrary clipboard
 * bytes; this service re-resolves the canonical text immediately before the
 * synchronous OS write.
 */
export class AssistantOutputClipboardService {
  constructor(
    private readonly tasks: AssistantOutputClipboardTaskSource,
    private readonly clipboard: PlainTextClipboardWriter
  ) {}

  async copy(rawInput: unknown): Promise<boolean> {
    try {
      const input = parseCopyAssistantOutputInput(rawInput)
      const task = this.tasks.getTask(input.taskId)
      const text = resolveAssistantOutputCopyText(task, input)
      if (text === undefined) return false
      await this.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Keeps the privileged service bound to its one reviewed IPC channel. The
 * caller still supplies Ground's existing trusted-sender wrapper.
 */
export function assistantOutputClipboardIpcOperation(
  service: Pick<AssistantOutputClipboardService, 'copy'>
): {
  channel: typeof IPC.copyAssistantOutput
  invoke: (rawInput: unknown) => Promise<boolean>
} {
  return {
    channel: IPC.copyAssistantOutput,
    invoke: (rawInput) => service.copy(rawInput)
  }
}
