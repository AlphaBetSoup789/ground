import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  assertPackagedRuntimeFiles,
  locatePackagedApp
} from './lib/packaged-app.mjs'

const scope = process.argv[2] ?? 'launch'
if (scope !== 'launch' && scope !== 'native') {
  throw new Error('Packaged runtime smoke scope must be "launch" or "native"')
}

const unexpectedControlKey = Object.keys(process.env).find((key) =>
  key.startsWith('GROUND_PACKAGED_SMOKE_')
)
if (unexpectedControlKey) {
  throw new Error(
    `Refusing inherited packaged-smoke control variable: ${unexpectedControlKey}`
  )
}

const packagedApp = await locatePackagedApp()
await assertPackagedRuntimeFiles(packagedApp)

const token = randomBytes(16).toString('hex')
const smokeDirectory = path.join(
  path.resolve(os.tmpdir()),
  `ground-packaged-smoke-${token}`
)
const resultPath = path.join(smokeDirectory, 'result.json')
await mkdir(smokeDirectory, { recursive: false, mode: 0o700 })

const appArguments = [
  `--ground-packaged-smoke=${token}:${scope}`,
  '--disable-gpu'
]
let executable = packagedApp.executable
let argumentsList = appArguments

if (process.platform === 'linux') {
  const xvfbRun = '/usr/bin/xvfb-run'
  await access(xvfbRun)
  executable = xvfbRun
  argumentsList = [
    '-a',
    '--server-args=-screen 0 1280x960x24',
    packagedApp.executable,
    ...appArguments
  ]
}

const outputChunks = []
let outputBytes = 0
const capture = (chunk) => {
  if (outputBytes >= 256_000) return
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const accepted = buffer.subarray(0, 256_000 - outputBytes)
  outputChunks.push(accepted)
  outputBytes += accepted.byteLength
}

const blockedLaunchEnvironment = new Set([
  'BASH_ENV',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'RUBYOPT'
])
const launchEnvironment = { ...process.env }
for (const key of Object.keys(launchEnvironment)) {
  if (blockedLaunchEnvironment.has(key.toUpperCase())) {
    delete launchEnvironment[key]
  }
}
if (process.platform === 'win32') {
  launchEnvironment.SystemRoot = 'C:\\Windows'
  launchEnvironment.WINDIR = 'C:\\Windows'
  launchEnvironment.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
}
launchEnvironment.GROUND_PACKAGED_SMOKE_DIRECTORY = smokeDirectory

function stopProcessTree(child) {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already be gone.
      }
      return
    }
  }
  spawnSync(
    'C:\\Windows\\System32\\taskkill.exe',
    ['/PID', String(child.pid), '/T', '/F'],
    {
      env: {
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows'
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000
    }
  )
}

let child
try {
  const completion = new Promise((resolve, reject) => {
    child = spawn(executable, argumentsList, {
      cwd: smokeDirectory,
      detached: process.platform !== 'win32',
      env: launchEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  let timer
  const outcome = await Promise.race([
    completion,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (child) stopProcessTree(child)
        reject(new Error('Packaged runtime smoke timed out after 75000ms'))
      }, 75_000)
    })
  ]).finally(() => clearTimeout(timer))

  let result
  try {
    result = JSON.parse(await readFile(resultPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Packaged app did not produce a valid smoke result (exit ${String(
        outcome.code
      )}, signal ${String(outcome.signal)}): ${Buffer.concat(outputChunks)
        .toString('utf8')
        .trim()}`,
      { cause: error }
    )
  }

  const requiredChecks =
    scope === 'native'
      ? [
          'main',
          'preload',
          'rendererDocument',
          'pty',
          'git',
          'mcp',
          'processTreeCancellation'
        ]
      : ['main', 'preload', 'rendererDocument']
  if (
    outcome.code !== 0 ||
    result.version !== 1 ||
    result.status !== 'passed' ||
    result.token !== token ||
    result.scope !== scope ||
    result.platform !== process.platform ||
    requiredChecks.some((name) => result.checks?.[name] !== true)
  ) {
    throw new Error(
      `Packaged ${scope} smoke failed: ${JSON.stringify(result)}\n${Buffer.concat(
        outputChunks
      )
        .toString('utf8')
        .trim()}`
    )
  }
  process.stdout.write(
    `ground-packaged-${scope}-ok (${requiredChecks.join(', ')})\n`
  )
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    stopProcessTree(child)
  }
  await rm(smokeDirectory, { recursive: true, force: true })
}
