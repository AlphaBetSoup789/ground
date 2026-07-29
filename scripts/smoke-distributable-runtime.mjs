import { spawn } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { sha256File } from './lib/packaged-components.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const releaseDirectory = path.join(projectRoot, 'release')
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const version = packageMetadata.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error('Ground package.json has an invalid version')
}
if (process.argv.length > 2) {
  throw new Error(
    `Unknown distributable smoke option: ${process.argv.slice(2).join(', ')}`
  )
}

function expectedArtifactName() {
  if (process.platform === 'darwin') {
    return `Ground-${version}-mac-${process.arch}.zip`
  }
  if (process.platform === 'win32') {
    return `Ground-${version}-windows-${process.arch}.exe`
  }
  if (process.platform === 'linux') {
    return `Ground-${version}-linux-${process.arch}.AppImage`
  }
  throw new Error(`Distributable smoke does not support ${process.platform}`)
}

async function waitForRemoval(targetPath, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await lstat(targetPath)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return
      throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} remained after the Windows uninstaller completed`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function runChecked(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? projectRoot,
      detached: process.platform !== 'win32',
      env: options.env ?? process.env,
      shell: false,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true
    })
    let settled = false
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', finish)
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `${path.basename(executable)} exited with ${String(code)} (${String(signal)})`
        )
      )
    })
    timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(
          'C:\\Windows\\System32\\taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          {
            env: {
              SystemRoot: 'C:\\Windows',
              WINDIR: 'C:\\Windows'
            },
            shell: false,
            stdio: 'ignore',
            windowsHide: true
          }
        )
        killer.unref()
      } else {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
      }
      finish(new Error(`${path.basename(executable)} timed out`))
    }, options.timeoutMs ?? 240_000)
  })
}

async function prepareMacArtifact(artifactPath, temporaryRelease) {
  const destination = path.join(temporaryRelease, 'mac-distributable')
  await mkdir(destination, { mode: 0o700 })
  await runChecked('/usr/bin/ditto', ['-x', '-k', artifactPath, destination])
  return 'mac-zip-extracted'
}

async function prepareWindowsArtifact(artifactPath, temporaryRelease) {
  const destination = path.join(temporaryRelease, 'win-unpacked')
  await mkdir(destination, { mode: 0o700 })
  // NSIS requires /D to be the final argument and does not accept quotes around
  // that value. spawn() still passes this as one argv item without a shell.
  await runChecked(artifactPath, ['/S', `/D=${destination}`])
  await access(path.join(destination, 'Ground.exe'))
  return 'windows-nsis-installed'
}

async function prepareLinuxArtifact(
  artifactPath,
  temporaryRoot,
  temporaryRelease
) {
  const extractionRoot = path.join(temporaryRoot, 'appimage')
  await mkdir(extractionRoot, { mode: 0o700 })
  await runChecked(artifactPath, ['--appimage-extract'], {
    cwd: extractionRoot
  })
  const extracted = path.join(extractionRoot, 'squashfs-root')
  await access(path.join(extracted, 'resources', 'app.asar'))
  const prepared = path.join(temporaryRelease, 'linux-unpacked')
  await rename(extracted, prepared)
  const extractedSandbox = path.join(prepared, 'chrome-sandbox')
  const sandboxDetails = await lstat(extractedSandbox)
  if (
    sandboxDetails.isSymbolicLink() ||
    !sandboxDetails.isFile()
  ) {
    throw new Error(
      'Extracted AppImage chrome-sandbox is not a regular file'
    )
  }
  const trustedSandbox = path.join(
    releaseDirectory,
    'linux-unpacked',
    'chrome-sandbox'
  )
  const trustedDetails = await lstat(trustedSandbox)
  if (
    trustedDetails.isSymbolicLink() ||
    !trustedDetails.isFile() ||
    trustedDetails.uid !== 0 ||
    trustedDetails.gid !== 0 ||
    (trustedDetails.mode & 0o4777) !== 0o4755
  ) {
    throw new Error(
      'The trusted unpacked chrome-sandbox must be root-owned with mode 4755'
    )
  }
  if (
    (await sha256File(extractedSandbox)) !==
    (await sha256File(trustedSandbox))
  ) {
    throw new Error(
      'The AppImage chrome-sandbox differs from the trusted unpacked package'
    )
  }
  if (process.env.GROUND_PACKAGE_SMOKE_PREPARE_SANDBOX === 'sudo') {
    await runChecked('/usr/bin/sudo', [
      '--',
      '/usr/bin/chown',
      'root:root',
      extractedSandbox
    ])
    await runChecked('/usr/bin/sudo', [
      '--',
      '/usr/bin/chmod',
      '4755',
      extractedSandbox
    ])
  }
  const preparedDetails = await lstat(extractedSandbox)
  if (
    preparedDetails.isSymbolicLink() ||
    !preparedDetails.isFile() ||
    preparedDetails.uid !== 0 ||
    preparedDetails.gid !== 0 ||
    (preparedDetails.mode & 0o4777) !== 0o4755
  ) {
    throw new Error(
      'The extracted AppImage chrome-sandbox must be root-owned with mode 4755; set GROUND_PACKAGE_SMOKE_PREPARE_SANDBOX=sudo only on a trusted package-smoke host'
    )
  }
  return {
    installationSource: 'linux-appimage-extracted',
    chromiumSandbox: extractedSandbox
  }
}

const artifactName = expectedArtifactName()
const artifactPath = path.join(releaseDirectory, artifactName)
await access(artifactPath)
const matchingArtifacts = (await readdir(releaseDirectory)).filter(
  (name) => name === artifactName
)
if (matchingArtifacts.length !== 1) {
  throw new Error(`Expected exactly one distributable named ${artifactName}`)
}

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'ground-distributable-smoke-')
)
const temporaryRelease = path.join(temporaryRoot, 'release')
await mkdir(temporaryRelease, { mode: 0o700 })
let windowsUninstaller

try {
  const prepared =
    process.platform === 'darwin'
      ? {
          installationSource: await prepareMacArtifact(
            artifactPath,
            temporaryRelease
          )
        }
      : process.platform === 'win32'
        ? {
            installationSource: await prepareWindowsArtifact(
              artifactPath,
              temporaryRelease
            )
          }
        : await prepareLinuxArtifact(
            artifactPath,
            temporaryRoot,
            temporaryRelease
          )
  const installationSource = prepared.installationSource
  if (process.platform === 'win32') {
    windowsUninstaller = path.join(
      temporaryRelease,
      'win-unpacked',
      'Uninstall Ground.exe'
    )
  }
  await runChecked(
    process.execPath,
    [
      path.join(projectRoot, 'scripts', 'smoke-packaged-runtime.mjs'),
      'native',
      installationSource,
      temporaryRelease,
      artifactPath
    ],
    {
      cwd: projectRoot,
      ...(prepared.chromiumSandbox
        ? {
            env: {
              ...process.env,
              CHROME_DEVEL_SANDBOX: prepared.chromiumSandbox
            }
          }
        : {})
    }
  )
  process.stdout.write(
    `ground-distributable-runtime-ok (${installationSource}, ${artifactName})\n`
  )
} finally {
  try {
    if (windowsUninstaller) {
      const windowsInstallDirectory = path.dirname(windowsUninstaller)
      const windowsExecutable = path.join(
        windowsInstallDirectory,
        'Ground.exe'
      )
      await access(windowsUninstaller)
      await runChecked(windowsUninstaller, ['/S'], {
        timeoutMs: 120_000
      })
      await waitForRemoval(
        windowsExecutable,
        'The installed Ground executable'
      )
      await waitForRemoval(
        windowsInstallDirectory,
        'The Ground installation directory'
      )
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
