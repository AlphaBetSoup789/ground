import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronExecutable from 'electron'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const hostPath = path.join(
  projectRoot,
  'scripts',
  'native-assistant-clipboard-host.cjs'
)
const profileDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'ground-native-assistant-clipboard-')
)
const appDataDirectory = path.join(profileDirectory, 'app-data')
const userDataDirectory = path.join(profileDirectory, 'user-data')
const statePath = path.join(userDataDirectory, 'ground-state.json')
const profileArgument =
  `--ground-native-assistant-clipboard-profile=${profileDirectory}`

const taskId = 'native-clipboard-task'
const messageId = 'native-clipboard-assistant'
const assistantResponse = [
  'Exact **Markdown** response for the native clipboard smoke.',
  '',
  '```ts',
  "const owner = 'Ground 🛡️'",
  '',
  'console.log(owner)',
  '```',
  '',
  'Trailing Markdown spaces stay.  '
].join('\n')
const representedCode =
  "const owner = 'Ground 🛡️'\n\nconsole.log(owner)\n"
const deniedSentinel = 'ground-renderer-denied-sentinel'
const rendererDeniedPayload = 'renderer-must-not-write-this'
const inactiveSentinel = 'ground-inactive-preload-sentinel'
const pointerSentinel = 'ground-pointer-copy-sentinel'
const keyboardSentinel = 'ground-keyboard-copy-sentinel'
const timestamp = '2026-01-01T00:00:00.000Z'
const state = {
  version: 2,
  providers: [
    {
      id: 'native-clipboard-provider',
      name: 'Native clipboard fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'fixture',
      hasApiKey: false,
      supportsTools: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  mcpServers: [],
  tasks: [
    {
      id: taskId,
      title: 'Native assistant clipboard smoke',
      providerId: 'native-clipboard-provider',
      mode: 'ask',
      runStatus: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      items: [
        {
          id: messageId,
          kind: 'message',
          role: 'assistant',
          content: assistantResponse,
          createdAt: timestamp
        }
      ]
    }
  ],
  settings: {
    selectedTaskId: taskId,
    defaultProviderId: 'native-clipboard-provider',
    sidebarCollapsed: false
  },
  pendingSecretDeletes: []
}

await chmod(profileDirectory, 0o700)
await Promise.all([
  mkdir(appDataDirectory, { mode: 0o700 }),
  mkdir(userDataDirectory, { mode: 0o700 })
])
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
  flag: 'wx'
})

let electronApplication
let originalClipboard
let clipboardWasMutated = false
let primaryError
let primaryFailed = false
const completedChecks = []
const cleanupErrors = []
const ownedClipboardTexts = new Set([
  deniedSentinel,
  rendererDeniedPayload,
  inactiveSentinel,
  pointerSentinel,
  keyboardSentinel,
  assistantResponse,
  representedCode
])
const launchEnvironment = { ...process.env }
const blockedLaunchEnvironment = new Set([
  'BASH_ENV',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'RUBYOPT'
])
const blockedCredentialEnvironment = new Set([
  'ANTHROPIC_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT'
])
for (const key of Object.keys(launchEnvironment)) {
  const normalized = key.toUpperCase()
  if (
    blockedLaunchEnvironment.has(normalized) ||
    blockedCredentialEnvironment.has(normalized)
  ) {
    delete launchEnvironment[key]
  }
}
launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

function passed(name) {
  completedChecks.push(name)
  process.stdout.write(`✓ ${name}\n`)
}

function isRestorableClipboardFormat(format) {
  const normalized = format.trim().toLowerCase()
  return (
    /^text\/(?:plain|html|rtf)(?:;.*)?$/u.test(normalized) ||
    /^image\/(?:png|tiff|bmp|jpe?g)$/u.test(normalized) ||
    [
      'html format',
      'rich text format',
      'string',
      'text',
      'utf8_string',
      'public.html',
      'public.png',
      'public.rtf',
      'public.tiff',
      'public.url',
      'public.url-name',
      'public.utf16-external-plain-text',
      'public.utf8-plain-text'
    ].includes(normalized)
  )
}

function isOwnedPlainTextFormat(format) {
  const normalized = format.trim().toLowerCase()
  return (
    /^text\/plain(?:;.*)?$/u.test(normalized) ||
    [
      'string',
      'text',
      'utf8_string',
      'public.utf16-external-plain-text',
      'public.utf8-plain-text'
    ].includes(normalized)
  )
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const summary = `${error.name}: ${error.message}`
  return error.cause === undefined
    ? summary
    : `${summary} (${describeError(error.cause)})`
}

