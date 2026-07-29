import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

export async function migrateLegacyData(
  dataDirectory: string,
  appDataDirectory: string
): Promise<void> {
  await mkdir(dataDirectory, { recursive: true })
  const legacyDirectories = [
    dataDirectory,
    path.join(appDataDirectory, 'ModelDock'),
    path.join(appDataDirectory, 'modeldock')
  ]
  const files = [
    { legacy: 'modeldock-state.json', current: 'ground-state.json' },
    { legacy: 'modeldock-secrets.json', current: 'ground-secrets.json' }
  ]

  for (const file of files) {
    const target = path.join(dataDirectory, file.current)
    if (await exists(target)) continue

    for (const legacyDirectory of legacyDirectories) {
      const source = path.join(legacyDirectory, file.legacy)
      if (!(await exists(source))) continue
      await copyFile(source, target)
      break
    }
  }
}
