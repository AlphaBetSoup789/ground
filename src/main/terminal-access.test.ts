import { describe, expect, it, vi } from 'vitest'
import { TerminalAccessRegistry } from './terminal-access'

function disposable() {
  return { dispose: vi.fn() }
}

describe('terminal renderer access', () => {
  it('binds every interactive operation to an opaque attachment and sender', () => {
    let nextId = 0
    const registry = new TerminalAccessRegistry(
      () => `attachment-${(nextId += 1)}`
    )
    registry.register('terminal-1', 'task-1')
    const first = disposable()
    const attachmentId = registry.attach(
      'terminal-1',
      'task-1',
      10,
      () => first
    )

    expect(attachmentId).toBe('attachment-1')
    expect(registry.authorize('terminal-1', attachmentId, 10)).toEqual({
      taskId: 'task-1'
    })
    expect(() =>
      registry.authorize('terminal-1', attachmentId, 11)
    ).toThrow(/not attached/i)
    expect(() =>
      registry.authorize('terminal-1', 'stale-token', 10)
    ).toThrow(/not attached/i)
    expect(first.dispose).not.toHaveBeenCalled()
  })

  it('invalidates stale capabilities when another view attaches', () => {
    let nextId = 0
    const registry = new TerminalAccessRegistry(
      () => `attachment-${(nextId += 1)}`
    )
    registry.register('terminal-1', 'task-1')
    const first = disposable()
    const second = disposable()
    const firstId = registry.attach('terminal-1', 'task-1', 10, () => first)
    const secondId = registry.attach('terminal-1', 'task-1', 11, () => second)

    expect(first.dispose).toHaveBeenCalledOnce()
    expect(() =>
      registry.detach('terminal-1', firstId, 10)
    ).toThrow(/not attached/i)
    expect(registry.detach('terminal-1', secondId, 11)).toBe(true)
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(registry.detach('terminal-1', secondId, 11)).toBe(false)
  })

  it('preserves the process on detach and cleans access on exit or sender loss', () => {
    let nextId = 0
    const registry = new TerminalAccessRegistry(
      () => `attachment-${(nextId += 1)}`
    )
    registry.register('terminal-1', 'task-1')
    registry.register('terminal-2', 'task-1')
    const first = disposable()
    const second = disposable()
    registry.attach('terminal-1', 'task-1', 10, () => first)
    registry.attach('terminal-2', 'task-1', 10, () => second)

    registry.releaseSender(10)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(registry.sessionsForTask('task-1')).toEqual([
      'terminal-1',
      'terminal-2'
    ])

    registry.reconcile(new Set(['terminal-2']))
    expect(registry.sessionsForTask('task-1')).toEqual(['terminal-2'])
    expect(registry.removeTask('task-1')).toEqual(['terminal-2'])
    expect(registry.sessionsForTask('task-1')).toEqual([])
  })

  it('never attaches a session through the wrong task', () => {
    const registry = new TerminalAccessRegistry(() => 'attachment-1')
    registry.register('terminal-1', 'task-1')
    const subscription = disposable()

    expect(() =>
      registry.attach('terminal-1', 'task-2', 10, () => subscription)
    ).toThrow(/not found/i)
    expect(subscription.dispose).not.toHaveBeenCalled()
  })
})
