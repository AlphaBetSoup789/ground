import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceGrantRegistry } from './trust-boundary'
import { WorkspaceLifecycleGate } from './workspace-lifecycle-gate'

describe('WorkspaceLifecycleGate', () => {
  it('keeps workspace authority changes serialized across awaits', async () => {
    const gate = new WorkspaceLifecycleGate()
    const entered: string[] = []
    let releaseFirst: () => void = () => undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = gate.run(async () => {
      entered.push('first:start')
      await firstBlocked
      entered.push('first:end')
    })
    const second = gate.run(() => {
      entered.push('second')
    })

    await Promise.resolve()
    expect(entered).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(entered).toEqual(['first:start', 'first:end', 'second'])
  })

  it('continues after a rejected lifecycle operation', async () => {
    const gate = new WorkspaceLifecycleGate()
    const failure = gate.run(() => {
      throw new Error('expected failure')
    })
    const recovered = gate.run(() => 'continued')

    await expect(failure).rejects.toThrow('expected failure')
    await expect(recovered).resolves.toBe('continued')
  })

  it('cannot persist a new task binding behind last-use revocation', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'ground-lifecycle-')
    )
    const grants = new WorkspaceGrantRegistry()
    const grant = await grants.grant(workspace)
    const taskBindings = new Set(['first-task'])
    const gate = new WorkspaceLifecycleGate()
    let releaseDeletion: () => void = () => undefined
    const deletionBlocked = new Promise<void>((resolve) => {
      releaseDeletion = resolve
    })

    const deletion = gate.run(async () => {
      taskBindings.delete('first-task')
      await deletionBlocked
      if (taskBindings.size === 0) grants.revoke(grant.id)
    })
    const attachment = gate.run(async () => {
      await grants.require(grant.id)
      taskBindings.add('second-task')
    })

    await Promise.resolve()
    releaseDeletion()
    await deletion
    await expect(attachment).rejects.toThrow(/choose this workspace/i)
    expect(taskBindings).toEqual(new Set())
  })
})
