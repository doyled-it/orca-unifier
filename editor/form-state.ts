import type { ModelChoice, WorkerKind } from '../src/core/worker-defaults'
import type { WorkerDefaultsForm } from './render'

export type WorkerDrafts = Partial<Record<WorkerKind, ModelChoice>>

export function mergeWorkerDefaults(
  fresh: WorkerDefaultsForm,
  drafts: WorkerDrafts,
): WorkerDefaultsForm {
  return { ...fresh, defaults: { ...fresh.defaults, ...drafts } }
}

export function workerSaveChoice(
  kind: WorkerKind,
  drafts: WorkerDrafts,
): ModelChoice | null {
  return drafts[kind] ?? null
}
