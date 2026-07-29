let input = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  if (process.argv.includes('--split-utf8')) {
    const payload = Buffer.from(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: `Received 🌱: ${input}`
        }
      })}\n`
    )
    const emoji = Buffer.from('🌱')
    const index = payload.indexOf(emoji)
    process.stdout.write(payload.subarray(0, index + 1))
    setTimeout(() => {
      process.stdout.write(payload.subarray(index + 1, index + 3))
      setTimeout(() => process.stdout.write(payload.subarray(index + 3)), 5)
    }, 5)
    return
  }
  if (process.argv.includes('--ndjson')) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: `Received: ${input}`
        }
      })}\n`
    )
    return
  }
  process.stdout.write('Received')
  setTimeout(() => process.stdout.write(`: ${input}`), 5)
})
