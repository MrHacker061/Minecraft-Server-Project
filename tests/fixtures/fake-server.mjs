import { createInterface } from 'node:readline'

process.stdout.write('[Server thread/INFO]: Starting fake Minecraft server\n')
const readinessDelay = Number.parseInt(process.argv[2] ?? '50', 10)
const stopMode = process.argv[3] ?? 'clean-stop'
const autoJoinDelay = Number.parseInt(process.argv[4] ?? '', 10)
setTimeout(() => process.stdout.write('[Server thread/INFO]: Done (0.05s)! For help, type "help"\n'), readinessDelay)
if (Number.isFinite(autoJoinDelay)) {
  setTimeout(() => process.stdout.write('[Server thread/INFO]: LatePlayer joined the game\n'), autoJoinDelay)
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
if (stopMode === 'closed-stdin') {
  input.close()
  process.stdin.destroy()
  setInterval(() => undefined, 1_000)
}
input.on('line', (line) => {
  if (line === 'stop') {
    process.stdout.write('[Server thread/INFO]: Stopping server\n')
    if (stopMode === 'nonzero-stop') process.exit(7)
    if (stopMode !== 'ignore-stop') process.exit(0)
    return
  }
  const joined = line.match(/^join ([A-Za-z0-9_]{1,16})$/)
  if (joined) {
    process.stdout.write(`[Server thread/INFO]: ${joined[1]} joined the game\n`)
    return
  }
  process.stdout.write(`[Server thread/INFO]: Executed ${line}\n`)
})