async function writeMainClipboard(text) {
  if (clipboardWasMutated) {
    await assertCurrentClipboardOwned(
      'Clipboard changed outside the native smoke before its next write'
    )
  }
  clipboardWasMutated = true
  await electronApplication.evaluate(
    ({ clipboard }, exactText) => clipboard.writeText(exactText),
    text
  )
}

async function assertCurrentClipboardOwned(message) {
  const currentClipboard =
    await electronApplication.evaluate(({ clipboard }) => ({
      formats: clipboard.availableFormats(),
      text: clipboard.readText()
    }))
  if (
    !ownedClipboardTexts.has(currentClipboard.text) ||
    currentClipboard.formats.some(
      (format) => !isOwnedPlainTextFormat(format)
    )
  ) {
    throw new Error(message)
  }
}

async function readMainClipboard() {
  return electronApplication.evaluate(({ clipboard }) =>
    clipboard.readText()
  )
}

async function waitForMainClipboard(page, expected, description) {
  const deadline = Date.now() + 5_000
  let actual
  while (Date.now() < deadline) {
    actual = await readMainClipboard()
    if (actual === expected) return
    await page.waitForTimeout(25)
  }
  assert.equal(actual, expected, description)
}

async function waitForClipboardControls(page) {
  await page
    .getByRole('button', { name: 'Copy assistant response' })
    .waitFor()
  await page
    .getByRole('button', { name: 'Copy code block 1' })
    .waitFor()
}

function createBoundedSignal(description) {
  let resolveSignal
  let timeout
  const promise = new Promise((resolve, reject) => {
    resolveSignal = resolve
    timeout = setTimeout(
      () => reject(new Error(`${description} timed out`)),
      10_000
    )
  })
  return {
    promise,
    resolve(value) {
      clearTimeout(timeout)
      resolveSignal(value)
    }
  }
}

