import { constants } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

async function existing(candidate, mode = constants.F_OK) {
  try {
    await access(candidate, mode)
    return candidate
  } catch {
    return undefined
  }
}

export async function locatePackagedApp(
  releaseDirectory = path.resolve('release')
) {
  const entries = await readdir(releaseDirectory, { withFileTypes: true })
  const candidates = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(releaseDirectory, entry.name)
    if (process.platform === 'darwin' && /^mac(?:-|$)/u.test(entry.name)) {
      const appPath = path.join(directory, 'Ground.app')
      const executable = await existing(
        path.join(appPath, 'Contents', 'MacOS', 'Ground'),
        constants.X_OK
      )
      if (executable) {
        candidates.push({
          appPath,
          executable,
          resourcesPath: path.join(appPath, 'Contents', 'Resources')
        })
      }
    } else if (
      process.platform === 'win32' &&
      /^win(?:-|$).*unpacked$/u.test(entry.name)
    ) {
      const executable = await existing(path.join(directory, 'Ground.exe'))
      if (executable) {
        candidates.push({
          appPath: directory,
          executable,
          resourcesPath: path.join(directory, 'resources')
        })
      }
    } else if (
      process.platform === 'linux' &&
      /^linux(?:-|$).*unpacked$/u.test(entry.name)
    ) {
      const executable =
        (await existing(path.join(directory, 'ground'), constants.X_OK)) ??
        (await existing(path.join(directory, 'Ground'), constants.X_OK))
      if (executable) {
        candidates.push({
          appPath: directory,
          executable,
          resourcesPath: path.join(directory, 'resources')
        })
      }
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked Ground application beneath ${releaseDirectory} for ${process.platform}; found ${candidates.length}`
    )
  }
  return candidates[0]
}

export async function assertPackagedRuntimeFiles(packagedApp) {
  const required = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'LICENSE.electron.txt',
    'LICENSES.chromium.html',
    'app.asar'
  ]
  await Promise.all(
    required.map((name) => access(path.join(packagedApp.resourcesPath, name)))
  )
}
