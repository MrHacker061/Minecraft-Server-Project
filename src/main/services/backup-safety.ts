import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ServerInstance } from '../../shared/contracts'
import { AppError } from './errors'

export const BACKUP_MARKER_FILE = 'emberhost-backup-in-progress.json'

const backupMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  stagingName: z.string().regex(/^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  restartAfter: z.boolean(),
  createdAt: z.string().datetime({ offset: true })
})

export type BackupInProgressMarker = z.infer<typeof backupMarkerSchema>

export async function readBackupInProgressMarker(instance: ServerInstance): Promise<BackupInProgressMarker | null> {
  const markerPath = join(instance.serverDirectory, BACKUP_MARKER_FILE)
  try {
    const stats = await lstat(markerPath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) {
      throw new AppError(
        'The automatic-backup recovery marker is unsafe. Inspect the server folder before starting it.',
        'BACKUP_RECOVERY_REQUIRED'
      )
    }
    const parsed = backupMarkerSchema.safeParse(JSON.parse(await readFile(markerPath, 'utf8')))
    if (!parsed.success || parsed.data.instanceId !== instance.id) {
      throw new AppError(
        'The automatic-backup recovery marker is invalid or belongs to another server.',
        'BACKUP_RECOVERY_REQUIRED'
      )
    }
    return parsed.data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof AppError) throw error
    throw new AppError(
      'The automatic-backup recovery marker could not be read. Inspect the server folder before starting it.',
      'BACKUP_RECOVERY_REQUIRED',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function assertNoBackupInProgress(instance: ServerInstance): Promise<void> {
  const marker = await readBackupInProgressMarker(instance)
  if (!marker) return
  throw new AppError(
    'An automatic backup was interrupted. EmberHost must recover it before this server can start or change worlds.',
    'BACKUP_RECOVERY_REQUIRED'
  )
}
