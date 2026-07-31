import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProcessHealthSample {
  cpuPercent: number | null
  memoryUsedMb: number | null
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function consoleMessage(line: string): string {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9A-FK-OR]/gi, '')
  const loggerBoundary = plain.indexOf(']: ')
  return loggerBoundary >= 0 ? plain.slice(loggerBoundary + 3) : plain
}

export function parseTpsLine(line: string): number | null {
  const message = consoleMessage(line)
  const match = message.match(/^TPS from last 1m, 5m, 15m:\s*\*?([\d.]+)/i)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.min(20, Math.max(0, value)) : null
}

export function isMsptHeader(line: string): boolean {
  const message = consoleMessage(line)
  return /^Server tick times \(avg\/min\/max\) from last 5s, 10s, 1m:/i.test(message)
}

export function parseMsptValuesLine(line: string): number | null {
  const message = consoleMessage(line)
  const match = message.match(/^[^A-Za-z0-9<\[]*([\d.]+)\s*\/\s*[\d.]+\s*\/\s*[\d.]+/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.max(0, value) : null
}

export async function sampleProcessHealth(pid: number): Promise<ProcessHealthSample> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { cpuPercent: null, memoryUsedMb: null }
  try {
    if (process.platform === 'win32') {
      const script = [
        `$p=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter 'IDProcess = ${pid}' -ErrorAction Stop | Select-Object -First 1`,
        `if ($null -eq $p) { throw 'Process not found' }`,
        `[pscustomobject]@{cpu=[double]$p.PercentProcessorTime;memory=[double]$p.WorkingSetPrivate}|ConvertTo-Json -Compress`
      ].join(';')
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024
      })
      const sample = JSON.parse(stdout) as { cpu?: unknown; memory?: unknown }
      const rawCpu = finiteOrNull(sample.cpu)
      const bytes = finiteOrNull(sample.memory)
      return {
        cpuPercent: rawCpu === null ? null : Math.min(100, rawCpu / Math.max(1, cpus().length)),
        memoryUsedMb: bytes === null ? null : Math.round(bytes / 1024 / 1024)
      }
    }

    const { stdout } = await execFileAsync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], {
      timeout: 5_000,
      maxBuffer: 16 * 1024
    })
    const match = stdout.trim().match(/^([\d.]+)\s+(\d+)$/)
    if (!match?.[1] || !match[2]) return { cpuPercent: null, memoryUsedMb: null }
    const cpu = finiteOrNull(match[1])
    const memoryKb = finiteOrNull(match[2])
    return {
      cpuPercent: cpu === null ? null : Math.min(100, cpu / Math.max(1, cpus().length)),
      memoryUsedMb: memoryKb === null ? null : Math.round(memoryKb / 1024)
    }
  } catch {
    return { cpuPercent: null, memoryUsedMb: null }
  }
}
