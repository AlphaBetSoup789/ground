import path from 'node:path'
import { z } from 'zod'
import type {
  ActivityItem,
  PortableJsonObject,
  PortableJsonValue,
  ProviderProfile,
  StoredModelConversationItem,
  Task,
  TaskItem
} from '../shared/types'

export const GROUND_TASK_BUNDLE_KIND = 'ground.task-bundle' as const
export const GROUND_TASK_BUNDLE_VERSION = 1 as const
export const GROUND_TASK_BUNDLE_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema' as const
export const GROUND_TASK_BUNDLE_SCHEMA_ID = 'urn:ground:schema:task-bundle:1' as const

export const GROUND_TASK_BUNDLE_LIMITS = Object.freeze({
  serializedBytes: 5_000_000,
  maximumDepth: 64,
  maximumNodes: 100_000,
  maximumObjectProperties: 50_000,
  maximumArrayItems: 50_000,
  maximumStrings: 50_000,
  maximumStringCharacters: 4_500_000,
  maximumSingleStringCharacters: 1_000_000,
  maximumSingleArrayItems: 10_000,
  maximumTimelineItems: 5_000,
  maximumConversationItems: 5_000,
  maximumPartsPerMessage: 1_000,
  maximumToolResultParts: 1_000
})

const MAX_IDENTIFIER_CHARACTERS = 512
const MAX_TITLE_CHARACTERS = 200
const MAX_PROVIDER_NAME_CHARACTERS = 200
const MAX_MODEL_CHARACTERS = 512
const MAX_TOOL_NAME_CHARACTERS = 512
const MAX_MARKDOWN_BYTES = GROUND_TASK_BUNDLE_LIMITS.serializedBytes * 2
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const OMITTED_JSON_KEYS = new Set([
  'providermetadata',
  'provideroptions',
  'providerstate'
])
const SECRET_JSON_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'password',
  'refreshtoken',
  'secret',
  'token'
])

export type GroundTaskBundleErrorCode =
  | 'INVALID_BUNDLE'
  | 'INVALID_SOURCE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_VERSION'

export class GroundTaskBundleError extends Error {
  readonly code: GroundTaskBundleErrorCode

  constructor(
    code: GroundTaskBundleErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'GroundTaskBundleError'
    this.code = code
  }
}

const boundedString = (
  maximum: number = GROUND_TASK_BUNDLE_LIMITS.maximumSingleStringCharacters
) =>
  z.string().max(maximum)

const displayString = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
      message: 'Control characters are not allowed'
    })

const identifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_CHARACTERS)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Control characters are not allowed'
  })

const timestampSchema = z.iso.datetime({ offset: true })

const portableJsonValueSchema: z.ZodType<PortableJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    boundedString(),
    z
      .array(portableJsonValueSchema)
      .max(GROUND_TASK_BUNDLE_LIMITS.maximumSingleArrayItems),
    z
      .record(
        z
          .string()
          .min(1)
          .max(MAX_IDENTIFIER_CHARACTERS)
          .refine((key) => !DANGEROUS_OBJECT_KEYS.has(key), {
            message: 'Dangerous object keys are not allowed'
          }),
        portableJsonValueSchema
      )
      .refine(
        (value) =>
          Object.keys(value).length <=
          GROUND_TASK_BUNDLE_LIMITS.maximumSingleArrayItems,
        { message: 'Object has too many properties' }
      )
  ])
)

const portableJsonObjectSchema: z.ZodType<PortableJsonObject> = z.record(
  z
    .string()
    .min(1)
    .max(MAX_IDENTIFIER_CHARACTERS)
    .refine((key) => !DANGEROUS_OBJECT_KEYS.has(key), {
      message: 'Dangerous object keys are not allowed'
    }),
  portableJsonValueSchema
)

const providerDescriptorSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('model-api'),
      kind: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
      name: displayString(MAX_PROVIDER_NAME_CHARACTERS),
      model: boundedString(MAX_MODEL_CHARACTERS),
      supportsTools: z.boolean()
    })
    .strict(),
  z
    .object({
      type: z.literal('agent-cli'),
      kind: z.literal('cli'),
      name: displayString(MAX_PROVIDER_NAME_CHARACTERS),
      model: boundedString(MAX_MODEL_CHARACTERS),
      adapter: z.enum([
        'generic',
        'codex',
        'claude',
        'gemini',
        'antigravity'
      ])
    })
    .strict()
])

const providerAttributionSchema = z
  .object({
    kind: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'cli']),
    name: displayString(80),
    model: boundedString(200)
  })
  .strict()

const timelineEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      role: z.enum(['user', 'assistant']),
      content: boundedString(),
      recordedAt: timestampSchema,
      provider: providerAttributionSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('activity'),
      activityType: z.enum([
        'status',
        'tool',
        'command',
        'approval',
        'error',
        'diagnostic'
      ]),
      title: boundedString(MAX_TITLE_CHARACTERS),
      detail: boundedString().optional(),
      status: z.enum(['success', 'error', 'denied', 'interrupted']),
      recordedAt: timestampSchema,
      toolName: boundedString(MAX_TOOL_NAME_CHARACTERS).optional(),
      input: portableJsonObjectSchema.optional(),
      result: boundedString().optional(),
      durationMs: z.number().finite().int().nonnegative().max(86_400_000).optional(),
      provider: providerAttributionSchema.optional()
    })
    .strict()
])

const conversationPartSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      text: boundedString()
    })
    .strict(),
  z
    .object({
      kind: z.literal('reasoning-summary'),
      text: boundedString()
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-call'),
      callId: identifierSchema,
      name: boundedString(MAX_TOOL_NAME_CHARACTERS),
      rawArguments: boundedString(),
      arguments: portableJsonObjectSchema.optional(),
      parseError: boundedString().optional()
    })
    .strict()
])

const toolResultContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      text: boundedString()
    })
    .strict(),
  z
    .object({
      kind: z.literal('json'),
      value: portableJsonValueSchema
    })
    .strict()
])

const conversationItemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      role: z.enum(['user', 'assistant']),
      parts: z
        .array(conversationPartSchema)
        .max(GROUND_TASK_BUNDLE_LIMITS.maximumPartsPerMessage)
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-result'),
      callId: identifierSchema,
      name: boundedString(MAX_TOOL_NAME_CHARACTERS).optional(),
      content: z
        .array(toolResultContentSchema)
        .max(GROUND_TASK_BUNDLE_LIMITS.maximumToolResultParts),
      isError: z.boolean().optional()
    })
    .strict()
])

export const groundTaskBundleV1Schema = z
  .object({
    $schema: z.literal(GROUND_TASK_BUNDLE_SCHEMA_DIALECT),
    kind: z.literal(GROUND_TASK_BUNDLE_KIND),
    version: z.literal(GROUND_TASK_BUNDLE_VERSION),
    exportedAt: timestampSchema,
    provider: providerDescriptorSchema,
    task: z
      .object({
        title: displayString(MAX_TITLE_CHARACTERS),
        mode: z.enum(['ask', 'agent']),
        sourceCreatedAt: timestampSchema,
        sourceUpdatedAt: timestampSchema,
        timeline: z
          .array(timelineEntrySchema)
          .max(GROUND_TASK_BUNDLE_LIMITS.maximumTimelineItems),
        conversation: z
          .array(conversationItemSchema)
          .max(GROUND_TASK_BUNDLE_LIMITS.maximumConversationItems)
      })
      .strict()
  })
  .strict()

export type GroundTaskBundleV1 = z.infer<typeof groundTaskBundleV1Schema>
export type GroundProviderDescriptor = GroundTaskBundleV1['provider']
export type GroundTimelineEntry = GroundTaskBundleV1['task']['timeline'][number]
export type GroundProviderAttribution = NonNullable<GroundTimelineEntry['provider']>
export type GroundConversationItem = GroundTaskBundleV1['task']['conversation'][number]
export type GroundImportedTimelineEntry = GroundTimelineEntry extends infer Entry
  ? Entry extends { recordedAt: string }
    ? Omit<Entry, 'recordedAt'>
    : never
  : never

export interface GroundTaskImportTemplate {
  title: string
  mode: 'ask' | 'agent'
  provider: GroundProviderDescriptor
  timeline: GroundImportedTimelineEntry[]
  conversation: GroundConversationItem[]
  source: {
    formatVersion: 1
    exportedAt: string
  }
}

export interface GroundTaskBundleExportOptions {
  now?: () => string
}

export const GROUND_TASK_BUNDLE_JSON_SCHEMA = Object.freeze({
  ...z.toJSONSchema(groundTaskBundleV1Schema, {
    target: 'draft-2020-12'
  }),
  $id: GROUND_TASK_BUNDLE_SCHEMA_ID,
  title: 'Ground task bundle version 1'
})

interface JsonAuditBudget {
  nodes: number
  properties: number
  arrayItems: number
  strings: number
  stringCharacters: number
}

interface SanitizerContext {
  workspaceVariants: string[]
  budget: JsonAuditBudget
  seen: WeakSet<object>
}

interface ConversationCallIds {
  next: number
  values: Map<string, string>
}

function taskBundleError(
  code: GroundTaskBundleErrorCode,
  message: string,
  cause?: unknown
): GroundTaskBundleError {
  return new GroundTaskBundleError(code, message, cause === undefined ? undefined : { cause })
}

