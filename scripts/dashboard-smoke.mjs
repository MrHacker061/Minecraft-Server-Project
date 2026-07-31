import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const workspace = resolve(import.meta.dirname, '..')
const testProfile = resolve(workspace, '.smoke-dashboard-data')
const artifacts = resolve(workspace, 'artifacts')
const serverId = '8f4b1cf8-7f1f-45d2-889f-2f0fc3c5f23c'
const paperServerId = '5030c6a4-1aa3-4adc-9a7c-4e1bed90fb3c'
const serverDirectory = resolve(testProfile, 'runtime-data', 'servers', serverId)
const paperServerDirectory = resolve(testProfile, 'runtime-data', 'servers', paperServerId)
await rm(testProfile, { recursive: true, force: true })
await mkdir(serverDirectory, { recursive: true })
await mkdir(paperServerDirectory, { recursive: true })
await mkdir(resolve(paperServerDirectory, 'plugins'), { recursive: true })
await mkdir(artifacts, { recursive: true })
await writeFile(resolve(paperServerDirectory, 'plugins', 'Chunky.jar'), 'seeded built-in plugin', 'utf8')
await writeFile(resolve(paperServerDirectory, 'plugins', 'ExamplePlugin.jar'), 'seeded external plugin', 'utf8')

const timestamp = '2026-07-31T12:00:00.000Z'
await writeFile(resolve(testProfile, 'runtime-data', 'emberhost.json'), `${JSON.stringify({
  schemaVersion: 2,
  settings: { launchAtLogin: false, minimizeToTray: true },
  instances: [{
    id: serverId,
    name: 'Cedar Valley',
    version: '26.2',
    serverDirectory,
    software: { kind: 'vanilla' },
    launchArtifact: 'server.jar',
    jarSha1: '823e2250d24b3ddac457a60c92a6a941943fcd6a',
    artifactSha256: null,
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
    performancePreset: 'custom',
    eulaAcceptedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  }, {
    id: paperServerId,
    name: 'Paper Ridge',
    version: '26.2',
    serverDirectory: paperServerDirectory,
    software: { kind: 'paper', build: 87, channel: 'STABLE' },
    launchArtifact: 'paper.jar',
    jarSha1: null,
    artifactSha256: 'a'.repeat(64),
    requiredJavaVersion: 25,
    javaPath: 'java',
    port: 25566,
    memoryMb: 6144,
    maxPlayers: 20,
    motd: 'Prepared for exploration',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 16,
    simulationDistance: 6,
    performancePreset: 'far-view',
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
  await window.locator('nav').getByRole('button', { name: 'World tools', exact: true }).click()
  await window.getByText('World tools need a Paper server.').waitFor()
  await window.screenshot({ path: resolve(artifacts, 'world-tools.png') })
  await window.getByRole('button', { name: 'Plugins', exact: false }).click()
  await window.getByText('Plugins need a Paper server.').waitFor()
  await window.screenshot({ path: resolve(artifacts, 'plugins-vanilla.png') })
  await window.getByLabel('Active server').selectOption(paperServerId)
  if (await window.getByLabel('Active server').inputValue() !== paperServerId) {
    throw new Error('Paper server selection did not stick.')
  }
  await window.getByText('Paper plugins', { exact: true }).waitFor()
  await window.getByText('Chunky', { exact: true }).waitFor()
  await window.getByText('ExamplePlugin', { exact: true }).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'paper-plugins.png') })
  await window.locator('nav').getByRole('button', { name: 'World tools', exact: false }).click()
  await window.getByText('World Preparation', { exact: true }).waitFor()
  await window.getByText('Force-loaded Regions', { exact: true }).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'paper-world-tools.png') })
  await window.getByRole('button', { name: 'Overview', exact: true }).click()
  await window.getByLabel('Paper server health').waitFor()
  await window.screenshot({ path: resolve(artifacts, 'paper-dashboard.png') })
  await window.getByRole('button', { name: 'Console', exact: true }).click()
  await window.getByText('Paper Ridge console').waitFor()
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByText('Server identity').waitFor()
  await window.getByRole('button', { name: 'Delete server', exact: true }).click()
  await window.getByText('Delete Paper Ridge?').waitFor()
  const deleteInput = window.locator('.confirm-dialog input')
  await deleteInput.fill('wrong name')
  if (await window.getByRole('button', { name: 'Move to recycle bin' }).isEnabled()) {
    throw new Error('Deletion confirmation accepted the wrong server name.')
  }
  await deleteInput.fill('Paper Ridge')
  if (!(await window.getByRole('button', { name: 'Move to recycle bin' }).isEnabled())) {
    throw new Error('Deletion confirmation did not accept the exact server name.')
  }
  await window.screenshot({ path: resolve(artifacts, 'delete-confirm.png') })
  await window.getByRole('button', { name: 'Cancel', exact: true }).click()
  await access(resolve(testProfile, 'runtime-data', 'emberhost.json'))
  process.stdout.write(`${JSON.stringify({ dashboard: true, browserMessages, screenshots: ['artifacts/dashboard.png', 'artifacts/world-tools.png', 'artifacts/plugins-vanilla.png', 'artifacts/paper-dashboard.png', 'artifacts/paper-world-tools.png', 'artifacts/paper-plugins.png', 'artifacts/delete-confirm.png'] })}\n`)
} finally {
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 20)
  }).catch(() => undefined)
  await application.close().catch(() => undefined)
  await rm(testProfile, { recursive: true, force: true })
}
