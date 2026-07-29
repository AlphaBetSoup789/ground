import { z } from 'zod'
import type { ProviderDraft, TaskPatch } from '../shared/types'
import { normalizeCliEnvironmentVariableNames } from './cli-environment'
import { canonicalProviderEndpoint } from './trust-boundary'

const providerDraftSchema = z
  .object({
    id: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'cli']),
    model: z.string().trim().max(200),
    apiKey: z.string().max(20_000).optional(),
    baseUrl: z.string().trim().max(2_000).optional(),
    supportsTools: z.boolean().optional(),
    contextWindowTokens: z.number().int().min(4_096).max(2_000_000).optional(),
    maxOutputTokens: z.number().int().min(128).max(262_144).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
    command: z.string().trim().max(2_000).optional(),
    args: z.array(z.string().max(8_192)).max(64).optional(),
    promptMode: z.enum(['stdin', 'argument']).optional(),
    outputMode: z.enum(['plain', 'ndjson']).optional(),
    cliAdapter: z.enum(['generic', 'codex', 'claude', 'gemini']).optional(),
    cliEnvironment: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(128),
            value: z
              .string()
              .max(20_000)
              .refine((entry) => !entry.includes('\0'), {
                message: 'Environment values cannot contain null bytes'
              })
              .refine((entry) => entry.length === 0 || entry.length >= 4, {
                message:
                  'Environment values must contain at least 4 characters'
              })
              .optional()
          })
          .strict()
      )
      .max(32)
      .optional(),
    trustConfirmed: z.boolean().optional()
  })
  .superRefine((value, context) => {
    if (value.kind !== 'cli') {
      if (!value.baseUrl) {
        context.addIssue({ code: 'custom', message: 'Base URL is required', path: ['baseUrl'] })
        return
      }
      try {
        canonicalProviderEndpoint(value.baseUrl)
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message:
            error instanceof Error ? error.message : 'Enter a valid URL',
          path: ['baseUrl']
        })
      }
      if (!value.model) {
        context.addIssue({ code: 'custom', message: 'Model is required', path: ['model'] })
      }
      if (
        value.contextWindowTokens !== undefined &&
        value.maxOutputTokens !== undefined &&
        value.maxOutputTokens >= value.contextWindowTokens
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Maximum response tokens must be smaller than the context window',
          path: ['maxOutputTokens']
        })
      }
    }
    if (value.kind === 'cli') {
      if (!value.command || value.command.includes('\0')) {
        context.addIssue({ code: 'custom', message: 'Executable is required', path: ['command'] })
      }
      const argumentCharacters = (value.args ?? []).reduce(
        (total, argument) => total + argument.length,
        0
      )
      if (argumentCharacters > 32_000) {
        context.addIssue({
          code: 'custom',
          message: 'CLI arguments are too large to review safely',
          path: ['args']
        })
      }
      try {
        normalizeCliEnvironmentVariableNames(
          (value.cliEnvironment ?? []).map((entry) => entry.name)
        )
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message:
            error instanceof Error
              ? error.message
              : 'CLI environment variables are invalid',
          path: ['cliEnvironment']
        })
      }
      const environmentCharacters = (value.cliEnvironment ?? []).reduce(
        (total, entry) =>
          total + entry.name.length + (entry.value?.length ?? 0),
        0
      )
      if (environmentCharacters > 128_000) {
        context.addIssue({
          code: 'custom',
          message: 'CLI environment values are too large',
          path: ['cliEnvironment']
        })
      }
    } else if (value.cliEnvironment?.length) {
      context.addIssue({
        code: 'custom',
        message: 'CLI environment values can be used only with a CLI provider',
        path: ['cliEnvironment']
      })
    }
  })

const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    providerId: z.string().min(1).max(200).optional(),
    mode: z.enum(['ask', 'agent']).optional(),
    workspaceGrantId: z
      .string()
      .regex(
        /^workspace_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        'Invalid workspace grant'
      )
      .optional(),
    includeImportedHistory: z.boolean().optional()
  })
  .strict()

export function parseProviderDraft(value: unknown): ProviderDraft {
  return providerDraftSchema.parse(value)
}

export function parseTaskPatch(value: unknown): TaskPatch {
  return taskPatchSchema.parse(value)
}

export function parseNonEmptyId(value: unknown, label = 'Identifier'): string {
  return z.string().min(1).max(200, `${label} is too long`).parse(value)
}

export function parsePrompt(value: unknown): string {
  return z.string().trim().min(1).max(1_000_000).parse(value)
}

export function parseWorkspaceGrantId(value: unknown): string {
  return z
    .string()
    .regex(
      /^workspace_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      'Invalid workspace grant'
    )
    .parse(value)
}