function inspectJsonTree(
  value: unknown,
  label: string,
  options: { allowUndefinedObjectProperties?: boolean } = {}
): void {
  const budget: JsonAuditBudget = {
    nodes: 0,
    properties: 0,
    arrayItems: 0,
    strings: 0,
    stringCharacters: 0
  }
  const ancestors = new Set<object>()

  const inspect = (item: unknown, depth: number): void => {
    budget.nodes += 1
    if (budget.nodes > GROUND_TASK_BUNDLE_LIMITS.maximumNodes) {
      throw taskBundleError('TOO_LARGE', `${label} contains too many values`)
    }
    if (depth > GROUND_TASK_BUNDLE_LIMITS.maximumDepth) {
      throw taskBundleError('TOO_LARGE', `${label} is nested too deeply`)
    }

    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw taskBundleError('INVALID_SOURCE', `${label} contains a non-finite number`)
      }
      return
    }
    if (typeof item === 'string') {
      countString(item, budget, label)
      return
    }
    if (typeof item !== 'object') {
      throw taskBundleError('INVALID_SOURCE', `${label} contains a non-JSON value`)
    }
    if (ancestors.has(item)) {
      throw taskBundleError('INVALID_SOURCE', `${label} contains a cycle`)
    }
    ancestors.add(item)

    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) {
          throw taskBundleError('INVALID_SOURCE', `${label} contains a non-plain array`)
        }
        if (Object.getOwnPropertySymbols(item).length) {
          throw taskBundleError('INVALID_SOURCE', `${label} contains symbol properties`)
        }
        if (item.length > GROUND_TASK_BUNDLE_LIMITS.maximumSingleArrayItems) {
          throw taskBundleError('TOO_LARGE', `${label} contains an oversized array`)
        }
        budget.arrayItems += item.length
        if (budget.arrayItems > GROUND_TASK_BUNDLE_LIMITS.maximumArrayItems) {
          throw taskBundleError('TOO_LARGE', `${label} contains too many array entries`)
        }
        const propertyNames = Object.getOwnPropertyNames(item)
        if (
          propertyNames.length !== item.length + 1 ||
          !propertyNames.includes('length')
        ) {
          throw taskBundleError(
            'INVALID_SOURCE',
            `${label} contains a sparse or decorated array`
          )
        }
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw taskBundleError(
              'INVALID_SOURCE',
              `${label} contains an invalid array entry`
            )
          }
          inspect(descriptor.value, depth + 1)
        }
        return
      }

      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        throw taskBundleError('INVALID_SOURCE', `${label} contains a non-plain object`)
      }
      if (Object.getOwnPropertySymbols(item).length) {
        throw taskBundleError('INVALID_SOURCE', `${label} contains symbol properties`)
      }
      const names = Object.getOwnPropertyNames(item)
      budget.properties += names.length
      if (budget.properties > GROUND_TASK_BUNDLE_LIMITS.maximumObjectProperties) {
        throw taskBundleError('TOO_LARGE', `${label} contains too many object properties`)
      }
      for (const name of names) {
        if (DANGEROUS_OBJECT_KEYS.has(name)) {
          throw taskBundleError(
            'INVALID_SOURCE',
            `${label} contains a dangerous object property`
          )
        }
        countString(name, budget, label)
        const descriptor = Object.getOwnPropertyDescriptor(item, name)
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw taskBundleError(
            'INVALID_SOURCE',
            `${label} contains accessors or hidden properties`
          )
        }
        if (
          descriptor.value === undefined &&
          options.allowUndefinedObjectProperties
        ) {
          continue
        }
        inspect(descriptor.value, depth + 1)
      }
    } finally {
      ancestors.delete(item)
    }
  }

  inspect(value, 0)
}

function countString(value: string, budget: JsonAuditBudget, label: string): void {
  if (value.length > GROUND_TASK_BUNDLE_LIMITS.maximumSingleStringCharacters) {
    throw taskBundleError('TOO_LARGE', `${label} contains an oversized string`)
  }
  budget.strings += 1
  budget.stringCharacters += value.length
  if (budget.strings > GROUND_TASK_BUNDLE_LIMITS.maximumStrings) {
    throw taskBundleError('TOO_LARGE', `${label} contains too many strings`)
  }
  if (
    budget.stringCharacters >
    GROUND_TASK_BUNDLE_LIMITS.maximumStringCharacters
  ) {
    throw taskBundleError('TOO_LARGE', `${label} contains too much string data`)
  }
}

function ensureSerializedSize(serialized: string, label: string): void {
  if (Buffer.byteLength(serialized, 'utf8') > GROUND_TASK_BUNDLE_LIMITS.serializedBytes) {
    throw taskBundleError(
      'TOO_LARGE',
      `${label} exceeds the ${GROUND_TASK_BUNDLE_LIMITS.serializedBytes} byte limit`
    )
  }
}

