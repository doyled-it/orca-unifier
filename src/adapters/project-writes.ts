import { basename, join, resolve } from 'node:path'
import { BOARD_DIR } from '../core/hubs'
import { isExcludedProject } from '../core/projects'
import type { FsLike } from './fs'

/** Validate all existing components before creating plugin metadata. */
export async function safeMetadataFolder(
  fs: FsLike,
  projectsRoot: string,
  project: string | null,
  filename: string,
  excluded: string[],
): Promise<string> {
  const root = await fs.realpath(projectsRoot)
  const folder =
    project === null ? root : await fs.realpath(join(root, project))
  if (
    (project !== null && folder !== join(root, project)) ||
    isExcludedProject(basename(folder), excluded)
  )
    throw new Error('That Project folder is outside the allowed location.')
  return safeWorktreeMetadata(fs, folder, filename)
}

/** Share canonical and lstat checks for every plugin-owned metadata write. */
export async function safeWorktreeMetadata(
  fs: FsLike,
  worktree: string,
  filename: string,
): Promise<string> {
  const folder = await fs.realpath(worktree)
  if (basename(filename) !== filename)
    throw new Error('The metadata filename is invalid.')
  for (const path of [
    join(folder, BOARD_DIR),
    join(folder, BOARD_DIR, filename),
  ]) {
    const stat = await fs.lstat(path)
    if (stat?.isSymbolicLink())
      throw new Error('The Project metadata must not use symbolic links.')
    try {
      if (resolve(await fs.realpath(path)) !== path)
        throw new Error('The Project metadata resolves outside the Worktree.')
    } catch (e) {
      if (stat || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  return folder
}
