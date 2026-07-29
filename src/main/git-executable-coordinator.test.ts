import { describe, expect, it } from 'vitest'
import type { GitExecutableBinding } from './git-executable-discovery'
import type {
  GitExecutablePreference,
  GitExecutablePreferenceLoadResult
} from './git-executable-preference'
import {
  GitExecutableCoordinator,
  GitExecutableSelectionRequiredError,
  type GitExecutablePreferences,
  type GitExecutableTrust
} from './git-executable-coordinator'

function binding(
  path: string,
  fingerprint: string,
  source: GitExecutableBinding['source'] = 'picked'
): GitExecutableBinding {
  return Object.freeze({
    version: 1,
    source,
    path,
    sha256: 'a'.repeat(64),
    size: 1,
    modifiedMs: 1,
    changedMs: 1,
    device: 1,
    inode: 1,
    fingerprint
  })
}

class FakePreferences implements GitExecutablePreferences {
  saved: GitExecutablePreference | undefined

  constructor(
    private readonly loaded: GitExecutablePreferenceLoadResult = {
      status: 'missing'
    }
  ) {}

  async load(): Promise<GitExecutablePreferenceLoadResult> {
    return this.loaded
  }

  async save(input: {
    path: string
    fingerprint: string
  }): Promise<GitExecutablePreference> {
    this.saved = Object.freeze({ version: 1, ...input })
    return this.saved
  }
}

class FakeTrust implements GitExecutableTrust {
  discovered: GitExecutableBinding[] = []
  picked = new Map<string, GitExecutableBinding>()
  invalid = new Set<GitExecutableBinding>()

  async discover(): Promise<readonly GitExecutableBinding[]> {
    return this.discovered
  }

  async validatePickedExecutable(
    candidate: string
  ): Promise<GitExecutableBinding> {
    const found = this.picked.get(candidate)
    if (!found) throw new Error('invalid picked executable')
    return found
  }

  async revalidateBeforeUse(
    candidate: GitExecutableBinding
  ): Promise<string> {
    if (this.invalid.has(candidate)) throw new Error('identity changed')
    return candidate.path
  }
}

describe('GitExecutableCoordinator', () => {
  it('restores a persisted preference only when the exact fingerprint revalidates', async () => {
    const trust = new FakeTrust()
    const preferred = binding('/trusted/git', 'b'.repeat(64))
    trust.picked.set(preferred.path, preferred)
    const coordinator = new GitExecutableCoordinator(
      trust,
      new FakePreferences({
        status: 'loaded',
        preference: {
          version: 1,
          path: preferred.path,
          fingerprint: preferred.fingerprint
        }
      })
    )

    await expect(coordinator.resolve()).resolves.toEqual({
      binding: preferred,
      path: preferred.path
    })
  })

  it('does not silently accept a changed persisted executable through discovery', async () => {
    const trust = new FakeTrust()
    const oldFingerprint = 'b'.repeat(64)
    const changed = binding('/trusted/git', 'c'.repeat(64), 'search-path')
    trust.picked.set(
      changed.path,
      binding(changed.path, changed.fingerprint)
    )
    trust.discovered = [changed]
    const coordinator = new GitExecutableCoordinator(
      trust,
      new FakePreferences({
        status: 'loaded',
        preference: {
          version: 1,
          path: changed.path,
          fingerprint: oldFingerprint
        }
      })
    )

    await expect(coordinator.resolve()).rejects.toBeInstanceOf(
      GitExecutableSelectionRequiredError
    )
  })

  it('persists a native-picked binding only around an exact post-confirmation probe', async () => {
    const trust = new FakeTrust()
    const preferences = new FakePreferences()
    const selected = binding('/chosen/git', 'd'.repeat(64))
    trust.picked.set(selected.path, selected)
    const coordinator = new GitExecutableCoordinator(trust, preferences)

    const prepared = await coordinator.preparePicked(selected.path)
    const probed: string[] = []
    await expect(
      coordinator.commitPicked(prepared, async (candidate) => {
        probed.push(candidate)
      })
    ).resolves.toEqual({
      binding: selected,
      path: selected.path
    })
    expect(probed).toEqual([selected.path])
    expect(preferences.saved).toEqual({
      version: 1,
      path: selected.path,
      fingerprint: selected.fingerprint
    })
  })

  it('does not persist a picked executable when its post-confirmation probe fails', async () => {
    const trust = new FakeTrust()
    const preferences = new FakePreferences()
    const selected = binding('/chosen/old-git', 'f'.repeat(64))
    trust.picked.set(selected.path, selected)
    const coordinator = new GitExecutableCoordinator(trust, preferences)
    const prepared = await coordinator.preparePicked(selected.path)

    await expect(
      coordinator.commitPicked(prepared, async () => {
        throw new Error('Git 2.23 or newer is required')
      })
    ).rejects.toThrow(/2\.23/)
    expect(preferences.saved).toBeUndefined()
  })

  it('revokes a changed active executable and refuses the same discovered path', async () => {
    const trust = new FakeTrust()
    const discovered = binding(
      '/system/git',
      'e'.repeat(64),
      'conventional'
    )
    trust.discovered = [discovered]
    const coordinator = new GitExecutableCoordinator(
      trust,
      new FakePreferences()
    )
    const active = await coordinator.resolve()
    trust.invalid.add(active.binding)

    await expect(coordinator.revalidate(active.binding)).rejects.toThrow(
      /changed/i
    )
    await expect(coordinator.resolve()).rejects.toBeInstanceOf(
      GitExecutableSelectionRequiredError
    )
  })

  it('skips passively discovered executables that fail the required version probe', async () => {
    const trust = new FakeTrust()
    const oldGit = binding(
      '/system/old-git',
      '1'.repeat(64),
      'conventional'
    )
    const currentGit = binding(
      '/system/current-git',
      '2'.repeat(64),
      'search-path'
    )
    trust.discovered = [oldGit, currentGit]
    const coordinator = new GitExecutableCoordinator(
      trust,
      new FakePreferences()
    )
    const probed: string[] = []

    await expect(
      coordinator.resolve(async (candidate) => {
        probed.push(candidate)
        if (candidate === oldGit.path) {
          throw new Error('Ground requires Git 2.23 or newer')
        }
      })
    ).resolves.toEqual({
      binding: currentGit,
      path: currentGit.path
    })
    expect(probed).toEqual([oldGit.path, currentGit.path])
  })
})
