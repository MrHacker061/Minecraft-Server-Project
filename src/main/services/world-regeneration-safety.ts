import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'

export async function assertNoInterruptedWorldRegeneration(instance: ServerInstance): Promise<void> {
  const prefix = `.${instance.id}.world-regeneration-`
  let entries
  try {
    entries = await readdir(dirname(instance.serverDirectory), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const recoveryEntry = entries.find((entry) => entry.name.startsWith(prefix))
  if (!recoveryEntry) return
  throw new AppError(
    `EmberHost found an interrupted world regeneration for ${instance.name}. Do not start or regenerate this server until the recovery folder ${recoveryEntry.name} has been inspected and restored.`,
    'WORLD_REGENERATION_RECOVERY_REQUIRED'
  )
}
