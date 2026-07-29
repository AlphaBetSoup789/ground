import { describe, expect, it } from 'vitest'
import type { GitExecutableBinding } from './git-executable-discovery'
import { gitExecutableConfirmationOptions } from './git-executable-presentation'

function binding(
  overrides: Partial<GitExecutableBinding> = {}
): GitExecutableBinding {
  return Object.freeze({
    version: 1,
    source: 'picked',
    path: '/Applications/Git/bin/git',
    sha256: 'a'.repeat(64),
    size: 1_234,
    modifiedMs: 1,
    changedMs: 1,
    device: 2,
    inode: 3,
    fingerprint: 'b'.repeat(64),
    ...overrides
  })
}

describe('Git executable native confirmation', () => {
  it('defaults to cancel and binds the complete selected identity', () => {
    const selected = binding()
    const options = gitExecutableConfirmationOptions(selected)

    expect(options).toMatchObject({
      buttons: ['Cancel', 'Use this Git'],
      defaultId: 0,
      cancelId: 0
    })
    expect(options.detail).toContain(selected.path)
    expect(options.detail).toContain(selected.sha256)
    expect(options.detail).toContain(`${selected.size} bytes`)
    expect(options.detail).toContain(selected.fingerprint)
    expect(options.detail).toContain('Git 2.23 or newer')
    expect(options.detail).toContain('before every Git process launch')
  })

  it('renders control and bidirectional characters visibly', () => {
    const options = gitExecutableConfirmationOptions(
      binding({ path: '/safe/\u0001git\u202e' })
    )

    expect(options.detail).toContain('/safe/\\u{0001}git\\u{202e}')
    expect(options.detail).not.toContain('\u202e')
  })
})
