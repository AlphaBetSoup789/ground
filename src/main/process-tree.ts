import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export interface WindowsTaskkillCommand {
  executable: string
  args: readonly string[]
  environment: NodeJS.ProcessEnv
}

function windowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string
): string | undefined {
  const actualKey = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase()
  )
  return actualKey ? environment[actualKey] : undefined
}

export function windowsTaskkillCommand(
  pid: number,
  environment: NodeJS.ProcessEnv = process.env
): WindowsTaskkillCommand | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const systemRoot =
    windowsEnvironmentValue(environment, 'SystemRoot') ??
    windowsEnvironmentValue(environment, 'WINDIR')
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return undefined
  const normalizedRoot = path.win32.normalize(systemRoot)
  return {
    executable: path.win32.join(normalizedRoot, 'System32', 'taskkill.exe'),
    args: Object.freeze(['/PID', String(pid), '/T', '/F']),
    environment: {
      SystemRoot: normalizedRoot,
      WINDIR: normalizedRoot
    }
  }
}

function killDirectChild(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill(signal)
  } catch {
    // Process termination is best effort.
  }
}

/**
 * Terminates the process tree rooted at a child spawned by Ground.
 *
 * POSIX children are launched as process-group leaders, so a negative PID
 * reaches their descendants. Windows has no equivalent signal API in Node;
 * taskkill.exe /T is used with an exact numeric PID and no shell.
 */
export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      killDirectChild(child, signal)
      return
    }
  }

  if (platform === 'win32' && child.pid) {
    const command = windowsTaskkillCommand(child.pid, environment)
    if (command) {
      try {
        const killer = spawn(command.executable, [...command.args], {
          env: command.environment,
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        })
        let fallbackUsed = false
        const fallback = (): void => {
          if (fallbackUsed) return
          fallbackUsed = true
          killDirectChild(child, signal)
        }
        killer.once('error', fallback)
        killer.once('close', (code) => {
          if (code !== 0) fallback()
        })
        killer.unref()
        return
      } catch {
        // Fall through when taskkill cannot be launched.
      }
    }
  }

  killDirectChild(child, signal)
}
