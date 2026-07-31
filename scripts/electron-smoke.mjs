import { access, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const workspace = resolve(import.meta.dirname, '..')
const testProfile = resolve(workspace, '.smoke-user-data')
const artifacts = resolve(workspace, 'artifacts')
await rm(testProfile, { recursive: true, force: true })
await mkdir(artifacts, { recursive: true })

const packagedExecutable = process.env.EMBERHOST_EXECUTABLE
const application = await electron.launch({
  ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
  args: packagedExecutable ? [] : ['.'],
  cwd: workspace,
  env: {
    ...process.env,
    ...(packagedExecutable ? { NODE_ENV: 'test' } : {}),
    EMBERHOST_USER_DATA: testProfile
  }
})

try {
  const window = await application.firstWindow()
  const browserMessages = []
  window.on('console', (message) => browserMessages.push(`[console:${message.type()}] ${message.text()}`))
  window.on('pageerror', (error) => browserMessages.push(`[pageerror] ${error.message}`))
  await window.waitForLoadState('domcontentloaded')
  await window.locator('.setup-dialog, .fatal-screen').first().waitFor({ timeout: 25_000 }).catch(() => undefined)
  const security = await window.evaluate(() => ({
    title: document.title,
    apiAvailable: typeof window.emberHost === 'object',
    nodeRequireAvailable: typeof window.require !== 'undefined',
    bodyText: document.body.innerText.slice(0, 500)
  }))
  if (security.title !== 'EmberHost' || !security.apiAvailable || security.nodeRequireAvailable) {
    throw new Error(`Unexpected renderer security state: ${JSON.stringify({ security, browserMessages })}`)
  }
  await window.screenshot({ path: resolve(artifacts, 'onboarding.png') })
  if (!security.bodyText.includes('Build a world that stays yours.')) {
    throw new Error(`Onboarding did not render: ${JSON.stringify({ security, browserMessages })}`)
  }
  const releaseSelect = window.getByLabel('Minecraft release')
  await releaseSelect.waitFor()
  const initialRelease = await releaseSelect.inputValue()
  const releaseOptions = await releaseSelect.locator('option').allTextContents()
  if (!releaseOptions.some((option) => option.startsWith('1.20.1')) || !releaseOptions.some((option) => option.startsWith('1.0'))) {
    throw new Error(`Official Mojang release catalog was incomplete: ${JSON.stringify(releaseOptions.slice(-12))}`)
  }
  await releaseSelect.selectOption('1.20.1')
  await window.getByText('Official Mojang server · Requires Java 17').waitFor({ timeout: 25_000 })
  await releaseSelect.selectOption('1.0')
  await window.getByText('Minecraft 1.0 does not provide a vanilla server download.').waitFor({ timeout: 25_000 })
  if (await window.getByRole('button', { name: 'Continue' }).isEnabled()) {
    throw new Error('Creation advanced for an official release without a Mojang server artifact.')
  }
  await releaseSelect.selectOption(initialRelease)
  const paperChoice = window.locator('input[name="software"][value="paper"]')
  await paperChoice.locator('xpath=..').waitFor()
  for (let attempt = 0; attempt < 100 && !(await paperChoice.isEnabled()); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  if (!(await paperChoice.isEnabled())) throw new Error(`Paper did not become available for Minecraft ${initialRelease}.`)
  await paperChoice.check()
  await window.getByRole('button', { name: 'Continue' }).click()
  await window.getByText('Shape performance').waitFor()
  await window.getByRole('button', { name: 'Continue' }).click()
  await window.getByText('Ready to create').waitFor()
  if (await window.locator('.eula-check input').isChecked()) {
    throw new Error('The Minecraft EULA checkbox must be unchecked by default.')
  }
  if (await window.getByRole('button', { name: 'Download & create' }).isEnabled()) {
    throw new Error('Server creation must remain disabled until the EULA is accepted.')
  }
  await window.screenshot({ path: resolve(artifacts, 'review.png') })
  await access(resolve(testProfile, 'runtime-data', 'emberhost.json'))
  process.stdout.write(`${JSON.stringify({ ...security, bodyText: undefined, browserMessages, screenshots: ['artifacts/onboarding.png', 'artifacts/review.png'] })}\n`)
} finally {
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 20)
  }).catch(() => undefined)
  await application.close().catch(() => undefined)
  await rm(testProfile, { recursive: true, force: true })
}
