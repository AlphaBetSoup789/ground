import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CliAdapter, CliProvider, RunMode } from '../../shared/types'
import { normalizeCliEnvironmentVariableNames } from '../cli-environment'
import {
  executableCandidates,
  executableSearchPath,
  processLaunchArguments,
  revalidateProcessLaunchEnvelope,
  safeChildEnvironment,
  type ProcessLaunchEnvelope
} from '../process-launch'
import { terminateProcessTree } from '../process-tree'

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const MAX_NDJSON_LINE_BYTES = 2_000_000
const MAX_CLI_TEXT_BYTES = 2_000_000
const MAX_CLI_STDOUT_BYTES = 16_000_000
const MAX_CLI_STDERR_BYTES = 16_000_000
const MAX_CLI_EVENTS = 10_000
const MAX_CLI_ACTIVITY_TITLE_CHARACTERS = 500
const MAX_CLI_ACTIVITY_DETAIL_CHARACTERS = 4_000
const MAX_CLI_UNPARSED_DIAGNOSTIC_CHARACTERS = 500
const TERMINATION_GRACE_MS = 3_000
const CLI_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface CliUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  costUsd?: number
}

export interface CliActivity {
  runtimeId?: string
  activityType: 'status' | 'tool' | 'command' | 'error'
  title: string
  detail?: string
  status: 'running' | 'success' | 'error'
}

export type CliRuntimeEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string; final?: boolean }
  | { type: 'activity'; activity: CliActivity }
  | { type: 'usage'; usage: CliUsage }

export interface CliCallbacks {
  onText: (delta: string) => void
  onDiagnostic: (detail: string) => void
  onSession?: (sessionId: string) => void
  onActivity?: (activity: CliActivity) => void
  onUsage?: (usage: CliUsage) => void
}

export interface CliInvocationOptions {
  mode?: RunMode
  sessionId?: string
}

export type CliPromptSummary =
  | { transport: 'stdin' }
  | { transport: 'argument'; byteLength: number; sha256: string }

export interface CliInvocationAuthorizationRequest {
  command: string
  displayArgs: readonly string[]
  invocationSha256: string
  cwd: string
  prompt: CliPromptSummary
  promptMode: 'stdin' | 'argument'
  outputMode: 'plain' | 'ndjson'
  cliAdapter: CliAdapter
  environmentVariables: readonly string[]
  environmentFingerprint?: string
}

export interface AuthorizedCliInvocation {
  launch: ProcessLaunchEnvelope
  cwd: string
}

export type CliInvocationAuthorizer = (
  request: CliInvocationAuthorizationRequest
) => Promise<AuthorizedCliInvocation>

export interface CliRunResult {
  sessionId?: string
  usage?: CliUsage
}

function clean(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

export function assertValidCliSessionId(sessionId: string): void {
  if (!CLI_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      'CLI session identifier must be 1-256 ASCII letters, numbers, dots, underscores, colons, or hyphens'
    )
  }
}

function stripCliOptions(
  args: string[],
  optionsWithValues: ReadonlySet<string>,
  flags: ReadonlySet<string>
): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string
    const optionName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (flags.has(optionName)) continue
    if (optionsWithValues.has(optionName)) {
      if (!argument.includes('=')) index += 1
      continue
    }
    result.push(argument)
  }
  return result
}

