import { IPC } from '../shared/ipc'
import type {
  CopyAssistantOutputInput,
  DesktopApi
} from '../shared/types'

export interface UserActivationState {
  isActive: boolean
}

export function hasActiveUserActivation(
  activation: UserActivationState | undefined
): boolean {
  return activation?.isActive === true
}

export interface CopyAssistantOutputInvokerDependencies {
  currentUserActivation: () => UserActivationState | undefined
  invoke: (
    channel: string,
    input: CopyAssistantOutputInput
  ) => Promise<boolean>
}

/**
 * Builds the exact preload method exposed to the renderer. Keeping the
 * activation check and dedicated channel selection in this testable factory
 * prevents a generic or inactive IPC path from being introduced unnoticed.
 */
export function createCopyAssistantOutputInvoker(
  dependencies: CopyAssistantOutputInvokerDependencies
): DesktopApi['copyAssistantOutput'] {
  return (input) => {
    if (
      !hasActiveUserActivation(
        dependencies.currentUserActivation()
      )
    ) {
      return Promise.resolve(false)
    }
    return dependencies.invoke(IPC.copyAssistantOutput, input)
  }
}
