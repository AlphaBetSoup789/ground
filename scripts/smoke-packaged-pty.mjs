import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const RELEASE_DIRECTORY = path.resolve('release')
const SUCCESS_MARKER = 'ground-packaged-pty-ok'

if (process.platform !== 'darwin') {
  throw new Error('The packaged PTY smoke test currently supports macOS only')
}

const candidates = []
for (const entry of await readdir(RELEASE_DIRECTORY, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue
  const candidate = path.join(RELEASE_DIRECTORY, entry.name, 'Ground.app')
  try {
    await access(candidate)
    candidates.push(candidate)
  } catch {
    // Ignore release directories that do not contain the unpacked app.
  }
}

if (candidates.length !== 1) {
  throw new Error(
    `Expected exactly one packaged Ground.app beneath ${RELEASE_DIRECTORY}; found ${candidates.length}`
  )
}

const appPath = candidates[0]
const executable = path.join(appPath, 'Contents', 'MacOS', 'Ground')
const resourcesPath = path.join(appPath, 'Contents', 'Resources')
await Promise.all([
  access(path.join(resourcesPath, 'LICENSE')),
  access(path.join(resourcesPath, 'THIRD_PARTY_NOTICES.md')),
  access(path.join(resourcesPath, 'LICENSE.electron.txt')),
  access(path.join(resourcesPath, 'LICENSES.chromium.html'))
])
const modulePath = path.join(
  resourcesPath,
  'app.asar',
  'node_modules',
  'node-pty'
)

const smokeProgram = [
  "const pty = require(process.argv[1]);",
  'const child = pty.spawn("/bin/sh", ["-lc", "printf ground-packaged-pty-ok"], {',
  '  cwd: "/tmp",',
  '  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },',
  '  cols: 80,',
  '  rows: 24',
  '});',
  'child.onData((data) => process.stdout.write(data));',
  'child.onExit(({ exitCode }) => process.exit(exitCode));'
].join('\n')

const result = spawnSync(executable, ['-e', smokeProgram, modulePath], {
  encoding: 'utf8',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  },
  timeout: 15_000
})

if (result.error) throw result.error
if (result.status !== 0 || !result.stdout.includes(SUCCESS_MARKER)) {
  throw new Error(
    [
      `Packaged PTY smoke failed with status ${String(result.status)}.`,
      result.stdout.trim(),
      result.stderr.trim()
    ]
      .filter(Boolean)
      .join('\n')
  )
}

process.stdout.write(`${SUCCESS_MARKER}\n`)