function configureKnownAdapterArgs(
  adapter: CliAdapter,
  originalArgs: string[],
  options: CliInvocationOptions,
  modelOverride?: string
): string[] {
  const mode = options.mode ?? 'agent'
  if (adapter === 'codex') {
    let args = stripCliOptions(
      originalArgs,
      new Set(['--sandbox', '-s']),
      new Set([
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        '--full-auto'
      ])
    )
    const sandboxArgs = [
      '--sandbox',
      mode === 'ask' ? 'read-only' : 'workspace-write'
    ]
    const modelArgs =
      modelOverride &&
      !args.some((argument) =>
        ['--model', '-m'].includes(
          argument.includes('=')
            ? argument.slice(0, argument.indexOf('='))
            : argument
        )
      )
        ? ['--model', modelOverride]
        : []
    if (options.sessionId) {
      const execIndex = args.indexOf('exec')
      const promptIndex = args.lastIndexOf('-')
      if (
        execIndex === -1 ||
        promptIndex !== args.length - 1 ||
        args.slice(execIndex + 1, promptIndex).includes('resume')
      ) {
        throw new Error(
          'Codex native resume requires one unambiguous `exec … -` argument template'
        )
      }
      args = [
        ...args.slice(0, promptIndex),
        ...modelArgs,
        ...sandboxArgs,
        'resume',
        options.sessionId,
        '-'
      ]
    } else {
      const promptIndex = args.lastIndexOf('-')
      if (promptIndex === -1) args.push(...modelArgs, ...sandboxArgs)
      else args.splice(promptIndex, 0, ...modelArgs, ...sandboxArgs)
    }
    return args
  }

  if (adapter === 'claude') {
    const args = stripCliOptions(
      originalArgs,
      new Set(['--permission-mode']),
      new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'])
    )
    if (
      modelOverride &&
      !args.some((argument) =>
        argument === '--model' || argument.startsWith('--model=')
      )
    ) {
      args.push('--model', modelOverride)
    }
    args.push('--permission-mode', mode === 'ask' ? 'plan' : 'acceptEdits')
    if (options.sessionId) args.push('--resume', options.sessionId)
    return args
  }

  if (adapter === 'gemini') {
    const args = stripCliOptions(
      originalArgs,
      new Set(['--approval-mode', '--resume']),
      new Set(['--yolo', '-y', '--skip-trust'])
    )
    if (
      modelOverride &&
      !args.some((argument) =>
        ['--model', '-m'].includes(
          argument.includes('=')
            ? argument.slice(0, argument.indexOf('='))
            : argument
        )
      )
    ) {
      args.push('--model', modelOverride)
    }
    args.push('--approval-mode', mode === 'ask' ? 'plan' : 'auto_edit')
    if (options.sessionId) args.push('--resume', options.sessionId)
    return args
  }

  return originalArgs
}

export function expandCliArgs(
  provider: CliProvider,
  prompt: string,
  workspacePath: string,
  options: CliInvocationOptions = {}
): { args: string[]; stdin?: string } {
  if (options.sessionId) assertValidCliSessionId(options.sessionId)
  const replacements: Record<string, string> = {
    '{prompt}': prompt,
    '{model}': provider.model,
    '{cwd}': workspacePath,
    '{sessionId}': options.sessionId ?? ''
  }
  const expandedArgs = provider.args.map((argument) => {
    let expanded = argument
    for (const [token, value] of Object.entries(replacements)) {
      expanded = expanded.split(token).join(value)
    }
    return expanded
  })
  const modelOverride =
    provider.model.trim() &&
    !provider.args.some((argument) => argument.includes('{model}'))
      ? provider.model.trim()
      : undefined
  const args = configureKnownAdapterArgs(
    provider.cliAdapter ?? 'generic',
    expandedArgs,
    options,
    modelOverride
  )
  if (
    provider.promptMode === 'argument' &&
    !provider.args.some((argument) => argument.includes('{prompt}'))
  ) {
    args.push(prompt)
  }
  return {
    args,
    stdin: provider.promptMode === 'stdin' ? prompt : undefined
  }
}

export async function resolveExecutable(command: string): Promise<string | undefined> {
  if (!command || command.includes('\0')) return undefined
  const includesSeparator = command.includes('/') || command.includes('\\')
  const candidates: string[] = []
  if (path.isAbsolute(command) || includesSeparator) {
    const resolved = path.resolve(command)
    for (const candidate of executableCandidates(resolved)) candidates.push(candidate)
  } else {
    const searchPaths = executableSearchPath().split(path.delimiter)
    for (const directory of searchPaths) {
      if (!directory) continue
      for (const candidate of executableCandidates(command)) {
        candidates.push(path.join(directory, candidate))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate)
      const details = await stat(canonical)
      if (!details.isFile()) continue
      if (process.platform !== 'win32' && (details.mode & 0o111) === 0) continue
      return canonical
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error
    }
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function cliActivityRuntimeId(
  adapter: Exclude<CliAdapter, 'generic'>,
  value: unknown
): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const raw = String(value)
  if (!raw) return undefined
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(raw)) {
    return `${adapter}:${raw}`
  }
  return `${adapter}:sha256:${createHash('sha256').update(raw).digest('hex')}`
}

function extractSessionId(adapter: CliAdapter, event: Record<string, unknown>): string | undefined {
  if (adapter === 'codex' && event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return event.thread_id
  }
  if (
    (adapter === 'claude' || adapter === 'gemini') &&
    typeof event.session_id === 'string'
  ) {
    return event.session_id
  }
  return undefined
}

