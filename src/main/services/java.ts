import { spawn } from 'node:child_process'
import type { JavaStatus } from '../../shared/contracts'

export function parseJavaMajorVersion(output: string): number | null {
  const match = output.match(/(?:java|openjdk) version\s+"([^"]+)"/i)
  if (!match?.[1]) return null
  const segments = match[1].split(/[._-]/)
  const first = Number.parseInt(segments[0] ?? '', 10)
  if (!Number.isFinite(first)) return null
  if (first === 1) {
    const legacy = Number.parseInt(segments[1] ?? '', 10)
    return Number.isFinite(legacy) ? legacy : null
  }
  return first
}

export async function checkJava(command = 'java'): Promise<JavaStatus> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(command, ['-version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const finish = (status: JavaStatus): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(status)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({
        available: false,
        command,
        majorVersion: null,
        versionText: null,
        error: error.message
      })
    })
    child.on('close', (code) => {
      const cleaned = output.trim()
      const majorVersion = parseJavaMajorVersion(cleaned)
      finish({
        available: code === 0 && majorVersion !== null,
        command,
        majorVersion,
        versionText: cleaned.split(/\r?\n/)[0] ?? null,
        error: code === 0 && majorVersion !== null ? null : 'Java did not return a recognizable version.'
      })
    })

    const timeout = setTimeout(() => {
      child.kill()
      finish({
        available: false,
        command,
        majorVersion: null,
        versionText: null,
        error: 'Java did not respond within 8 seconds.'
      })
    }, 8_000)
  })
}
