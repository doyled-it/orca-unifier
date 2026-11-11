import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import type { OrcaCli } from '../adapters/orca-cli'
import {
  type AgentEntry,
  type AgentStates,
  applyAgentEvent,
  enrichAgents,
  type LaunchRecord,
  overlayAgents,
} from '../core/agents'
import { buildBoard } from '../core/board-model'
import type { OrchestratorView } from '../core/board-types'
import { boardFilePath, hubFolder } from '../core/hubs'
import { parseSettings } from '../core/settings'
import type { UnifierSettings, WorktreeSummary } from '../core/types'
import {
  outsideWorkerDefaults,
  type WorkerDefaults,
} from '../core/worker-defaults'
import { createConsentBackoff } from './retirement'
import type { TrackedWorker } from './tracker'
import '../protocol'

/** Storage keys of earlier agent tracking; removed on activation. */
const OLD_AGENT_KEYS = ['agents.v1', 'agents.v2']
const DEBOUNCE_MS = 500
/**
 * Live events only bridge the gap until `orca worktree ps` reports the change.
 * Kept in memory: the worker restarts often, and a fresh summary covers that.
 */
const OVERLAY_TTL_MS = 2 * 60 * 1000

/** Schedules `fn` after `ms` and returns a cancel function. */
export type Schedule = (fn: () => void, ms: number) => () => void

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export interface BoardService {
  dispose(): void
  /** Agent panes per worktree id from a fresh worktree summary, live events applied. */
  agentStates(): Promise<{ states: AgentStates; truncated: boolean }>
}

/** Reads plugin settings through `orca.settings` and applies defaults. */
export function settingsReader(
  orca: OrcaWorkerApi,
): () => Promise<UnifierSettings> {
  return async () => parseSettings(await orca.settings.get(), homedir())
}