function parseBundleInputUnchecked(input: string | unknown): GroundTaskBundleV1 {
  let value: unknown = input
  if (typeof input === 'string') {
    ensureSerializedSize(input, 'Task bundle')
    try {
      value = JSON.parse(input) as unknown
    } catch (error) {
      throw taskBundleError('INVALID_BUNDLE', 'Task bundle is not valid JSON', error)
    }
  }

  try {
    inspectJsonTree(value, 'Task bundle')
  } catch (error) {
    if (error instanceof GroundTaskBundleError) {
      throw new GroundTaskBundleError(
        error.code === 'INVALID_SOURCE' ? 'INVALID_BUNDLE' : error.code,
        error.message,
        { cause: error }
      )
    }
    throw error
  }

  if (isPlainRecord(value) && value.kind === GROUND_TASK_BUNDLE_KIND) {
    if (value.version !== GROUND_TASK_BUNDLE_VERSION) {
      throw taskBundleError(
        'UNSUPPORTED_VERSION',
        `Unsupported Ground task bundle version: ${String(value.version)}`
      )
    }
  }

  const parsed = groundTaskBundleV1Schema.safeParse(value)
  if (!parsed.success) {
    throw taskBundleError(
      'INVALID_BUNDLE',
      `Task bundle failed strict validation: ${z.prettifyError(parsed.error)}`
    )
  }
  const serialized = JSON.stringify(parsed.data)
  ensureSerializedSize(serialized, 'Task bundle')
  inspectJsonTree(parsed.data, 'Task bundle')
  return parsed.data
}

function parseBundleInput(input: string | unknown): GroundTaskBundleV1 {
  try {
    return parseBundleInputUnchecked(input)
  } catch (error) {
    if (error instanceof GroundTaskBundleError) throw error
    throw taskBundleError('INVALID_BUNDLE', 'Task bundle is not safe JSON', error)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizedSensitiveKey(key: string): string {
  return key.replace(/[-_\s]/gu, '').toLowerCase()
}

function shouldOmitJsonKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key)
  return OMITTED_JSON_KEYS.has(normalized) || SECRET_JSON_KEYS.has(normalized)
}

function createWorkspaceVariants(workspacePath: string | undefined): string[] {
  if (!workspacePath || !path.isAbsolute(workspacePath)) return []
  const normalized = path.normalize(workspacePath).replace(/[\\/]+$/u, '')
  if (!normalized || normalized === path.parse(normalized).root) return []
  return [
    normalized,
    normalized.split(path.sep).join('/'),
    normalized.replaceAll('/', '\\')
  ]
    .filter((value, index, values) => value.length > 1 && values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length)
}

function redactWorkspace(value: string, variants: readonly string[]): string {
  let redacted = value
  for (const variant of variants) {
    if (process.platform === 'win32') {
      redacted = redacted.replace(new RegExp(escapeRegExp(variant), 'giu'), '<workspace>')
    } else {
      redacted = redacted.split(variant).join('<workspace>')
    }
  }
  return redacted
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function newSanitizerContext(workspacePath: string | undefined): SanitizerContext {
  return {
    workspaceVariants: createWorkspaceVariants(workspacePath),
    budget: {
      nodes: 0,
      properties: 0,
      arrayItems: 0,
      strings: 0,
      stringCharacters: 0
    },
    seen: new WeakSet<object>()
  }
}

function sanitizeText(value: string, context: SanitizerContext, label: string): string {
  if (typeof value !== 'string') {
    throw taskBundleError('INVALID_SOURCE', `${label} must be a string`)
  }
  const redacted = redactWorkspace(value, context.workspaceVariants)
  countString(redacted, context.budget, label)
  return redacted
}

function sanitizePortableJson(
  value: unknown,
  context: SanitizerContext,
  label: string,
  depth = 0
): PortableJsonValue {
  context.budget.nodes += 1
  if (context.budget.nodes > GROUND_TASK_BUNDLE_LIMITS.maximumNodes) {
    throw taskBundleError('TOO_LARGE', `${label} contains too many values`)
  }
  if (depth > GROUND_TASK_BUNDLE_LIMITS.maximumDepth) {
    throw taskBundleError('TOO_LARGE', `${label} is nested too deeply`)
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw taskBundleError('INVALID_SOURCE', `${label} contains a non-finite number`)
    }
    return value
  }
  if (typeof value === 'string') return sanitizeText(value, context, label)
  if (!value || typeof value !== 'object') {
    throw taskBundleError('INVALID_SOURCE', `${label} contains a non-JSON value`)
  }
  if (context.seen.has(value)) {
    throw taskBundleError('INVALID_SOURCE', `${label} contains a cycle`)
  }
  context.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > GROUND_TASK_BUNDLE_LIMITS.maximumSingleArrayItems) {
        throw taskBundleError('TOO_LARGE', `${label} contains an oversized array`)
      }
      context.budget.arrayItems += value.length
      if (
        context.budget.arrayItems >
        GROUND_TASK_BUNDLE_LIMITS.maximumArrayItems
      ) {
        throw taskBundleError('TOO_LARGE', `${label} contains too many array entries`)
      }
      return value.map((item, index) =>
        sanitizePortableJson(item, context, `${label}[${index}]`, depth + 1)
      )
    }
    if (!isPlainRecord(value)) {
      throw taskBundleError('INVALID_SOURCE', `${label} contains a non-plain object`)
    }
    const result: Record<string, PortableJsonValue> = Object.create(null) as Record<
      string,
      PortableJsonValue
    >
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        throw taskBundleError('INVALID_SOURCE', `${label} contains a dangerous key`)
      }
      if (shouldOmitJsonKey(key)) continue
      const safeKey = redactWorkspace(key, context.workspaceVariants)
      if (Object.prototype.hasOwnProperty.call(result, safeKey)) {
        throw taskBundleError(
          'INVALID_SOURCE',
          `${label} contains keys that collide after path redaction`
        )
      }
      context.budget.properties += 1
      if (
        context.budget.properties >
        GROUND_TASK_BUNDLE_LIMITS.maximumObjectProperties
      ) {
        throw taskBundleError('TOO_LARGE', `${label} contains too many properties`)
      }
      countString(safeKey, context.budget, label)
      result[safeKey] = sanitizePortableJson(
        item,
        context,
        `${label}.${safeKey}`,
        depth + 1
      )
    }
    return result
  } finally {
    context.seen.delete(value)
  }
}

