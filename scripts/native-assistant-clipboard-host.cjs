const { lstatSync } = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const PROFILE_ARGUMENT_PREFIX =
  '--ground-native-assistant-clipboard-profile='
const profileArguments = process.argv.filter((argument) =>
  argument.startsWith(PROFILE_ARGUMENT_PREFIX)
)

if (profileArguments.length !== 1) {
  throw new Error(
    'Native assistant clipboard smoke requires exactly one isolated profile'
  )
}

const profileArgument = profileArguments[0].slice(
  PROFILE_ARGUMENT_PREFIX.length
)
if (
  !profileArgument ||
  !path.isAbsolute(profileArgument) ||
  profileArgument.includes('\0')
) {
  throw new Error(
    'Native assistant clipboard smoke profile must be an absolute path'
  )
}

const profileRoot = path.resolve(profileArgument)
const profileStat = lstatSync(profileRoot)
if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
  throw new Error(
    'Native assistant clipboard smoke profile must be a real directory'
  )
}

// Isolate state before importing the unmodified production main bundle. The
// smoke therefore exercises the real startup, BrowserWindow, trusted IPC
// registration, clipboard service, and preload while never touching a
// developer's Ground profile.
app.setPath('appData', path.join(profileRoot, 'app-data'))
app.setPath('userData', path.join(profileRoot, 'user-data'))

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
