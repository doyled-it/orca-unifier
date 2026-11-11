/** Template filling and the model catalog. Pure and node-free. */
import type { AgentModels } from './board-types'

/** First line of `templates/worker-brief.md`; a prompt carrying it already has the brief. */
export const WORKER_BRIEF_MARKER = '<!-- unifier:worker-brief v1 -->'

export interface CharterVars {
  project: string
  projectPath: string
  /** Absolute repo folders of the project. */
  repos: string[]
  railsPath: string
}

function repoLines(repos: readonly string[]): string {
  // The template indents the first line; later lines carry the indent themselves.
  return repos.length === 0
    ? '- none found yet'
    : repos.map((r) => `- \`${r}\``).join('\n  ')
}

/** Replaces every `{{name}}`. Throws on a placeholder it does not know. */
export function renderCharter(t: string, vars: CharterVars): string {
  const values: Record<string, string> = {
    project: vars.project,
    projectPath: vars.projectPath,
    repos: repoLines(vars.repos),
    railsPath: vars.railsPath,
  }
  return t.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`Unknown placeholder {{${name}}}`)
    }
    return values[name] as string
  })
}

/** Appends the brief once: a prompt that already carries the marker is returned unchanged. */
export function withWorkerBrief(prompt: string, brief: string): string {
  if (prompt.includes(WORKER_BRIEF_MARKER)) return prompt
  return `${prompt.trimEnd()}\n\n${brief}`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * Models of one catalog entry. An alias (`opus`) resolves to its full id
 * (`resolvedModel`), the first label for an id wins, and an "alias" suffix is
 * dropped from labels.
 */
function modelsOf(entry: Record<string, unknown>): AgentModels['models'] {
  const discovered = isObj(entry.discovered) ? entry.discovered : {}
  const raw = Array.isArray(discovered.models) ? discovered.models : []
  const out: AgentModels['models'] = []
  const seen = new Set<string>()
  for (const m of raw) {
    if (!isObj(m)) continue
    const id = text(m.resolvedModel) ?? text(m.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = (text(m.label) ?? id).replace(/\s+alias$/i, '')
    out.push({ id, label })
  }
  return out
}

/**
 * Agents and their models from Orca's model catalog (`{ entries: [...] }`, or
 * the bare entries array). The newest (last) entry per agent wins. Never
 * throws: bad input gives `[]`.
 */
export function readModelCatalog(json: string): AgentModels[] {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return []
  }
  const entries = Array.isArray(v)
    ? v
    : isObj(v) && Array.isArray(v.entries)
      ? v.entries
      : []
  const byAgent = new Map<string, AgentModels['models']>()
  for (const e of entries) {
    if (!isObj(e)) continue
    const agent = text(e.agent)
    if (!agent) continue
    const models = modelsOf(e)
    if (models.length === 0) continue
    // The agent keeps its first-seen place; its models come from the newest entry.
    byAgent.set(agent, models)
  }
  return [...byAgent].map(([agent, models]) => ({ agent, models }))
}