function sanitizePortableObject(
  value: unknown,
  context: SanitizerContext,
  label: string
): PortableJsonObject {
  const sanitized = sanitizePortableJson(value, context, label)
  if (!isPlainRecord(sanitized)) {
    throw taskBundleError('INVALID_SOURCE', `${label} must be a JSON object`)
  }
  return sanitized as PortableJsonObject
}

function portableActivityStatus(
  status: ActivityItem['status']
): 'success' | 'error' | 'denied' | 'interrupted' {
  if (status === 'success' || status === 'error' || status === 'denied') return status
  return 'interrupted'
}

function projectTimeline(
  items: TaskItem[],
  context: SanitizerContext
): GroundTimelineEntry[] {
  if (!Array.isArray(items)) {
    throw taskBundleError('INVALID_SOURCE', 'Task timeline must be an array')
  }
  if (items.length > GROUND_TASK_BUNDLE_LIMITS.maximumTimelineItems) {
    throw taskBundleError('TOO_LARGE', 'Task timeline contains too many items')
  }
  return items.map((item, index) => {
    if (item.kind === 'message') {
      return {
        kind: 'message',
        role: item.role,
        content: sanitizeText(item.content, context, `Timeline message ${index + 1}`),
        recordedAt: item.createdAt,
        ...(item.provider === undefined
          ? {}
          : {
              provider: projectProviderAttribution(
                item.provider,
                context,
                `Timeline message ${index + 1} provider`
              )
            })
      }
    }
    if (item.kind !== 'activity') {
      throw taskBundleError('INVALID_SOURCE', 'Task timeline contains an unknown item')
    }
    return {
      kind: 'activity',
      activityType: item.activityType,
      title: sanitizeText(item.title, context, `Timeline activity ${index + 1}`),
      ...(item.detail === undefined
        ? {}
        : {
            detail: sanitizeText(
              item.detail,
              context,
              `Timeline activity ${index + 1} detail`
            )
          }),
      status: portableActivityStatus(item.status),
      recordedAt: item.createdAt,
      ...(item.toolName === undefined
        ? {}
        : {
            toolName: sanitizeText(
              item.toolName,
              context,
              `Timeline activity ${index + 1} tool`
            )
          }),
      ...(item.input === undefined
        ? {}
        : {
            input: sanitizePortableObject(
              item.input,
              context,
              `Timeline activity ${index + 1} input`
            )
          }),
      ...(item.result === undefined
        ? {}
        : {
            result: sanitizeText(
              item.result,
              context,
              `Timeline activity ${index + 1} result`
            )
          }),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      ...(item.provider === undefined
        ? {}
        : {
            provider: projectProviderAttribution(
              item.provider,
              context,
              `Timeline activity ${index + 1} provider`
            )
          })
    }
  })
}

