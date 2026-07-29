import path from 'node:path'
import type {
  GitExecutableBinding,
  GitExecutableTrustService
} from './git-executable-discovery'
import type {
  GitExecutablePreference,
  GitExecutablePreferenceLoadResult,
  GitExecutablePreferenceStore
} from './git-executable-preference'

export interface GitExecutableTrust {
  discover(): Promise<readonly GitExecutableBinding[]>
  validatePickedExecutable(candidate: string): Promise<GitExecutableBinding>
  revalidateBeforeUse(binding: GitExecutableBinding): Promise<string>
}

export interface GitExecutablePreferences {
  load(): Promise<GitExecutablePreferenceLoadResult>
  save(input: {
    path: string
    fingerprint: string
  }): Promise<GitExecutablePreference>
}

export interface TrustedGitExecutable {
  readonly binding: GitExecutableBinding
  readonly path: string
}

export class GitExecutableSelectionRequiredError extends Error {
  constructor() {
    super(
      'Git 2.23 or newer was not found in a trusted location. Choose the Git executable to continue.'
    )
    this.name = 'GitExecutableSelectionRequiredError'
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * Coordinates passive discovery and an explicitly selected main-only
 * preference. Persisted data is only a hint: the trust service must recreate
 * and revalidate the exact process-local binding before every Git launch.
 */
export class GitExecutableCoordinator {
  private active: GitExecutableBinding | undefined
  private stalePaths = new Set<string>()
  private initialization: Promise<void> | undefined

  constructor(
    private readonly trust: GitExecutableTrustService | GitExecutableTrust,
    private readonly preferences:
      | GitExecutablePreferenceStore
      | GitExecutablePreferences
  ) {}

  async resolve(
    validateExecutable?: (path: string) => Promise<void>
  ): Promise<TrustedGitExecutable> {
    await this.initialize()
    if (this.active) {
      const active = this.active
      try {
        const trusted = await this.revalidate(active)
        await validateExecutable?.(trusted.path)
        return trusted
      } catch {
        this.deactivate(active)
      }
    }

    const discovered = await this.trust.discover()
    for (const candidate of discovered) {
      if (this.hasStalePath(candidate.path)) continue
      this.active = candidate
      try {
        const trusted = await this.revalidate(candidate)
        await validateExecutable?.(trusted.path)
        return trusted
      } catch {
        // Continue to the next independently fingerprinted candidate. The
        // failed path is marked stale by revalidate() and cannot be rebound.
        this.deactivate(candidate)
      }
    }
    throw new GitExecutableSelectionRequiredError()
  }

  async preparePicked(candidate: string): Promise<GitExecutableBinding> {
    await this.initialize()
    return this.trust.validatePickedExecutable(candidate)
  }

  async commitPicked(
    binding: GitExecutableBinding,
    validateExecutable?: (path: string) => Promise<void>
  ): Promise<TrustedGitExecutable> {
    if (binding.source !== 'picked') {
      throw new Error('Only a native-picked Git executable can be saved')
    }
    const firstPath = await this.trust.revalidateBeforeUse(binding)
    if (!samePath(firstPath, binding.path)) {
      throw new Error('Git executable trust resolved to a different path')
    }
    await validateExecutable?.(firstPath)
    const pathAfterValidation =
      await this.trust.revalidateBeforeUse(binding)
    if (!samePath(pathAfterValidation, binding.path)) {
      throw new Error('Git executable changed during validation')
    }
    await this.preferences.save({
      path: binding.path,
      fingerprint: binding.fingerprint
    })
    const resolved = await this.trust.revalidateBeforeUse(binding)
    if (!samePath(resolved, binding.path)) {
      throw new Error('Git executable changed while its preference was saved')
    }
    this.removeStalePath(binding.path)
    this.active = binding
    return Object.freeze({ binding, path: resolved })
  }

  async revalidate(
    binding: GitExecutableBinding
  ): Promise<TrustedGitExecutable> {
    if (this.active !== binding) {
      throw new Error('Git executable binding is not active')
    }
    try {
      const resolved = await this.trust.revalidateBeforeUse(binding)
      if (!samePath(resolved, binding.path)) {
        throw new Error('Git executable trust resolved to a different path')
      }
      return Object.freeze({ binding, path: resolved })
    } catch (error) {
      this.deactivate(binding)
      throw error
    }
  }

  private deactivate(binding: GitExecutableBinding): void {
    if (this.active === binding) this.active = undefined
    this.addStalePath(binding.path)
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.loadPreference()
    }
    await this.initialization
  }

  private async loadPreference(): Promise<void> {
    const result = await this.preferences.load()
    if (result.status !== 'loaded') return
    let binding: GitExecutableBinding
    try {
      binding = await this.trust.validatePickedExecutable(
        result.preference.path
      )
    } catch {
      this.addStalePath(result.preference.path)
      return
    }
    if (binding.fingerprint !== result.preference.fingerprint) {
      this.addStalePath(result.preference.path)
      return
    }
    try {
      const resolved = await this.trust.revalidateBeforeUse(binding)
      if (!samePath(resolved, binding.path)) {
        throw new Error('Git executable trust resolved to a different path')
      }
      this.active = binding
    } catch {
      this.addStalePath(result.preference.path)
    }
  }

  private pathKey(candidate: string): string {
    const normalized = path.normalize(candidate)
    return process.platform === 'win32'
      ? normalized.toLowerCase()
      : normalized
  }

  private addStalePath(candidate: string): void {
    this.stalePaths.add(this.pathKey(candidate))
  }

  private removeStalePath(candidate: string): void {
    this.stalePaths.delete(this.pathKey(candidate))
  }

  private hasStalePath(candidate: string): boolean {
    return this.stalePaths.has(this.pathKey(candidate))
  }
}
