import { relative, resolve, sep } from 'node:path'

/** First path segment under projectsRoot, or null outside it or for the root itself. */
export function projectOf(path: string, projectsRoot: string): string | null {
  const rel = relative(resolve(projectsRoot), resolve(path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null
  const first = rel.split(sep)[0]
  return first ? first : null
}

/** Configured Project exclusions, in any letter case (macOS paths ignore case). */
export function isExcludedProject(
  project: string,
  excluded: string[],
): boolean {
  return excluded.some((name) => name.toLowerCase() === project.toLowerCase())
}

/**
 * The Project of a worktree: by its own path, or else by its repo's main
 * checkout (Orca keeps worktrees under `~/orca/workspaces`, outside the root).
 */
export function projectOfWorktree(
  w: { path: string; repoId: string },
  mainPathByRepoId: Map<string, string>,
  projectsRoot: string,
): string | null {
  const own = projectOf(w.path, projectsRoot)
  if (own) return own
  const main = mainPathByRepoId.get(w.repoId)
  return main ? projectOf(main, projectsRoot) : null
}
