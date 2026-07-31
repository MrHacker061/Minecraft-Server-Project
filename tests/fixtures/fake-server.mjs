import { createInterface } from 'node:readline'

process.stdout.write('[Server thread/INFO]: Starting fake Minecraft server\n')
setTimeout(() => process.stdout.write('[Server thread/INFO]: Done (0.05s)! For help, type "help"\n'), 50)

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (line === 'stop') {
    process.stdout.write('[Server thread/INFO]: Stopping server\n')
    process.exit(0)
  }
  process.stdout.write(`[Server thread/INFO]: Executed ${line}\n`)
})
