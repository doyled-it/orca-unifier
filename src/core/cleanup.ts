export interface RemovalFacts {
  isMainWorktree: boolean
  isPinned: boolean
  isHub: boolean
  dirty: boolean | 'unknown'
  hasUpstream: boolean | 'unknown'
  ahead: number | 'unknown'
  merge: 'merged' | 'unmerged' | 'unknown'
  liveAgent: boolean | 'unknown'
}

/** Every rule needs explicit safe evidence. Missing or unknown facts keep it. */
export function evaluateRemoval(
  f: RemovalFacts,
): { remove: true } | { remove: false; reason: string } {
  if (f.isMainWorktree !== false) {
    return {
      remove: false,
      reason: 'Main worktree rule: keep the main checkout.',
    }
  }
  if (f.isPinned !== false) {
    return { remove: false, reason: 'Pinned rule: keep pinned worktrees.' }
  }
  if (f.isHub !== false) {
    return { remove: false, reason: 'Hub rule: keep hub workspaces.' }
  }
  if (f.dirty !== false) {
    return {
      remove: false,
      reason: 'Dirty rule: a clean working directory has not been confirmed.',
    }
  }
  if (f.hasUpstream !== true) {
    return {
      remove: false,
      reason: 'Upstream rule: an upstream branch has not been confirmed.',
    }
  }
  if (f.ahead !== 0) {
    return {
      remove: false,
      reason: 'Ahead rule: zero unpushed commits has not been confirmed.',
    }
  }
  if (f.merge !== 'merged') {
    return {
      remove: false,
      reason: 'Merged rule: merged work has not been confirmed.',
    }
  }
  if (f.liveAgent !== false) {
    return {
      remove: false,
      reason:
        f.liveAgent === 'unknown'
          ? 'Live agent rule: agent activity could not be confirmed.'
          : 'Live agent rule: keep an active agent.',
    }
  }
  return { remove: true }
}
