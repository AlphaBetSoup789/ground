import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { locatePackagedApp } from './lib/packaged-app.mjs'
import { classifyUnsignedMacSignature } from './lib/mac-signature.mjs'

if (process.platform !== 'darwin') {
  throw new Error('Unsigned macOS preview verification requires macOS')
}

const projectRoot = path.resolve(import.meta.dirname, '..')
const packageMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)
const packagedApp = await locatePackagedApp(
  path.join(projectRoot, process.argv[2] ?? 'release')
)

function command(executable, args) {
  return spawnSync(executable, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
    shell: false,
    windowsHide: true
  })
}

const bundleIdentifier = command('/usr/bin/plutil', [
  '-extract',
  'CFBundleIdentifier',
  'raw',
  '-o',
  '-',
  path.join(packagedApp.appPath, 'Contents', 'Info.plist')
])
if (
  bundleIdentifier.status !== 0 ||
  bundleIdentifier.stdout.trim() !== packageMetadata.build?.appId
) {
  throw new Error(
    `macOS preview bundle identifier differs from package.json: ${
      bundleIdentifier.stdout.trim() || '(unavailable)'
    }`
  )
}

const signature = command('/usr/bin/codesign', [
  '-dv',
  '--verbose=4',
  packagedApp.appPath
])
const signatureOutput = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`
const signatureKind = classifyUnsignedMacSignature(
  signature.status,
  signatureOutput
)
if (!signatureKind) {
  throw new Error(
    `macOS preview is neither completely unsigned nor provably ad-hoc and teamless:\n${signatureOutput.trim()}`
  )
}

const gatekeeper = command('/usr/sbin/spctl', [
  '--assess',
  '--type',
  'execute',
  '--verbose=2',
  packagedApp.appPath
])
if (gatekeeper.status === 0) {
  throw new Error('Unsigned macOS preview unexpectedly passed Gatekeeper')
}

const stapler = command('/usr/bin/xcrun', [
  'stapler',
  'validate',
  packagedApp.appPath
])
if (stapler.status === 0) {
  throw new Error('Unsigned macOS preview unexpectedly has a notarization ticket')
}

process.stdout.write(
  `Verified macOS preview bundle identity and ${
    signatureKind === 'completely-unsigned'
      ? 'completely unsigned'
      : 'ad-hoc, teamless'
  }, Gatekeeper-rejected, unstapled status.\n`
)
