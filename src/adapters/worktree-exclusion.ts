import { isAbsolute } from 'node:path'
import {
  isExcludedProject,
  projectOf,
  projectOfWorktree,
} from '../core/projects'
import type { WorktreeRecord } from '../core/types'
import { nodeFs } from './fs'

/** Both the Worktree and its Repo main checkout must pass the same exclusions. */
export async function worktreeExclusionReason(
  worktree: Pick<WorktreeRecord, 'path' | 'repoId'>,
  mainPaths: Map<string, string>,
  projectsRoot: string,
  excluded: string[],
  canonical: (path: string) => string | Promise<string> = nodeFs.realpath,
): Promise<string | null> {
  const main = mainPaths.get(worktree.repoId)
  if (
    [
      projectOf(worktree.path, projectsRoot),
      main ? projectOf(main, projectsRoot) : null,
    ].some(
      (project) => project !== null && isExcludedProject(project, excluded),
    )
  )
    return 'This Project is excluded.'
  if (!main) return 'The Repo main checkout could not be resolved.'
  let root: string, path: string, mainPath: string
  try {
    ;[root, path, mainPath] = await Promise.all([
      canonical(projectsRoot),
      canonical(worktree.path),
      canonical(main),
    ])
  } catch {
    return 'The Project path could not be resolved.'
  }
  if (!isAbsolute(root) || !isAbsolute(path) || !isAbsolute(mainPath))
    return 'The Project path could not be resolved.'
  for (const [own, repo, base] of [
    [worktree.path, main, projectsRoot],
    [path, mainPath, root],
  ] as const) {
    const projects = [projectOf(own, base), repo ? projectOf(repo, base) : null]
    if (
      projects.some(
        (project) => project !== null && isExcludedProject(project, excluded),
      )
    )
      return 'This Project is excluded.'
  }
  if (
    !projectOfWorktree(
      { path, repoId: worktree.repoId },
      mainPath ? new Map([[worktree.repoId, mainPath]]) : new Map(),
      root,
    )
  )
    return 'The Worktree Project could not be resolved.'
  return null
}