function extractTextEvent(
  adapter: CliAdapter,
  event: Record<string, unknown>
): Extract<CliRuntimeEvent, { type: 'text' }> | undefined {
  if (adapter === 'codex' && event.type === 'item.completed') {
    const item = asRecord(event.item)
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      return { type: 'text', delta: item.text, final: true }
    }
  }

  if (adapter === 'claude') {
    if (event.type === 'stream_event') {
      const streamEvent = asRecord(event.event)
      const delta = asRecord(streamEvent?.delta)
      if (streamEvent?.type === 'content_block_delta' && typeof delta?.text === 'string') {
        return { type: 'text', delta: delta.text }
      }
    }
    const delta = asRecord(event.delta)
    if (event.type === 'content_block_delta' && typeof delta?.text === 'string') {
      return { type: 'text', delta: delta.text }
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      return { type: 'text', delta: event.result, final: true }
    }
  }

  if (adapter === 'gemini' && event.type === 'message' && event.role === 'assistant') {
    if (typeof event.content === 'string') {
      return { type: 'text', delta: event.content, final: event.delta !== true }
    }
  }

  if (adapter === 'generic') {
    if (event.type === 'item.completed') {
      const item = asRecord(event.item)
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        return { type: 'text', delta: item.text, final: true }
      }
    }
    if (event.type === 'stream_event') {
      const streamEvent = asRecord(event.event)
      const delta = asRecord(streamEvent?.delta)
      if (typeof delta?.text === 'string') {
        return { type: 'text', delta: delta.text }
      }
    }
    if (event.type === 'message' && typeof event.content === 'string') {
      return { type: 'text', delta: event.content }
    }
    if (event.type === 'text' && typeof event.text === 'string') {
      return { type: 'text', delta: event.text }
    }
    if (event.type === 'delta' && typeof event.delta === 'string') {
      return { type: 'text', delta: event.delta }
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      return { type: 'text', delta: event.result, final: true }
    }
  }
  return undefined
}

function codexActivity(event: Record<string, unknown>): CliActivity | undefined {
  if (event.type === 'turn.started') {
    return {
      runtimeId: 'codex:turn',
      activityType: 'status',
      title: 'Codex turn',
      status: 'running'
    }
  }
  if (event.type === 'turn.completed') {
    return {
      runtimeId: 'codex:turn',
      activityType: 'status',
      title: 'Codex turn',
      status: 'success'
    }
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    return {
      ...(event.type === 'turn.failed' ? { runtimeId: 'codex:turn' } : {}),
      activityType: 'error',
      title: 'Codex reported an error',
      detail: compactJson(event.error ?? event.message ?? event),
      status: 'error'
    }
  }
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined
  const item = asRecord(event.item)
  if (!item || item.type === 'agent_message' || item.type === 'reasoning') return undefined
  const complete = event.type === 'item.completed'
  const itemType = typeof item.type === 'string' ? item.type : 'activity'
  const isCommand = itemType === 'command_execution'
  const title =
    typeof item.command === 'string'
      ? item.command
      : typeof item.name === 'string'
        ? item.name
        : itemType.replaceAll('_', ' ')
  return {
    runtimeId: cliActivityRuntimeId('codex', item.id),
    activityType: isCommand ? 'command' : 'tool',
    title,
    detail: compactJson(item.aggregated_output ?? item.changes ?? item),
    status:
      complete && (item.status === 'failed' || asFiniteNumber(item.exit_code))
        ? 'error'
        : complete
          ? 'success'
          : 'running'
  }
}

function claudeActivity(event: Record<string, unknown>): CliActivity | undefined {
  if (event.type === 'system' && event.subtype === 'init') {
    return {
      activityType: 'status',
      title: 'Claude session ready',
      detail: compactJson({
        model: event.model,
        permissionMode: event.permissionMode ?? event.permission_mode
      }),
      status: 'success'
    }
  }
  if (event.type === 'stream_event') {
    const streamEvent = asRecord(event.event)
    const block = asRecord(streamEvent?.content_block)
    if (streamEvent?.type === 'content_block_start' && block?.type === 'tool_use') {
      return {
        runtimeId: cliActivityRuntimeId('claude', block.id),
        activityType: block.name === 'Bash' ? 'command' : 'tool',
        title: typeof block.name === 'string' ? block.name : 'Claude tool',
        detail: compactJson(block.input),
        status: 'running'
      }
    }
  }
  if (event.type === 'result' && event.is_error === true) {
    return {
      activityType: 'error',
      title: 'Claude run failed',
      detail: typeof event.result === 'string' ? event.result : compactJson(event),
      status: 'error'
    }
  }
  return undefined
}