function projectProviderAttribution(
  provider: NonNullable<TaskItem['provider']>,
  context: SanitizerContext,
  label: string
): GroundProviderAttribution {
  if (
    provider.kind !== 'openai' &&
    provider.kind !== 'anthropic' &&
    provider.kind !== 'google' &&
    provider.kind !== 'openai-compatible' &&
    provider.kind !== 'cli'
  ) {
    throw taskBundleError('INVALID_SOURCE', `${label} kind is not supported`)
  }
  return {
    kind: provider.kind,
    name: sanitizeText(provider.name, context, `${label} name`),
    model: sanitizeText(provider.model, context, `${label} model`)
  }
}

function mappedCallId(sourceId: string, ids: ConversationCallIds): string {
  const existing = ids.values.get(sourceId)
  if (existing) return existing
  const mapped = `call-${++ids.next}`
  ids.values.set(sourceId, mapped)
  return mapped
}

function sanitizeRawArguments(
  rawArguments: string,
  context: SanitizerContext,
  label: string
): string {
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    const sanitized = sanitizePortableJson(parsed, context, label)
    return JSON.stringify(sanitized)
  } catch (error) {
    if (error instanceof GroundTaskBundleError) throw error
    return sanitizeText(rawArguments, context, label)
  }
}

function projectConversation(
  conversation: StoredModelConversationItem[],
  context: SanitizerContext
): GroundConversationItem[] {
  if (!Array.isArray(conversation)) {
    throw taskBundleError('INVALID_SOURCE', 'Canonical conversation must be an array')
  }
  if (conversation.length > GROUND_TASK_BUNDLE_LIMITS.maximumConversationItems) {
    throw taskBundleError('TOO_LARGE', 'Canonical conversation contains too many items')
  }
  const ids: ConversationCallIds = { next: 0, values: new Map() }
  return conversation.map((item, itemIndex) => {
    if (item.kind === 'message') {
      if (item.parts.length > GROUND_TASK_BUNDLE_LIMITS.maximumPartsPerMessage) {
        throw taskBundleError('TOO_LARGE', 'Conversation message contains too many parts')
      }
      return {
        kind: 'message',
        role: item.role,
        parts: item.parts.map((part, partIndex) => {
          const label = `Conversation item ${itemIndex + 1} part ${partIndex + 1}`
          if (part.kind === 'text' || part.kind === 'reasoning-summary') {
            return {
              kind: part.kind,
              text: sanitizeText(part.text, context, label)
            }
          }
          if (part.kind !== 'tool-call') {
            throw taskBundleError('INVALID_SOURCE', 'Conversation contains an unknown part')
          }
          const argumentsValue =
            part.arguments === undefined
              ? undefined
              : sanitizePortableObject(part.arguments, context, `${label} arguments`)
          return {
            kind: 'tool-call',
            callId: mappedCallId(part.callId, ids),
            name: sanitizeText(part.name, context, `${label} name`),
            rawArguments:
              argumentsValue === undefined
                ? sanitizeRawArguments(part.rawArguments, context, `${label} raw arguments`)
                : JSON.stringify(argumentsValue),
            ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
            ...(part.parseError === undefined
              ? {}
              : {
                  parseError: sanitizeText(
                    part.parseError,
                    context,
                    `${label} parse error`
                  )
                })
          }
        })
      }
    }
    if (item.kind !== 'tool-result') {
      throw taskBundleError('INVALID_SOURCE', 'Conversation contains an unknown item')
    }
    if (item.content.length > GROUND_TASK_BUNDLE_LIMITS.maximumToolResultParts) {
      throw taskBundleError('TOO_LARGE', 'Tool result contains too many parts')
    }
    return {
      kind: 'tool-result',
      callId: mappedCallId(item.callId, ids),
      ...(item.name === undefined
        ? {}
        : {
            name: sanitizeText(
              item.name,
              context,
              `Conversation tool result ${itemIndex + 1} name`
            )
          }),
      content: item.content.map((content, contentIndex) => {
        const label = `Conversation tool result ${itemIndex + 1} content ${contentIndex + 1}`
        if (content.kind === 'text') {
          return {
            kind: 'text' as const,
            text: sanitizeText(content.text, context, label)
          }
        }
        return {
          kind: 'json' as const,
          value: sanitizePortableJson(content.value, context, label)
        }
      }),
      ...(item.isError === undefined ? {} : { isError: item.isError })
    }
  })
}

function canonicalConversationForTask(task: Task): StoredModelConversationItem[] {
  const sessions = task.modelSessions
  if (!sessions || !isPlainRecord(sessions)) return []
  const descriptor = Object.getOwnPropertyDescriptor(sessions, task.providerId)
  if (!descriptor || !('value' in descriptor) || !descriptor.value) return []
  const session = descriptor.value as unknown
  if (!isPlainRecord(session)) {
    throw taskBundleError('INVALID_SOURCE', 'Canonical model session is invalid')
  }
  const conversation = session.conversation
  if (!Array.isArray(conversation)) {
    throw taskBundleError('INVALID_SOURCE', 'Canonical model conversation is invalid')
  }
  return conversation as StoredModelConversationItem[]
}

