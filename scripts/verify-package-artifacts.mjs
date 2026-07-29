import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const argumentsList = process.argv.slice(2)
const allTargets = argumentsList[0] === '--all'
const directoryArgument = allTargets ? argumentsList[1] : argumentsList[0]
if (argumentsList.length > (allTargets ? 2 : 1)) {
  throw new Error(
    'Usage: node scripts/verify-package-artifacts.mjs [--all] [DIRECTORY]'
  )
}
const artifactDirectory = path.resolve(
  projectRoot,
  directoryArgument ?? 'release'
)
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const version = packageMetadata.version
if (
  typeof version !== 'string' ||
  !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)
) {
  throw new Error('Ground package.json has an invalid version')
}

function artifactsFor(platform, architecture) {
  if (platform === 'darwin') {
    return [
      `Ground-${version}-mac-${architecture}.zip`,
      `Ground-${version}-mac-${architecture}.dmg`
    ]
  }
  if (platform === 'win32') {
    return [`Ground-${version}-windows-${architecture}.exe`]
  }
  if (platform === 'linux') {
    return [
      `Ground-${version}-linux-${architecture}.AppImage`,
      `Ground-${version}-linux-${architecture}.deb`
    ]
  }
  throw new Error(`Unsupported package target ${platform}-${architecture}`)
}

const expected = (
  allTargets
    ? [
        ...artifactsFor('darwin', 'arm64'),
        ...artifactsFor('darwin', 'x64'),
        ...artifactsFor('win32', 'x64'),
        ...artifactsFor('linux', 'x64')
      ]
    : artifactsFor(process.platform, process.arch)
).sort()
const releaseArtifactPattern =
  /^Ground-.+\.(?:zip|dmg|exe|AppImage|deb)$/u
const actual = (await readdir(artifactDirectory))
  .filter((name) => releaseArtifactPattern.test(name))
  .sort()

if (
  actual.length !== expected.length ||
  actual.some((name, index) => name !== expected[index])
) {
  throw new Error(
    `Expected exact package artifacts ${expected.join(', ')}; found ${
      actual.join(', ') || '(none)'
    }`
  )
}

for (const name of expected) {
  const details = await lstat(path.join(artifactDirectory, name))
  if (details.isSymbolicLink() || !details.isFile() || details.size < 1) {
    throw new Error(`Package artifact ${name} is not a non-empty regular file`)
  }
}

process.stdout.write(
  `Verified exact package artifact inventory: ${expected.join(', ')}.\n`
)
