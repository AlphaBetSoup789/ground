export function compactPath(value?: string): string {
  if (!value) return 'No workspace'
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= 2) return value
  return `…/${parts.slice(-2).join('/')}`
}

export function workspaceName(value?: string): string {
  if (!value) return 'Scratch'
  return value.split('/').filter(Boolean).pop() ?? value
}

export function timeAgo(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime()
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function readableError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  }
  return String(error)
}
