import type { BoardFilter } from './core/board-filter'
import type { AgentModels, BoardModel } from './core/board-types'
import type { BoardStatus } from './core/types'
import type { WorkerDefaults, WorkerKind } from './core/worker-defaults'

declare module 'orca' {
  interface PluginRequests {
    'board.get': {
      input: { filter: BoardFilter }
      output: { model: BoardModel } | { error: string }
    }
    'board.setMainCheckouts': {
      input: { filter: BoardFilter; hidden: boolean }
      output: { ok: true } | { error: string }
    }
    'board.setStatus': {
      input: { worktreeId: string; status: BoardStatus }
      output: { ok: true } | { error: string }
    }
    'hub.open': {
      input: BoardFilter
      output: { ok: true } | { error: string }
    }
    'board.openWorktree': {
      input: { worktreeId: string }
      output: { ok: true } | { error: string }
    }
    'orchestrator.options': {
      /** With a project, its last started choice is the default. */
      input: { project: string } | null
      output: {
        agents: AgentModels[]
        defaults: { agent: string; model: string }
      }
    }
    'workerDefaults.get': {
      input: { project: string }
      output: { defaults: WorkerDefaults; options: AgentModels[] }
    }
    'workerDefaults.set': {
      input: { project: string; kind: WorkerKind; agent: string; model: string }
      output: { ok: true } | { error: string }
    }
    'orchestrator.start': {
      input: { project: string; agent: string; model: string }
      output: { ok: true } | { error: string }
    }
    'orchestrator.jump': {
      input: { project: string }
      output: { ok: true } | { error: string }
    }
  }
  interface PluginPanelEvents {
    'board.changed': { at: number }
  }
}
