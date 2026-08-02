import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const workspace = resolve(import.meta.dirname, '..')
const testProfile = resolve(workspace, '.smoke-dashboard-data')
const artifacts = resolve(workspace, 'artifacts')
const serverId = '8f4b1cf8-7f1f-45d2-889f-2f0fc3c5f23c'
const paperServerId = '5030c6a4-1aa3-4adc-9a7c-4e1bed90fb3c'
const forgeServerId = '094231ff-d165-4268-9864-fe80565e9d35'
const serverDirectory = resolve(testProfile, 'runtime-data', 'servers', serverId)
const paperServerDirectory = resolve(testProfile, 'runtime-data', 'servers', paperServerId)
const forgeServerDirectory = resolve(testProfile, 'runtime-data', 'servers', forgeServerId)

async function waitForInputValue(input, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await input.inputValue() === expected) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Input did not reach the expected value: ${expected}`)
}

async function waitForEnabledInputValue(input, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await input.isEnabled() && await input.inputValue() === expected) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Enabled input did not settle on the expected value: ${expected}`)
}

await rm(testProfile, { recursive: true, force: true })
await mkdir(serverDirectory, { recursive: true })
await mkdir(paperServerDirectory, { recursive: true })
await mkdir(resolve(paperServerDirectory, 'plugins'), { recursive: true })
await mkdir(resolve(forgeServerDirectory, 'mods'), { recursive: true })
await mkdir(resolve(forgeServerDirectory, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.1.16'), { recursive: true })
await mkdir(artifacts, { recursive: true })
const vanillaLevelName = 'cedar_world'
const vanillaWorldDirectories = [
  resolve(serverDirectory, vanillaLevelName),
  resolve(serverDirectory, `${vanillaLevelName}_nether`),
  resolve(serverDirectory, `${vanillaLevelName}_the_end`)
]
const paperWorldDirectories = [
  resolve(paperServerDirectory, 'world'),
  resolve(paperServerDirectory, 'world_nether'),
  resolve(paperServerDirectory, 'world_the_end')
]
await Promise.all(vanillaWorldDirectories.map((directory) => mkdir(directory, { recursive: true })))
await Promise.all(vanillaWorldDirectories.map((directory, index) => writeFile(resolve(directory, 'level.dat'), `world-${index}`, 'utf8')))
await Promise.all(paperWorldDirectories.map((directory) => mkdir(directory, { recursive: true })))
await Promise.all(paperWorldDirectories.map((directory, index) => writeFile(resolve(directory, 'level.dat'), `paper-world-${index}`, 'utf8')))
await writeFile(resolve(serverDirectory, 'server.jar'), 'seeded vanilla server', 'utf8')
await writeFile(resolve(paperServerDirectory, 'paper.jar'), 'seeded paper server', 'utf8')
await writeFile(resolve(forgeServerDirectory, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.1.16', 'win_args.txt'), 'seeded Forge Windows arguments', 'utf8')
await writeFile(resolve(forgeServerDirectory, 'libraries', 'net', 'minecraftforge', 'forge', '1.21.1-52.1.16', 'unix_args.txt'), 'seeded Forge Unix arguments', 'utf8')
await writeFile(resolve(serverDirectory, 'emberhost-instance.json'), `${JSON.stringify({ id: serverId })}\n`, 'utf8')
await writeFile(resolve(paperServerDirectory, 'emberhost-instance.json'), `${JSON.stringify({ id: paperServerId })}\n`, 'utf8')
await writeFile(resolve(forgeServerDirectory, 'emberhost-instance.json'), `${JSON.stringify({ id: forgeServerId })}\n`, 'utf8')
await writeFile(resolve(serverDirectory, 'server.properties'), `# smoke properties\nlevel-name=${vanillaLevelName}\nlevel-seed=old-seed\nunknown-smoke-setting=preserve-me\n`, 'utf8')
await writeFile(resolve(paperServerDirectory, 'server.properties'), 'level-name=world\nlevel-seed=paper-seed\n', 'utf8')
await writeFile(resolve(paperServerDirectory, 'plugins', 'Chunky.jar'), 'seeded built-in plugin', 'utf8')
await writeFile(resolve(paperServerDirectory, 'plugins', 'ExamplePlugin.jar'), 'seeded external plugin', 'utf8')

const timestamp = '2026-07-31T12:00:00.000Z'
await writeFile(resolve(testProfile, 'runtime-data', 'emberhost.json'), `${JSON.stringify({
  schemaVersion: 3,
  settings: { launchAtLogin: false, minimizeToTray: true },
  instances: [{
    id: serverId,
    name: 'Cedar Valley',
    version: '26.2',
    serverDirectory,
    software: { kind: 'vanilla' },
    launch: { kind: 'jar', path: 'server.jar' },
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
    launch: { kind: 'jar', path: 'paper.jar' },
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
  }, {
    id: forgeServerId,
    name: 'Forge Hollow',
    version: '1.21.1',
    serverDirectory: forgeServerDirectory,
    software: { kind: 'forge', forgeVersion: '52.1.16', mavenVersion: '1.21.1-52.1.16', channel: 'latest', installerSha1: 'b'.repeat(40) },
    launch: {
      kind: 'java-argfile',
      windowsPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/win_args.txt',
      unixPath: 'libraries/net/minecraftforge/forge/1.21.1-52.1.16/unix_args.txt'
    },
    jarSha1: null,
    artifactSha256: null,
    requiredJavaVersion: 21,
    javaPath: 'java',
    port: 25567,
    memoryMb: 6144,
    maxPlayers: 12,
    motd: 'Ready for trusted mods',
    gameMode: 'survival',
    difficulty: 'normal',
    onlineMode: true,
    viewDistance: 10,
    simulationDistance: 8,
    performancePreset: 'custom',
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
    EMBERHOST_USER_DATA: testProfile,
    EMBERHOST_TEST_TRASH_DIRECTORY: resolve(testProfile, 'test-trash')
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
  const addressPill = window.locator('.address-pill')
  const assignedAddresses = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => {
      if (address.family !== 'IPv4' || address.internal) return false
      const [first, second] = address.address.split('.').map(Number)
      return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254)
    })
    .map((address) => address.address)
  await window.waitForFunction(({ addresses, port }) => {
    const displayed = document.querySelector('.address-pill')?.getAttribute('data-address')
    return addresses.length ? addresses.some((address) => displayed === `${address}:${port}`) : displayed === `localhost:${port}`
  }, { addresses: assignedAddresses, port: 25565 }, { timeout: 7_000 })
  const initialAddress = await addressPill.getAttribute('data-address')
  if (!initialAddress?.endsWith(':25565')) throw new Error(`Overview showed the wrong Vanilla port: ${initialAddress}`)
  await window.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (value) => { window.__emberHostSmokeCopiedAddress = value }
    })
  })
  await window.getByRole('button', { name: 'Copy server address' }).click()
  await window.getByText('Server address copied.', { exact: true }).waitFor()
  const copiedAddress = await window.evaluate(() => window.__emberHostSmokeCopiedAddress)
  if (copiedAddress !== initialAddress) throw new Error(`Copied address diverged from the display: ${copiedAddress}`)
  if (browserMessages.length) throw new Error(`Dashboard renderer errors: ${JSON.stringify(browserMessages)}`)
  await window.screenshot({ path: resolve(artifacts, 'dashboard.png') })
  await window.locator('nav').getByRole('button', { name: 'World tools', exact: true }).click()
  await window.getByText('World generation', { exact: true }).waitFor()
  await window.getByText('Advanced terrain tools need a Paper server.').waitFor()
  const seedInput = window.getByLabel('World seed')
  await seedInput.waitFor()
  await waitForInputValue(seedInput, 'old-seed')
  await seedInput.fill('new-seed-8675309')
  const regenerateButton = window.getByRole('button', { name: 'Regenerate world', exact: true })
  await regenerateButton.click()
  let regenerationDialog = window.getByRole('alertdialog', { name: 'Regenerate Cedar Valley?' })
  await regenerationDialog.getByText('The previous world is wiped before the new one is created.').waitFor()
  await regenerationDialog.getByText('This removes the active Overworld, Nether, and End, including every build, explored chunk, inventory, advancement, and player-data file in those worlds.').waitFor()
  await regenerationDialog.getByText('The old active world folders are moved to your recycle bin. Server settings, plugins, mods, and EmberHost backups remain. Minecraft creates the replacement world the next time you start the server.').waitFor()
  await regenerationDialog.getByText('New world seed').waitFor()
  const regenerationConfirmation = regenerationDialog.getByLabel('Enter Cedar Valley to confirm world regeneration')
  await regenerationConfirmation.fill('wrong name')
  if (await regenerationDialog.getByRole('button', { name: 'Wipe and regenerate world' }).isEnabled()) {
    throw new Error('World regeneration accepted the wrong server name.')
  }
  await regenerationConfirmation.fill('Cedar Valley')
  const confirmRegenerationButton = regenerationDialog.getByRole('button', { name: 'Wipe and regenerate world' })
  if (!(await confirmRegenerationButton.isEnabled())) {
    throw new Error('World regeneration did not accept the exact server name.')
  }
  await regenerationConfirmation.press('Shift+Tab')
  if (!(await confirmRegenerationButton.evaluate((element) => document.activeElement === element))) {
    throw new Error('World regeneration dialog did not contain backward keyboard focus.')
  }
  await confirmRegenerationButton.press('Tab')
  if (!(await regenerationConfirmation.evaluate((element) => document.activeElement === element))) {
    throw new Error('World regeneration dialog did not contain forward keyboard focus.')
  }
  await window.screenshot({ path: resolve(artifacts, 'regenerate-confirm.png') })
  await regenerationDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await window.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Regenerate world')
  for (const directory of vanillaWorldDirectories) await access(resolve(directory, 'level.dat'))
  if (!(await readFile(resolve(serverDirectory, 'server.properties'), 'utf8')).includes('level-seed=old-seed')) {
    throw new Error('Cancelling regeneration changed server.properties.')
  }
  await regenerateButton.click()
  regenerationDialog = window.getByRole('alertdialog', { name: 'Regenerate Cedar Valley?' })
  await regenerationDialog.getByLabel('Enter Cedar Valley to confirm world regeneration').fill('Cedar Valley')
  await regenerationDialog.getByRole('button', { name: 'Wipe and regenerate world' }).click()
  await window.getByText('World wiped. Start the server to generate seed new-seed-8675309.', { exact: true }).waitFor({ timeout: 30_000 })
  await window.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Regenerate world')
  for (const directory of vanillaWorldDirectories) {
    try {
      await access(directory)
      throw new Error(`Regeneration left the old world directory in place: ${directory}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Regeneration left')) throw error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const trashedRegenerations = await readdir(resolve(testProfile, 'test-trash'))
  if (!trashedRegenerations.some((name) => name.includes(`${serverId}.world-regeneration-`))) {
    throw new Error('Regeneration did not use the isolated smoke-test trash directory.')
  }
  const regeneratedProperties = await readFile(resolve(serverDirectory, 'server.properties'), 'utf8')
  if (!regeneratedProperties.includes('level-seed=new-seed-8675309') || !regeneratedProperties.includes('unknown-smoke-setting=preserve-me')) {
    throw new Error('Regeneration did not update the seed while preserving unknown server properties.')
  }
  if (await readFile(resolve(serverDirectory, 'server.jar'), 'utf8') !== 'seeded vanilla server') {
    throw new Error('Regeneration changed the server launch artifact.')
  }
  await window.screenshot({ path: resolve(artifacts, 'world-tools.png') })
  await window.getByRole('button', { name: 'Extensions', exact: false }).click()
  await window.getByText('This server keeps the official Vanilla experience.', { exact: true }).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'extensions-vanilla.png') })
  await window.getByLabel('Active server').selectOption(paperServerId)
  if (await window.getByLabel('Active server').inputValue() !== paperServerId) {
    throw new Error('Paper server selection did not stick.')
  }
  await window.getByText('Paper plugins', { exact: true }).waitFor()
  await window.getByText('Recommended Paper plugins', { exact: true }).waitFor()
  await window.locator('.catalog-card').first().waitFor({ timeout: 45_000 })
  if (await window.locator('.catalog-card').count() !== 12) throw new Error('The curated plugin catalog did not render all 12 projects.')
  await window.locator('.catalog-card h3').getByText('LuckPerms', { exact: true }).waitFor()
  const catalogSearch = window.getByLabel('Search curated plugins')
  await catalogSearch.fill('permissions')
  if (await catalogSearch.inputValue() !== 'permissions') throw new Error('Plugin catalog search did not accept input.')
  await catalogSearch.fill('')
  if (await window.getByLabel('Plugin category').inputValue() !== 'all') throw new Error('Plugin catalog did not default to all categories.')
  if (await window.locator('.catalog-grid img').count()) throw new Error('Catalog rendered remote icons despite the renderer CSP policy.')
  const luckPermsCard = window.locator('.catalog-card').filter({ has: window.locator('h3', { hasText: 'LuckPerms' }) })
  await luckPermsCard.getByRole('button', { name: 'Install', exact: true }).click()
  await luckPermsCard.locator('.catalog-state.installed').waitFor({ timeout: 120_000 })
  await window.locator('.plugin-row').filter({ hasText: 'LuckPerms' }).waitFor()
  const installedFiles = await readdir(resolve(paperServerDirectory, 'plugins'))
  if (!installedFiles.some((fileName) => /^LuckPerms.*\.jar$/i.test(fileName))) throw new Error('The verified catalog JAR was not installed.')
  await window.getByText('Chunky', { exact: true }).waitFor()
  await window.getByText('ExamplePlugin', { exact: true }).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'paper-plugins.png') })
  await window.locator('nav').getByRole('button', { name: 'World tools', exact: false }).click()
  await window.getByText('World generation', { exact: true }).waitFor()
  await window.getByLabel('World seed').waitFor()
  await waitForInputValue(window.getByLabel('World seed'), 'paper-seed')
  await window.getByText('World Preparation', { exact: true }).waitFor()
  await window.getByText('Force-loaded Regions', { exact: true }).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'paper-world-tools.png') })
  await window.getByRole('button', { name: 'Overview', exact: true }).click()
  await window.getByLabel('Paper server health').waitFor()
  const paperAddress = await window.locator('.address-pill').getAttribute('data-address')
  if (!paperAddress?.endsWith(':25566')) throw new Error(`Overview did not update the selected server port: ${paperAddress}`)
  await window.screenshot({ path: resolve(artifacts, 'paper-dashboard.png') })
  await window.getByRole('button', { name: 'Console', exact: true }).click()
  await window.getByText('Paper Ridge console').waitFor()
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByText('Server identity').waitFor()
  await window.getByText('Automatic world backups', { exact: true }).waitFor()
  const automaticBackupToggle = window.getByRole('checkbox', { name: /Back up this world automatically/ })
  if (!(await automaticBackupToggle.isChecked())) throw new Error('Automatic backups were not enabled by default.')
  const backupFrequency = window.getByLabel('Backup frequency')
  const backupRetention = window.getByLabel('Automatic copies to keep')
  await waitForEnabledInputValue(backupFrequency, '6')
  await waitForEnabledInputValue(backupRetention, '3')
  await backupFrequency.selectOption('12')
  await waitForEnabledInputValue(backupFrequency, '12')
  await backupRetention.selectOption('5')
  await waitForEnabledInputValue(backupRetention, '5')
  await window.getByRole('button', { name: 'Back up now', exact: true }).click()
  await window.getByText('World backup created and checked.', { exact: true }).waitFor({ timeout: 30_000 })
  await window.getByText(/1 copy ·/).waitFor()
  const automaticBackupDirectory = resolve(paperServerDirectory, 'emberhost-backups', 'automatic')
  const automaticBackupNames = (await readdir(automaticBackupDirectory)).filter((name) => /^auto-.*-[0-9a-f-]{36}$/i.test(name))
  if (automaticBackupNames.length !== 1) throw new Error(`Expected one verified automatic backup, found: ${automaticBackupNames.join(', ')}`)
  const automaticBackupPath = resolve(automaticBackupDirectory, automaticBackupNames[0])
  const backupManifest = JSON.parse(await readFile(resolve(automaticBackupPath, 'emberhost-backup.json'), 'utf8'))
  if (backupManifest.schemaVersion !== 1 || backupManifest.kind !== 'automatic' || backupManifest.instanceId !== paperServerId || backupManifest.scope !== 'active-world-only') {
    throw new Error(`Automatic backup manifest was invalid: ${JSON.stringify(backupManifest)}`)
  }
  if (backupManifest.captureMode !== 'offline' || backupManifest.worlds?.length !== 3) {
    throw new Error(`Automatic backup did not capture all three offline world folders: ${JSON.stringify(backupManifest)}`)
  }
  for (const directory of paperWorldDirectories) {
    await access(resolve(automaticBackupPath, directory.split(/[\\/]/).at(-1), 'level.dat'))
  }
  const savedBackupPolicy = JSON.parse(await readFile(resolve(paperServerDirectory, 'emberhost-backup-policy.json'), 'utf8'))
  if (!savedBackupPolicy.enabled || savedBackupPolicy.intervalHours !== 12 || savedBackupPolicy.retentionCount !== 5 || !savedBackupPolicy.lastSuccessfulAt) {
    throw new Error(`Automatic backup policy did not persist: ${JSON.stringify(savedBackupPolicy)}`)
  }
  await window.screenshot({ path: resolve(artifacts, 'backup-settings.png') })
  await window.getByLabel('Active server').selectOption(forgeServerId)
  await window.locator('nav').getByRole('button', { name: 'Mods', exact: false }).click()
  await window.getByText('Forge mods', { exact: true }).waitFor()
  await window.getByRole('button', { name: 'Browse CurseForge', exact: true }).waitFor()
  await window.getByRole('button', { name: 'Import mods folder', exact: true }).waitFor()
  await window.getByRole('button', { name: 'Add mod JAR', exact: true }).waitFor()
  await window.getByText(/await CurseForge API approval/i).waitFor()
  await window.screenshot({ path: resolve(artifacts, 'forge-mods.png') })
  await window.getByLabel('Active server').selectOption(paperServerId)
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Delete server', exact: true }).click()
  const deleteDialog = window.getByRole('dialog', { name: 'Delete Paper Ridge?' })
  await deleteDialog.waitFor()
  const deleteInput = deleteDialog.getByLabel('Enter Paper Ridge to confirm')
  await deleteInput.fill('wrong name')
  if (await deleteDialog.getByRole('button', { name: 'Move to recycle bin' }).isEnabled()) {
    throw new Error('Deletion confirmation accepted the wrong server name.')
  }
  await deleteInput.fill('Paper Ridge')
  if (!(await deleteDialog.getByRole('button', { name: 'Move to recycle bin' }).isEnabled())) {
    throw new Error('Deletion confirmation did not accept the exact server name.')
  }
  await window.screenshot({ path: resolve(artifacts, 'delete-confirm.png') })
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await access(resolve(testProfile, 'runtime-data', 'emberhost.json'))
  if (browserMessages.length) throw new Error(`Dashboard renderer errors after interactions: ${JSON.stringify(browserMessages)}`)
  process.stdout.write(`${JSON.stringify({ dashboard: true, browserMessages, screenshots: ['artifacts/dashboard.png', 'artifacts/world-tools.png', 'artifacts/regenerate-confirm.png', 'artifacts/extensions-vanilla.png', 'artifacts/paper-dashboard.png', 'artifacts/paper-world-tools.png', 'artifacts/paper-plugins.png', 'artifacts/backup-settings.png', 'artifacts/forge-mods.png', 'artifacts/delete-confirm.png'] })}\n`)
} finally {
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 20)
  }).catch(() => undefined)
  await application.close().catch(() => undefined)
  await rm(testProfile, { recursive: true, force: true })
}
