import type { AgentEntry } from './agents'

export type BoardStatus = 'todo' | 'in-progress' | 'in-review' | 'completed'

export interface UnifierSettings {
  projectsRoot: string
  excludedProjects: string[]
  protectedPaths: string[]
  orchestratorAgent: string
  orchestratorModel: string
  workerImplementation: string
  workerReview: string
  workerDesign: string
  workerProse: string
  hideMainCheckouts: boolean
  cleanupEnabled: boolean
  cleanupIntervalMinutes: number
  approverEnabled: boolean
  setupEnabled: boolean
}

export interface WorktreeRecord {
  id: string
  /** Host workspace id (`identity:<key>`), the form `workspace.open` takes for a git worktree. */
  identityKey: string
  projectId: string
  repoId: string
  path: string
  branch: string | null
  displayName: string
  isMainWorktree: boolean
  isPinned: boolean
  isUnread: boolean
  isArchived: boolean
  /** Free-text note on the worktree; empty when none. */
  comment: string
  workspaceStatus: BoardStatus | string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  linkedGitLabMR: unknown
  linkedPR: unknown
  lastActivityAt: number
}

/** A worktree from `orca worktree ps`: the record plus its agent panes. */
export interface WorktreeSummary extends WorktreeRecord {
  agents: AgentEntry[]
}
