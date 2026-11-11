import { type AgentEntry, isAgentState } from '../core/agents'
import type {
  BoardStatus,
  WorktreeRecord,
  WorktreeSummary,
} from '../core/types'
import type { Exec } from './exec'

export type { WorktreeSummary } from '../core/types'

export type OrcaCliErrorCode = 'not_found' | 'timeout' | 'bad_output' | 'failed'

export class OrcaCliError extends Error {
  code: OrcaCliErrorCode
  constructor(code: OrcaCliErrorCode, message: string) {
    super(message)
    this.name = 'OrcaCliError'
    this.code = code
  }
}

export interface OrcaCli {
  listWorktrees(): Promise<WorktreeRecord[]>
  /** `orca worktree ps`: every worktree with its agent panes, as the native board shows them. */
  worktreeSummaries(): Promise<{
    summaries: WorktreeSummary[]
    truncated: boolean
  }>
  setStatus(worktreeId: string, status: BoardStatus): Promise<void>
  removeWorktree(worktreeId: string): Promise<void>
  hideExternalWorktrees(repoId: string): Promise<void>
  ensureFolderWorkspace(path: string): Promise<string>
  sendOrchestrationMessage(m: {
    fromTerminalId: string
    runId: string
    subject: string
    body: string
  }): Promise<void>
  findRunId(coordinatorTerminalId: string): Promise<string | null>
  sendTerminalText(
    terminalId: string,
    text: string,
    enter: boolean,
  ): Promise<void>
  launchAgent(l: {
    workspacePath: string
    agent: string
    model: string
    prompt: string
  }): Promise<{ terminalId: string }>
  /** `orca terminal switch`: navigates the window to that terminal. */
  switchTerminal(terminalId: string): Promise<void>
  /**
   * A live terminal's title and pane key (`<tabId>:<leafId>`, as `worktree ps`
   * names agent panes), or null when the terminal is gone or has exited.
   */
  terminalInfo(
    terminalId: string,
  ): Promise<{ title: string | null; paneKey: string | null } | null>
}

