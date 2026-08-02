import { z } from 'zod'

const serverName = z
  .string()
  .trim()
  .min(1, 'Give your server a name.')
  .max(48, 'Use 48 characters or fewer.')
  .regex(/^[^<>:"/\\|?*\u0000-\u001f]+$/, 'The name contains a character that cannot be used in a folder name.')

const javaPath = z.string().trim().min(1).max(500)
const performancePreset = z.enum(['balanced', 'far-view', 'maximum-performance', 'custom'])
const serverSoftware = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vanilla') }),
  z.object({ kind: z.literal('paper'), build: z.number().int().positive() })
])

export const instanceIdSchema = z.string().uuid()
export const minecraftVersionSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Invalid Minecraft version.')

export const createInstanceSchema = z.object({
  name: serverName,
  version: minecraftVersionSchema,
  memoryMb: z.number().int().min(1024).max(65536),
  port: z.number().int().min(1024).max(65535),
  maxPlayers: z.number().int().min(1).max(1000),
  motd: z.string().trim().min(1).max(120),
  javaPath: javaPath.optional(),
  software: serverSoftware.optional(),
  performancePreset: performancePreset.optional(),
  eulaAccepted: z.literal(true)
})

export const deleteInstanceSchema = z.object({
  id: instanceIdSchema,
  confirmationName: serverName
})

const worldSeedSchema = z
  .string()
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'The world seed cannot contain control characters.')
  .transform((value) => value.trim())
  .refine((value) => value.length <= 128, 'Use 128 characters or fewer for the world seed.')

export const regenerateWorldSchema = z.object({
  instanceId: instanceIdSchema,
  seed: worldSeedSchema,
  confirmationName: serverName
})

export const updateBackupPolicySchema = z.object({
  instanceId: instanceIdSchema,
  enabled: z.boolean(),
  intervalHours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
  retentionCount: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7), z.literal(14)])
})

export const removePaperPluginSchema = z.object({
  instanceId: instanceIdSchema,
  fileName: z.string().min(5).max(240)
    .regex(/^[^<>:"/\\|?*\u0000-\u001f]+\.jar$/i, 'Invalid plugin file name.')
})

export const catalogPluginInstallSchema = z.object({
  instanceId: instanceIdSchema,
  projectId: z.string().regex(/^[A-Za-z0-9]{8}$/, 'Invalid catalog project ID.')
})

export const catalogProjectIdSchema = z.string().regex(/^[A-Za-z0-9]{8}$/, 'Invalid catalog project ID.')

export const updateInstanceSchema = z.object({
  id: instanceIdSchema,
  name: serverName,
  memoryMb: z.number().int().min(1024).max(65536),
  port: z.number().int().min(1024).max(65535),
  maxPlayers: z.number().int().min(1).max(1000),
  motd: z.string().trim().min(1).max(120),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  onlineMode: z.boolean(),
  viewDistance: z.number().int().min(2).max(32),
  simulationDistance: z.number().int().min(2).max(32),
  performancePreset,
  javaPath
}).refine((value) => value.simulationDistance <= value.viewDistance, {
  message: 'Simulation distance cannot exceed view distance.',
  path: ['simulationDistance']
})

export const removeForceLoadedRegionSchema = z.object({
  instanceId: instanceIdSchema,
  regionId: instanceIdSchema
})

export const commandSchema = z.object({
  id: instanceIdSchema,
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine((value) => !/[\r\n]/.test(value), 'Send one command at a time.')
})

export const appSettingsSchema = z.object({
  launchAtLogin: z.boolean(),
  minimizeToTray: z.boolean()
})

export function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'The supplied values are not valid.'
}
