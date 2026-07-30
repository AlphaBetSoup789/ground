import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronExecutable from 'electron'
import { _electron as electron } from 'playwright-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostPath = path.join(projectRoot, 'scripts', 'renderer-e2e-host.cjs')
const electronApplication = await electron.launch({
  executablePath: electronExecutable,
  args: [hostPath],
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  },
  timeout: 30_000
})

const page = await electronApplication.firstWindow()
page.setDefaultTimeout(20_000)

const results = []

async function resetRenderer() {
  await page.setViewportSize({ width: 1_280, height: 860 })
  await page.emulateMedia({
    reducedMotion: 'no-preference',
    forcedColors: 'none'
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByLabel('Task title').waitFor()
}

async function waitForValue(read, expected, description) {
  const deadline = Date.now() + 5_000
  let actual
  while (Date.now() < deadline) {
    actual = await read()
    if (actual === expected) return
    await page.waitForTimeout(25)
  }
  assert.equal(actual, expected, description)
}

async function run(name, test) {
  const startedAt = Date.now()
  try {
    await resetRenderer()
    await test()
    results.push({ name, ok: true, durationMs: Date.now() - startedAt })
    process.stdout.write(`✓ ${name}\n`)
  } catch (error) {
    results.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    process.stderr.write(`✗ ${name}\n${error instanceof Error ? error.stack : error}\n`)
  }
}

try {
  await run('keyboard command palette traps and restores focus', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.focus()
    assert.equal(await composer.evaluate((element) => element === document.activeElement), true)

    await page.keyboard.press('F1')
    const palette = page.getByRole('dialog', { name: 'Ground commands' })
    await palette.waitFor()

    const search = page.getByLabel('Search commands')
    await waitForValue(
      () => search.evaluate((element) => element === document.activeElement),
      true,
      'the command search should receive focus'
    )
    await search.fill('provider')
    const searchTaskAction = page.getByRole('option', { name: /Search tasks/ })
    const providerAction = page.getByRole('option', { name: /Provider settings/ })
    await searchTaskAction.waitFor()
    await providerAction.waitFor()
    await waitForValue(
      () => searchTaskAction.getAttribute('aria-selected'),
      'true',
      'the first filtered action should be selected'
    )
    await page.keyboard.press('ArrowDown')
    await waitForValue(
      () => providerAction.getAttribute('aria-selected'),
      'true',
      'ArrowDown should move command selection'
    )

    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'detached' })
    await waitForValue(
      () => composer.evaluate((element) => element === document.activeElement),
      true,
      'closing the command palette should restore focus'
    )
  })

  await run('provider form exposes labels and native constraint validation', async () => {
    await page.getByRole('button', { name: 'Providers & settings' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await page.getByRole('button', { name: 'API', exact: true }).click()

    const namedDialog = page.getByRole('dialog', { name: 'Connect a provider' })
    await namedDialog.waitFor()
    const displayName = page.getByLabel('Display name')
    const model = page.getByLabel('Model identifier')
    const baseUrl = page.getByLabel('Base URL')
    const apiKey = page.getByRole('textbox', { name: /^API key/ })
    assert.equal(await baseUrl.getAttribute('type'), 'url')
    assert.equal(await apiKey.getAttribute('type'), 'password')

    await displayName.fill('')
    await model.fill('')
    await page.getByRole('button', { name: 'Save provider' }).click()
    assert.equal(await displayName.evaluate((element) => element.matches(':invalid')), true)
    assert.notEqual(await displayName.evaluate((element) => element.validationMessage), '')
    assert.equal(
      await displayName.evaluate((element) => element === document.activeElement),
      true
    )

    await displayName.fill('Renderer test provider')
    await page.getByRole('button', { name: 'Save provider' }).click()
    assert.equal(await model.evaluate((element) => element.matches(':invalid')), true)
    assert.notEqual(await model.evaluate((element) => element.validationMessage), '')
    assert.equal(await model.evaluate((element) => element === document.activeElement), true)
  })

  await run('local provider failure explains ownership and offers an installed CLI', async () => {
    await page.getByRole('button', { name: 'Providers & settings' }).click()
    await page.getByRole('dialog', { name: 'Connect a provider' }).waitFor()

    const connectionPaths = page.getByRole('group', { name: 'Connection path' })
    await connectionPaths.waitFor()
    const localPath = connectionPaths.getByRole('radio', {
      name: /Local server/
    })
    const cliPath = connectionPaths.getByRole('radio', {
      name: /Installed CLI/
    })
    assert.equal(
      await localPath.isChecked(),
      true,
      'general settings should start a new local template, not edit the seeded provider'
    )
    await localPath.focus()
    await localPath.press('ArrowRight')
    assert.equal(await cliPath.isChecked(), true)
    assert.equal(
      await cliPath.evaluate((element) => element === document.activeElement),
      true,
      'switching connection paths with arrow keys should preserve radio focus'
    )
    await cliPath.press('ArrowLeft')
    assert.equal(await localPath.isChecked(), true)
    assert.equal(
      await localPath.evaluate((element) => element === document.activeElement),
      true
    )
    await connectionPaths.getByText('Hosted API', { exact: true }).click()
    await connectionPaths.getByText('Local server', { exact: true }).click()
    await page.getByText(
      /included local-server values are only a connection template/
    ).waitFor()

    const baseUrl = page.getByLabel('Base URL')
    assert.equal(await baseUrl.inputValue(), 'http://127.0.0.1:11434/v1')
    await page.getByLabel('Model identifier').fill('missing-local-model')
    await baseUrl.fill('http://127.0.0.1:1/v1')
    await page.getByRole('button', { name: 'Test', exact: true }).click()

    const failure = page.getByRole('alert').filter({ hasText: 'Could not connect' })
    await failure.waitFor()
    await failure.getByText('Before testing this local server again').waitFor()
    await failure.getByText(
      /Ground does not install or start the server and does not pull models/
    ).waitFor()

    await failure.getByRole('button', { name: 'Configure Codex CLI' }).click()
    assert.equal(
      await page.getByRole('radio', { name: /Installed CLI/ }).isChecked(),
      true
    )
    assert.equal(
      await page.getByRole('textbox', { name: /^Executable/ }).inputValue(),
      '/opt/homebrew/bin/codex'
    )
    await page.getByText(
      /Detection does not prove sign-in, model access, or a successful turn/
    ).waitFor()
  })

  await run('composer drafts remain task-local across task switches', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill('Dashboard-specific working draft')
    await page.getByRole('button', { name: /Explain the auth flow/ }).click()
    await waitForValue(
      () => page.getByLabel('Task title').inputValue(),
      'Explain the auth flow',
      'the selected task should change'
    )
    assert.equal(await composer.inputValue(), '')

    await composer.fill('Auth-flow-specific working draft')
    await page.getByRole('button', { name: /Refine the project dashboard/ }).click()
    assert.equal(await composer.inputValue(), 'Dashboard-specific working draft')

    await page.getByRole('button', { name: /Explain the auth flow/ }).click()
    assert.equal(await composer.inputValue(), 'Auth-flow-specific working draft')
  })

  await run('mock run can be sent and cancelled from the real renderer', async () => {
    const composer = page.getByRole('textbox', { name: 'Message' })
    const prompt = 'Cancel this deterministic renderer run'
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()

    const stop = page.getByRole('button', { name: 'Stop run' })
    await stop.waitFor()
    await stop.click()
    await page.getByText(prompt, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Send message' }).waitFor()

    const assistantMessages = page.locator('.message-assistant')
    await page.waitForTimeout(100)
    const contentAfterStop = await assistantMessages.allTextContents()
    await page.waitForTimeout(800)
    assert.deepEqual(
      await assistantMessages.allTextContents(),
      contentAfterStop,
      'cancelled preview runs must not emit later assistant output'
    )
  })

  await run('archive and search flows update the visible task scope', async () => {
    await page.getByRole('button', { name: 'Task actions' }).click()
    await page.getByRole('menuitem', { name: 'Archive task' }).click()
    await page.getByRole('status').filter({ hasText: 'Task archived' }).waitFor()
    assert.equal(await page.getByLabel('Task title').inputValue(), 'Explain the auth flow')

    await page.getByRole('button', { name: /Archived/ }).click()
    await page.getByText(/This task is archived/).waitFor()
    const archivedSearch = page.getByLabel('Search archived tasks')
    await archivedSearch.fill('dashboard')
    await page.getByRole('button', { name: /Refine the project dashboard/ }).waitFor()

    await archivedSearch.fill('does-not-exist')
    await page.getByText('No matching tasks', { exact: true }).waitFor()
  })

  await run('responsive settings and reduced-motion rules apply', async () => {
    await page.setViewportSize({ width: 680, height: 760 })
    await page.emulateMedia({
      reducedMotion: 'reduce',
      forcedColors: 'active'
    })
    assert.equal(
      await page.evaluate(() =>
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ),
      true
    )
    assert.equal(
      await page.evaluate(() =>
        window.matchMedia('(forced-colors: active)').matches
      ),
      true
    )

    await page.getByRole('button', { name: 'Providers & settings' }).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.locator('.settings-nav').isVisible(), false)
    assert.equal(await page.getByLabel('Settings section').isVisible(), true)
    const selectedConnectionPath = page.locator(
      '.connection-path-options input:checked + span'
    )
    assert.equal(await selectedConnectionPath.count(), 1)
    assert.equal(
      await selectedConnectionPath.evaluate(
        (element) => getComputedStyle(element).outlineStyle
      ),
      'solid'
    )

    const transitionDurationsMs = await page
      .getByRole('button', { name: 'Close provider settings' })
      .evaluate((element) =>
        getComputedStyle(element)
          .transitionDuration.split(',')
          .map((duration) => {
            const value = Number.parseFloat(duration)
            return duration.trim().endsWith('ms') ? value : value * 1_000
          })
      )
    assert.equal(
      transitionDurationsMs.every((duration) => duration <= 0.01),
      true,
      `expected reduced transition durations, received ${transitionDurationsMs.join(', ')}ms`
    )
  })
} finally {
  await electronApplication.close()
}

const failures = results.filter((result) => !result.ok)
if (failures.length) {
  process.stderr.write(
    `Renderer interaction evidence failed: ${failures.length}/${results.length} scenarios.\n`
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    `Renderer interaction evidence passed: ${results.length} scenarios in Electron.\n`
  )
}
