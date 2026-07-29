import { readFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '..')
const packageDocument = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8')
)

const expectedNode = packageDocument.devEngines?.runtime?.version
const expectedNpm = packageDocument.devEngines?.packageManager?.version
const actualNode = process.version.replace(/^v/u, '')
const actualNpm = process.env.npm_config_user_agent?.match(/\bnpm\/([^\s]+)/u)?.[1]

if (!expectedNode || !expectedNpm) {
  throw new Error('package.json must declare exact Node.js and npm devEngines')
}
if (actualNode !== expectedNode) {
  throw new Error(
    `Ground requires Node.js ${expectedNode}; current runtime is ${actualNode}`
  )
}
if (!actualNpm) {
  throw new Error('Run the toolchain check through npm so its version can be verified')
}
if (actualNpm !== expectedNpm) {
  throw new Error(`Ground requires npm ${expectedNpm}; current npm is ${actualNpm}`)
}

process.stdout.write(`Verified Node.js ${actualNode} and npm ${actualNpm}.\n`)