function geminiActivity(event: Record<string, unknown>): CliActivity | undefined {
  if (event.type === 'init') {
    return {
      activityType: 'status',
      title: 'Gemini session ready',
      detail: typeof event.model === 'string' ? `Model: ${event.model}` : undefined,
      status: 'success'
    }
  }
  if (event.type === 'tool_use') {
    return {
      runtimeId: cliActivityRuntimeId('gemini', event.tool_id),
      activityType: event.tool_name === 'run_shell_command' ? 'command' : 'tool',
      title: typeof event.tool_name === 'string' ? event.tool_name : 'Gemini tool',
      detail: compactJson(event.parameters),
      status: 'running'
    }
  }
  if (event.type === 'tool_result') {
    return {
      runtimeId: cliActivityRuntimeId('gemini', event.tool_id),
      activityType: 'tool',
      title: 'Gemini tool result',
      detail: compactJson(event.error ?? event.output),
      status: event.status === 'error' ? 'error' : 'success'
    }
  }
  if (event.type === 'error') {
    return {
      activityType: 'error',
      title: 'Gemini reported an error',
      detail: compactJson(event),
      status: 'error'
    }
  }
  return undefined
}

function extractUsage(adapter: CliAdapter, event: Record<string, unknown>): CliUsage | undefined {
  if (adapter === 'codex' && event.type === 'turn.completed') {
    const usage = asRecord(event.usage)
    if (!usage) return undefined
    return {
      inputTokens: asFiniteNumber(usage.input_tokens),
      outputTokens: asFiniteNumber(usage.output_tokens),
      cachedInputTokens: asFiniteNumber(usage.cached_input_tokens),
      reasoningTokens: asFiniteNumber(usage.reasoning_output_tokens)
    }
  }
  if (adapter === 'claude' && event.type === 'result') {
    const usage = asRecord(event.usage)
    return {
      inputTokens: asFiniteNumber(usage?.input_tokens),
      outputTokens: asFiniteNumber(usage?.output_tokens),
      cachedInputTokens:
        asFiniteNumber(usage?.cache_read_input_tokens) ??
        asFiniteNumber(usage?.cached_input_tokens),
      costUsd: asFiniteNumber(event.total_cost_usd)
    }
  }
  if (adapter === 'gemini' && event.type === 'result') {
    const stats = asRecord(event.stats)
    return {
      inputTokens: asFiniteNumber(stats?.input_tokens),
      outputTokens: asFiniteNumber(stats?.output_tokens),
      cachedInputTokens: asFiniteNumber(stats?.cached),
      totalTokens: asFiniteNumber(stats?.total_tokens)
    }
  }
  return undefined
}

export function parseCliRuntimeEvent(
  adapter: CliAdapter,
  value: unknown
): CliRuntimeEvent[] {
  const event = asRecord(value)
  if (!event) return []
  const output: CliRuntimeEvent[] = []
  const sessionId = extractSessionId(adapter, event)
  if (sessionId) output.push({ type: 'session', sessionId })
  const textEvent = extractTextEvent(adapter, event)
  if (textEvent?.delta) output.push(textEvent)
  const activity =
    adapter === 'codex'
      ? codexActivity(event)
      : adapter === 'claude'
        ? claudeActivity(event)
        : adapter === 'gemini'
          ? geminiActivity(event)
          : undefined
  if (activity) output.push({ type: 'activity', activity })
  const usage = extractUsage(adapter, event)
  if (usage && Object.values(usage).some((value) => value !== undefined)) {
    output.push({ type: 'usage', usage })
  }
  return output
}

const SHARED_CLI_NETWORK_ENVIRONMENT_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS'
] as const)

const CLI_ADAPTER_ENVIRONMENT_KEYS: Readonly<
  Record<CliAdapter, readonly string[]>
> = Object.freeze({
  generic: Object.freeze([]),
  codex: Object.freeze([
    'CODEX_HOME',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_CA_CERTIFICATE',
    'OPENAI_API_KEY',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT'
  ]),
  claude: Object.freeze([
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN'
  ]),
  gemini: Object.freeze([
    'GEMINI_CLI_HOME',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_GENAI_USE_VERTEXAI'
  ])
})

const CLI_SENSITIVE_ENVIRONMENT_KEYS: Readonly<
  Record<CliAdapter, readonly string[]>
> = Object.freeze({
  generic: Object.freeze([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ]),
  codex: Object.freeze([
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ]),
  claude: Object.freeze([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ]),
  gemini: Object.freeze([
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ])
})

