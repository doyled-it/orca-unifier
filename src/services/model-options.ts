import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import { readCatalogText } from '../adapters/model-catalog'
import type { AgentModels } from '../core/board-types'
import { readModelCatalog } from '../core/templates'
import type { UnifierSettings } from '../core/types'
import {
  isModelChoice,
  type ModelChoice,
  type WorkerDefaults,
} from '../core/worker-defaults'

export const CHOICE_KEY = 'orchestrator-choice.v1'

export function readChoices(raw: unknown): Record<string, ModelChoice> {
  if (!raw || typeof raw !== 'object') return {}
  const choices = (raw as Record<string, unknown>).choices
  if (!choices || typeof choices !== 'object' || Array.isArray(choices))
    return {}
  return Object.fromEntries(
    Object.entries(choices).filter(([, v]) => isModelChoice(v)),
  )
}

function withModel(agents: AgentModels[], choice: ModelChoice): AgentModels[] {
  const found = agents.find((a) => a.agent === choice.agent)
  const model = { id: choice.model, label: choice.model }
  if (!found) return [...agents, { agent: choice.agent, models: [model] }]
  if (found.models.some((m) => m.id === choice.model)) return agents
  return agents.map((a) =>
    a === found ? { ...a, models: [model, ...a.models] } : a,
  )
}

/** Both header editors use this catalog and the same settings fallback. */
export async function modelOptions(
  orca: OrcaWorkerApi,
  deps: { fs: FsLike; exec: Exec; home: string },
  project: string | null,
  settings: UnifierSettings,
  workers: WorkerDefaults,
): Promise<{
  agents: AgentModels[]
  defaults: ModelChoice
  catalogAvailable: boolean
}> {
  let remembered: ModelChoice | undefined
  try {
    const choices = readChoices(await orca.storage.get(CHOICE_KEY))
    if (project && Object.hasOwn(choices, project.toLowerCase()))
      remembered = choices[project.toLowerCase()]
  } catch {
    // Settings remain available when the previous start could not be remembered.
  }
  const defaults = remembered ?? {
    agent: settings.orchestratorAgent,
    model: settings.orchestratorModel,
  }
  const text = await readCatalogText(deps.fs, deps.exec, deps.home)
  let agents = text ? readModelCatalog(text) : []
  const catalogAvailable = agents.length > 0
  if (!catalogAvailable) {
    for (const choice of Object.values(workers))
      agents = withModel(agents, choice)
  }
  agents = withModel(agents, defaults)
  return { agents, defaults, catalogAvailable }
}

export async function rememberChoice(
  orca: OrcaWorkerApi,
  project: string,
  choice: ModelChoice,
): Promise<void> {
  try {
    const choices = readChoices(await orca.storage.get(CHOICE_KEY))
    Object.defineProperty(choices, project.toLowerCase(), {
      value: choice,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    await orca.storage.set(CHOICE_KEY, { choices } as unknown as JsonValue)
  } catch (e) {
    orca.log(`unifier: could not remember the choice: ${String(e)}`)
  }
}
