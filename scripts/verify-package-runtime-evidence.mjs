import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { sha256File } from './lib/packaged-components.mjs'
import {
  hasCompleteProviderRuntimeEvidence,
  REQUIRED_NATIVE_RUNTIME_CHECKS
} from './lib/package-runtime-evidence-contract.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const artifactDirectory = path.resolve(
  projectRoot,
  process.argv[2] ?? 'release'
)
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const targets = [
  {
    platform: 'darwin',
    architecture: 'arm64',
    source: 'mac-zip-extracted',
    artifact: `Ground-${packageMetadata.version}-mac-arm64.zip`
  },
  {
    platform: 'darwin',
    architecture: 'x64',
    source: 'mac-zip-extracted',
    artifact: `Ground-${packageMetadata.version}-mac-x64.zip`
  },
  {
    platform: 'win32',
    architecture: 'x64',
    source: 'windows-nsis-installed',
    artifact: `Ground-${packageMetadata.version}-windows-x64.exe`
  },
  {
    platform: 'linux',
    architecture: 'x64',
    source: 'linux-appimage-extracted',
    artifact: `Ground-${packageMetadata.version}-linux-x64.AppImage`
  }
]

function invalid(source, reason) {
  throw new Error(`Invalid package runtime evidence ${source}: ${reason}`)
}

const directoryEntries = await readdir(artifactDirectory)
const evidenceNames = directoryEntries
  .filter((name) =>
    /^ground-package-runtime-evidence-[a-z0-9._-]+\.json$/u.test(name)
  )
  .sort()
const expectedNames = targets
  .map(
    (target) =>
      `ground-package-runtime-evidence-${target.platform}-${target.architecture}.json`
  )
  .sort()
if (
  evidenceNames.length !== expectedNames.length ||
  evidenceNames.some((name, index) => name !== expectedNames[index])
) {
  throw new Error(
    `Expected package runtime evidence ${expectedNames.join(', ')}; found ${
      evidenceNames.join(', ') || '(none)'
    }`
  )
}

for (const target of targets) {
  const evidenceName =
    `ground-package-runtime-evidence-${target.platform}-${target.architecture}.json`
  const document = JSON.parse(
    await readFile(path.join(artifactDirectory, evidenceName), 'utf8')
  )
  if (document.version !== 1 || document.status !== 'passed') {
    invalid(evidenceName, 'status is not passed')
  }
  if (
    document.packageVersion !== packageMetadata.version ||
    document.platform !== target.platform ||
    document.architecture !== target.architecture ||
    document.installationSource !== target.source
  ) {
    invalid(evidenceName, 'target metadata does not match the release')
  }
  if (
    REQUIRED_NATIVE_RUNTIME_CHECKS.some(
      (name) => document.checks?.[name] !== true
    )
  ) {
    invalid(evidenceName, 'one or more required runtime checks are missing')
  }
  if (
    document.evidence?.app?.packaged !== true ||
    document.evidence?.app?.name !== packageMetadata.build?.productName ||
    document.evidence?.app?.version !== packageMetadata.version ||
    document.evidence?.app?.configuredAppId !== packageMetadata.build?.appId ||
    document.evidence?.app?.platform !== target.platform ||
    document.evidence?.app?.architecture !== target.architecture
  ) {
    invalid(evidenceName, 'packaged application identity does not match')
  }
  if (
    document.evidence?.version !== 1 ||
    document.evidence?.credentialStorage?.encryptionAvailable !== true ||
    document.evidence?.credentialStorage?.roundTrip !== true ||
    document.evidence?.credentialStorage?.backend === 'basic_text' ||
    (target.platform === 'linux' &&
      document.evidence?.credentialStorage?.backend !==
        'gnome_libsecret') ||
    document.evidence?.nativeApproval?.cancelled !== true ||
    document.evidence?.mcpLaunchApproval?.exactEnvelopeValidated !== true
  ) {
    invalid(evidenceName, 'security evidence is incomplete')
  }
  if (
    !hasCompleteProviderRuntimeEvidence(
      document.evidence?.providerRuntime
    )
  ) {
    invalid(evidenceName, 'provider runtime evidence is incomplete')
  }
  if (
    document.distributable?.name !== target.artifact ||
    !/^[a-f0-9]{64}$/u.test(document.distributable?.sha256 ?? '')
  ) {
    invalid(evidenceName, 'distributable binding is invalid')
  }
  const artifactPath = path.join(artifactDirectory, target.artifact)
  if ((await sha256File(artifactPath)) !== document.distributable.sha256) {
    invalid(evidenceName, 'distributable hash does not match')
  }
  if (
    process.env.GITHUB_SHA &&
    document.commit !== process.env.GITHUB_SHA.toLowerCase()
  ) {
    invalid(evidenceName, 'commit does not match GITHUB_SHA')
  }
}

process.stdout.write(
  `Verified ${targets.length} distributable package runtime-evidence records.\n`
)