/**
 * Build a deliberately small environment for one recognized CLI adapter.
 * Provider credentials are never inherited across adapters, arbitrary parent
 * variables remain unavailable, and generic CLIs receive only shared
 * proxy/certificate variables plus the process-launch baseline.
 */
export function safeCliEnvironment(
  adapter: CliAdapter,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  overrides: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const environment = safeChildEnvironment(
    [
      ...SHARED_CLI_NETWORK_ENVIRONMENT_KEYS,
      ...CLI_ADAPTER_ENVIRONMENT_KEYS[adapter]
    ],
    source,
    platform
  )
  const sensitiveNames = new Set(
    CLI_SENSITIVE_ENVIRONMENT_KEYS[adapter].map((name) =>
      name.toUpperCase()
    )
  )
  for (const [name, value] of Object.entries(environment)) {
    if (
      sensitiveNames.has(name.toUpperCase()) &&
      (value === undefined || value.length < 4 || value.includes('\0'))
    ) {
      delete environment[name]
    }
  }
  const variables = normalizeCliEnvironmentVariableNames(
    Object.keys(overrides)
  )
  for (const name of variables) {
    const value = overrides[name]
    if (
      typeof value !== 'string' ||
      value.length < 4 ||
      value.includes('\0')
    ) {
      throw new Error(`Environment variable ${name} has an invalid value`)
    }
    if (platform === 'win32') {
      for (const existing of Object.keys(environment)) {
        if (existing.toLowerCase() === name.toLowerCase()) {
          delete environment[existing]
        }
      }
    }
    environment[name] = value
  }
  return environment
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  requestedKey: string
): string | undefined {
  const key =
    process.platform === 'win32'
      ? Object.keys(environment).find(
          (candidate) =>
            candidate.toLowerCase() === requestedKey.toLowerCase()
        )
      : requestedKey
  return key ? environment[key] : undefined
}

interface CliSecretRedactionPlan {
  readonly patterns: readonly string[]
  readonly marker: string
}

function cliRedactionMarker(patterns: readonly string[]): string {
  const usedCharacters = new Set<string>()
  for (const pattern of patterns) {
    for (const character of pattern) usedCharacters.add(character)
  }
  if (!usedCharacters.has('█')) return '█'.repeat(5)
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCharCode(codePoint)
    if (!usedCharacters.has(candidate)) return candidate.repeat(5)
  }
  // Environment values cannot contain NUL. It is an invisible last-resort
  // separator that still prevents two redaction boundaries from recreating a
  // configured value if every BMP private-use character was supplied.
  return '\0'.repeat(5)
}

function cliSecretRedactionPlan(
  adapter: CliAdapter,
  environment: NodeJS.ProcessEnv,
  customEnvironment: Readonly<Record<string, string>>
): CliSecretRedactionPlan {
  const values = [
    ...new Set(
      [
        ...CLI_SENSITIVE_ENVIRONMENT_KEYS[adapter].map((key) =>
          environmentValue(environment, key)
        ),
        ...Object.values(customEnvironment)
      ].filter(
        (value): value is string =>
          typeof value === 'string' && value.length >= 4
      )
    )
  ]
  const patterns = new Set<string>()
  for (const value of values) {
    patterns.add(value)
    const serialized = JSON.stringify(value)
    patterns.add(serialized.slice(1, -1))
  }
  const sortedPatterns = Object.freeze(
    [...patterns].sort(
      (left, right) =>
        right.length - left.length || left.localeCompare(right)
    )
  )
  return Object.freeze({
    patterns: sortedPatterns,
    marker: sortedPatterns.length ? cliRedactionMarker(sortedPatterns) : ''
  })
}

function redactCliEnvironmentValues(
  value: string,
  plan: CliSecretRedactionPlan
): string {
  if (!plan.patterns.length) return value
  const redactor = new CliSecretStreamRedactor(plan)
  return `${redactor.push(value)}${redactor.finish()}`
}

function redactAndBoundCliEnvironmentValue(
  value: string,
  plan: CliSecretRedactionPlan,
  maximumCharacters: number
): string {
  return redactCliEnvironmentValues(value, plan).slice(0, maximumCharacters)
}

function containsCliEnvironmentValue(
  value: string,
  plan: CliSecretRedactionPlan
): boolean {
  return plan.patterns.some((pattern) => value.includes(pattern))
}

class CliSecretStreamRedactor {
  private pending = ''
  private readonly maximumSecretLength: number

