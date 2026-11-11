import type { JsonValue, OrcaWorkerApi } from 'orca/worker'

/** The worker restarts after every hook call, so every record lives in storage. */
const KEY = 'tracker.v1'
const MAX_LAUNCHES = 200
const MAX_WORKERS = 500

export interface TrackedOrchestrator {
  project: string
  workspaceId: string
  terminalId: string
  agent: string
  model: string
  runId: string | null
}

/** A launch as parsed in the hook; the command itself (and any prompt) is never stored. */
export interface LaunchEntry {
  terminalId: string
  workspaceId: string | null
  agent: string
  model: string | null
  bypass: string[]
  at: number
}

export interface TrackedWorker {
  /** Actual launch model; absent on records from older plugin versions. */
  model?: string | null
  terminalId: string
  workspaceId: string | null
  agent: string
  project: string
  orchestratorTerminalId: string
  taskId: string | null
}

export interface Tracker {
  recordOrchestrator(o: TrackedOrchestrator): Promise<void>
  orchestrators(): Promise<TrackedOrchestrator[]>
  orchestratorByTerminal(
    terminalId: string,
  ): Promise<TrackedOrchestrator | null>
  rootOrchestrator(terminalId: string): Promise<TrackedOrchestrator | null>
  setRunId(terminalId: string, runId: string): Promise<void>
  recordLaunch(l: LaunchEntry): Promise<void>
  launchFor(terminalId: string): Promise<Omit<LaunchEntry, 'terminalId'> | null>
  /** Every recorded launch, oldest first. */
  launches(): Promise<LaunchEntry[]>
  recordWorker(w: TrackedWorker): Promise<void>
  workers(): Promise<TrackedWorker[]>
  /**
   * The Orchestrator terminal whose Worker runs in this workspace, or null.
   * Null for an Orchestrator's own workspace (the global hub, which they share).
   */
  ownerOfWorkspace(workspaceId: string): Promise<string | null>
  /** Rewrites storage without launch records from before parsed launches. */
  migrate(): Promise<void>
}

interface State {
  orchestrators: TrackedOrchestrator[]
  launches: LaunchEntry[]
  workers: TrackedWorker[]
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function list<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter(isObj) as T[]) : []
}

/** Old records kept the whole command; current ones carry parsed fields only. */
function isLaunch(v: Record<string, unknown>): boolean {
  return !('command' in v) && Array.isArray(v.bypass)
}

function toState(raw: unknown): State {
  if (!isObj(raw)) return { orchestrators: [], launches: [], workers: [] }
  return {
    orchestrators: list(raw.orchestrators),
    launches: list<Record<string, unknown>>(raw.launches).filter(
      isLaunch,
    ) as unknown as LaunchEntry[],
    workers: list(raw.workers),
  }
}

/** Replaces the entry with the same terminal id, appending it as the newest. */
function upsert<T extends { terminalId: string }>(
  xs: T[],
  x: T,
  max: number,
): T[] {
  return [...xs.filter((y) => y.terminalId !== x.terminalId), x].slice(-max)
}

export function createTracker(storage: OrcaWorkerApi['storage']): Tracker {
  /** Serializes read-modify-write so concurrent records are not lost. */
  let chain: Promise<unknown> = Promise.resolve()

  async function read(): Promise<State> {
    return toState(await storage.get(KEY))
  }

  function serial(fn: () => Promise<void>): Promise<void> {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }

  function update(fn: (s: State) => State): Promise<void> {
    return serial(async () => {
      const s = fn(await read())
      await storage.set(KEY, s as unknown as JsonValue)
    })
  }

  async function orchestratorByTerminal(terminalId: string) {
    return (
      (await read()).orchestrators.find((o) => o.terminalId === terminalId) ??
      null
    )
  }

  return {
    recordOrchestrator: (o) =>
      update((s) => ({
        ...s,
        orchestrators: upsert(s.orchestrators, o, Number.POSITIVE_INFINITY),
      })),
    orchestrators: async () => (await read()).orchestrators,
    orchestratorByTerminal,
    async rootOrchestrator(terminalId) {
      const { orchestrators, workers } = await read()
      const seen = new Set<string>()
      for (let depth = 0; depth <= 3; depth++) {
        if (seen.has(terminalId)) return null
        seen.add(terminalId)
        const root = orchestrators.find((o) => o.terminalId === terminalId)
        if (root) return root
        const parent = workers.find((w) => w.terminalId === terminalId)
        if (!parent) return null
        terminalId = parent.orchestratorTerminalId
      }
      return null
    },
    setRunId: (terminalId, runId) =>
      update((s) => ({
        ...s,
        orchestrators: s.orchestrators.map((o) =>
          o.terminalId === terminalId ? { ...o, runId } : o,
        ),
      })),
    recordLaunch: (l) =>
      update((s) => ({
        ...s,
        workers: s.workers.filter((w) => w.terminalId !== l.terminalId),
        launches: upsert(
          s.launches,
          {
            terminalId: l.terminalId,
            workspaceId: l.workspaceId,
            agent: l.agent,
            model: l.model,
            bypass: [...l.bypass],
            at: l.at,
          },
          MAX_LAUNCHES,
        ),
      })),
    async launchFor(terminalId) {
      const l = (await read()).launches.find((x) => x.terminalId === terminalId)
      if (!l) return null
      return {
        agent: l.agent,
        model: l.model,
        bypass: l.bypass,
        workspaceId: l.workspaceId,
        at: l.at,
      }
    },
    launches: async () => (await read()).launches,
    recordWorker: (w) =>
      update((s) => ({ ...s, workers: upsert(s.workers, w, MAX_WORKERS) })),
    workers: async () => (await read()).workers,
    async ownerOfWorkspace(workspaceId) {
      const { orchestrators, workers } = await read()
      if (orchestrators.some((o) => o.workspaceId === workspaceId)) return null
      for (let i = workers.length - 1; i >= 0; i--) {
        const w = workers[i]
        if (w?.workspaceId === workspaceId) return w.orchestratorTerminalId
      }
      return null
    },
    migrate: () =>
      serial(async () => {
        const raw = await storage.get(KEY)
        const old =
          isObj(raw) && Array.isArray(raw.launches) ? raw.launches : []
        const s = toState(raw)
        if (old.length !== s.launches.length) {
          await storage.set(KEY, s as unknown as JsonValue)
        }
      }),
  }
}
