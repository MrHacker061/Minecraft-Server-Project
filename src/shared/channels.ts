export const channels = {
  getBootstrap: 'app:get-bootstrap',
  refreshInstances: 'instances:list',
  latestVersion: 'minecraft:latest-version',
  checkJava: 'java:check',
  createInstance: 'instance:create',
  updateInstance: 'instance:update',
  startInstance: 'instance:start',
  stopInstance: 'instance:stop',
  command: 'instance:command',
  getLogs: 'instance:logs',
  openFolder: 'instance:open-folder',
  openEula: 'app:open-eula',
  updateAppSettings: 'app:update-settings',
  setupProgress: 'event:setup-progress',
  consoleEntry: 'event:console-entry',
  stateChange: 'event:state-change'
} as const