  constructor(private readonly plan: CliSecretRedactionPlan) {
    this.maximumSecretLength = Math.max(
      0,
      ...plan.patterns.map((secret) => secret.length)
    )
  }

  push(chunk: string): string {
    if (!this.plan.patterns.length) return chunk
    this.pending += chunk
    return this.drain(false)
  }

  finish(): string {
    if (!this.plan.patterns.length) return ''
    return this.drain(true)
  }

  private drain(final: boolean): string {
    const safeStartLimit = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.maximumSecretLength + 1)
    let output = ''
    let index = 0
    while (index < safeStartLimit) {
      const secret = this.plan.patterns.find((candidate) =>
        this.pending.startsWith(candidate, index)
      )
      if (secret) {
        output += this.plan.marker
        index += secret.length
      } else {
        output += this.pending[index]
        index += 1
      }
    }
    this.pending = this.pending.slice(index)
    return output
  }
}

export function cliSessionIdContainsSensitiveValue(
  provider: CliProvider,
  sessionId: string,
  customEnvironment: Readonly<Record<string, string>>
): boolean {
  const environment = safeCliEnvironment(
    provider.cliAdapter ?? 'generic',
    process.env,
    process.platform,
    customEnvironment
  )
  return containsCliEnvironmentValue(
    sessionId,
    cliSecretRedactionPlan(
      provider.cliAdapter ?? 'generic',
      environment,
      customEnvironment
    )
  )
}

function cliPromptSummary(
  provider: CliProvider,
  prompt: string
): { summary: CliPromptSummary; displayValue: string } {
  const appearsInArgv =
    provider.promptMode === 'argument' ||
    provider.args.some((argument) => argument.includes('{prompt}'))
  if (!appearsInArgv) {
    return {
      summary: { transport: 'stdin' },
      displayValue: '<prompt delivered through stdin>'
    }
  }
  const byteLength = Buffer.byteLength(prompt, 'utf8')
  const sha256 = createHash('sha256').update(prompt).digest('hex')
  return {
    summary: { transport: 'argument', byteLength, sha256 },
    displayValue: `<prompt omitted; ${byteLength} UTF-8 bytes; SHA-256 ${sha256}>`
  }
}

function cliInvocationSha256(args: readonly string[], hasStdin: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify({ args, promptTransport: hasStdin ? 'stdin' : 'argument' }))
    .digest('hex')
}

