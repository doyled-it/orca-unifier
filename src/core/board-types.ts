/** Board data shapes. Node-free so the editor frame can import them. */
import type { AgentState } from './agents'
import type { BoardStatus } from './types'

export type { AgentState } from './agents'

/** One agent shown on a card. */
export interface CardAgent {
  state: AgentState
  since: number
  title: string | null
  /** Current tool and its input, such as "Bash: git status". */
  detail: string | null
  agent: string | null
  model: string | null
  outsideDefaults?: boolean
}

export interface BoardCard {
  id: string
  project: string | null
  repo: string
  title: string
  branch: string | null
  status: BoardStatus
  /** `mr` when the worktree links a merge or pull request. */
  kind: 'branch' | 'mr'
  isUnread: boolean
  isPinned: boolean
  /** The worktree has a non-empty comment. */
  hasNote: boolean
  /** The most urgent top-level agent first, then the rest (sub-agents last). */
  agents: CardAgent[]
  mr: string | null
  parentTitle: string | null
  childCount: number
  isMain: boolean
}

/** One agent Orca knows and the models it offers, as the start form lists them. */
export interface AgentModels {
  agent: string
  models: { id: string; label: string }[]
}

/** A project's live Orchestrator, as its board shows it. */
export interface OrchestratorView {
  terminalId: string
  /** The terminal's title. */
  name: string
  agent: string
  model: string
  /** Null when the board cannot tell. */
  state: AgentState | null
}

export interface BoardModel {
  columns: { status: BoardStatus; label: string; cards: BoardCard[] }[]
  /** Pinned worktrees, shown in their own strip instead of a column. */
  pinned: BoardCard[]
  projects: string[]
  hiddenMainCount: number
  mainCheckoutCount?: number
  mainCheckoutsHidden?: boolean
  /** Partial data is still usable; explain any missing Worktrees. */
  notice?: string | null
  /** Project boards: the live Orchestrator, or null. Absent on models built without one. */
  orchestrator?: OrchestratorView | null
}
