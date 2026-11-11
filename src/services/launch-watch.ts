import type { JsonValue, OrcaWorkerApi, PluginHooks } from 'orca/worker'
import type { OrcaCli } from '../adapters/orca-cli'
import { WRONG_LAUNCH_SUBJECT } from '../core/launch-notice'
import {
  checkWorkerLaunch,
  type LaunchProblem,
  parseDispatchPrompt,
  parseLaunch,
} from '../core/launch-policy'
import { isExcludedProject, projectOfWorktree } from '../core/projects'
import { withWorkerBrief } from '../core/templates'
import type { UnifierSettings } from '../core/types'
import type { Messenger } from './messenger'
import type { TrackedWorker, Tracker } from './tracker'

type PromptEvent = PluginHooks['agent.prompt.before']['event']

export { WRONG_LAUNCH_SUBJECT } from '../core/launch-notice'

/** Bypass flags repeat on every Worker: once per Orchestrator per day. */
const KEY = 'launch-watch.v1'
const BYPASS_EVERY_MS = 24 * 60 * 60 * 1000

function bypassAdvice(agent: string): string {
  const source =
    agent === 'codex'
      ? "Orca's Codex permission setting"
      : "Orca's agent permission setting"
  return `The bypass flag comes from ${source}, not from worker-start, so a relaunch keeps it. Do not relaunch the Worker for this alone. Raise it once with the user as a Decision.`
}

function wrongLaunchBody(w: TrackedWorker, problems: LaunchProblem[]): string {
  const lines = [
    `Worker terminal ${w.terminalId} (${w.agent}) launched with a bypass flag:`,
    ...problems.map((p) => `- ${p.text}`),
    bypassAdvice(w.agent),
  ]
  return lines.join('\n')
}

function readNotified(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const n = (raw as Record<string, unknown>).notified
  if (typeof n !== 'object' || n === null || Array.isArray(n)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(n)) {
    if (k.endsWith('|bypass') && typeof v === 'number') out[k] = v
  }
  return out
}

/**
 * Watches launches and dispatch prompts. It records every launch (parsed:
 * agent, model and bypass flags, never the command), recognizes Workers of
 * tracked Orchestrators from their dispatch prompt, and tells the
 * Orchestrator when a Worker launched with a bypass flag.
 * Launches are never altered; a tracked Worker's dispatch prompt gets the
 * Worker brief appended once.
 */
export function createLaunchWatch(
  orca: OrcaWorkerApi,
  deps: {
    tracker: Tracker
    messenger: Messenger
    cli: OrcaCli
    settings: () => Promise<UnifierSettings>
    /** The Worker brief and report format appended to tracked dispatch prompts. */
    workerBrief: () => string
    now?: () => number
  },
): { dispose(): void } {
  const { tracker, messenger } = deps
  const now = deps.now ?? Date.now
  /** Serializes the read-modify-write of the notified map. */
  let chain: Promise<unknown> = Promise.resolve()

  /** Claims a notice and prunes expired or obsolete model marks. */
  function claimBypass(orchestrator: string): Promise<boolean> {
    const next = chain.then(async () => {
      const t = now()
      const notified = Object.fromEntries(
        Object.entries(readNotified(await orca.storage.get(KEY))).filter(
          ([, at]) => t - at < BYPASS_EVERY_MS,
        ),
      )
      const mark = `${orchestrator}|bypass`
      const fresh = !(mark in notified)
      if (fresh) notified[mark] = t
      await orca.storage.set(KEY, { notified } as unknown as JsonValue)
      return fresh
    })
    chain = next.catch(() => {})
    return next
  }

  /** Resolves a tracked dispatch against the current Project exclusions. */
  async function trackedDispatch(event: PromptEvent) {
    const dispatch = parseDispatchPrompt(event.prompt)
    if (!dispatch) return null
    const orchestrator = await tracker.rootOrchestrator(
      dispatch.coordinatorTerminal,
    )
    if (!orchestrator) return null
    const settings = await deps.settings()
    if (isExcludedProject(orchestrator.project, settings.excludedProjects))
      return null
    const launch = await tracker.launchFor(event.terminalId)
    if (launch?.workspaceId && settings.excludedProjects.length > 0) {
      const worktrees = await deps.cli.listWorktrees()
      const worktree = worktrees.find((w) => w.id === launch.workspaceId)
      const mainPaths = new Map(
        worktrees
          .filter((w) => w.isMainWorktree)
          .map((w) => [w.repoId, w.path]),
      )
      const project = worktree
        ? projectOfWorktree(worktree, mainPaths, settings.projectsRoot)
        : null
      if (project && isExcludedProject(project, settings.excludedProjects))
        return null
    }
    return { dispatch, orchestrator, launch }
  }

  /** Records and checks a Worker; null means the dispatch is now excluded. */
  async function verifyWorker(event: PromptEvent): Promise<boolean | null> {
    const tracked = await trackedDispatch(event)
    if (!tracked) return null
    const { dispatch, orchestrator, launch } = tracked
    const worker: TrackedWorker = {
      terminalId: event.terminalId,
      workspaceId: launch?.workspaceId ?? null,
      agent: launch?.agent ?? event.agent ?? 'unknown',
      model: launch?.model ?? null,
      project: orchestrator.project,
      orchestratorTerminalId: orchestrator.terminalId,
      taskId: dispatch.taskId,
    }
    await tracker.recordWorker(worker)
    if (!launch) {
      // Hooks fail open, so a launch can go unseen: nothing to verify.
      orca.log(`unifier: no launch recorded for worker ${event.terminalId}`)
      return false
    }
    const verdict = checkWorkerLaunch(launch)
    if (verdict.ok) return false
    if (!(await claimBypass(orchestrator.terminalId))) return false
    await messenger.enqueue(
      orchestrator.terminalId,
      WRONG_LAUNCH_SUBJECT,
      wrongLaunchBody(worker, verdict.problems),
    )
    return true
  }

  /** The prompt to submit: a tracked Worker's dispatch gets the Worker brief, once. */
  function rewritePrompt(event: PromptEvent, tracked: boolean): string {
    if (!tracked) return event.prompt
    try {
      return withWorkerBrief(event.prompt, deps.workerBrief())
    } catch (e) {
      orca.log(`unifier: could not add the worker brief: ${String(e)}`)
      return event.prompt
    }
  }

  const subs = [
    orca.hooks.on('agent.launch.before', async (event) => {
      if (!event.terminalId) return
      try {
        await tracker.recordLaunch({
          terminalId: event.terminalId,
          workspaceId: event.workspaceId,
          agent: event.agent,
          ...parseLaunch(event.agent, event.command),
          at: now(),
        })
      } catch (e) {
        orca.log(`unifier: could not record a launch: ${String(e)}`)
      }
    }),

    orca.hooks.on('agent.prompt.before', async (event, next) => {
      if (event.inputKind !== 'orchestration') return
      let tracked = false
      try {
        tracked = (await trackedDispatch(event)) !== null
        // verifyWorker queues a message in storage; it is sent after the hook returns.
        if (tracked) {
          const queued = await verifyWorker(event)
          tracked = queued !== null
          if (queued) void messenger.flush()
        }
      } catch (e) {
        orca.log(`unifier: could not check a worker: ${String(e)}`)
      }
      const prompt = rewritePrompt(event, tracked)
      return prompt === event.prompt ? undefined : next({ ...event, prompt })
    }),
  ]

  return {
    dispose() {
      for (const s of subs) s.dispose()
    },
  }
}
