import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifySensitiveWorkspacePath,
  executePreparedCommandAction,
  executePreparedWriteAction,
  executeTool,
  loadWorkspaceInstructions,
  normalizeToolInput,
  prepareCommandAction,
  prepareEditAction,
  prepareWriteAction,
  previewTool
} from './tools'

describe('workspace tools', () => {
  it('rejects malformed tool arguments', () => {
    expect(() => normalizeToolInput('read_file', '{"path":42}')).toThrow()
    expect(() => normalizeToolInput('unknown', '{}')).toThrow('Unsupported tool')
  })

  it('prevents path traversal outside the workspace', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const workspace = path.join(parent, 'workspace')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace))
    await writeFile(path.join(parent, 'secret.txt'), 'secret')

    await expect(
      executeTool(
        'read_file',
        { path: '../secret.txt' },
        workspace,
        new AbortController().signal
      )
    ).rejects.toThrow(/workspace|relative/i)
  })

  it('loads bounded root project guidance without following workspace escapes', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const workspace = path.join(parent, 'workspace')
    const outside = path.join(parent, 'outside')
    await mkdir(path.join(workspace, '.github'), { recursive: true })
    await mkdir(outside)
    await writeFile(path.join(workspace, 'AGENTS.md'), 'Use exact tests.\n')
    await writeFile(path.join(workspace, 'CLAUDE.md'), 'Keep changes small.\n')
    await writeFile(
      path.join(workspace, '.github', 'copilot-instructions.md'),
      'Prefer TypeScript.\n'
    )
    await writeFile(path.join(outside, 'AGENTS.md'), 'outside-secret\n')

    const instructions = await loadWorkspaceInstructions(workspace)

    expect(instructions).toContain('WORKSPACE INSTRUCTIONS: AGENTS.md')
    expect(instructions).toContain('Use exact tests.')
    expect(instructions).toContain('Keep changes small.')
    expect(instructions).toContain('Prefer TypeScript.')
    expect(instructions).not.toContain('outside-secret')
  })

  it('loads a bounded prefix of an oversized repository instruction file', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    await writeFile(
      path.join(workspace, 'AGENTS.md'),
      `Keep the leading rule.\n${'x'.repeat(100_000)}`
    )

    const instructions = await loadWorkspaceInstructions(workspace)

    expect(instructions).toContain('Keep the leading rule.')
    expect(instructions).toContain(
      '[Ground truncated this instruction file.]'
    )
    expect(instructions.length).toBeLessThan(70_000)
  })

  it.runIf(process.platform !== 'win32')(
    'ignores instruction paths whose parent resolves outside the workspace',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
      const workspace = path.join(parent, 'workspace')
      const outside = path.join(parent, 'outside')
      await mkdir(workspace)
      await mkdir(outside)
      await writeFile(
        path.join(outside, 'copilot-instructions.md'),
        'do not expose this'
      )
      await symlink(outside, path.join(workspace, '.github'))

      await expect(loadWorkspaceInstructions(workspace)).resolves.toBe('')
    }
  )

  it('writes and reads a nested workspace file', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    await executeTool(
      'write_file',
      { path: 'src/hello.txt', content: 'hello\nworld\n' },
      workspace,
      new AbortController().signal
    )
    expect(await readFile(path.join(workspace, 'src/hello.txt'), 'utf8')).toBe('hello\nworld\n')
    const result = await executeTool(
      'read_file',
      { path: 'src/hello.txt', start_line: 2 },
      workspace,
      new AbortController().signal
    )
    expect(result).toContain('world')
  })

  it('refuses writes through a symlink that leaves the workspace', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const workspace = path.join(parent, 'workspace')
    const outside = path.join(parent, 'outside.txt')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace))
    await writeFile(outside, 'keep me')
    await symlink(outside, path.join(workspace, 'linked.txt'))

    await expect(
      executeTool(
        'write_file',
        { path: 'linked.txt', content: 'replace me' },
        workspace,
        new AbortController().signal
      )
    ).rejects.toThrow(/outside|workspace/i)
    expect(await readFile(outside, 'utf8')).toBe('keep me')
  })

  it('classifies common secret-bearing workspace paths while allowing env examples', () => {
    const sensitive = [
      '.env',
      '.env.local',
      'config/credentials.json',
      '.npmrc',
      '.pypirc',
      '.netrc',
      '.envrc',
      '.git/config',
      '.git/hooks/pre-commit',
      '.hg/hgrc',
      '.svn/wc.db',
      '.direnv/allow',
      '.ssh/config',
      '.aws/credentials',
      '.config/gcloud/application_default_credentials.json',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      'production.tfvars',
      'certificates/client.pem',
      'id_ed25519',
      'api_key.json',
      'client_secret_web.json',
      'secrets/token.txt'
    ]
    for (const candidate of sensitive) {
      expect(classifySensitiveWorkspacePath(candidate), candidate).toMatchObject({
        sensitive: true
      })
    }
    for (const candidate of [
      '.env.example',
      '.env.test.sample',
      'examples/.env.template',
      'src/config.ts',
      'README.md'
    ]) {
      expect(classifySensitiveWorkspacePath(candidate), candidate).toEqual({
        sensitive: false
      })
    }
  })

  it('denies direct reads and searches of sensitive paths', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const sensitive = [
      '.env',
      '.git/config',
      'config/credentials.json',
      '.npmrc',
      '.ssh/config',
      '.aws/credentials',
      'terraform.tfstate',
      'client.pem'
    ]
    for (const relative of sensitive) {
      const target = path.join(workspace, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, 'sensitive-needle')
      await expect(
        executeTool(
          'read_file',
          { path: relative },
          workspace,
          new AbortController().signal
        )
      ).rejects.toThrow(/sensitive/i)
      await expect(
        executeTool(
          'search_files',
          { path: relative, query: 'sensitive-needle' },
          workspace,
          new AbortController().signal
        )
      ).rejects.toThrow(/sensitive/i)
    }

    await writeFile(path.join(workspace, '.env.example'), 'example-needle')
    const example = await executeTool(
      'read_file',
      { path: '.env.example' },
      workspace,
      new AbortController().signal
    )
    expect(example).toContain('example-needle')
  })

  it('refuses sensitive write targets before reading or previewing their contents', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const secret = 'must-not-appear-in-an-approval-preview'
    await writeFile(path.join(workspace, '.env'), secret)
    await mkdir(path.join(workspace, '.git'))
    await writeFile(path.join(workspace, '.git', 'config'), secret)

    for (const relative of ['.env', '.git/config']) {
      let failure: unknown
      try {
        await prepareWriteAction(
          { path: relative, content: 'replacement' },
          workspace
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toMatch(/sensitive/i)
      expect(String(failure)).not.toContain(secret)
    }

    await symlink(path.join(workspace, '.git'), path.join(workspace, 'metadata'))
    let aliasFailure: unknown
    try {
      await prepareWriteAction(
        { path: 'metadata/config', content: 'replacement' },
        workspace
      )
    } catch (error) {
      aliasFailure = error
    }
    expect(aliasFailure).toBeInstanceOf(Error)
    expect(String(aliasFailure)).toMatch(/sensitive/i)
    expect(String(aliasFailure)).not.toContain(secret)
  })

  it('uses bounded in-process search, skips secrets, and returns only workspace-relative paths', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const marker = path.join(workspace, 'workspace-rg-was-executed')
    const maliciousBin = path.join(workspace, 'bin')
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await mkdir(maliciousBin)
    await writeFile(path.join(workspace, 'src/public.txt'), 'shared-needle\n')
    await writeFile(path.join(workspace, '.env'), 'shared-needle\n')
    await writeFile(path.join(workspace, 'credentials.json'), 'shared-needle\n')
    const maliciousRg = path.join(maliciousBin, 'rg')
    await writeFile(
      maliciousRg,
      `#!/bin/sh\nprintf pwned > "${marker}"\nexit 99\n`
    )
    if (process.platform !== 'win32') await chmod(maliciousRg, 0o755)

    const previousPath = process.env.PATH
    process.env.PATH = `${maliciousBin}${path.delimiter}${previousPath ?? ''}`
    try {
      const result = await executeTool(
        'search_files',
        { query: 'shared-needle' },
        workspace,
        new AbortController().signal
      )
      expect(result).toContain('src/public.txt:1:1:shared-needle')
      expect(result).not.toContain('.env')
      expect(result).not.toContain('credentials.json')
      expect(result).not.toContain(workspace)
      await expect(access(marker)).rejects.toThrow()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('prepares an immutable write envelope and atomically applies it', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    await writeFile(path.join(workspace, 'note.txt'), 'before\n')
    const action = await prepareWriteAction(
      { path: 'note.txt', content: 'after\n' },
      workspace
    )

    expect(Object.isFrozen(action)).toBe(true)
    expect(action).toMatchObject({
      version: 1,
      relativePath: 'note.txt',
      existed: true,
      previewStatus: 'complete'
    })
    expect(action.canonicalTarget).toBe(path.join(await realpath(workspace), 'note.txt'))
    expect(action.baseSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(action.newContentSha256).toMatch(/^[a-f0-9]{64}$/)

    await executePreparedWriteAction(action)
    expect(await readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe('after\n')
  })

  it('prepares and applies a localized exact-text edit from one file snapshot', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'alpha\nkeep this\nomega\n')

    const action = await prepareEditAction(
      {
        path: 'note.txt',
        old_text: 'alpha\nkeep this\n',
        new_text: 'beta\nkeep this\n'
      },
      workspace
    )

    expect(Object.isFrozen(action)).toBe(true)
    expect(action.preview).toContain('-alpha')
    expect(action.preview).toContain('+beta')
    await executePreparedWriteAction(action)
    expect(await readFile(target, 'utf8')).toBe('beta\nkeep this\nomega\n')
  })

  it('requires unique edit context unless replace_all is explicit', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'same\nmiddle\nsame\n')

    await expect(
      prepareEditAction(
        { path: 'note.txt', old_text: 'same', new_text: 'changed' },
        workspace
      )
    ).rejects.toThrow(/occurs 2 times/i)

    const action = await prepareEditAction(
      {
        path: 'note.txt',
        old_text: 'same',
        new_text: 'changed',
        replace_all: true
      },
      workspace
    )
    await executePreparedWriteAction(action)
    expect(await readFile(target, 'utf8')).toBe('changed\nmiddle\nchanged\n')
  })

  it('does not apply an approved localized edit over a concurrent file change', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'approved base\n')
    const action = await prepareEditAction(
      {
        path: 'note.txt',
        old_text: 'approved',
        new_text: 'edited'
      },
      workspace
    )
    await writeFile(target, 'concurrent user change\n')

    await expect(executePreparedWriteAction(action)).rejects.toThrow(
      /changed since approval/i
    )
    expect(await readFile(target, 'utf8')).toBe('concurrent user change\n')
  })

  it('rejects a prepared write when the file changes after approval preparation', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'approved base\n')
    const action = await prepareWriteAction(
      { path: 'note.txt', content: 'model replacement\n' },
      workspace
    )
    await writeFile(target, 'user changed this concurrently\n')

    await expect(executePreparedWriteAction(action)).rejects.toThrow(
      /changed since approval/i
    )
    expect(await readFile(target, 'utf8')).toBe('user changed this concurrently\n')
  })

  it('rejects a prepared write when a missing parent is swapped for an escaping symlink', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const workspace = path.join(parent, 'workspace')
    const outside = path.join(parent, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    const action = await prepareWriteAction(
      { path: 'nested/note.txt', content: 'must stay inside\n' },
      workspace
    )
    await symlink(outside, path.join(workspace, 'nested'))

    await expect(executePreparedWriteAction(action)).rejects.toThrow(
      /outside|workspace|target changed/i
    )
    await expect(access(path.join(outside, 'note.txt'))).rejects.toThrow()
  })

  it('marks oversized write previews as truncated and refuses compatibility approval', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const content = 'a long replacement line\n'.repeat(4_000)
    const action = await prepareWriteAction({ path: 'large.txt', content }, workspace)
    expect(action.previewStatus).toBe('truncated')
    expect(action.preview).toContain('preview truncated')
    await expect(
      previewTool('write_file', { path: 'large.txt', content }, workspace)
    ).rejects.toThrow(/complete approval preview/i)
  })

  it('keeps written UTF-8 content within the same byte limit used for later edits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const multibyte = '😀'.repeat(600_000)

    await expect(
      prepareWriteAction(
        { path: 'too-large.txt', content: multibyte },
        workspace
      )
    ).rejects.toThrow(/MB write limit/i)
  })

  it('prepares a resolved immutable command envelope and executes it', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const action = await prepareCommandAction(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('prepared-command-ok')"],
        timeout_ms: 5_000
      },
      workspace
    )

    expect(Object.isFrozen(action)).toBe(true)
    expect(Object.isFrozen(action.args)).toBe(true)
    expect(Object.isFrozen(action.launch)).toBe(true)
    expect(Object.isFrozen(action.launch.executable)).toBe(true)
    expect(action).toMatchObject({
      version: 1,
      workspaceRoot: await realpath(workspace),
      cwd: await realpath(workspace),
      relativeCwd: '.',
      executable: await realpath(process.execPath),
      previewStatus: 'complete'
    })
    expect(action.executableSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(action.launch.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(action.preview).toContain(`Executable: ${await realpath(process.execPath)}`)

    await expect(
      executePreparedCommandAction(action, new AbortController().signal)
    ).resolves.toBe('prepared-command-ok')
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a prepared command when its executable changes after approval',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
      const executable = path.join(workspace, 'approved-command')
      const marker = path.join(workspace, 'unexpected-run')
      await writeFile(executable, '#!/bin/sh\nprintf original\n')
      await chmod(executable, 0o755)
      const action = await prepareCommandAction(
        { command: './approved-command' },
        workspace
      )

      await writeFile(
        executable,
        `#!/bin/sh\nprintf changed > ${JSON.stringify(marker)}\n`
      )
      await chmod(executable, 0o755)

      await expect(
        executePreparedCommandAction(action, new AbortController().signal)
      ).rejects.toThrow(/changed since approval/i)
      await expect(access(marker)).rejects.toThrow()
    }
  )

  it('times out commands and escalates beyond SIGTERM', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ground-tools-'))
    const startedAt = Date.now()
    await expect(
      executeTool(
        'run_command',
        {
          command: process.execPath,
          args: [
            '-e',
            "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"
          ],
          timeout_ms: 1_000
        },
        workspace,
        new AbortController().signal
      )
    ).rejects.toThrow(/timed out/i)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(4_000)
    if (process.platform !== 'win32') expect(elapsed).toBeGreaterThanOrEqual(1_350)
  })
})
