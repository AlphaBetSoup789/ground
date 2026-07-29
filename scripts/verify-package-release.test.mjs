import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import packageMetadata from '../package.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')
const temporaryDirectories = []
const requiredChecks = [
  'main',
  'preload',
  'rendererDocument',
  'appIdentity',
  'safeStorage',
  'nativeApprovalDialog',
  'pty',
  'git',
  'mcp',
  'mcpLaunchApproval',
  'processTreeCancellation'
]
const targets = [
  ['darwin', 'arm64', 'mac-zip-extracted', 'mac-arm64.zip'],
  ['darwin', 'x64', 'mac-zip-extracted', 'mac-x64.zip'],
  ['win32', 'x64', 'windows-nsis-installed', 'windows-x64.exe'],
  ['linux', 'x64', 'linux-appimage-extracted', 'linux-x64.AppImage']
]
const allArtifacts = [
  'mac-arm64.zip',
  'mac-arm64.dmg',
  'mac-x64.zip',
  'mac-x64.dmg',
  'windows-x64.exe',
  'linux-x64.AppImage',
  'linux-x64.deb'
].map((suffix) => `Ground-${packageMetadata.version}-${suffix}`)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fixtureDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-package-release-test-')
  )
  temporaryDirectories.push(directory)
  for (const name of allArtifacts) {
    await writeFile(path.join(directory, name), `artifact:${name}\n`)
  }
  return directory
}

async function runScript(script, args) {
  return execFileAsync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 1_000_000
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('release artifact and runtime-evidence verification', () => {
  it('requires the exact complete cross-platform artifact inventory', async () => {
    const directory = await fixtureDirectory()
    await expect(
      runScript('scripts/verify-package-artifacts.mjs', ['--all', directory])
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Verified exact package artifact inventory')
    })

    await writeFile(path.join(directory, 'Ground-surprise.exe'), 'unexpected\n')
    await expect(
      runScript('scripts/verify-package-artifacts.mjs', ['--all', directory])
    ).rejects.toThrow(/exact package artifacts/iu)
  })

  it('binds every runtime-evidence record to its exact distributable bytes', async () => {
    const directory = await fixtureDirectory()
    for (const [platform, architecture, source, suffix] of targets) {
      const artifact = `Ground-${packageMetadata.version}-${suffix}`
      const contents = `artifact:${artifact}\n`
      const checks = Object.fromEntries(requiredChecks.map((name) => [name, true]))
      const document = {
        version: 1,
        status: 'passed',
        packageVersion: packageMetadata.version,
        platform,
        architecture,
        installationSource: source,
        distributable: {
          name: artifact,
          sha256: sha256(contents)
        },
        checks,
        evidence: {
          version: 1,
          app: {
            packaged: true,
            name: packageMetadata.build.productName,
            version: packageMetadata.version,
            configuredAppId: packageMetadata.build.appId,
            platform,
            architecture
          },
          credentialStorage: {
            encryptionAvailable: true,
            roundTrip: true,
            ...(platform === 'linux'
              ? { backend: 'gnome_libsecret' }
              : {})
          },
          nativeApproval: { cancelled: true },
          mcpLaunchApproval: { exactEnvelopeValidated: true }
        }
      }
      await writeFile(
        path.join(
          directory,
          `ground-package-runtime-evidence-${platform}-${architecture}.json`
        ),
        `${JSON.stringify(document)}\n`
      )
    }

    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory])
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(
        'Verified 4 distributable package runtime-evidence records'
      )
    })

    const linuxEvidencePath = path.join(
      directory,
      'ground-package-runtime-evidence-linux-x64.json'
    )
    const linuxEvidence = JSON.parse(
      await readFile(linuxEvidencePath, 'utf8')
    )
    delete linuxEvidence.evidence.credentialStorage.backend
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory])
    ).rejects.toThrow(/security evidence is incomplete/iu)
    linuxEvidence.evidence.credentialStorage.backend = 'gnome_libsecret'
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )

    await writeFile(
      path.join(
        directory,
        `Ground-${packageMetadata.version}-windows-x64.exe`
      ),
      'changed bytes\n'
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory])
    ).rejects.toThrow(/distributable hash does not match/iu)
  })
})
