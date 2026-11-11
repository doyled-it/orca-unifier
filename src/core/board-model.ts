import { basename, relative, resolve, sep } from 'node:path'
import { type AgentStates, orderForCard } from './agents'
import type { BoardFilter } from './board-filter'
import type { BoardCard, BoardModel, CardAgent } from './board-types'
import { projectOfWorktree } from './projects'
import type { BoardStatus, WorktreeRecord } from './types'
import { STATUS_LABELS } from './vocabulary'

export type { AgentEntry, AgentState, AgentStates } from './agents'
export type { BoardFilter } from './board-filter'
export { parseBoardFile } from './board-filter'
export type { BoardCard, BoardModel, CardAgent } from './board-types'

const ORDER: BoardStatus[] = ['todo', 'in-progress', 'in-review', 'completed']

function toStatus(s: string): BoardStatus {
  return (ORDER as string[]).includes(s) ? (s as BoardStatus) : 'todo'
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function mrId(v: unknown): number | null {
  const direct = num(v)
  if (direct !== null) return direct
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return num(o.iid) ?? num(o.number)
  }
  return null
}

function mrLabel(gitlab: unknown, github: unknown): string | null {
  const g = mrId(gitlab)
  if (g !== null) return `!${g}`
  const p = mrId(github)
  return p !== null ? `#${p}` : null
}

/** Second path segment under projectsRoot, or null when outside it. */
function repoUnderRoot(path: string, projectsRoot: string): string | null {
  const rel = relative(resolve(projectsRoot), resolve(path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return rel.split(sep)[1] || null
}

/** Cards with any agent blocked or waiting sort first. */
function urgency(c: BoardCard): number {
  return c.agents.some((a) => a.state === 'blocked' || a.state === 'waiting')
    ? 0
    : 1
}

function cardAgents(entries: AgentStates[string] | undefined): CardAgent[] {
  return orderForCard(entries ?? []).map((e) => ({
    state: e.state,
    since: e.since,
    title: e.title,
    detail: e.detail,
    agent: e.agent,
    model: e.model,
    ...(e.outsideDefaults ? { outsideDefaults: true } : {}),
  }))
}

function byUrgencyThenRecency(xs: { card: BoardCard; at: number }[]) {
  return xs
    .sort((a, b) => urgency(a.card) - urgency(b.card) || b.at - a.at)
    .map((x) => x.card)
}

export function buildBoard(
  worktrees: WorktreeRecord[],
  agents: AgentStates,
  filter: BoardFilter,
  opts: { projectsRoot: string; hideMainCheckouts: boolean },
): BoardModel {
  const byId = new Map(worktrees.map((w) => [w.id, w]))
  const mainByRepo = new Map<string, WorktreeRecord>()
  for (const w of worktrees) {
    if (w.isMainWorktree) mainByRepo.set(w.repoId, w)
  }
  const mainPathByRepo = new Map(
    [...mainByRepo].map(([repoId, w]) => [repoId, w.path]),
  )

  const projects = new Set<string>()
  const grouped = new Map<BoardStatus, { card: BoardCard; at: number }[]>(
    ORDER.map((s) => [s, []]),
  )
  const pinned: { card: BoardCard; at: number }[] = []
  let hiddenMainCount = 0
  let mainCheckoutCount = 0

  for (const w of worktrees) {
    if (w.isArchived) continue
    const project = projectOfWorktree(w, mainPathByRepo, opts.projectsRoot)
    if (project) projects.add(project)
    if (filter.scope === 'project' && project !== filter.project) continue
    if (w.isMainWorktree) mainCheckoutCount++
    if (w.isMainWorktree && opts.hideMainCheckouts) {
      hiddenMainCount++
      continue
    }

    const main = mainByRepo.get(w.repoId)
    const repo =
      repoUnderRoot(w.path, opts.projectsRoot) ??
      (main ? basename(main.path) : w.displayName)
    const status = toStatus(w.workspaceStatus)
    const mr = mrLabel(w.linkedGitLabMR, w.linkedPR)
    const card: BoardCard = {
      id: w.id,
      project,
      repo,
      title: w.displayName,
      branch: w.branch,
      status,
      kind: mr ? 'mr' : 'branch',
      isUnread: w.isUnread,
      isPinned: w.isPinned,
      hasNote: w.comment.trim() !== '',
      agents: cardAgents(agents[w.id]),
      mr,
      parentTitle: w.parentWorktreeId
        ? (byId.get(w.parentWorktreeId)?.displayName ?? null)
        : null,
      childCount: w.childWorktreeIds.length,
      isMain: w.isMainWorktree,
    }
    const entry = { card, at: w.lastActivityAt }
    if (w.isPinned) pinned.push(entry)
    else grouped.get(status)?.push(entry)
  }

  return {
    columns: ORDER.map((status) => ({
      status,
      label: STATUS_LABELS[status],
      cards: byUrgencyThenRecency(grouped.get(status) ?? []),
    })),
    pinned: byUrgencyThenRecency(pinned),
    projects: [...projects].sort(),
    hiddenMainCount,
    mainCheckoutCount,
    mainCheckoutsHidden: opts.hideMainCheckouts,
  }
}
