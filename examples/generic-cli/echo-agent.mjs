#!/usr/bin/env node

const MAX_PROMPT_BYTES = 1_000_000
const chunks = []
let promptBytes = 0

for await (const chunk of process.stdin) {
  promptBytes += chunk.byteLength
  if (promptBytes > MAX_PROMPT_BYTES) {
    process.stderr.write('Prompt exceeded the example bridge limit.\n')
    process.exitCode = 2
    break
  }
  chunks.push(chunk)
}

if (process.exitCode) process.exit()

const prompt = Buffer.concat(chunks).toString('utf8').trim()
const response = prompt
  ? `Generic CLI bridge received: ${prompt}`
  : 'Generic CLI bridge received an empty prompt.'
const midpoint = Math.max(1, Math.ceil(response.length / 2))

for (const text of [
  response.slice(0, midpoint),
  response.slice(midpoint)
]) {
  if (!text) continue
  process.stdout.write(`${JSON.stringify({ type: 'text', text })}\n`)
}