function projectProvider(
  provider: ProviderProfile,
  context: SanitizerContext
): GroundProviderDescriptor {
  const name = sanitizeText(provider.name, context, 'Provider name')
  const model = sanitizeText(provider.model, context, 'Provider model')
  if (provider.kind === 'cli') {
    return {
      type: 'agent-cli',
      kind: 'cli',
      name,
      model,
      adapter: provider.cliAdapter ?? 'generic'
    }
  }
  if (
    provider.kind !== 'openai' &&
    provider.kind !== 'anthropic' &&
    provider.kind !== 'google' &&
    provider.kind !== 'openai-compatible'
  ) {
    throw taskBundleError('INVALID_SOURCE', 'Provider kind is not supported')
  }
  return {
    type: 'model-api',
    kind: provider.kind,
    name,
    model,
    supportsTools: provider.supportsTools
  }
}

function validateSourceTimestamp(value: string, label: string): string {
  const parsed = timestampSchema.safeParse(value)
  if (!parsed.success) {
    throw taskBundleError('INVALID_SOURCE', `${label} is not a valid ISO timestamp`)
  }
  return parsed.data
}

function createGroundTaskBundleUnchecked(
  task: Task,
  provider: ProviderProfile,
  options: GroundTaskBundleExportOptions = {}
): GroundTaskBundleV1 {
  inspectJsonTree(task, 'Task source', { allowUndefinedObjectProperties: true })
  inspectJsonTree(provider, 'Provider source', {
    allowUndefinedObjectProperties: true
  })
  if (task.providerId !== provider.id) {
    throw taskBundleError(
      'INVALID_SOURCE',
      'Task provider does not match the supplied provider descriptor'
    )
  }
  const workspacePath =
    typeof task.workspacePath === 'string' ? task.workspacePath : undefined
  const context = newSanitizerContext(workspacePath)
  const exportedAt = validateSourceTimestamp(
    (options.now ?? (() => new Date().toISOString()))(),
    'Export timestamp'
  )
  const candidate = {
    $schema: GROUND_TASK_BUNDLE_SCHEMA_DIALECT,
    kind: GROUND_TASK_BUNDLE_KIND,
    version: GROUND_TASK_BUNDLE_VERSION,
    exportedAt,
    provider: projectProvider(provider, context),
    task: {
      title: sanitizeText(task.title, context, 'Task title'),
      mode: task.mode,
      sourceCreatedAt: validateSourceTimestamp(task.createdAt, 'Task creation timestamp'),
      sourceUpdatedAt: validateSourceTimestamp(task.updatedAt, 'Task update timestamp'),
      timeline: projectTimeline(task.items, context),
      conversation: projectConversation(
        canonicalConversationForTask(task),
        context
      )
    }
  }
  const parsed = groundTaskBundleV1Schema.safeParse(candidate)
  if (!parsed.success) {
    throw taskBundleError(
      'INVALID_SOURCE',
      `Task cannot be exported safely: ${z.prettifyError(parsed.error)}`
    )
  }
  inspectJsonTree(parsed.data, 'Exported task bundle')
  ensureSerializedSize(JSON.stringify(parsed.data), 'Exported task bundle')
  return parsed.data
}

export function createGroundTaskBundle(
  task: Task,
  provider: ProviderProfile,
  options: GroundTaskBundleExportOptions = {}
): GroundTaskBundleV1 {
  try {
    return createGroundTaskBundleUnchecked(task, provider, options)
  } catch (error) {
    if (error instanceof GroundTaskBundleError) throw error
    throw taskBundleError(
      'INVALID_SOURCE',
      'Task source could not be projected into a portable bundle',
      error
    )
  }
}

export function serializeGroundTaskBundle(
  task: Task,
  provider: ProviderProfile,
  options: GroundTaskBundleExportOptions = {}
): string {
  const serialized = JSON.stringify(
    createGroundTaskBundle(task, provider, options),
    null,
    2
  )
  ensureSerializedSize(serialized, 'Serialized task bundle')
  return serialized
}

function rekeyImportedConversation(
  conversation: GroundConversationItem[]
): GroundConversationItem[] {
  const ids: ConversationCallIds = { next: 0, values: new Map() }
  return conversation.map((item) => {
    if (item.kind === 'message') {
      return {
        kind: 'message',
        role: item.role,
        parts: item.parts.map((part) =>
          part.kind === 'tool-call'
            ? {
                ...part,
                callId: mappedCallId(part.callId, ids)
              }
            : { ...part }
        )
      }
    }
    return {
      ...item,
      callId: mappedCallId(item.callId, ids),
      content: item.content.map((content) =>
        content.kind === 'json'
          ? {
              kind: 'json' as const,
              value: structuredClone(content.value)
            }
          : { ...content }
      )
    }
  })
}

