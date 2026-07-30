import type {
  DesktopTask,
  ProviderProfile,
  RunMode
} from '../../../shared/types'

export const ASK_TO_AGENT_DRAFT =
  'Use the response above as context. Re-check the current workspace state before implementing the requested changes.'

export interface AskToAgentHandoffSource {
  readonly taskId: string
  readonly providerId: string
  readonly providerUpdatedAt: string
  readonly assistantMessageId: string
  readonly assistantContent: string
}

function providerSupportsAgentMode(
  provider: ProviderProfile | undefined
): provider is ProviderProfile {
  return Boolean(
    provider &&
      (provider.kind === 'cli' || provider.supportsTools)
  )
}

function latestCompletedAssistantMessage(
  task: DesktopTask
): Extract<DesktopTask['items'][number], { kind: 'message' }> | undefined {
  const assistantIndex = task.items.findLastIndex(
    (item) => item.kind === 'message' && item.role === 'assistant'
  )
  if (assistantIndex < 0) return undefined

  const assistant = task.items[assistantIndex]
  if (
    assistant?.kind !== 'message' ||
    assistant.role !== 'assistant' ||
    assistant.historyOnly ||
    !assistant.content.trim() ||
    task.items
      .slice(assistantIndex + 1)
      .some((item) => item.kind === 'message')
  ) {
    return undefined
  }
  return assistant
}

export function taskMatchesAskToAgentHandoff(
  task: DesktopTask | undefined,
  provider: ProviderProfile | undefined,
  source: AskToAgentHandoffSource,
  expectedMode: RunMode
): boolean {
  if (
    !task ||
    task.id !== source.taskId ||
    task.providerId !== source.providerId ||
    task.mode !== expectedMode ||
    task.runStatus !== 'idle' ||
    task.archivedAt ||
    !task.workspace ||
    provider?.id !== source.providerId ||
    provider.updatedAt !== source.providerUpdatedAt ||
    !providerSupportsAgentMode(provider)
  ) {
    return false
  }

  const assistant = latestCompletedAssistantMessage(task)
  return (
    assistant?.id === source.assistantMessageId &&
    assistant.content === source.assistantContent
  )
}

export function askToAgentHandoffSource(
  task: DesktopTask,
  provider: ProviderProfile | undefined
): AskToAgentHandoffSource | undefined {
  const assistant = latestCompletedAssistantMessage(task)
  if (!assistant) return undefined

  const source = {
    taskId: task.id,
    providerId: task.providerId,
    providerUpdatedAt: provider?.updatedAt ?? '',
    assistantMessageId: assistant.id,
    assistantContent: assistant.content
  }
  return taskMatchesAskToAgentHandoff(
    task,
    provider,
    source,
    'ask'
  )
    ? source
    : undefined
}

export function prepareAskToAgentDraft(existingDraft: string): string {
  return existingDraft.trim() ? existingDraft : ASK_TO_AGENT_DRAFT
}