type Json = Record<string, unknown>

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function toRecord(w: Json): WorktreeRecord {
  const branch = typeof w.branch === 'string' ? w.branch : null
  return {
    id: str(w.id),
    identityKey: isObj(w.identity) ? str(w.identity.key) : '',
    projectId: str(w.projectId),
    repoId: str(w.repoId),
    path: str(w.path),
    branch: branch === null ? null : branch.replace(/^refs\/heads\//, ''),
    displayName: str(w.displayName),
    isMainWorktree: w.isMainWorktree === true,
    isPinned: w.isPinned === true,
    isUnread: w.isUnread === true,
    isArchived: w.isArchived === true,
    comment: str(w.comment),
    workspaceStatus: str(w.workspaceStatus, 'todo'),
    parentWorktreeId:
      typeof w.parentWorktreeId === 'string' ? w.parentWorktreeId : null,
    childWorktreeIds: Array.isArray(w.childWorktreeIds)
      ? w.childWorktreeIds.filter((c): c is string => typeof c === 'string')
      : [],
    linkedGitLabMR: w.linkedGitLabMR ?? null,
    linkedPR: w.linkedPR ?? null,
    lastActivityAt: typeof w.lastActivityAt === 'number' ? w.lastActivityAt : 0,
  }
}

/** Longest tool detail kept; the board truncates it further with CSS. */
const DETAIL_MAX = 200

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function firstText(...vs: unknown[]): string | null {
  for (const v of vs) {
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** "Bash: git status", with the input on one line. */
function toolDetail(name: unknown, input: unknown): string | null {
  const tool = firstText(name)
  if (!tool) return null
  const text =
    typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : ''
  return text ? `${tool}: ${text.slice(0, DETAIL_MAX)}` : tool
}

function toAgent(a: Json): AgentEntry | null {
  if (typeof a.paneKey !== 'string' || !a.paneKey) return null
  const main = isObj(a.mainAgent) ? a.mainAgent : {}
  const state = isAgentState(main.state)
    ? main.state
    : isAgentState(a.state)
      ? a.state
      : null
  if (!state) return null
  const since = num(a.stateStartedAt) ?? num(main.stateStartedAt) ?? 0
  return {
    paneKey: a.paneKey,
    parentPaneKey: firstText(a.parentPaneKey),
    terminalId: null,
    title: firstText(a.conversationName, a.displayName, a.taskTitle),
    detail: toolDetail(a.toolName, a.toolInput),
    state,
    since,
    updatedAt: num(a.updatedAt) ?? since,
    agent: firstText(a.agentType),
    model: null,
  }
}

function toSummary(w: Json): WorktreeSummary {
  const record = toRecord({
    ...w,
    id: w.worktreeId ?? w.id,
    isUnread: w.unread ?? w.isUnread,
  })
  if (!Array.isArray(w.agents))
    throw new OrcaCliError('bad_output', 'worktree ps: missing agent evidence')
  const agents = w.agents.map((a) => (isObj(a) ? toAgent(a) : null))
  if (agents.some((a) => a === null))
    throw new OrcaCliError(
      'bad_output',
      'worktree ps: unreadable agent evidence',
    )
  return { ...record, agents: agents as AgentEntry[] }
}

function findTerminalId(result: unknown): string | null {
  if (!isObj(result)) return null
  const candidates: unknown[] = [
    // Orca 1.4.255: `{ outcome: { kind: 'terminal', handle, paneKey }, ... }`.
    isObj(result.outcome) ? result.outcome.handle : undefined,
    result.terminalId,
    result.terminalHandle,
    isObj(result.terminal) ? result.terminal.handle : undefined,
    isObj(result.terminal) ? result.terminal.id : undefined,
    isObj(result.outcome) ? result.outcome.terminalId : undefined,
    isObj(result.outcome) ? result.outcome.terminalHandle : undefined,
    isObj(result.outcome) && isObj(result.outcome.terminal)
      ? result.outcome.terminal.handle
      : undefined,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return null
}

export function createOrcaCli(exec: Exec, orcaBin: string): OrcaCli {
  async function run(args: string[]): Promise<unknown> {
    let res: Awaited<ReturnType<Exec>>
    try {
      res = await exec(orcaBin, [...args, '--json'])
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err?.code === 'ENOENT') {
        throw new OrcaCliError('not_found', `orca not found at ${orcaBin}`)
      }
      throw new OrcaCliError('failed', String(err?.message ?? e))
    }
    if (res.error === 'timeout') {
      throw new OrcaCliError('timeout', `orca ${args[0]} timed out`)
    }
    if (res.error === 'not_found') {
      throw new OrcaCliError('not_found', `orca not found at ${orcaBin}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.stdout)
    } catch {
      if (res.code !== 0) {
        throw new OrcaCliError(
          'failed',
          `orca ${args[0]} exited ${res.code}: ${res.stderr.trim()}`,
        )
      }
      throw new OrcaCliError(
        'bad_output',
        `orca ${args[0]}: output is not JSON`,
      )
    }
    if (!isObj(parsed) || typeof parsed.ok !== 'boolean') {
      throw new OrcaCliError('bad_output', `orca ${args[0]}: unexpected shape`)
    }
    if (!parsed.ok || res.code !== 0) {
      const detail =
        isObj(parsed.error) && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : res.stderr.trim()
      throw new OrcaCliError('failed', `orca ${args[0]} failed: ${detail}`)
    }
    return parsed.result
  }

  return {
    async listWorktrees() {
      const result = await run(['worktree', 'list'])
      if (!isObj(result) || !Array.isArray(result.worktrees)) {
        throw new OrcaCliError('bad_output', 'worktree list: no worktrees')
      }
      return result.worktrees.filter(isObj).map(toRecord)
    },
    async worktreeSummaries() {
      const result = await run(['worktree', 'ps'])
      if (!isObj(result) || !Array.isArray(result.worktrees)) {
        throw new OrcaCliError('bad_output', 'worktree ps: no worktrees')
      }
      return {
        summaries: result.worktrees.filter(isObj).map(toSummary),
        truncated: result.truncated === true,
      }
    },
    async setStatus(worktreeId, status) {
      await run([
        'worktree',
        'set',
        '--worktree',
        `id:${worktreeId}`,
        '--workspace-status',
        status,
      ])
    },
    async removeWorktree(worktreeId) {
      await run(['worktree', 'rm', '--worktree', `id:${worktreeId}`])
    },
    async hideExternalWorktrees(repoId) {
      await run([
        'repo',
        'set',
        '--repo',
        `id:${repoId}`,
        '--external-worktree-visibility',
        'hide',
      ])
    },
    async ensureFolderWorkspace(path) {
      const result = await run([
        'repo',
        'add',
        '--path',
        path,
        '--kind',
        'folder',
      ])
      const id =
        isObj(result) && isObj(result.repo) ? result.repo.id : undefined
      if (typeof id !== 'string' || !id) {
        throw new OrcaCliError('bad_output', 'repo add: no repo id')
      }
      return `${id}::${path}`
    },
    async sendOrchestrationMessage(m) {
      await run([
        'orchestration',
        'send',
        '--from',
        m.fromTerminalId,
        '--to',
        `run:${m.runId}`,
        '--subject',
        m.subject,
        '--body',
        m.body,
      ])
    },
    async findRunId(coordinatorTerminalId) {
      const result = await run(['orchestration', 'run-list', '--full'])
      if (!isObj(result) || !Array.isArray(result.runs)) {
        throw new OrcaCliError('bad_output', 'run-list: no runs')
      }
      for (const r of result.runs) {
        if (
          isObj(r) &&
          r.coordinator_handle === coordinatorTerminalId &&
          typeof r.id === 'string'
        ) {
          return r.id
        }
      }
      return null
    },
    async sendTerminalText(terminalId, text, enter) {
      const args = [
        'terminal',
        'send',
        '--terminal',
        terminalId,
        '--text',
        text,
      ]
      if (enter) args.push('--enter')
      await run(args)
    },
    async launchAgent(l) {
      const result = await run([
        'agent',
        'launch',
        '--agent',
        l.agent,
        '--worktree',
        `path:${l.workspacePath}`,
        '--model',
        l.model,
        // A chat surface has no terminal handle to track or message.
        '--surface',
        'terminal',
        '--prompt',
        l.prompt,
      ])
      const terminalId = findTerminalId(result)
      if (!terminalId) {
        throw new OrcaCliError('bad_output', 'agent launch: no terminal handle')
      }
      return { terminalId }
    },
    async switchTerminal(terminalId) {
      await run(['terminal', 'switch', '--terminal', terminalId])
    },
    async terminalInfo(terminalId) {
      let result: unknown
      try {
        result = await run(['terminal', 'show', '--terminal', terminalId])
      } catch (e) {
        // A closed terminal's handle goes stale; anything else is a real failure.
        if (
          e instanceof OrcaCliError &&
          e.code === 'failed' &&
          /terminal_handle_stale|terminal_not_found/.test(e.message)
        ) {
          return null
        }
        throw e
      }
      const t = isObj(result) && isObj(result.terminal) ? result.terminal : null
      if (!t) throw new OrcaCliError('bad_output', 'terminal show: no terminal')
      // A closed terminal stays listed for a while, orphaned with an exit cause.
      if (t.orphaned === true || isObj(t.exitCause)) return null
      const tab = firstText(t.tabId)
      const leaf = firstText(t.leafId)
      return {
        title: firstText(t.title),
        paneKey: tab && leaf ? `${tab}:${leaf}` : null,
      }
    },
  }
}
