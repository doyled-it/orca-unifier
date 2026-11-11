/** Per-pane agent state. Node-free so the editor frame can import its types. */

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** One agent pane in a worktree, from `orca worktree ps` or a live event. */
export type AgentEntry = {
  paneKey: string
  /** The pane that started this agent; a sub-agent when it is in the same worktree. */
  parentPaneKey: string | null
  terminalId: string | null
  title: string | null
  /** Current tool and its input, such as "Bash: git status". */
  detail: string | null
  state: AgentState
  since: number
  /** When this entry was last reported; the newer report of a pane wins. */
  updatedAt: number
  /** Agent kind (`claude`, `codex`). */
  agent: string | null
  model: string | null
  /** A tracked Worker's known choice matches none of its project's defaults. */
  outsideDefaults?: boolean
}

/** Worktree id to its agent panes. */
export type AgentStates = Record<string, AgentEntry[]>

/** The parts of an `agent.status.changed` payload this module reads. */
export interface AgentEvent {
  paneKey: string
  terminalId?: string
  title?: string
  state: AgentState
  receivedAt: number
  mainAgent?: { state: AgentState; stateStartedAt: number }
}

/** A recorded launch: which agent and model a terminal runs. */
export interface LaunchRecord {
  terminalId: string
  agent: string | null
  model: string | null
}

const STATES: readonly AgentState[] = ['blocked', 'waiting', 'working', 'done']

export function isAgentState(v: unknown): v is AgentState {
  return (STATES as readonly unknown[]).includes(v)
}

/** Returns `entries` with the event's pane added or updated. Does not mutate. */
export function applyAgentEvent(
  entries: readonly AgentEntry[],
  e: AgentEvent,
): AgentEntry[] {
  const prev = entries.find((x) => x.paneKey === e.paneKey)
  const next: AgentEntry = {
    paneKey: e.paneKey,
    parentPaneKey: prev?.parentPaneKey ?? null,
    terminalId: e.terminalId ?? prev?.terminalId ?? null,
    title: e.title ?? prev?.title ?? null,
    detail: prev?.detail ?? null,
    state: e.mainAgent?.state ?? e.state,
    since: e.mainAgent?.stateStartedAt ?? e.receivedAt,
    updatedAt: e.receivedAt,
    agent: prev?.agent ?? null,
    model: prev?.model ?? null,
  }
  return prev ? entries.map((x) => (x === prev ? next : x)) : [...entries, next]
}

/**
 * Merges live event entries over a summary's entries for one worktree.
 * An event newer than the summary's report of that pane sets its state, start
 * time and (when known) title; panes the summary lacks are added. A known
 * terminal id is always kept.
 */
export function overlayAgents(
  summary: readonly AgentEntry[],
  live: readonly AgentEntry[],
): AgentEntry[] {
  const byPane = new Map(live.map((e) => [e.paneKey, e]))
  const out = summary.map((s) => {
    const ev = byPane.get(s.paneKey)
    if (!ev) return s
    byPane.delete(s.paneKey)
    const terminalId = ev.terminalId ?? s.terminalId
    if (ev.updatedAt <= s.updatedAt) return { ...s, terminalId }
    return {
      ...s,
      terminalId,
      title: ev.title ?? s.title,
      state: ev.state,
      since: ev.since,
      updatedAt: ev.updatedAt,
    }
  })
  return [...out, ...byPane.values()]
}

/** Most urgent first (blocked, waiting, working, done), then newest. */
export function sortAgents<T extends { state: AgentState; since: number }>(
  xs: readonly T[],
): T[] {
  return [...xs].sort(
    (a, b) =>
      STATES.indexOf(a.state) - STATES.indexOf(b.state) || b.since - a.since,
  )
}

/**
 * Card order for one worktree: top-level agents (no parent, or a parent pane
 * in another worktree, such as a dispatching coordinator) most urgent first,
 * then their sub-agents.
 */
export function orderForCard(entries: readonly AgentEntry[]): AgentEntry[] {
  const panes = new Set(entries.map((e) => e.paneKey))
  const isSub = (e: AgentEntry) =>
    e.parentPaneKey !== null && panes.has(e.parentPaneKey)
  return [
    ...sortAgents(entries.filter((e) => !isSub(e))),
    ...sortAgents(entries.filter(isSub)),
  ]
}

/**
 * Fills `agent` and `model` from recorded launches matched by terminal id.
 * Tracked terminals use the recorded launch; otherwise values already known win.
 * With no launches it returns equal entries.
 */
export function enrichAgents(
  entries: readonly AgentEntry[],
  launches: readonly LaunchRecord[],
  trackedTerminals: ReadonlySet<string> = new Set(),
): AgentEntry[] {
  const byTerminal = new Map(launches.map((l) => [l.terminalId, l]))
  return entries.map((e) => {
    const l = e.terminalId ? byTerminal.get(e.terminalId) : undefined
    if (!l) return e
    if (trackedTerminals.has(l.terminalId)) {
      return { ...e, agent: l.agent ?? e.agent, model: l.model ?? e.model }
    }
    return { ...e, agent: e.agent ?? l.agent, model: e.model ?? l.model }
  })
}