export async function runCli(
  provider: CliProvider,
  prompt: string,
  workspacePath: string,
  signal: AbortSignal,
  callbacks: CliCallbacks,
  options: CliInvocationOptions = {},
  authorizeInvocation?: CliInvocationAuthorizer,
  customEnvironment: Readonly<Record<string, string>> = {}
): Promise<CliRunResult> {
  signal.throwIfAborted()
  if (!authorizeInvocation) {
    throw new Error('A main-process CLI invocation authorizer is required')
  }
  if (options.sessionId) assertValidCliSessionId(options.sessionId)
  const environmentVariables = normalizeCliEnvironmentVariableNames(
    provider.environmentVariables ?? []
  )
  const suppliedEnvironmentVariables = normalizeCliEnvironmentVariableNames(
    Object.keys(customEnvironment)
  )
  if (
    environmentVariables.length !== suppliedEnvironmentVariables.length ||
    environmentVariables.some(
      (name, index) => name !== suppliedEnvironmentVariables[index]
    )
  ) {
    throw new Error(
      'Resolved CLI environment does not match the saved provider profile'
    )
  }
  for (const name of suppliedEnvironmentVariables) {
    const value = customEnvironment[name]
    if (
      typeof value !== 'string' ||
      value.length < 4 ||
      value.includes('\0')
    ) {
      throw new Error(`Environment variable ${name} has an invalid value`)
    }
  }
  if (
    environmentVariables.length > 0 &&
    !/^[a-f0-9]{64}$/u.test(provider.environmentFingerprint ?? '')
  ) {
    throw new Error('CLI environment fingerprint is missing or invalid')
  }
  if (
    environmentVariables.length === 0 &&
    provider.environmentFingerprint !== undefined
  ) {
    throw new Error('CLI environment fingerprint has no variables')
  }
  const childEnvironment = safeCliEnvironment(
    provider.cliAdapter ?? 'generic',
    process.env,
    process.platform,
    customEnvironment
  )
  const environmentSecrets = cliSecretRedactionPlan(
    provider.cliAdapter ?? 'generic',
    childEnvironment,
    customEnvironment
  )
  if (
    options.sessionId &&
    containsCliEnvironmentValue(options.sessionId, environmentSecrets)
  ) {
    throw new Error(
      'Saved CLI session identifier disclosed a configured credential; Ground refused to resume it'
    )
  }
  const invocation = expandCliArgs(provider, prompt, workspacePath, options)
  const promptDetails = cliPromptSummary(provider, prompt)
  const displayInvocation = expandCliArgs(
    provider,
    promptDetails.displayValue,
    workspacePath,
    options
  )
  const authorization = await authorizeInvocation({
    command: provider.command,
    displayArgs: Object.freeze([...displayInvocation.args]),
    invocationSha256: cliInvocationSha256(
      invocation.args,
      invocation.stdin !== undefined
    ),
    cwd: workspacePath,
    prompt: promptDetails.summary,
    promptMode: provider.promptMode,
    outputMode: provider.outputMode,
    cliAdapter: provider.cliAdapter ?? 'generic',
    environmentVariables,
    ...(provider.environmentFingerprint
      ? { environmentFingerprint: provider.environmentFingerprint }
      : {})
  })
  signal.throwIfAborted()
  if (!path.isAbsolute(authorization.cwd)) {
    throw new Error('Authorized CLI working directory must be canonical and absolute')
  }
  const canonicalCwd = await realpath(authorization.cwd)
  const cwdDetails = await stat(canonicalCwd)
  if (canonicalCwd !== authorization.cwd || !cwdDetails.isDirectory()) {
    throw new Error('Authorized CLI working directory changed before launch')
  }
  await revalidateProcessLaunchEnvelope(authorization.launch)
  signal.throwIfAborted()
  const child = spawn(
    authorization.launch.executable.path,
    processLaunchArguments(authorization.launch, invocation.args),
    {
      cwd: authorization.cwd,
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    }
  )

  let stderr = ''
  let lineBuffer = ''
  let emittedText = false
  let sessionId = options.sessionId
  let usage: CliUsage | undefined
  let protocolError: Error | undefined
  let killTimer: NodeJS.Timeout | undefined
  let rawTextBytes = 0
  let emittedTextBytes = 0
  let stopping = false
  let stdoutBytes = 0
  let stderrBytes = 0
  let eventCount = 0
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const textRedactor = new CliSecretStreamRedactor(environmentSecrets)
  const stderrRedactor = new CliSecretStreamRedactor(environmentSecrets)

  const signalProcess = (processSignal: NodeJS.Signals): void => {
    if (
      child.killed ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return
    }
    terminateProcessTree(child, processSignal)
  }
  const stop = (): void => {
    if (stopping) return
    stopping = true
    if (child.exitCode !== null || child.signalCode !== null) return
    signalProcess('SIGTERM')
    killTimer = setTimeout(() => signalProcess('SIGKILL'), TERMINATION_GRACE_MS)
    killTimer.unref()
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()

  const emitRedactedText = (delta: string): void => {
    if (!delta) return
    const nextBytes = emittedTextBytes + Buffer.byteLength(delta, 'utf8')
    if (nextBytes > MAX_CLI_TEXT_BYTES) {
      protocolError = new Error(
        'CLI text output exceeded the 2 MB limit after credential redaction'
      )
      stop()
      return
    }
    emittedTextBytes = nextBytes
    callbacks.onText(delta)
  }

  const emitText = (delta: string, final = false): void => {
    if (final && emittedText) return
    const nextBytes = rawTextBytes + Buffer.byteLength(delta, 'utf8')
    if (nextBytes > MAX_CLI_TEXT_BYTES) {
      protocolError = new Error('CLI text output exceeded the 2 MB limit')
      stop()
      return
    }
    rawTextBytes = nextBytes
    emittedText = true
    emitRedactedText(textRedactor.push(delta))
  }

  const consume = (value: unknown): void => {
    for (const event of parseCliRuntimeEvent(provider.cliAdapter ?? 'generic', value)) {
      eventCount += 1
      if (eventCount > MAX_CLI_EVENTS) {
        protocolError = new Error('CLI emitted too many runtime events')
        stop()
        return
      }
      if (event.type === 'session') {
        try {
          assertValidCliSessionId(event.sessionId)
          if (
            containsCliEnvironmentValue(event.sessionId, environmentSecrets)
          ) {
            throw new Error(
              'CLI session identifier disclosed a configured credential'
            )
          }
        } catch (error) {
          protocolError =
            error instanceof Error
              ? error
              : new Error('CLI emitted an invalid session identifier')
          stop()
          return
        }
        sessionId = event.sessionId
        callbacks.onSession?.(event.sessionId)
      } else if (event.type === 'text') {
        emitText(event.delta, event.final)
      } else if (event.type === 'activity') {
        const runtimeId =
          event.activity.runtimeId &&
          !containsCliEnvironmentValue(
            event.activity.runtimeId,
            environmentSecrets
          )
            ? event.activity.runtimeId
            : undefined
        callbacks.onActivity?.({
          ...event.activity,
          ...(runtimeId ? { runtimeId } : { runtimeId: undefined }),
          title: redactAndBoundCliEnvironmentValue(
            event.activity.title,
            environmentSecrets,
            MAX_CLI_ACTIVITY_TITLE_CHARACTERS
          ),
          detail:
            event.activity.detail === undefined
              ? undefined
              : redactAndBoundCliEnvironmentValue(
                  event.activity.detail,
                  environmentSecrets,
                  MAX_CLI_ACTIVITY_DETAIL_CHARACTERS
                )
        })
      } else if (event.type === 'usage') {
        usage = event.usage
        callbacks.onUsage?.(event.usage)
      }
    }
  }

  const consumeLine = (line: string): void => {
    if (!line.trim()) return
    try {
      consume(JSON.parse(line))
    } catch (error) {
      if (error instanceof SyntaxError) {
        callbacks.onDiagnostic(
          redactAndBoundCliEnvironmentValue(
            `Unparsed CLI output: ${line}`,
            environmentSecrets,
            MAX_CLI_UNPARSED_DIAGNOSTIC_CHARACTERS
          )
        )
        return
      }
      protocolError = error instanceof Error ? error : new Error(String(error))
      stop()
    }
  }

  const consumeStdout = (decoded: string): void => {
    const chunk = clean(decoded)
    if (provider.outputMode === 'plain') {
      emitText(chunk)
      return
    }
    lineBuffer += chunk
    if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_NDJSON_LINE_BYTES) {
      protocolError = new Error('CLI emitted an oversized JSON line')
      stop()
      return
    }
    const lines = lineBuffer.split(/\r?\n/)
    lineBuffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }

  child.stdout.on('data', (raw: Buffer) => {
    stdoutBytes += raw.byteLength
    if (stdoutBytes > MAX_CLI_STDOUT_BYTES) {
      protocolError = new Error('CLI stdout exceeded the 16 MB limit')
      stop()
      return
    }
    consumeStdout(stdoutDecoder.write(raw))
  })

  child.stderr.on('data', (raw: Buffer) => {
    stderrBytes += raw.byteLength
    if (stderrBytes > MAX_CLI_STDERR_BYTES) {
      protocolError = new Error('CLI stderr exceeded the 16 MB limit')
      stop()
      return
    }
    const chunk = stderrRedactor.push(clean(stderrDecoder.write(raw)))
    if (chunk) {
      stderr = `${stderr}${chunk}`.slice(-8_000)
      callbacks.onDiagnostic(chunk)
    }
  })

  if (invocation.stdin !== undefined) {
    child.stdin.end(invocation.stdin)
  } else {
    child.stdin.end()
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (handler: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', stop)
      if (killTimer) clearTimeout(killTimer)
      handler()
    }
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, terminationSignal) => {
      finish(() => {
        consumeStdout(stdoutDecoder.end())
        const stderrTail = `${stderrRedactor.push(
          clean(stderrDecoder.end())
        )}${stderrRedactor.finish()}`
        if (stderrTail) {
          stderr = `${stderr}${stderrTail}`.slice(-8_000)
          callbacks.onDiagnostic(stderrTail)
        }
        if (signal.aborted) {
          resolve()
          return
        }
        if (provider.outputMode === 'ndjson' && lineBuffer.trim()) consumeLine(lineBuffer)
        const finalText = textRedactor.finish()
        emitRedactedText(finalText)
        if (protocolError) {
          reject(protocolError)
          return
        }
        if (code === 0) {
          if (!emittedText) callbacks.onDiagnostic('The CLI completed without a text response.')
          resolve()
        } else {
          reject(
            new Error(
              `CLI exited ${terminationSignal ? `after ${terminationSignal}` : `with code ${code ?? 'unknown'}`}${
                stderr.trim() ? ` — ${stderr.trim().slice(-2_000)}` : ''
              }`
            )
          )
        }
      })
    })
  })

  return { sessionId, usage }
}
