import { z } from 'zod'

const serverName = z
  .string()
  .trim()
  .min(1, 'Give your server a name.')
  .max(48, 'Use 48 characters or fewer.')
  .regex(/^[^<>:"/\\|?*\u0000-\u001f]+$/, 'The name contains a character that cannot be used in a folder name.')

const javaPath = z.string().trim().min(1).max(500)

export const instanceIdSchema = z.string().uuid()

export const createInstanceSchema = z.object({
  name: serverName,
  version: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Invalid Minecraft version.'),
  memoryMb: z.number().int().min(1024).max(65536),
  port: z.number().int().min(1024).max(65535),
  maxPlayers: z.number().int().min(1).max(1000),
  motd: z.string().trim().min(1).max(120),
  javaPath: javaPath.optional(),
  eulaAccepted: z.literal(true)
})

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
  javaPath
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
