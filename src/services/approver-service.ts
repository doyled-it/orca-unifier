import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { containsNestedGit, resolveRealpath } from '../adapters/realpath'
import { worktreeExclusionReason } from '../adapters/worktree-exclusion'
import type { AgentEntry, AgentState } from '../core/agents'
import {
  type ApprovalPrompt,
  judge,
  parseApprovalPrompt,
} from '../core/approval-policy'
import { isExcludedProject, projectOfWorktree } from '../core/projects'
import type { UnifierSettings } from '../core/types'
import type { BoardService, Schedule } from './board-service'
import type { Messenger } from './messenger'
import { createConsentBackoff, isConsentError } from './retirement'
import type { TrackedWorker, Tracker } from './tracker'

const SEEN = 'approver.seen.v1'
const ACTIVE = 'approver.active.v1'
const APPROVED = 'approver.approved.v1'
const CLAIMS = 'approver.claims.v1'
const LOG = 'approver.log'
const LIMIT = 500
const POLL_MS = 3000
const CLAIM_TTL_MS = 60_000
const EVENT_TTL_MS = 2 * 60 * 1000
const SUBJECT = '[approver] ASK: worker needs approval'
const PRESS = 'Press enter to confirm or esc to cancel'

type ApprovalClaim = { key: string; claimedAt: number }

function isClaim(value: JsonValue): value is ApprovalClaim {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.key === 'string' &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt)
  )
}

const scheduleTimeout: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

function worktreePath(workspaceId: string | null): string | null {
  if (!workspaceId) return null
  const at = workspaceId.indexOf('::')
  if (at < 1) return null
  const path = workspaceId.slice(at + 2)
  return isAbsolute(path) &&
    !/[~$]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    !path.split('/').includes('..')
    ? path
    : null
}

/** Only the current prompt, excluding earlier conversation and completed prompts. */
function promptBlock(screen: string, prompt: ApprovalPrompt): string {
  const lines = screen
    .trimEnd()
    .split('\n')
    .map((line) => line.trimEnd())
  let boundary = 0
  for (let i = lines.length - 2; i >= 0; i--) {
    if ((lines[i] as string).trim() === PRESS) {
      boundary = i + 1
      break
    }
  }
  let start = -1
  for (let i = lines.length - 1; i >= boundary; i--) {
    const line = (lines[i] as string).trim()
    if (
      line === 'Would you like to run the following command?' ||
      line === 'Would you like to make the following edits?'
    ) {
      start = i
      break
    }
  }
  if (start < 0) {
    start = boundary
  } else if (prompt.kind === 'edit') {
    for (let i = start - 1; i >= boundary; i--) {
      if (lines[i] && /^\S/.test(lines[i] as string)) {
        start = i
        break
      }
    }
  }
  return lines.slice(start).join('\n')
}

function promptFingerprint(screen: string, prompt: ApprovalPrompt): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        prompt.kind,
        prompt.kind === 'edit'
          ? [prompt.path ?? prompt.command, prompt.summary ?? null]
          : prompt.command,
        promptBlock(screen, prompt),
      ]),
    )
    .digest('hex')
}

async function packageScripts(
  fs: FsLike,
  worktree: string,
): Promise<string[] | undefined> {
  try {
    const value: unknown = JSON.parse(
      await fs.read(join(worktree, 'package.json')),
    )
    if (!value || typeof value !== 'object' || !('scripts' in value))
      return undefined
    const scripts = value.scripts
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? Object.keys(scripts)
      : undefined
  } catch {
    return undefined
  }
}

