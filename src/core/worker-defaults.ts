/** Worker choices and validation, shared with settings and the editor frame. */
import type { UnifierSettings } from './types'

/** The same safe names accepted by Orchestrator start. */
export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/

export const WORKER_KINDS = [
  'implementation',
  'review',
  'design',
  'prose',
] as const
export type WorkerKind = (typeof WORKER_KINDS)[number]
export type ModelChoice = { agent: string; model: string }
export type WorkerDefaults = Record<WorkerKind, ModelChoice>

export function isWorkerKind(value: unknown): value is WorkerKind {
  return WORKER_KINDS.some((kind) => kind === value)
}

export function isModelChoice(value: unknown): value is ModelChoice {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.agent === 'string' &&
    typeof c.model === 'string' &&
    AGENT_ID.test(c.agent) &&
    MODEL_ID.test(c.model)
  )
}

/** Split only the first colon: a provider's model may contain further colons. */
export function parseWorkerChoice(value: unknown): ModelChoice | null {
  if (typeof value !== 'string') return null
  const colon = value.indexOf(':')
  if (colon === -1) return null
  const choice = { agent: value.slice(0, colon), model: value.slice(colon + 1) }
  return isModelChoice(choice) ? choice : null
}

export function globalWorkerDefaults(s: UnifierSettings): WorkerDefaults {
  return {
    implementation: parseWorkerChoice(s.workerImplementation) as ModelChoice,
    review: parseWorkerChoice(s.workerReview) as ModelChoice,
    design: parseWorkerChoice(s.workerDesign) as ModelChoice,
    prose: parseWorkerChoice(s.workerProse) as ModelChoice,
  }
}

/** Unknown launch fields do not establish a difference. */
export function outsideWorkerDefaults(
  choice: { agent: string | null; model: string | null },
  defaults: WorkerDefaults,
): boolean {
  return (
    choice.agent !== null &&
    choice.model !== null &&
    !WORKER_KINDS.some(
      (kind) =>
        defaults[kind].agent === choice.agent &&
        defaults[kind].model === choice.model,
    )
  )
}