export function createBoardService(
  orca: OrcaWorkerApi,
  cli: OrcaCli,
  settings: () => Promise<UnifierSettings>,
  schedule: Schedule = defaultSchedule,
  /** Recorded launches; they fill an agent's model when a live event names its terminal. */
  launches: () => Promise<LaunchRecord[]> = async () => [],
  /** A project's live Orchestrator for its board. */
  orchestrator: (
    project: string,
    summaries: readonly WorktreeSummary[],
  ) => Promise<OrchestratorView | null> = async () => null,
  workerData?: {
    workers(): Promise<TrackedWorker[]>
    defaults(project: string): Promise<WorkerDefaults>
  },
): BoardService {
  let cancelPending: (() => void) | null = null
  let disposed = false
  let migrated = false
  const backoff = createConsentBackoff(
    (message) => orca.log(message),
    schedule,
    () => {
      void migrate().then(() => postUpdate())
    },
  )
  /** Worktree id to live event entries, newest per pane. */
  const live = new Map<string, AgentEntry[]>()

  async function migrate() {
    if (disposed || migrated || backoff.pending) return
    try {
      const keys = await orca.storage.keys().then(backoff.success)
      for (const k of OLD_AGENT_KEYS) {
        if (disposed) return
        if (keys.includes(k)) await orca.storage.delete(k).then(backoff.success)
      }
      migrated = true
    } catch (error) {
      backoff.handle(error)
      // Leftover keys are harmless.
    }
  }
  void migrate()

  function liveFor(id: string, now: number): AgentEntry[] {
    const fresh = (live.get(id) ?? []).filter(
      (e) => now - e.updatedAt <= OVERLAY_TTL_MS,
    )
    if (fresh.length > 0) live.set(id, fresh)
    else live.delete(id)
    return fresh
  }

  /** Launch records, or none when they cannot be read: the model is optional. */
  async function knownLaunches(): Promise<LaunchRecord[]> {
    try {
      return await launches()
    } catch (error) {
      if (backoff.handle(error)) throw error
      return []
    }
  }

  /** The board still loads when the Orchestrator cannot be looked up. */
  async function orchestratorOf(
    project: string,
    summaries: readonly WorktreeSummary[],
  ): Promise<OrchestratorView | null> {
    try {
      return await orchestrator(project, summaries)
    } catch (error) {
      if (backoff.handle(error)) throw error
      return null
    }
  }

  async function withLive(
    summaries: WorktreeSummary[],
    known: LaunchRecord[],
  ): Promise<AgentStates> {
    const now = Date.now()
    const out: AgentStates = {}
    let workers: TrackedWorker[] = []
    try {
      workers = (await workerData?.workers()) ?? []
    } catch (error) {
      if (backoff.handle(error)) throw error
      /* The board still loads. */
    }
    const tracked = new Map(workers.map((w) => [w.terminalId, w]))
    const terminals = new Set(tracked.keys())
    const launches = [
      ...workers.map((w) => ({
        terminalId: w.terminalId,
        agent: w.agent,
        model: w.model ?? null,
      })),
      ...known,
    ]
    const defaults = new Map<string, WorkerDefaults>()
    for (const project of new Set(workers.map((w) => w.project))) {
      try {
        if (workerData)
          defaults.set(project, await workerData.defaults(project))
      } catch (error) {
        if (backoff.handle(error)) throw error
        /* An unavailable choice cannot establish a difference. */
      }
    }
    for (const w of summaries) {
      let entries = overlayAgents(w.agents, liveFor(w.id, now))
      // Summaries omit terminal ids. Resolve each tracked terminal by its pane,
      // never by agent name or the number of agents sharing a worktree.
      const missing = workers.filter(
        (worker) =>
          worker.workspaceId === w.id &&
          !entries.some((e) => e.terminalId === worker.terminalId),
      )
      const panes = await Promise.all(
        missing.map(async (worker) => {
          try {
            const info = await cli.terminalInfo(worker.terminalId)
            return { paneKey: info?.paneKey, terminalId: worker.terminalId }
          } catch (error) {
            if (backoff.handle(error)) throw error
            return { paneKey: null, terminalId: worker.terminalId }
          }
        }),
      )
      entries = entries.map((e) => {
        const terminal = panes.find((p) => p.paneKey === e.paneKey)
        return e.terminalId || !terminal
          ? e
          : { ...e, terminalId: terminal.terminalId }
      })
      const agents = enrichAgents(entries, launches, terminals).map((e) => {
        const worker = e.terminalId ? tracked.get(e.terminalId) : undefined
        const choices = worker ? defaults.get(worker.project) : undefined
        return choices && outsideWorkerDefaults(e, choices)
          ? { ...e, outsideDefaults: true }
          : e
      })
      out[w.id] = agents
    }
    return out
  }

  async function agentStates() {
    const [{ summaries, truncated }, known] = await Promise.all([
      cli.worktreeSummaries(),
      knownLaunches(),
    ])
    return { states: await withLive(summaries, known), truncated }
  }

  function notify(): void {
    if (disposed || backoff.pending) return
    if (cancelPending) cancelPending()
    cancelPending = schedule(() => {
      cancelPending = null
      postUpdate()
    }, DEBOUNCE_MS)
  }

  function postUpdate() {
    if (disposed || backoff.pending) return
    try {
      orca.panels.post('board.changed', { at: Date.now() })
      backoff.success(undefined)
    } catch (error) {
      if (!backoff.handle(error))
        orca.log(`unifier: board update failed: ${String(error)}`)
    }
  }

  const subs = [
    orca.panels.handle('board.setMainCheckouts', async ({ filter, hidden }) => {
      try {
        const s = await settings().then(backoff.success)
        const key = `board.main-checkouts.v1:${boardFilePath(hubFolder(filter, s.projectsRoot))}`
        await orca.storage.set(key, hidden).then(backoff.success)
        notify()
        return { ok: true as const }
      } catch (error) {
        backoff.handle(error)
        return {
          error: 'The main checkout visibility could not be saved. Try again.',
        }
      }
    }),
    orca.panels.handle('board.get', async ({ filter }) => {
      try {
        const [{ summaries: worktrees, truncated }, s, known] =
          await Promise.all([
            cli.worktreeSummaries(),
            settings().then(backoff.success),
            knownLaunches(),
          ])
        const key = `board.main-checkouts.v1:${boardFilePath(hubFolder(filter, s.projectsRoot))}`
        const hidden = await orca.storage.get(key).then(backoff.success)
        const model = buildBoard(
          worktrees,
          await withLive(worktrees, known),
          filter,
          {
            projectsRoot: s.projectsRoot,
            hideMainCheckouts:
              typeof hidden === 'boolean' ? hidden : s.hideMainCheckouts,
          },
        )
        return {
          model: {
            ...model,
            notice: truncated
              ? 'Some worktrees could not be listed; the board may be incomplete.'
              : null,
            orchestrator:
              filter.scope === 'project'
                ? await orchestratorOf(filter.project, worktrees)
                : null,
          },
        }
      } catch (error) {
        backoff.handle(error)
        return {
          error:
            'The board could not be loaded. Check that the app is still running, then try again.',
        }
      }
    }),

    orca.panels.handle('board.setStatus', async ({ worktreeId, status }) => {
      try {
        await cli.setStatus(worktreeId, status)
      } catch (error) {
        backoff.handle(error)
        return { error: 'The status could not be changed. Try again.' }
      }
      notify()
      return { ok: true as const }
    }),

    orca.panels.handle('board.openWorktree', async ({ worktreeId }) => {
      try {
        const found = (await cli.listWorktrees()).find(
          (w) => w.id === worktreeId,
        )
        if (!found) return { error: 'That Worktree no longer exists.' }
        await orca.host
          .call('workspace.open', {
            workspaceId: found.identityKey
              ? `identity:${found.identityKey}`
              : found.id,
          })
          .then(backoff.success)
        return { ok: true as const }
      } catch (error) {
        backoff.handle(error)
        return { error: 'The Worktree could not be opened. Try again.' }
      }
    }),

    orca.events.on('agent.status.changed', (e) => {
      const id = e.workspaceId
      if (!id) return
      live.set(id, applyAgentEvent(live.get(id) ?? [], e))
      notify()
    }),

    orca.events.on('workspace.created', () => notify()),
    orca.events.on('workspace.changed', () => notify()),
    orca.events.on('workspace.removed', (e) => {
      live.delete(e.workspaceId)
      notify()
    }),
  ]

  return {
    agentStates,
    dispose() {
      disposed = true
      backoff.dispose()
      if (cancelPending) cancelPending()
      cancelPending = null
      for (const s of subs) s.dispose()
    },
  }
}
