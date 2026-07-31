import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const workspace = resolve(import.meta.dirname, '..')
const testProfile = resolve(workspace, '.smoke-dashboard-data')
const artifacts = resolve(workspace, 'artifacts')
const serverId = '8f4b1cf8-7f1f-45d2-889f-2f0fc3c5f23c'
const serverDirectory = resolve(testProfile, 'runtime-data', 'servers', serverId)
await rm(testProfile, { recursive: true, force: true })
await mkdir(serverDirectory, { recursive: true })
await mkdir(artifacts, { recursive: true })

const timestamp = '2026-07-31T12:00:00.000Z'
await writeFile(resolve(testProfile, 'runtime-data', 'emberhost.json'), `${JSON.stringify({
  schemaVersion: 1,
  settings: { launchAtLogin: false, minimizeToTray: true },
  instances: [{
    id: serverId,
    name: 'Cedar Valley',
    version: '26.2',
    serverDirectory,
    jarSha1: '823e2250d24b3ddac457a60c92a6a941943fcd6a',
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25565,
    memoryMb: 4096,
    maxPlayers: 20,
    motd: 'A quiet place to build',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 10,
    simulationDistance: 10,
    eulaAcceptedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  }]
}, null, 2)}\n`, 'utf8')

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
  await window.locator('.hero-card').waitFor({ timeout: 30_000 })
  await window.locator('.topbar h1').getByText('Cedar Valley', { exact: true }).waitFor()
  if (browserMessages.length) throw new Error(`Dashboard renderer errors: ${JSON.stringify(browserMessages)}`)
  await window.screenshot({ path: resolve(artifacts, 'dashboard.png') })
  await window.getByRole('button', { name: 'Console', exact: true }).click()
  await window.getByText('Cedar Valley console').waitFor()
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByText('Server identity').waitFor()
  await access(resolve(testProfile, 'runtime-data', 'emberhost.json'))
  process.stdout.write(`${JSON.stringify({ dashboard: true, browserMessages, screenshot: 'artifacts/dashboard.png' })}\n`)
} finally {
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 20)
  }).catch(() => undefined)
  await application.close().catch(() => undefined)
  await rm(testProfile, { recursive: true, force: true })
}