export function createApproverService(
  orca: OrcaWorkerApi,
  deps: {
    tracker: Pick<Tracker, 'workers'>
    cli: OrcaCli
    messenger: Pick<Messenger, 'toOrchestrator'>
    board: Pick<BoardService, 'agentStates'>
    fs: FsLike
    settings: () => Promise<UnifierSettings>
    schedule?: Schedule
    now?: () => number
  },
): { tick(): Promise<void>; dispose(): void } {
  const schedule = deps.schedule ?? scheduleTimeout
  const now = deps.now ?? Date.now
  const events = new Map<string, { state: AgentState; at: number }>()
  const resumed = new Set<string>()
  let disposed = false
  let cancelPending: (() => void) | null = null
  let inFlight: Promise<void> | null = null
  let requested = false
  let pollAgain = false
  const backoff = createConsentBackoff(
    (message) => orca.log(message),
    schedule,
    () => void tick(),
  )

  function cancel() {
    cancelPending?.()
    cancelPending = null
  }

  async function workerState(worker: TrackedWorker, entries: AgentEntry[]) {
    let entry: AgentEntry | undefined = entries
      .filter((e) => e.terminalId === worker.terminalId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    let live = events.get(worker.terminalId)
    if (live && now() - live.at > EVENT_TTL_MS) {
      events.delete(worker.terminalId)
      live = undefined
    }
    if (
      !entry &&
      entries.length > 0 &&
      (live ||
        entries.some((e) => e.state === 'waiting' || e.state === 'blocked'))
    ) {
      const info = await deps.cli.terminalInfo(worker.terminalId)
      entry = entries.find((e) => e.paneKey === info?.paneKey)
    }
    if (entry?.agent !== 'codex') return undefined
    if (live && live.at >= entry.updatedAt) return live.state
    return entry.state
  }

  async function readScreen(terminalId: string) {
    const { lines } = await orca.host
      .call('terminal.read', {
        terminalId,
        maxLines: 2000,
      })
      .then(backoff.success)
    // Normalize menu decoration before parsing as well as fingerprinting.
    return stripVTControlCharacters(lines.join('\n'))
      .split('\n')
      .map((line) => line.replace(/^\s*[›>❯]?\s*(?=\d+\.\s+(?:Yes|No)\b)/, ''))
      .join('\n')
  }

  async function readClaims(): Promise<Record<string, number>> {
    const raw = await orca.storage.get(CLAIMS).then(backoff.success)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    )
  }

  async function migrateClaims() {
    const raw = await orca.storage.get(SEEN).then(backoff.success)
    if (!Array.isArray(raw) || !raw.some(isClaim)) return
    const claims = await readClaims()
    for (const claim of raw.filter(isClaim)) {
      claims[claim.key] = Math.max(
        claims[claim.key] ?? claim.claimedAt,
        claim.claimedAt,
      )
    }
    // Save claims first so interruption cannot lose an uncertain delivery.
    await orca.storage.set(CLAIMS, claims).then(backoff.success)
    await orca.storage
      .set(
        SEEN,
        raw.filter((s) => typeof s === 'string'),
      )
      .then(backoff.success)
  }

  async function releaseClaim(key: string) {
    const claims = await readClaims()
    delete claims[key]
    await orca.storage.set(CLAIMS, claims).then(backoff.success)
  }

  async function clearActive(terminalIds: readonly string[]) {
    if (terminalIds.length === 0) return
    const raw = await orca.storage.get(ACTIVE).then(backoff.success)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const active = { ...raw }
    let changed = false
    for (const terminalId of terminalIds) {
      if (!Object.hasOwn(active, terminalId)) continue
      delete active[terminalId]
      changed = true
    }
    if (changed) await orca.storage.set(ACTIVE, active).then(backoff.success)
  }

  async function handle(worker: TrackedWorker) {
    const screen = await readScreen(worker.terminalId)
    const prompt = parseApprovalPrompt(screen)
    if (disposed) return
    const rawActive = await orca.storage.get(ACTIVE).then(backoff.success)
    const active =
      rawActive && typeof rawActive === 'object' && !Array.isArray(rawActive)
        ? rawActive
        : {}
    if (!prompt) {
      if (Object.hasOwn(active, worker.terminalId)) {
        delete active[worker.terminalId]
        await orca.storage.set(ACTIVE, active).then(backoff.success)
      }
      return
    }
    const command =
      prompt.kind === 'edit' ? (prompt.path ?? prompt.command) : prompt.command
    const hash = promptFingerprint(screen, prompt)
    const key = JSON.stringify([worker.terminalId, command, hash])
    const raw = await orca.storage.get(SEEN).then(backoff.success)
    const seen = Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string')
      : []
    const occurrence = active[worker.terminalId]
    if (
      occurrence &&
      typeof occurrence === 'object' &&
      !Array.isArray(occurrence) &&
      occurrence.key === key &&
      occurrence.handled === true &&
      seen.includes(key)
    )
      return
    await orca.storage
      .set(ACTIVE, {
        ...active,
        [worker.terminalId]: { key, handled: false },
      })
      .then(backoff.success)
    const rawApproved = await orca.storage.get(APPROVED).then(backoff.success)
    const approved = Array.isArray(rawApproved)
      ? rawApproved.filter((s): s is string => typeof s === 'string')
      : []
    const claims = await readClaims()
    const claimedAt = claims[key]
    if (claimedAt !== undefined && now() - claimedAt <= CLAIM_TTL_MS) return

    const path = worktreePath(worker.workspaceId)
    let unresolved = false
    // Preserve the parser's wrap and edit-summary evidence, and never infer a cwd.
    let decision =
      claimedAt !== undefined
        ? {
            verdict: 'escalate' as const,
            reason: 'Approval was interrupted; please check this prompt',
          }
        : approved.includes(key)
          ? {
              verdict: 'escalate' as const,
              reason:
                'This prompt was previously approved in this terminal; please check the repeated request.',
            }
          : judge(prompt, {
              worktreePath: path ?? '',
              cwd: null,
              protectedNames: (await deps.settings().then(backoff.success))
                .protectedPaths,
              packageScripts: path
                ? await packageScripts(deps.fs, path)
                : undefined,
              containsGit: (p) => containsNestedGit(p, path ?? ''),
              realpath: (p) => {
                const resolved = resolveRealpath(p)
                if (!resolved) unresolved = true
                return resolved
              },
            })
    if (unresolved) {
      // An unresolved link invalidates the path context. Let policy explain it.
      decision = judge(prompt, { worktreePath: '', cwd: null })
    }
    if (
      disposed ||
      !(await deps.settings().then(backoff.success)).approverEnabled
    )
      return
    const entry = {
      at: now(),
      terminalId: worker.terminalId,
      command,
      verdict: decision.verdict,
    }
    const log = await orca.storage.get(LOG).then(backoff.success)
    await orca.storage
      .set(
        LOG,
        [...(Array.isArray(log) ? log : []), entry].slice(-LIMIT) as JsonValue,
      )
      .then(backoff.success)
    orca.log(JSON.stringify(entry))
    if (
      disposed ||
      !(await deps.settings().then(backoff.success)).approverEnabled
    )
      return
    if (decision.verdict === 'approve') {
      // Persist before reading so a restart or uncertain send cannot approve twice.
      await orca.storage
        .set(CLAIMS, { ...claims, [key]: now() })
        .then(backoff.success)
      if (disposed) return
      let currentScreen: string
      try {
        currentScreen = await readScreen(worker.terminalId)
      } catch (error) {
        if (isConsentError(error)) throw error
        await releaseClaim(key)
        throw error
      }
      const currentPrompt = parseApprovalPrompt(currentScreen)
      if (
        disposed ||
        !currentPrompt ||
        promptFingerprint(currentScreen, currentPrompt) !== hash
      ) {
        await releaseClaim(key)
        return
      }
      // Nothing may await between the matching fingerprint and key delivery.
      await deps.cli.sendTerminalText(worker.terminalId, 'y', false)
      await orca.storage.set(APPROVED, [...approved, key]).then(backoff.success)
    } else {
      await deps.messenger.toOrchestrator(
        worker.orchestratorTerminalId,
        SUBJECT,
        `Worker terminal: ${worker.terminalId}\nWorker assignment: ${worker.taskId ?? 'unknown'}\n${prompt.kind === 'edit' ? 'Destination' : 'Command'}: ${command || '(unreadable)'}\nReason: ${decision.reason}`,
      )
    }
    // Persist handled history before releasing any claim.
    await orca.storage
      .set(SEEN, seen.includes(key) ? seen : [...seen, key].slice(-LIMIT))
      .then(backoff.success)
    await orca.storage
      .set(ACTIVE, {
        ...active,
        [worker.terminalId]: { key, handled: true },
      })
      .then(backoff.success)
    await releaseClaim(key)
  }

  async function poll() {
    cancel()
    const settings = await deps.settings().then(backoff.success)
    // Retry if startup migration fails before worker discovery can begin.
    pollAgain = true
    await migrateClaims()
    if (disposed) return
    const workers = (await deps.tracker.workers()).filter(
      (w) =>
        w.agent === 'codex' &&
        !isExcludedProject(w.project, settings.excludedProjects),
    )
    // Keep resume boundaries even if a newer waiting event replaces the state,
    // or summary discovery fails. Serialize these writes with prompt handling.
    const pending = [...resumed]
    resumed.clear()
    try {
      await clearActive(
        pending.filter((id) => workers.some((w) => w.terminalId === id)),
      )
    } catch (error) {
      for (const id of pending) resumed.add(id)
      throw error
    }
    if (!settings.approverEnabled) {
      pollAgain = false
      return
    }
    if (workers.length === 0 || disposed) {
      pollAgain = false
      return
    }
    // Failed state discovery is unknown, so retry without reading any terminals.
    pollAgain = true
    const worktrees = await deps.cli.listWorktrees()
    const byWorkspace = new Map(worktrees.map((w) => [w.id, w]))
    const mainPathByRepoId = new Map(
      worktrees.filter((w) => w.isMainWorktree).map((w) => [w.repoId, w.path]),
    )
    const presentWorkers = workers.filter((w) =>
      byWorkspace.has(w.workspaceId ?? ''),
    )
    if (presentWorkers.length === 0) {
      pollAgain = false
      return
    }
    const { states } = await deps.board.agentStates()
    pollAgain = false
    for (const worker of presentWorkers) {
      if (disposed) return
      try {
        const worktree = byWorkspace.get(worker.workspaceId ?? '')
        if (!worktree) continue
        if (worktree.path !== worktreePath(worker.workspaceId)) {
          pollAgain = true
          continue
        }
        const exclusion = await worktreeExclusionReason(
          worktree,
          mainPathByRepoId,
          settings.projectsRoot,
          settings.excludedProjects,
          deps.fs.realpath,
        )
        if (exclusion) {
          if (!exclusion.includes('excluded')) pollAgain = true
          continue
        }
        const project = projectOfWorktree(
          worktree,
          mainPathByRepoId,
          settings.projectsRoot,
        )
        if (!project) {
          pollAgain = true
          continue
        }
        if (isExcludedProject(project, settings.excludedProjects)) continue
        if (!Object.hasOwn(states, worker.workspaceId ?? '')) {
          pollAgain = true
          continue
        }
        const state = await workerState(
          worker,
          states[worker.workspaceId ?? ''] ?? [],
        )
        if (state === 'working' || state === 'done')
          await clearActive([worker.terminalId])
        if (state !== 'waiting' && state !== 'blocked') continue
        pollAgain = true
        await handle(worker)
      } catch (error) {
        if (backoff.handle(error)) return
        pollAgain = true
        orca.log(
          `unifier: approval check for ${worker.terminalId} failed: ${String(error)}`,
        )
      }
    }
  }

  function tick(): Promise<void> {
    if (disposed || backoff.pending) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = (async () => {
      do {
        requested = false
        try {
          await poll()
        } catch (error) {
          if (backoff.handle(error)) return
          orca.log(`unifier: approval polling failed: ${String(error)}`)
        }
      } while (requested && !disposed && !backoff.pending)
    })().finally(() => {
      inFlight = null
      if (pollAgain && !disposed && !backoff.pending)
        cancelPending = schedule(() => {
          cancelPending = null
          void tick()
        }, POLL_MS)
    })
    return inFlight
  }

  function requestTick() {
    if (disposed) return
    requested = true
    void tick()
  }

  const subs = [
    orca.events.on('agent.status.changed', (e) => {
      if (e.terminalId) {
        const old = events.get(e.terminalId)
        if (!old || e.receivedAt >= old.at) {
          const state = e.mainAgent?.state ?? e.state
          events.set(e.terminalId, {
            state,
            at: e.receivedAt,
          })
          if (state === 'working' || state === 'done') resumed.add(e.terminalId)
        }
      }
      requestTick()
    }),
    orca.settings.onDidChange(requestTick),
  ]

  return {
    tick,
    dispose() {
      disposed = true
      backoff.dispose()
      cancel()
      events.clear()
      resumed.clear()
      for (const sub of subs) sub.dispose()
    },
  }
}
