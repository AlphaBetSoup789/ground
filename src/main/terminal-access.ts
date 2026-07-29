import { randomUUID } from 'node:crypto'
import type { TerminalDisposable } from './terminal-service'

interface TerminalOwner {
  taskId: string
}

interface TerminalAttachment {
  attachmentId: string
  senderId: number
  disposable: TerminalDisposable
}

export interface TerminalAccessAuthorization {
  taskId: string
}

/**
 * Keeps renderer authority over a PTY explicit and short-lived.
 *
 * A session belongs to a Ground task, while interactive operations require the
 * opaque attachment capability issued to the renderer that most recently attached.
 * Stale views therefore cannot keep typing, resizing, detaching, or closing a PTY
 * after another view has taken over.
 */
export class TerminalAccessRegistry {
  private readonly owners = new Map<string, TerminalOwner>()
  private readonly attachments = new Map<string, TerminalAttachment>()

  constructor(private readonly createId: () => string = randomUUID) {}

  register(sessionId: string, taskId: string): void {
    if (!sessionId || !taskId || this.owners.has(sessionId)) {
      throw new Error('Could not register terminal session')
    }
    this.owners.set(sessionId, { taskId })
  }

  sessionsForTask(taskId: string): string[] {
    return [...this.owners]
      .filter(([, owner]) => owner.taskId === taskId)
      .map(([sessionId]) => sessionId)
  }

  reconcile(activeSessionIds: ReadonlySet<string>): void {
    for (const sessionId of [...this.owners.keys()]) {
      if (!activeSessionIds.has(sessionId)) this.remove(sessionId)
    }
  }

  assertOwnedByTask(sessionId: string, taskId: string): void {
    const owner = this.owners.get(sessionId)
    if (!owner || owner.taskId !== taskId) {
      throw new Error('Terminal session not found')
    }
  }

  attach(
    sessionId: string,
    taskId: string,
    senderId: number,
    subscribe: () => TerminalDisposable
  ): string {
    this.assertOwnedByTask(sessionId, taskId)
    this.attachments.get(sessionId)?.disposable.dispose()
    this.attachments.delete(sessionId)
    const attachmentId = this.allocateAttachmentId()
    const disposable = subscribe()
    this.attachments.set(sessionId, {
      attachmentId,
      senderId,
      disposable
    })
    return attachmentId
  }

  authorize(
    sessionId: string,
    attachmentId: string,
    senderId: number
  ): TerminalAccessAuthorization {
    const owner = this.owners.get(sessionId)
    const attachment = this.attachments.get(sessionId)
    if (
      !owner ||
      !attachment ||
      attachment.attachmentId !== attachmentId ||
      attachment.senderId !== senderId
    ) {
      throw new Error('Terminal is not attached to this view')
    }
    return { taskId: owner.taskId }
  }

  detach(sessionId: string, attachmentId: string, senderId: number): boolean {
    const current = this.attachments.get(sessionId)
    if (!current) return false
    if (
      current.attachmentId !== attachmentId ||
      current.senderId !== senderId
    ) {
      throw new Error('Terminal is not attached to this view')
    }
    current.disposable.dispose()
    this.attachments.delete(sessionId)
    return true
  }

  releaseSender(senderId: number): void {
    for (const [sessionId, attachment] of [...this.attachments]) {
      if (attachment.senderId !== senderId) continue
      attachment.disposable.dispose()
      this.attachments.delete(sessionId)
    }
  }

  remove(sessionId: string): boolean {
    const ownerRemoved = this.owners.delete(sessionId)
    const attachment = this.attachments.get(sessionId)
    attachment?.disposable.dispose()
    this.attachments.delete(sessionId)
    return ownerRemoved
  }

  removeTask(taskId: string): string[] {
    const removed = this.sessionsForTask(taskId)
    for (const sessionId of removed) this.remove(sessionId)
    return removed
  }

  private allocateAttachmentId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.createId()
      if (
        id &&
        ![...this.attachments.values()].some(
          (attachment) => attachment.attachmentId === id
        )
      ) {
        return id
      }
    }
    throw new Error('Could not allocate a terminal attachment')
  }
}
