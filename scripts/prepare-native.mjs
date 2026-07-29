import { spawnSync } from 'node:child_process'
import { access, chmod, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const electronRoot = path.resolve('node_modules', 'electron')
const electronPackage = JSON.parse(
  await readFile(path.join(electronRoot, 'package.json'), 'utf8')
)
const electronRuntimeFiles = [
  path.join(electronRoot, 'dist', 'version'),
  path.join(electronRoot, 'dist', 'LICENSE'),
  path.join(electronRoot, 'dist', 'LICENSES.chromium.html')
]

async function electronRuntimeIsComplete() {
  try {
    const runtimeVersion = (
      await readFile(electronRuntimeFiles[0], 'utf8')
    ).trim().replace(/^v/u, '')
    if (runtimeVersion !== electronPackage.version) return false
    await Promise.all(
      electronRuntimeFiles.slice(1).map((filePath) => access(filePath))
    )
    return true
  } catch {
    return false
  }
}

if (!(await electronRuntimeIsComplete())) {
  const installer = path.join(electronRoot, 'install.js')
  const result = spawnSync(process.execPath, [installer], {
    env: process.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Electron ${electronPackage.version} runtime installation exited with status ${String(result.status)}`
    )
  }
  if (!(await electronRuntimeIsComplete())) {
    throw new Error(
      `Electron ${electronPackage.version} runtime or license inventory is incomplete`
    )
  }
}

if (process.platform !== 'win32') {
  const helper = path.resolve(
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper'
  )
  try {
    await chmod(helper, 0o755)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