try {
  electronApplication = await electron.launch({
    executablePath: electronExecutable,
    args: [hostPath, profileArgument, '--disable-gpu'],
    env: launchEnvironment,
    timeout: 30_000
  })

  const page = await electronApplication.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForLoadState('domcontentloaded')
  await waitForClipboardControls(page)
  assert.equal(
    path.resolve(fileURLToPath(page.url())),
    path.join(projectRoot, 'out', 'renderer', 'index.html'),
    'native smoke must load the compiled production renderer'
  )

  const actualUserDataDirectory =
    await electronApplication.evaluate(({ app }) =>
      app.getPath('userData')
    )
  assert.equal(
    path.resolve(actualUserDataDirectory),
    path.resolve(userDataDirectory),
    'production main must use the smoke-owned profile'
  )

  const bridgeBoundary = await page.evaluate(() => ({
    hasGroundBridge: typeof window.ground === 'object',
    hasCopyMethod:
      typeof window.ground?.copyAssistantOutput === 'function',
    hasClipboardRead:
      typeof window.ground?.readClipboard === 'function',
    hasArbitraryClipboardWrite:
      typeof window.ground?.writeClipboard === 'function',
    hasNodeRequire: typeof window.require === 'function',
    hasNodeProcess: typeof window.process === 'object'
  }))
  assert.deepEqual(bridgeBoundary, {
    hasGroundBridge: true,
    hasCopyMethod: true,
    hasClipboardRead: false,
    hasArbitraryClipboardWrite: false,
    hasNodeRequire: false,
    hasNodeProcess: false
  })
  passed('production sandboxed preload exposes only source-bound copy')

  originalClipboard = await electronApplication.evaluate(
    ({ clipboard }) => {
      const image = clipboard.readImage()
      let bookmark
      try {
        bookmark = clipboard.readBookmark()
      } catch {
        bookmark = undefined
      }
      return {
        formats: clipboard.availableFormats(),
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        bookmark,
        imagePng: image.isEmpty()
          ? undefined
          : image.toPNG().toString('base64')
      }
    }
  )
  const unsupportedClipboardFormats = originalClipboard.formats.filter(
    (format) => !isRestorableClipboardFormat(format)
  )
  assert.deepEqual(
    unsupportedClipboardFormats,
    [],
    'Native clipboard smoke refuses unsupported clipboard formats; clear the clipboard or copy plain text before retrying'
  )

  await writeMainClipboard(deniedSentinel)
  await page.evaluate((deniedPayload) => {
    const probe = document.createElement('button')
    probe.id = 'ground-native-renderer-clipboard-probe'
    probe.type = 'button'
    probe.textContent = 'Renderer clipboard probe'
    probe.addEventListener(
      'click',
      async () => {
        const activationWasActive =
          navigator.userActivation?.isActive === true
        const hasWriteText =
          typeof navigator.clipboard?.writeText === 'function'
        if (!hasWriteText) {
          window.__groundNativeRendererClipboardProbe = {
            activationWasActive,
            hasWriteText,
            wrote: false,
            errorName: 'Unavailable'
          }
          return
        }
        try {
          await navigator.clipboard.writeText(deniedPayload)
          window.__groundNativeRendererClipboardProbe = {
            activationWasActive,
            hasWriteText,
            wrote: true
          }
        } catch (error) {
          window.__groundNativeRendererClipboardProbe = {
            activationWasActive,
            hasWriteText,
            wrote: false,
            errorName:
              error &&
              typeof error === 'object' &&
              'name' in error
                ? String(error.name)
                : typeof error
          }
        }
      },
      { once: true }
    )
    document.body.append(probe)
  }, rendererDeniedPayload)
  await assertCurrentClipboardOwned(
    'Clipboard changed outside the native smoke before the renderer-denial probe'
  )
  await page.locator('#ground-native-renderer-clipboard-probe').click()
  await page.waitForFunction(
    () => window.__groundNativeRendererClipboardProbe !== undefined
  )
  const rendererClipboardProbe = await page.evaluate(() =>
    structuredClone(window.__groundNativeRendererClipboardProbe)
  )
  assert.equal(
    rendererClipboardProbe.activationWasActive,
    true,
    'renderer clipboard denial must be tested during a real pointer activation'
  )
  assert.equal(
    rendererClipboardProbe.hasWriteText,
    true,
    'renderer clipboard denial must exercise the available Web Clipboard API'
  )
  assert.equal(
    rendererClipboardProbe.wrote,
    false,
    'deny-all renderer permissions must block direct clipboard writes'
  )
  assert.equal(
    rendererClipboardProbe.errorName,
    'NotAllowedError',
    'deny-all renderer permissions must reject with NotAllowedError'
  )
  assert.equal(
    await readMainClipboard(),
    deniedSentinel,
    'a denied renderer write must leave the OS clipboard unchanged'
  )
  passed('deny-all renderer permissions reject an activated direct write')

  await writeMainClipboard(inactiveSentinel)
  const inactiveSignal = createBoundedSignal(
    'inactive preload clipboard probe'
  )
  await page.exposeFunction(
    '__groundNativeReportInactiveCopy',
    (result) => inactiveSignal.resolve(result)
  )
  await assertCurrentClipboardOwned(
    'Clipboard changed outside the native smoke before inactive copy'
  )
  await page.evaluate(
    ({ expectedContent, taskId: exactTaskId, messageId: exactMessageId }) => {
      const invokeWhenInactive = () => {
        if (navigator.userActivation?.isActive === true) {
          setTimeout(invokeWhenInactive, 25)
          return
        }
        void (async () => {
          if (!window.ground) {
            throw new Error('Ground preload bridge is missing')
          }
          const activationWasActive =
            navigator.userActivation?.isActive === true
          const copied = await window.ground.copyAssistantOutput({
            taskId: exactTaskId,
            messageId: exactMessageId,
            expectedContent,
            target: { kind: 'response' }
          })
          await window.__groundNativeReportInactiveCopy({
            activationWasActive,
            copied
          })
        })()
      }
      setTimeout(invokeWhenInactive, 0)
    },
    {
      expectedContent: assistantResponse,
      taskId,
      messageId
    }
  )
  const inactiveResult = await inactiveSignal.promise
  assert.deepEqual(inactiveResult, {
    activationWasActive: false,
    copied: false
  })
  assert.equal(
    await readMainClipboard(),
    inactiveSentinel,
    'an inactive preload call must make zero clipboard change'
  )
  passed('preload user-activation guard rejects inactive source copy')

  await writeMainClipboard(pointerSentinel)
  await assertCurrentClipboardOwned(
    'Clipboard changed outside the native smoke before pointer copy'
  )
  await page
    .getByRole('button', { name: 'Copy assistant response' })
    .click()
  await waitForMainClipboard(
    page,
    assistantResponse,
    'pointer copy must write the exact canonical assistant Markdown'
  )
  await page
    .locator('.assistant-output-copy-feedback')
    .getByText('Assistant response copied.', { exact: true })
    .waitFor()
  passed('pointer activation crosses trusted IPC into main clipboard')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForClipboardControls(page)
  const keyboardReadySignal = createBoundedSignal(
    'inactive keyboard focus probe'
  )
  await page.exposeFunction(
    '__groundNativeReportKeyboardReady',
    (result) => keyboardReadySignal.resolve(result)
  )
  await page.evaluate(() => {
    const focusWhenInactive = () => {
      if (navigator.userActivation?.isActive === true) {
        setTimeout(focusWhenInactive, 25)
        return
      }
      const copyCode = document.querySelector(
        'button[aria-label="Copy code block 1"]'
      )
      if (!(copyCode instanceof HTMLButtonElement)) {
        setTimeout(focusWhenInactive, 25)
        return
      }
      const activationWasActive =
        navigator.userActivation?.isActive === true
      copyCode.focus()
      void window.__groundNativeReportKeyboardReady({
        activationWasActive,
        focusIsOnCodeCopy: document.activeElement === copyCode
      })
    }
    setTimeout(focusWhenInactive, 0)
  })
  assert.deepEqual(await keyboardReadySignal.promise, {
    activationWasActive: false,
    focusIsOnCodeCopy: true
  })
  await writeMainClipboard(keyboardSentinel)
  await assertCurrentClipboardOwned(
    'Clipboard changed outside the native smoke before keyboard copy'
  )
  await page.keyboard.press('Enter')
  await waitForMainClipboard(
    page,
    representedCode,
    'keyboard copy must write the exact represented fenced-code text'
  )
  await page
    .locator('.assistant-output-copy-feedback')
    .getByText('Code block copied.', { exact: true })
    .waitFor()
  passed('keyboard activation writes exact fenced-code text')
} catch (error) {
  primaryFailed = true
  primaryError = error
} finally {
  if (
    electronApplication &&
    originalClipboard &&
    clipboardWasMutated
  ) {
    try {
      await assertCurrentClipboardOwned(
        'Clipboard changed outside the native smoke; newer clipboard content was left untouched'
      )
      await electronApplication.evaluate(
        ({ clipboard, nativeImage }, snapshot) => {
          clipboard.clear()
          const data = {}
          if (snapshot.text) data.text = snapshot.text
          if (snapshot.html) data.html = snapshot.html
          if (snapshot.rtf) data.rtf = snapshot.rtf
          if (snapshot.bookmark?.url) {
            data.text ??= snapshot.bookmark.url
            data.bookmark = snapshot.bookmark.title
          }
          if (snapshot.imagePng) {
            data.image = nativeImage.createFromBuffer(
              Buffer.from(snapshot.imagePng, 'base64')
            )
          }
          if (Object.keys(data).length > 0) {
            clipboard.write(data)
          }
        },
        originalClipboard
      )
    } catch (error) {
      cleanupErrors.push(
        new Error('Native clipboard restoration failed', {
          cause: error
        })
      )
    }
  } else if (clipboardWasMutated) {
    cleanupErrors.push(
      new Error(
        'Native clipboard could not be restored because the Electron application was unavailable'
      )
    )
  }
  if (electronApplication) {
    try {
      await electronApplication.close()
    } catch (error) {
      cleanupErrors.push(
        new Error('Native clipboard smoke application cleanup failed', {
          cause: error
        })
      )
    }
  }
  try {
    await rm(profileDirectory, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(
      new Error('Native clipboard smoke profile cleanup failed', {
        cause: error
      })
    )
  }
}

if (primaryFailed) {
  for (const cleanupError of cleanupErrors) {
    process.stderr.write(
      `Secondary cleanup failure: ${describeError(cleanupError)}\n`
    )
  }
  throw primaryError
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    cleanupErrors,
    'Native clipboard smoke passed its assertions but cleanup failed'
  )
}
process.stdout.write(
  `Native assistant clipboard smoke passed (${completedChecks.length}/${completedChecks.length}).\n`
)