export function importGroundTaskBundle(input: string | unknown): GroundTaskImportTemplate {
  const bundle = parseBundleInput(input)
  const template: GroundTaskImportTemplate = {
    title: bundle.task.title,
    mode: bundle.task.mode,
    provider: structuredClone(bundle.provider),
    timeline: bundle.task.timeline.map(({ recordedAt: _recordedAt, ...entry }) => ({
      ...entry
    })) as GroundImportedTimelineEntry[],
    conversation: rekeyImportedConversation(bundle.task.conversation),
    source: {
      formatVersion: GROUND_TASK_BUNDLE_VERSION,
      exportedAt: bundle.exportedAt
    }
  }
  inspectJsonTree(template, 'Imported task template')
  return template
}

export function groundTaskBundleToMarkdown(input: string | unknown): string {
  const bundle = parseBundleInput(input)
  const lines: string[] = [
    `# ${escapeMarkdownInline(bundle.task.title)}`,
    '',
    `> Ground task bundle v${bundle.version} · exported ${bundle.exportedAt}`,
    `> Provider hint: ${escapeMarkdownInline(bundle.provider.name)}${
      bundle.provider.model ? ` · ${escapeMarkdownInline(bundle.provider.model)}` : ''
    } · ${bundle.task.mode === 'agent' ? 'Agent mode' : 'Ask mode'}`,
    ''
  ]

  if (bundle.task.timeline.length) {
    for (const entry of bundle.task.timeline) {
      if (entry.kind === 'message') {
        lines.push(
          `## ${entry.role === 'user' ? 'User' : 'Ground'}${
            entry.provider ? ` · ${escapeMarkdownInline(entry.provider.name)}` : ''
          }`,
          '',
          entry.content,
          '',
          `_${entry.recordedAt}_`,
          ''
        )
        continue
      }
      lines.push(
        `## Activity · ${escapeMarkdownInline(activityLabel(entry.activityType))}`,
        '',
        `**${escapeMarkdownInline(entry.title)}** · ${entry.status}${
          entry.provider ? ` · ${escapeMarkdownInline(entry.provider.name)}` : ''
        }`,
        ''
      )
      if (entry.detail) lines.push(entry.detail, '')
      if (entry.input) lines.push(fenced(JSON.stringify(entry.input, null, 2), 'json'), '')
      if (entry.result) lines.push(fenced(entry.result, 'text'), '')
      lines.push(`_${entry.recordedAt}_`, '')
    }
  } else if (bundle.task.conversation.length) {
    appendConversationMarkdown(lines, bundle.task.conversation)
  } else {
    lines.push('_This task has no transcript yet._', '')
  }

  const markdown = `${lines.join('\n').trimEnd()}\n`
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw taskBundleError('TOO_LARGE', 'Markdown transcript exceeds the safety limit')
  }
  return markdown
}

export function exportGroundTaskMarkdown(
  task: Task,
  provider: ProviderProfile,
  options: GroundTaskBundleExportOptions = {}
): string {
  return groundTaskBundleToMarkdown(createGroundTaskBundle(task, provider, options))
}

function appendConversationMarkdown(
  lines: string[],
  conversation: GroundConversationItem[]
): void {
  for (const item of conversation) {
    if (item.kind === 'tool-result') {
      lines.push(
        `## Tool result · ${escapeMarkdownInline(item.name ?? item.callId)}`,
        ''
      )
      for (const content of item.content) {
        lines.push(
          content.kind === 'text'
            ? content.text
            : fenced(JSON.stringify(content.value, null, 2), 'json'),
          ''
        )
      }
      continue
    }
    lines.push(`## ${item.role === 'user' ? 'User' : 'Ground'}`, '')
    for (const part of item.parts) {
      if (part.kind === 'tool-call') {
        lines.push(
          `**Tool call: ${escapeMarkdownInline(part.name)}**`,
          '',
          fenced(part.rawArguments, 'json'),
          ''
        )
      } else {
        lines.push(part.text, '')
      }
    }
  }
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_[\]<>#])/gu, '\\$1')
}

function fenced(content: string, language: string): string {
  let fence = '```'
  while (content.includes(fence)) fence += '`'
  return `${fence}${language}\n${content}\n${fence}`
}

function activityLabel(value: GroundTimelineEntry extends infer Entry
  ? Entry extends { kind: 'activity'; activityType: infer Activity }
    ? Activity
    : never
  : never): string {
  const labels: Record<string, string> = {
    status: 'Status',
    tool: 'Tool',
    command: 'Command',
    approval: 'Approval',
    error: 'Error',
    diagnostic: 'Diagnostic'
  }
  return labels[value] ?? value
}
