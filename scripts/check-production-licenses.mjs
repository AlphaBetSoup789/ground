import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const lockPath = path.join(root, 'package-lock.json')
const noticesPath = path.join(root, 'THIRD_PARTY_NOTICES.md')
const allowedLicenses = new Set([
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  '(AFL-2.1 OR BSD-3-Clause)'
])

function packageName(location, metadata) {
  if (typeof metadata.name === 'string' && metadata.name) return metadata.name
  const marker = 'node_modules/'
  const index = location.lastIndexOf(marker)
  const remainder = index === -1 ? location : location.slice(index + marker.length)
  if (!remainder.startsWith('@')) return remainder.split('/')[0]
  return remainder.split('/').slice(0, 2).join('/')
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|')
}

function renderNotices(packages) {
  const rows = packages
    .map(
      (entry) =>
        `| ${markdownCell(entry.name)} | ${markdownCell(entry.version)} | ${markdownCell(entry.license)} |`
    )
    .join('\n')
  return `# Third-party software notices

Ground includes open-source software from the projects listed below. This
inventory is generated from the production dependency graph in
\`package-lock.json\`; development-only packages are excluded.

The corresponding license files remain alongside each dependency in Ground's
packaged application. Copyright ownership remains with each project's authors.
Ground's MIT license does not replace those third-party terms.

| Package | Version | Declared license |
| --- | --- | --- |
${rows}

Generated with \`npm run licenses:generate\`. Verify it with
\`npm run licenses:check\`.
`
}

const lockfile = JSON.parse(await readFile(lockPath, 'utf8'))
const packages = []
const seen = new Set()
const rejected = []

function isDevelopmentOnlyLink(metadata) {
  if (metadata.link !== true || typeof metadata.resolved !== 'string') return false
  const target = lockfile.packages?.[metadata.resolved]
  return Boolean(target?.dev)
}

for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
  // npm can omit `dev` and package metadata from a link entry while marking its
  // resolved lockfile target as development-only. This occurs for reviewed local
  // overrides beneath development-time build tools. Do not misclassify those link
  // aliases as shipped production packages.
  if (!location || metadata.dev || isDevelopmentOnlyLink(metadata)) continue
  const name = packageName(location, metadata)
  const version = metadata.version
  const license = metadata.license
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof license !== 'string'
  ) {
    rejected.push(`${location || '(root)'}: missing name, version, or license`)
    continue
  }
  if (!allowedLicenses.has(license)) {
    rejected.push(`${name}@${version}: unreviewed license ${license}`)
    continue
  }
  const identity = `${name}\u0000${version}\u0000${license}`
  if (seen.has(identity)) continue
  seen.add(identity)
  packages.push({ name, version, license })
}

if (rejected.length) {
  throw new Error(
    `Production license review failed:\n${rejected.map((item) => `- ${item}`).join('\n')}`
  )
}

packages.sort((left, right) => {
  const byName = left.name.localeCompare(right.name)
  return byName || left.version.localeCompare(right.version)
})
const expected = renderNotices(packages)

if (process.argv.includes('--write')) {
  await writeFile(noticesPath, expected, 'utf8')
  process.stdout.write(`Wrote ${path.basename(noticesPath)} for ${packages.length} packages.\n`)
} else {
  let actual = ''
  try {
    actual = await readFile(noticesPath, 'utf8')
  } catch {
    // The comparison below provides the actionable error.
  }
  if (actual !== expected) {
    throw new Error(
      'THIRD_PARTY_NOTICES.md is stale. Run npm run licenses:generate and review the diff.'
    )
  }
  process.stdout.write(`Reviewed ${packages.length} production dependency licenses.\n`)
}
