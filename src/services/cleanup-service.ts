import { resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import { gatherFacts } from '../adapters/git-facts'
import type { OrcaCli } from '../adapters/orca-cli'
import { resolveRealpath } from '../adapters/realpath'
import { worktreeExclusionReason } from '../adapters/worktree-exclusion'
import type { AgentStates } from '../core/agents'
import { evaluateRemoval } from '../core/cleanup'
import { hubFolder } from '../core/hubs'
import {
  isExcludedProject,
  projectOf,
  projectOfWorktree,
} from '../core/projects'
import type { UnifierSettings, WorktreeRecord } from '../core/types'
import type { BoardService, Schedule } from './board-service'
import { createConsentBackoff, isConsentError } from './retirement'

const ARMED = 'cleanup.armed.v1'
const LAST_AUTO_AT = 'cleanup.lastAutoAt.v1'

const scheduleTimeout: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

export interface CleanupResult {
  /** Worktree ids removed in live mode, or eligible for removal in dry mode. */
  removed: string[]
  kept: { id: string; reason: string }[]
}

export function createCleanupService(
  orca: OrcaWorkerApi,
  deps: {
    cli: Pick<
      OrcaCli,
      'listWorktrees' | 'removeWorktree' | 'hideExternalWorktrees'
    >
    exec: Exec
    board: Pick<BoardService, 'agentStates'>
    settings: () => Promise<UnifierSettings>
    schedule?: Schedule
    now?: () => number
  },
): { run(mode: 'dry' | 'live'): Promise<CleanupResult>; dispose(): void } {
  const schedule = deps.schedule ?? scheduleTimeout
  const now = deps.now ?? Date.now
  let disposed = false
  let livePending: Promise<CleanupResult> | null = null
  let autoPending: Promise<void> | null = null
  let cancelTimer: (() => void) | null = null
  let timerVersion = 0
  let initialContext = true
  let retryAutomatic = false
  const backoff = createConsentBackoff(
    (message) => orca.log(message),
    schedule,
    () => {
      if (retryAutomatic) {
        retryAutomatic = false
        void automatic(true).finally(() => configureTimer())
      } else void configureTimer()
    },
  )

  function mainPaths(worktrees: WorktreeRecord[]) {
    return new Map(
      worktrees.filter((w) => w.isMainWorktree).map((w) => [w.repoId, w.path]),
    )
  }

  function confirmedWorktree(
    original: WorktreeRecord,
    worktrees: WorktreeRecord[],
  ) {
    const matches = worktrees.filter((w) => w.id === original.id)
    const w = matches[0]
    return matches.length === 1 &&
      w &&
      w.path === original.path &&
      w.repoId === original.repoId &&
      w.identityKey === original.identityKey &&
      w.branch === original.branch
      ? w
      : null
  }

  /** Check both spellings so links cannot bypass exclusions or hide a hub. */
  async function protectedReason(
    w: WorktreeRecord,
    worktrees: WorktreeRecord[],
    settings: UnifierSettings,
    keepHubs = true,
  ): Promise<string | null> {
    const root = settings.projectsRoot
    const paths = mainPaths(worktrees)
    const exclusion = await worktreeExclusionReason(
      w,
      paths,
      root,
      settings.excludedProjects,
    )
    if (exclusion) return exclusion
    const realRoot = resolveRealpath(root)
    const realPath = resolveRealpath(w.path)
    if (!realRoot || !realPath) return 'The Project path could not be resolved.'
    const realMains = new Map(
      [...paths].map(([id, path]) => [id, resolveRealpath(path)]),
    )
    for (const [path, mains, projectsRoot] of [
      [w.path, paths, root],
      [realPath, realMains, realRoot],
    ] as const) {
      const project = projectOfWorktree(
        { path, repoId: w.repoId },
        mains,
        projectsRoot,
      )
      if (!project) return 'The Worktree Project could not be resolved.'
      const mainProject = projectOf(
        mains.get(w.repoId) ?? projectsRoot,
        projectsRoot,
      )
      if (
        isExcludedProject(project, settings.excludedProjects) ||
        (mainProject &&
          isExcludedProject(mainProject, settings.excludedProjects))
      ) {
        return 'This Project is excluded from cleanup.'
      }
      const samePath = (other: string) =>
        resolve(path).toLowerCase() === resolve(other).toLowerCase()
      if (
        keepHubs &&
        (samePath(hubFolder({ scope: 'global' }, projectsRoot)) ||
          samePath(hubFolder({ scope: 'project', project }, projectsRoot)))
      ) {
        return 'Hub rule: keep hub workspaces.'
      }
    }
    return null
  }

  async function pass(
    mode: 'dry' | 'live',
    automatic: boolean,
  ): Promise<CleanupResult> {
    const result: CleanupResult = { removed: [], kept: [] }
    if (disposed) return result
    const initial = await deps.cli.listWorktrees()
    const names = new Map(initial.map((w) => [w.id, w.displayName || w.id]))
    let states: AgentStates = {}
    let agentsUnknown = false
    async function readAgents() {
      if (agentsUnknown) return
      try {
        states = (await deps.board.agentStates()).states
      } catch (error) {
        if (isConsentError(error)) throw error
        agentsUnknown = true
      }
    }
    function liveAgentFor(id: string): boolean | 'unknown' {
      if (agentsUnknown || !Object.hasOwn(states, id)) return 'unknown'
      return (states[id] ?? []).some((a) =>
        ['working', 'blocked', 'waiting'].includes(a.state),
      )
    }
    await readAgents()
    for (const original of initial) {
      let reason: string | null = null
      try {
        if (disposed) break
        const worktrees = initial
        const w = confirmedWorktree(original, worktrees)
        if (!w) {
          reason = 'The Worktree identity changed or could not be confirmed.'
        } else {
          const settings = await deps.settings().then(backoff.success)
          reason =
            automatic && !settings.cleanupEnabled
              ? 'Automatic cleanup is disabled.'
              : await protectedReason(w, worktrees, settings)
          if (!reason && agentsUnknown)
            reason = 'Live agent rule: agent activity could not be confirmed.'
          if (!reason && w.isMainWorktree)
            reason = 'Main worktree rule: keep the main checkout.'
          if (!reason) {
            const facts = await gatherFacts(w, {
              exec: deps.exec,
              isHub: false,
              liveAgent: true,
            })
            // Only removal candidates need a fresh identity and metadata lookup.
            await readAgents()
            const liveAgent = liveAgentFor(w.id)
            const candidate = evaluateRemoval({ ...facts, liveAgent })
            if (!candidate.remove) {
              result.kept.push({ id: original.id, reason: candidate.reason })
              orca.log(`unifier: keep ${original.id}: ${candidate.reason}`)
              continue
            }
            const latest =
              mode === 'live' ? await deps.cli.listWorktrees() : worktrees
            const current = confirmedWorktree(w, latest)
            reason = current
              ? await protectedReason(
                  current,
                  latest,
                  await deps.settings().then(backoff.success),
                )
              : 'The Worktree identity changed or could not be confirmed.'
            if (!current || reason) {
              result.kept.push({
                id: original.id,
                reason:
                  reason ?? 'The Worktree identity could not be confirmed.',
              })
              orca.log(`unifier: keep ${original.id}: ${reason}`)
              continue
            }
            // An agent may have started while Git was being checked.
            await readAgents()
            const currentLiveAgent = liveAgentFor(w.id)
            const verdict = evaluateRemoval({
              ...facts,
              isMainWorktree: current.isMainWorktree,
              isPinned: current.isPinned,
              liveAgent: currentLiveAgent,
            })
            // The person can disable cleanup while any of the checks await I/O.
            if (
              automatic &&
              !(await deps.settings().then(backoff.success)).cleanupEnabled
            )
              reason = 'Automatic cleanup is disabled.'
            else if (!verdict.remove) reason = verdict.reason
            else if (!disposed) {
              if (mode === 'live') {
                await deps.cli.removeWorktree(w.id)
                orca.log(
                  `unifier: removed merged Worktree ${names.get(w.id)} (${w.id})`,
                )
              } else {
                orca.log(
                  `unifier: would remove merged Worktree ${names.get(w.id)} (${w.id})`,
                )
              }
              result.removed.push(w.id)
            }
          }
        }
      } catch (error) {
        if (isConsentError(error)) throw error
        reason =
          'Safety checks or removal failed. Keep this Worktree and check the plugin logs.'
        orca.log(`unifier: cleanup kept ${original.id}: ${String(error)}`)
      }
      if (reason) {
        result.kept.push({ id: original.id, reason })
        orca.log(`unifier: keep ${original.id}: ${reason}`)
      }
    }
    if (mode === 'live' && result.removed.length > 0) {
      const title = `Removed ${result.removed.length} merged worktrees: ${result.removed.map((id) => names.get(id)).join(', ')}`
      try {
        await orca.host
          .call('notifications.show', { title })
          .then(backoff.success)
      } catch (error) {
        if (isConsentError(error)) throw error
        orca.log(`unifier: cleanup notification failed: ${String(error)}`)
      }
    }
    return result
  }

  // Keep this non-async: concurrent callers receive the identical promise.
  function run(
    mode: 'dry' | 'live',
    automatic = false,
  ): Promise<CleanupResult> {
    if (mode === 'dry') return pass(mode, automatic)
    if (livePending) return livePending
    livePending = pass(mode, automatic).finally(() => {
      livePending = null
    })
    return livePending
  }

  // Include settings and storage reads in deduplication, for either pass mode.
  function automatic(consentRetry = false): Promise<void> {
    if (disposed || backoff.pending) return Promise.resolve()
    if (autoPending) return autoPending
    autoPending = (async () => {
      const settings = await deps.settings().then(backoff.success)
      if (disposed || !settings.cleanupEnabled) return
      const lastAutoAt = await orca.storage
        .get(LAST_AUTO_AT)
        .then(backoff.success)
      if (
        !consentRetry &&
        typeof lastAutoAt === 'number' &&
        Number.isFinite(lastAutoAt) &&
        now() - lastAutoAt < settings.cleanupIntervalMinutes * 60_000
      )
        return
      const armed =
        (await orca.storage.get(ARMED).then(backoff.success)) === true
      if (disposed) return
      // Claim before any expensive work, so worker restarts honor the interval.
      await orca.storage.set(LAST_AUTO_AT, now()).then(backoff.success)
      if (!armed)
        orca.log('unifier: cleanup is not armed; automatic cleanup is dry only')
      await run(armed ? 'live' : 'dry', true)
    })()
      .catch((error) => {
        if (isConsentError(error)) {
          retryAutomatic = true
          cancelTimer?.()
          cancelTimer = null
          backoff.handle(error)
          return
        }
        orca.log(`unifier: automatic cleanup failed: ${String(error)}`)
      })
      .finally(() => {
        autoPending = null
      })
    return autoPending
  }

  async function configureTimer() {
    if (disposed || backoff.pending) return
    const version = ++timerVersion
    cancelTimer?.()
    cancelTimer = null
    try {
      const settings = await deps.settings().then(backoff.success)
      if (disposed || version !== timerVersion || !settings.cleanupEnabled)
        return
      cancelTimer = schedule(() => {
        cancelTimer = null
        void automatic().finally(() => {
          if (version === timerVersion) void configureTimer()
        })
      }, settings.cleanupIntervalMinutes * 60_000)
    } catch (error) {
      if (backoff.handle(error)) return
      orca.log(
        `unifier: cleanup timer could not be configured: ${String(error)}`,
      )
    }
  }

  async function cleanupCommand(mode: 'dry' | 'live') {
    try {
      if (mode === 'live')
        await orca.storage.set(ARMED, true).then(backoff.success)
      const result = await run(mode)
      return (
        [
          ...result.removed.map(
            (id) => `${mode === 'dry' ? 'Would remove' : 'Removed'}: ${id}`,
          ),
          ...result.kept.map((w) => `Keep: ${w.id}: ${w.reason}`),
        ].join('\n') || 'No Worktrees to clean up.'
      )
    } catch (error) {
      orca.log(`unifier: cleanup command failed: ${String(error)}`)
      return 'Cleanup could not be completed. Check the plugin logs, then try again.'
    }
  }

  async function hideExternal() {
    try {
      const settings = await deps.settings().then(backoff.success)
      const worktrees = await deps.cli.listWorktrees()
      const hidden: string[] = []
      for (const w of worktrees) {
        const project = projectOf(w.path, settings.projectsRoot)
        if (
          !w.isMainWorktree ||
          !project ||
          isExcludedProject(project, settings.excludedProjects) ||
          hidden.includes(w.repoId)
        )
          continue
        if ((await protectedReason(w, worktrees, settings, false)) || disposed)
          continue
        await deps.cli.hideExternalWorktrees(w.repoId)
        hidden.push(w.repoId)
      }
      return (
        hidden.map((id) => `Hidden outside worktrees: ${id}`).join('\n') ||
        'No Repos to update.'
      )
    } catch (error) {
      orca.log(`unifier: hiding outside worktrees failed: ${String(error)}`)
      return 'Outside Worktrees could not all be hidden. Check the plugin logs, then try again.'
    }
  }

  const subs = [
    orca.commands.register('unifier.cleanupDryRun', () =>
      cleanupCommand('dry'),
    ),
    orca.commands.register('unifier.cleanupNow', () => cleanupCommand('live')),
    orca.commands.register('unifier.hideExternal', hideExternal),
    orca.events.on('workspace.changed', () => {
      // Orca publishes the current context on subscription. Activation is not
      // a workspace change and must not start background Git checks.
      if (initialContext) {
        initialContext = false
        return
      }
      return automatic()
    }),
    orca.settings.onDidChange(() => {
      void configureTimer()
    }),
  ]
  void configureTimer()
  return {
    run,
    dispose() {
      disposed = true
      backoff.dispose()
      ++timerVersion
      cancelTimer?.()
      cancelTimer = null
      for (const sub of subs) sub.dispose()
    },
  }
}
