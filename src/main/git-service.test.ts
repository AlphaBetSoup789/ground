import { execFile } from 'node:child_process'
import {
  access,
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitSupportsRequiredFeatures,
  GitServiceError,
  GitWorkspaceService,
  resolveGitExecutable,
  verifyGitExecutableVersion
} from './git-service'

const execFileAsync = promisify(execFile)
const gitExecutable = await resolveGitExecutable()
const temporaryRoots: string[] = []
const commitOptions = (message: string) => ({
  message,
  authorName: 'Ground Author',
  authorEmail: 'author@example.test'
})

it('accepts only Git versions with recoverable restore support', () => {
  expect(gitSupportsRequiredFeatures('git version 2.23.0')).toBe(true)
  expect(
    gitSupportsRequiredFeatures('git version 2.39.5 (Apple Git-154)')
  ).toBe(true)
  expect(gitSupportsRequiredFeatures('git version 2.50.1.windows.1')).toBe(
    true
  )
  expect(gitSupportsRequiredFeatures('git version 2.22.9')).toBe(false)
  expect(gitSupportsRequiredFeatures('not git 2.50.0')).toBe(false)
})

it.skipIf(!gitExecutable)(
  'probes the selected absolute executable in a pinned directory',
  async () => {
    if (!gitExecutable) throw new Error('Git is unavailable')
    const version = await verifyGitExecutableVersion(gitExecutable, {
      cwd: os.tmpdir()
    })
    expect(gitSupportsRequiredFeatures(version)).toBe(true)
    await expect(
      verifyGitExecutableVersion('git', { cwd: os.tmpdir() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }
)

interface Fixture {
  root: string
  workspace: string
  worktreeRoot: string
  service: GitWorkspaceService
}

async function git(
  cwd: string,
  args: string[],
  options: { reject?: boolean } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (!gitExecutable) throw new Error('Git is unavailable')
  try {
    const result = await execFileAsync(gitExecutable, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0'
      },
      maxBuffer: 8_000_000,
      timeout: 10_000,
      windowsHide: true
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (options.reject !== false) throw error
    const failure = error as Error & { stdout?: string; stderr?: string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function createFixture(
  options: {
    revalidateGitExecutable?: () => Promise<string>
  } = {}
): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'ground-git-service-'))
  const root = await realpath(created)
  temporaryRoots.push(root)
  const workspace = path.join(root, 'workspace')
  const worktreeRoot = path.join(root, 'ground-worktrees')
  await mkdir(workspace)
  await mkdir(worktreeRoot)
  await git(workspace, ['init', '--quiet', '--initial-branch=main'])
  await git(workspace, ['config', 'user.name', 'Ground Test'])
  await git(workspace, ['config', 'user.email', 'ground@example.test'])
  await writeFile(path.join(workspace, 'tracked.txt'), 'original\n')
  await writeFile(path.join(workspace, 'staged.txt'), 'original\n')
  await git(workspace, ['add', '--', 'tracked.txt', 'staged.txt'])
  await git(workspace, ['commit', '--quiet', '-m', 'Initial commit'])
  const service = await GitWorkspaceService.open({
    workspacePath: workspace,
    worktreeRoot,
    gitExecutable,
    ...options
  })
  return { root, workspace, worktreeRoot, service }
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()
    if (target && path.basename(target).startsWith('ground-git-service-')) {
      await rm(target, { recursive: true, force: true })
    }
  }
})

describe.skipIf(!gitExecutable)('GitWorkspaceService', () => {
  it('pins an absolute Git executable and rejects a repository subdirectory', async () => {
    const fixture = await createFixture()
    expect(path.isAbsolute(fixture.service.gitExecutable)).toBe(true)
    expect(await resolveGitExecutable('git')).toBeUndefined()

    const nested = path.join(fixture.workspace, 'nested')
    await mkdir(nested)
    await expect(
      GitWorkspaceService.open({
        workspacePath: nested,
        worktreeRoot: fixture.worktreeRoot,
        gitExecutable
      })
    ).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' })
  })

  it('revalidates a trusted Git identity before use and fails closed on drift', async () => {
    if (!gitExecutable) throw new Error('Git is unavailable')
    let currentExecutable = gitExecutable
    let validations = 0
    const fixture = await createFixture({
      revalidateGitExecutable: async () => {
        validations += 1
        return currentExecutable
      }
    })
    const validationsAfterOpen = validations

    await fixture.service.status()
    expect(validations).toBeGreaterThan(validationsAfterOpen)

    currentExecutable = path.join(fixture.root, 'replacement-git')
    await expect(fixture.service.status()).rejects.toMatchObject({
      code: 'UNSAFE_CONFIGURATION'
    })
  })

  it('summarizes branch state and staged, unstaged, and untracked paths', async () => {
    const { service, workspace } = await createFixture()
    await appendFile(path.join(workspace, 'tracked.txt'), 'worktree change\n')
    await appendFile(path.join(workspace, 'staged.txt'), 'index change\n')
    await git(workspace, ['add', '--', 'staged.txt'])
    await writeFile(path.join(workspace, 'new file.txt'), 'untracked\n')

    const status = await service.status()
    expect(status).toMatchObject({
      branch: 'main',
      detached: false,
      staged: ['staged.txt'],
      unstaged: ['tracked.txt'],
      untracked: ['new file.txt'],
      conflicted: []
    })
    expect(JSON.stringify(status)).not.toContain(workspace)
    expect(await service.identity()).toEqual({
      name: 'Ground Test',
      email: 'ground@example.test'
    })
  })

  it('reports upstream ahead/behind counts and detached HEAD state when available', async () => {
    const { root, service, workspace } = await createFixture()
    const remote = path.join(root, 'remote.git')
    await git(root, ['init', '--quiet', '--bare', remote])
    await git(workspace, ['remote', 'add', 'origin', remote])
    await git(workspace, ['push', '--quiet', '--set-upstream', 'origin', 'main'])
    await writeFile(path.join(workspace, 'ahead.txt'), 'one\n')
    await git(workspace, ['add', '--', 'ahead.txt'])
    await git(workspace, ['commit', '--quiet', '-m', 'Ahead locally'])

    expect(await service.status()).toMatchObject({
      branch: 'main',
      detached: false,
      ahead: 1,
      behind: 0
    })

    await git(workspace, ['checkout', '--quiet', '--detach'])
    expect(await service.status()).toMatchObject({
      branch: null,
      detached: true
    })
  })

  it('identifies conflicted files from porcelain v2 status', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'conflict.txt'), 'base\n')
    await git(workspace, ['add', '--', 'conflict.txt'])
    await git(workspace, ['commit', '--quiet', '-m', 'Conflict base'])
    await git(workspace, ['checkout', '--quiet', '-b', 'topic'])
    await writeFile(path.join(workspace, 'conflict.txt'), 'topic\n')
    await git(workspace, ['commit', '--quiet', '--all', '-m', 'Topic change'])
    await git(workspace, ['checkout', '--quiet', 'main'])
    await writeFile(path.join(workspace, 'conflict.txt'), 'main\n')
    await git(workspace, ['commit', '--quiet', '--all', '-m', 'Main change'])
    await git(workspace, ['merge', '--no-edit', 'topic'], { reject: false })

    const status = await service.status()
    expect(status.conflicted).toEqual(['conflict.txt'])
  })

  it('returns bounded unified working-tree and staged diffs', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'changed\n')
    const working = await service.diff({ path: 'tracked.txt' })
    expect(working.text).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(working.text).toContain('+changed')
    expect(working.truncated).toBe(false)
    expect(JSON.stringify(working)).not.toContain(workspace)

    await git(workspace, ['add', '--', 'tracked.txt'])
    const staged = await service.diff({ staged: true, path: 'tracked.txt' })
    expect(staged.text).toContain('+changed')

    await writeFile(path.join(workspace, 'tracked.txt'), 'large changed line\n'.repeat(20_000))
    const bounded = await service.diff({ path: 'tracked.txt', maxBytes: 512 })
    expect(bounded.truncated).toBe(true)
    expect(bounded.bytes).toBeLessThanOrEqual(512)
    await expect(service.diff({ path: '../outside.txt' })).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    })
  })

  it.runIf(process.platform !== 'win32')(
    'neutralizes repository-defined filters for status, diff, and worktree checkout',
    async () => {
      const { root, service, workspace } = await createFixture()
      const cleanMarker = path.join(root, 'clean-filter-ran')
      const smudgeMarker = path.join(root, 'smudge-filter-ran')
      await writeFile(path.join(workspace, '.gitattributes'), '*.txt filter=pwn\n')
      await git(workspace, ['add', '--', '.gitattributes'])
      await git(workspace, ['commit', '--quiet', '-m', 'Add attributes'])
      await git(workspace, [
        'config',
        'filter.pwn.clean',
        `/usr/bin/touch ${JSON.stringify(cleanMarker)}; /bin/cat`
      ])
      await git(workspace, [
        'config',
        'filter.pwn.smudge',
        `/usr/bin/touch ${JSON.stringify(smudgeMarker)}; /bin/cat`
      ])
      await git(workspace, ['config', 'filter.pwn.required', 'true'])
      await writeFile(path.join(workspace, 'tracked.txt'), 'changed\n')

      const status = await service.status()
      expect(status.unstaged).toContain('tracked.txt')
      expect((await service.diff({ path: 'tracked.txt' })).text).toContain('+changed')
      const worktree = await service.createWorktree({
        relativePath: 'filter-safe',
        branch: 'filter-safe'
      })
      expect(worktree.relativePath).toBe('filter-safe')
      await service.removeWorktree({ relativePath: 'filter-safe' })

      await expect(access(cleanMarker)).rejects.toThrow()
      await expect(access(smudgeMarker)).rejects.toThrow()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'stages and unstages only selected paths without running repository filters',
    async () => {
      const { root, service, workspace } = await createFixture()
      const cleanMarker = path.join(root, 'stage-filter-ran')
      await writeFile(path.join(workspace, '.gitattributes'), '*.txt filter=pwn\n')
      await git(workspace, ['add', '--', '.gitattributes'])
      await git(workspace, ['commit', '--quiet', '-m', 'Add attributes'])
      await git(workspace, [
        'config',
        'filter.pwn.clean',
        `/usr/bin/touch ${JSON.stringify(cleanMarker)}; /bin/cat`
      ])
      await git(workspace, ['config', 'filter.pwn.required', 'true'])
      await writeFile(path.join(workspace, 'tracked.txt'), 'approved\n')
      await writeFile(path.join(workspace, 'new file.txt'), 'new\n')

      const stage = await service.preparePathMutation('stage', ['tracked.txt'])
      expect(stage).toMatchObject({ kind: 'stage', paths: ['tracked.txt'] })
      let status = await service.executePreparedPathMutation(stage)
      expect(status.staged).toEqual(['tracked.txt'])
      expect(status.untracked).toEqual(['new file.txt'])
      await expect(access(cleanMarker)).rejects.toThrow()

      const unstage = await service.preparePathMutation('unstage', ['tracked.txt'])
      status = await service.executePreparedPathMutation(unstage)
      expect(status.staged).toEqual([])
      expect(status.unstaged).toEqual(['tracked.txt'])
      expect(await realpath(workspace)).toBe(workspace)
      expect(await service.diff({ path: 'tracked.txt' })).toMatchObject({
        truncated: false
      })

      await expect(service.executePreparedPathMutation(unstage)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT'
      })
    }
  )

  it('rejects escaping, repository-wide, metadata, and stale path mutations', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'changed.txt'), 'changed\n')

    await expect(
      service.preparePathMutation('stage', ['../outside.txt'])
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(
      service.preparePathMutation('stage', ['.'])
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(
      service.preparePathMutation('stage', ['.git/config'])
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })

    const prepared = await service.preparePathMutation('stage', ['changed.txt'])
    await git(workspace, ['add', '--', 'changed.txt'])
    await expect(service.executePreparedPathMutation(prepared)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
  })

  it('restores only selected working paths, quarantines untracked files, and undoes without losing staged content', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'approved index version\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    await writeFile(path.join(workspace, 'tracked.txt'), 'later working version\n')
    await writeFile(path.join(workspace, 'staged.txt'), 'unselected working edit\n')
    await writeFile(path.join(workspace, 'quarantine me.txt'), 'recoverable untracked\n')
    await writeFile(path.join(workspace, 'keep me.txt'), 'unselected untracked\n')

    const prepared = await service.preparePathRevert([
      'tracked.txt',
      'quarantine me.txt'
    ])
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(prepared).toMatchObject({
      version: 1,
      trackedPaths: ['tracked.txt'],
      untrackedPaths: ['quarantine me.txt']
    })
    expect(prepared.preview).toContain('-approved index version')
    expect(prepared.preview).toContain('+later working version')
    expect(prepared.preview).toContain(
      'Untracked files that will be moved into Ground recovery'
    )
    expect(prepared.preview).toContain('quarantine me.txt')
    expect(prepared.previewSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(prepared.actionSha256).toMatch(/^[0-9a-f]{64}$/u)

    const applied = await service.executePreparedPathRevert(prepared)
    expect(applied.recovery).toMatchObject({
      status: 'applied',
      trackedPaths: ['tracked.txt'],
      untrackedPaths: ['quarantine me.txt'],
      canUndo: true
    })
    expect(await readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe(
      'approved index version\n'
    )
    expect(await readFile(path.join(workspace, 'staged.txt'), 'utf8')).toBe(
      'unselected working edit\n'
    )
    expect(await readFile(path.join(workspace, 'keep me.txt'), 'utf8')).toBe(
      'unselected untracked\n'
    )
    await expect(
      access(path.join(workspace, 'quarantine me.txt'))
    ).rejects.toThrow()
    expect(await service.status()).toMatchObject({
      staged: ['tracked.txt'],
      unstaged: ['staged.txt'],
      untracked: ['keep me.txt']
    })

    const listed = await service.listRecoveries()
    expect(listed).toEqual([applied.recovery])
    expect(JSON.stringify(listed)).not.toContain(workspace)

    const undo = await service.prepareRecoveryUndo(applied.recovery.id)
    expect(Object.isFrozen(undo)).toBe(true)
    expect(undo.preview).toContain('tracked.txt')
    expect(undo.preview).toContain('quarantine me.txt')
    const restored = await service.executePreparedRecoveryUndo(undo)
    expect(restored).toMatchObject({
      id: applied.recovery.id,
      status: 'restored',
      canUndo: false
    })
    expect(await readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe(
      'later working version\n'
    )
    expect(
      await readFile(path.join(workspace, 'quarantine me.txt'), 'utf8')
    ).toBe('recoverable untracked\n')
    expect(await service.status()).toMatchObject({
      staged: ['tracked.txt'],
      unstaged: ['staged.txt', 'tracked.txt'],
      untracked: ['keep me.txt', 'quarantine me.txt']
    })
    await expect(
      service.executePreparedPathRevert(prepared)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      service.executePreparedRecoveryUndo(undo)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('restores a selected tracked deletion and undo returns it to the missing state without deleting the recovery copy', async () => {
    const { service, workspace, worktreeRoot } = await createFixture()
    await rm(path.join(workspace, 'tracked.txt'))

    const prepared = await service.preparePathRevert(['tracked.txt'])
    expect(prepared.preview).toContain('deleted file mode')
    const applied = await service.executePreparedPathRevert(prepared)
    expect(await readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe(
      'original\n'
    )

    const undo = await service.prepareRecoveryUndo(applied.recovery.id)
    await service.executePreparedRecoveryUndo(undo)
    await expect(access(path.join(workspace, 'tracked.txt'))).rejects.toThrow()
    const displaced = path.join(
      worktreeRoot,
      '.ground-recovery',
      applied.recovery.id,
      'undo-current-000000.bin'
    )
    expect(await readFile(displaced, 'utf8')).toBe('original\n')
  })

  it('rejects content, index, and parent swaps after a complete restore review', async () => {
    const first = await createFixture()
    await writeFile(path.join(first.workspace, 'tracked.txt'), 'reviewed change\n')
    const contentPrepared = await first.service.preparePathRevert(['tracked.txt'])
    await writeFile(path.join(first.workspace, 'tracked.txt'), 'later change\n')
    await expect(
      first.service.executePreparedPathRevert(contentPrepared)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await first.service.listRecoveries()).toEqual([])

    const second = await createFixture()
    await writeFile(path.join(second.workspace, 'tracked.txt'), 'reviewed working\n')
    const indexPrepared = await second.service.preparePathRevert(['tracked.txt'])
    await writeFile(path.join(second.workspace, 'tracked.txt'), 'new index\n')
    await git(second.workspace, ['add', '--', 'tracked.txt'])
    await writeFile(path.join(second.workspace, 'tracked.txt'), 'new working\n')
    await expect(
      second.service.executePreparedPathRevert(indexPrepared)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    if (process.platform !== 'win32') {
      const third = await createFixture()
      const nested = path.join(third.workspace, 'nested')
      const parked = path.join(third.workspace, 'nested-parked')
      const outside = path.join(third.root, 'outside')
      await mkdir(nested)
      await mkdir(outside)
      await writeFile(path.join(nested, 'safe.txt'), 'base\n')
      await git(third.workspace, ['add', '--', 'nested/safe.txt'])
      await git(third.workspace, ['commit', '--quiet', '-m', 'Nested base'])
      await writeFile(path.join(nested, 'safe.txt'), 'reviewed\n')
      const parentPrepared = await third.service.preparePathRevert([
        'nested/safe.txt'
      ])
      await rename(nested, parked)
      await writeFile(path.join(outside, 'safe.txt'), 'outside must stay\n')
      await symlink(outside, nested)

      await expect(
        third.service.executePreparedPathRevert(parentPrepared)
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
      expect(await readFile(path.join(outside, 'safe.txt'), 'utf8')).toBe(
        'outside must stay\n'
      )
    }
  })

  it.runIf(process.platform !== 'win32')(
    'rejects final symlinks and conflicted paths instead of restoring ambiguous filesystem objects',
    async () => {
      const { root, service, workspace } = await createFixture()
      const outside = path.join(root, 'outside.txt')
      await writeFile(outside, 'outside\n')
      await symlink(outside, path.join(workspace, 'linked.txt'))
      await expect(
        service.preparePathRevert(['linked.txt'])
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })

      await writeFile(path.join(workspace, 'conflict.txt'), 'base\n')
      await git(workspace, ['add', '--', 'conflict.txt'])
      await git(workspace, ['commit', '--quiet', '-m', 'Conflict base'])
      await git(workspace, ['checkout', '--quiet', '-b', 'restore-topic'])
      await writeFile(path.join(workspace, 'conflict.txt'), 'topic\n')
      await git(workspace, ['commit', '--quiet', '--all', '-m', 'Topic'])
      await git(workspace, ['checkout', '--quiet', 'main'])
      await writeFile(path.join(workspace, 'conflict.txt'), 'main\n')
      await git(workspace, ['commit', '--quiet', '--all', '-m', 'Main'])
      await git(workspace, ['merge', '--no-edit', 'restore-topic'], {
        reject: false
      })

      await expect(
        service.preparePathRevert(['conflict.txt'])
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

      const recoveryFixture = await createFixture()
      await writeFile(
        path.join(recoveryFixture.workspace, 'tracked.txt'),
        'reviewed change\n'
      )
      const recoveryPrepared =
        await recoveryFixture.service.preparePathRevert(['tracked.txt'])
      const redirectedRecovery = path.join(
        recoveryFixture.root,
        'redirected-recovery'
      )
      await mkdir(redirectedRecovery)
      await writeFile(
        path.join(redirectedRecovery, 'sentinel.txt'),
        'must remain untouched\n'
      )
      await symlink(
        redirectedRecovery,
        path.join(
          recoveryFixture.worktreeRoot,
          '.ground-recovery'
        )
      )
      await expect(
        recoveryFixture.service.executePreparedPathRevert(
          recoveryPrepared
        )
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
      expect(
        await readFile(
          path.join(redirectedRecovery, 'sentinel.txt'),
          'utf8'
        )
      ).toBe('must remain untouched\n')
      expect(
        await readFile(
          path.join(recoveryFixture.workspace, 'tracked.txt'),
          'utf8'
        )
      ).toBe('reviewed change\n')
    }
  )

  it('refuses undo when a path changed or reappeared and preserves the completed recovery', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'working change\n')
    await writeFile(path.join(workspace, 'recover.txt'), 'untracked before\n')
    const applied = await service.executePreparedPathRevert(
      await service.preparePathRevert(['tracked.txt', 'recover.txt'])
    )

    await writeFile(path.join(workspace, 'recover.txt'), 'new occupant\n')
    await expect(
      service.prepareRecoveryUndo(applied.recovery.id)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await readFile(path.join(workspace, 'recover.txt'), 'utf8')).toBe(
      'new occupant\n'
    )
    expect(await service.listRecoveries()).toMatchObject([
      {
        id: applied.recovery.id,
        status: 'applied',
        canUndo: true
      }
    ])
  })

  it('treats recovery manifests as untrusted and refuses traversal after tampering', async () => {
    const { service, workspace, worktreeRoot } = await createFixture()
    await writeFile(path.join(workspace, 'recover.txt'), 'untracked\n')
    const applied = await service.executePreparedPathRevert(
      await service.preparePathRevert(['recover.txt'])
    )
    const manifestPath = path.join(
      worktreeRoot,
      '.ground-recovery',
      applied.recovery.id,
      'manifest.json'
    )
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as {
      untracked: Array<{ relativePath: string; before: { relativePath: string } }>
    }
    const first = manifest.untracked[0]
    if (!first) throw new Error('Expected an untracked recovery entry')
    first.relativePath = '../outside.txt'
    first.before.relativePath = '../outside.txt'
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)

    expect(await service.listRecoveries()).toEqual([])
    await expect(
      service.prepareRecoveryUndo(applied.recovery.id)
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(access(path.join(workspace, '..', 'outside.txt'))).rejects.toThrow()
  })

  it('fails closed when the complete selected restore preview exceeds its bound', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(
      path.join(workspace, 'tracked.txt'),
      `${'changed'.repeat(650_000)}\n`
    )

    await expect(
      service.preparePathRevert(['tracked.txt'])
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
    expect(await readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toContain(
      'changed'
    )
    expect(await service.listRecoveries()).toEqual([])
  })

  it.runIf(process.platform !== 'win32')(
    'commits the exact prepared index while preserving concurrent index and working-tree edits',
    async () => {
      const { root, service, workspace } = await createFixture()
      const hookMarker = path.join(root, 'commit-hook-ran')
      const hooks = path.join(workspace, '.git', 'hooks')
      await writeFile(
        path.join(hooks, 'reference-transaction'),
        `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(hookMarker)}\n`
      )
      await chmod(path.join(hooks, 'reference-transaction'), 0o700)
      await git(workspace, ['config', 'core.hooksPath', hooks])
      await git(workspace, ['config', 'commit.gpgSign', 'true'])

      await writeFile(path.join(workspace, 'tracked.txt'), 'approved staged content\n')
      const stage = await service.preparePathMutation('stage', ['tracked.txt'])
      await service.executePreparedPathMutation(stage)
      const prepared = await service.prepareCommit(
        commitOptions('Commit approved tree')
      )

      expect(prepared).toMatchObject({
        version: 1,
        symbolicRef: 'refs/heads/main',
        branch: 'main',
        detached: false,
        message: 'Commit approved tree',
        authorName: 'Ground Author',
        authorEmail: 'author@example.test'
      })
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(Object.isFrozen(prepared.stagedPaths)).toBe(true)
      expect(prepared.preview).toContain(
        'Exact approved ref: "refs/heads/main"'
      )
      expect(prepared.preview).toContain(
        `Repository identity SHA-256: ${prepared.repositoryIdentitySha256}`
      )
      expect(prepared.preview).toContain(
        `Worktree identity SHA-256: ${prepared.worktreeIdentitySha256}`
      )
      expect(prepared.previewSha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(prepared.actionSha256).toMatch(/^[0-9a-f]{64}$/u)

      await writeFile(path.join(workspace, 'tracked.txt'), 'later working edit\n')
      await writeFile(path.join(workspace, 'later.txt'), 'later staged edit\n')
      await git(workspace, ['add', '--', 'later.txt'])

      const committed = await service.executePreparedCommit(
        prepared,
        commitOptions('Commit approved tree')
      )
      expect(committed.subject).toBe('Commit approved tree')
      expect(committed.authorName).toBe('Ground Author')
      expect(
        (await git(workspace, ['show', 'HEAD:tracked.txt'])).stdout
      ).toBe('approved staged content\n')
      const absentFromCommit = await git(
        workspace,
        ['cat-file', '-e', 'HEAD:later.txt'],
        { reject: false }
      )
      expect(absentFromCommit.stderr).toMatch(/(?:does not exist|not in)/u)
      expect(await readFile(path.join(workspace, 'tracked.txt'), 'utf8')).toBe(
        'later working edit\n'
      )
      expect(await service.status()).toMatchObject({
        staged: ['later.txt'],
        unstaged: ['tracked.txt']
      })
      await expect(access(hookMarker)).rejects.toThrow()
      await expect(
        service.executePreparedCommit(
          prepared,
          commitOptions('Cannot reuse')
        )
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  )

  it('refuses to move HEAD when it changes after commit confirmation', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'prepared\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    const prepared = await service.prepareCommit(
      commitOptions('Stale approval')
    )

    await writeFile(path.join(workspace, 'other.txt'), 'external\n')
    await git(workspace, ['add', '--', 'other.txt'])
    await git(workspace, ['commit', '--quiet', '-m', 'External commit'])
    const externalHead = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()

    await expect(
      service.executePreparedCommit(
        prepared,
        commitOptions('Stale approval')
      )
    ).rejects.toMatchObject({ code: 'UNSAFE_CONFIGURATION' })
    expect((await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      externalHead
    )
  })

  it('does not commit a same-OID checkout race onto a different branch', async () => {
    const { service, workspace } = await createFixture()
    const originalHead = (
      await git(workspace, ['rev-parse', 'HEAD'])
    ).stdout.trim()
    await writeFile(path.join(workspace, 'tracked.txt'), 'prepared\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    const prepared = await service.prepareCommit(
      commitOptions('Bound to main')
    )

    await git(workspace, ['checkout', '--quiet', '-b', 'other'])
    expect((await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      originalHead
    )

    await expect(
      service.executePreparedCommit(
        prepared,
        commitOptions('Bound to main')
      )
    ).rejects.toMatchObject({ code: 'UNSAFE_CONFIGURATION' })
    expect(
      (await git(workspace, ['rev-parse', 'refs/heads/main'])).stdout.trim()
    ).toBe(originalHead)
    expect(
      (await git(workspace, ['rev-parse', 'refs/heads/other'])).stdout.trim()
    ).toBe(originalHead)
  })

  it('refuses to prepare a commit while HEAD is detached', async () => {
    const { service, workspace } = await createFixture()
    const originalHead = (
      await git(workspace, ['rev-parse', 'HEAD'])
    ).stdout.trim()
    await git(workspace, ['checkout', '--quiet', '--detach'])
    await writeFile(path.join(workspace, 'tracked.txt'), 'prepared detached\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    await expect(
      service.prepareCommit(commitOptions('Detached approval'))
    ).rejects.toMatchObject({ code: 'UNSAFE_CONFIGURATION' })
    expect((await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      originalHead
    )
  })

  it('rejects replacement repository metadata with the same approved ref and index', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'prepared\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    const prepared = await service.prepareCommit(
      commitOptions('Bound repository')
    )
    const originalMetadata = path.join(workspace, '.git-approved')
    await rename(path.join(workspace, '.git'), originalMetadata)
    await cp(originalMetadata, path.join(workspace, '.git'), {
      recursive: true
    })

    await expect(
      service.executePreparedCommit(
        prepared,
        commitOptions('Bound repository')
      )
    ).rejects.toMatchObject({ code: 'UNSAFE_CONFIGURATION' })
  })

  it('rejects replacement of the approved worktree directory identity', async () => {
    const { root, service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'tracked.txt'), 'prepared\n')
    await git(workspace, ['add', '--', 'tracked.txt'])
    const prepared = await service.prepareCommit(
      commitOptions('Bound worktree')
    )
    const displacedWorkspace = path.join(root, 'workspace-approved')
    await rename(workspace, displacedWorkspace)
    await mkdir(workspace)
    await rename(
      path.join(displacedWorkspace, '.git'),
      path.join(workspace, '.git')
    )

    await expect(
      service.executePreparedCommit(
        prepared,
        commitOptions('Bound worktree')
      )
    ).rejects.toMatchObject({ code: 'UNSAFE_CONFIGURATION' })
  })

  it('creates an exact initial commit on an unborn branch', async () => {
    const { service, workspace } = await createFixture()
    await git(workspace, ['update-ref', '-d', 'refs/heads/main'])
    const prepared = await service.prepareCommit(
      commitOptions('Initial prepared commit')
    )
    expect(prepared.expectedHeadOid).toBeNull()
    expect(prepared.branch).toBe('main')

    const committed = await service.executePreparedCommit(
      prepared,
      commitOptions('Initial prepared commit')
    )
    expect(committed.subject).toBe('Initial prepared commit')
    expect(committed.parents).toEqual([])
    expect((await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      committed.hash
    )
  })

  it('parses commit log entries without exposing host paths', async () => {
    const { service, workspace } = await createFixture()
    await writeFile(path.join(workspace, 'feature.txt'), 'feature\n')
    await git(workspace, ['add', '--', 'feature.txt'])
    await git(workspace, [
      'commit',
      '--quiet',
      '-m',
      'Feature subject',
      '-m',
      'Body line one\nBody line two'
    ])

    const result = await service.log({ limit: 1 })
    expect(result.truncated).toBe(false)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      authorName: 'Ground Test',
      authorEmail: 'ground@example.test',
      subject: 'Feature subject',
      body: 'Body line one\nBody line two'
    })
    expect(result.entries[0]?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(result.entries[0]?.parents).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(workspace)
  })

  it('creates, lists, and removes only registered Ground worktrees', async () => {
    const { service, workspace, worktreeRoot } = await createFixture()
    const created = await service.createWorktree({
      relativePath: 'feature-one',
      branch: 'feature/one'
    })
    expect(created).toMatchObject({
      relativePath: 'feature-one',
      isMain: false,
      branch: 'feature/one',
      detached: false
    })

    const listed = await service.listWorktrees()
    expect(listed.map((worktree) => worktree.relativePath)).toEqual([
      '.',
      'feature-one'
    ])
    expect(JSON.stringify(listed)).not.toContain(workspace)
    expect(JSON.stringify(listed)).not.toContain(worktreeRoot)

    const managedPath = path.join(worktreeRoot, 'feature-one')
    await writeFile(path.join(managedPath, 'uncommitted.txt'), 'keep me\n')
    await expect(
      service.removeWorktree({ relativePath: 'feature-one' })
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' })
    await expect(access(path.join(managedPath, 'uncommitted.txt'))).resolves.toBeUndefined()

    const unmanagedPath = path.join(worktreeRoot, 'not-registered')
    await mkdir(unmanagedPath)
    await writeFile(path.join(unmanagedPath, 'important.txt'), 'do not delete\n')
    await expect(
      service.removeWorktree({ relativePath: 'not-registered', force: true })
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(access(path.join(unmanagedPath, 'important.txt'))).resolves.toBeUndefined()

    const removed = await service.removeWorktree({
      relativePath: 'feature-one',
      force: true
    })
    expect(removed.relativePath).toBe('feature-one')
    await expect(access(managedPath)).rejects.toThrow()
    expect((await service.listWorktrees()).map((worktree) => worktree.relativePath)).toEqual([
      '.'
    ])
  })

  it('filters externally registered worktrees and rejects escaping locations', async () => {
    const { root, service, workspace } = await createFixture()
    const external = path.join(root, 'external-worktree')
    await git(workspace, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      'external-branch',
      '--',
      external,
      'HEAD'
    ])

    expect((await service.listWorktrees()).map((worktree) => worktree.relativePath)).toEqual([
      '.'
    ])
    await expect(
      service.createWorktree({ relativePath: '../escape', branch: 'escape' })
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(
      service.removeWorktree({ relativePath: '../external-worktree', force: true })
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(access(external)).resolves.toBeUndefined()
  })

  it('supports an existing branch without accepting ambiguous start points', async () => {
    const { service, workspace } = await createFixture()
    await git(workspace, ['branch', 'existing'])
    const created = await service.createWorktree({
      relativePath: 'existing',
      branch: 'existing',
      createBranch: false
    })
    expect(created.branch).toBe('existing')

    await expect(
      service.createWorktree({
        relativePath: 'invalid',
        branch: 'another',
        createBranch: false,
        startPoint: 'HEAD'
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      service.createWorktree({
        relativePath: 'invalid',
        branch: '--upload-pack=evil'
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('honors an already-aborted operation signal', async () => {
    const { service } = await createFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(service.status({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('requires the Ground worktree root to remain outside the workspace', async () => {
    const { workspace } = await createFixture()
    const unsafeRoot = path.join(workspace, 'worktrees')
    await mkdir(unsafeRoot)
    await expect(
      GitWorkspaceService.open({
        workspacePath: workspace,
        worktreeRoot: unsafeRoot,
        gitExecutable
      })
    ).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    } satisfies Partial<GitServiceError>)
  })
})
