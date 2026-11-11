import { resolve, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { type Exec, nodeExec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { safeMetadataFolder } from '../adapters/project-writes'
import {
  BOARD_DIR,
  BOARD_RELATIVE,
  boardFileContents,
  boardFilePath,
  type HubTarget,
  isPlainProjectName,
} from '../core/hubs'
import { isExcludedProject } from '../core/projects'
import type { UnifierSettings } from '../core/types'
import '../protocol'

const EXCLUDE_LINE = `${BOARD_DIR}/`

/** Keeps `.unifier/` out of a hub that is itself a git repo. Once, never twice. */
export async function excludeFromGit(
  fs: FsLike,
  hub: string,
  excluded: string[],
  exec: Exec = nodeExec,
): Promise<void> {
  let git = `${hub}/.git`
  if (!(await fs.exists(git))) return
  if (!(await fs.exists(`${git}/HEAD`))) {
    const result = await exec('git', [
      '-C',
      hub,
      'rev-parse',
      '--git-common-dir',
    ])
    if (result.code !== 0 || result.error || !result.stdout.trim())
      throw new Error('The Project repository could not be prepared.')
    git = resolve(hub, result.stdout.trim())
  }
  git = await fs.realpath(git)
  if (git.split(sep).some((name) => isExcludedProject(name, excluded)))
    throw new Error('That repository belongs to an excluded Project.')
  const file = `${git}/info/exclude`
  let current = ''
  if (await fs.exists(file)) {
    current = await fs.read(file)
    if (current.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return
  } else {
    await fs.mkdir(`${git}/info`)
  }
  await fs.append(
    file,
    `${current === '' || current.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`,
  )
}

export function createHubService(
  orca: OrcaWorkerApi,
  cli: OrcaCli,
  settings: () => Promise<UnifierSettings>,
  fs: FsLike,
  exec: Exec = nodeExec,
): { dispose(): void } {
  async function openHub(
    target: HubTarget,
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const { projectsRoot, excludedProjects } = await settings()
      if (target.scope === 'project') {
        if (!isPlainProjectName(target.project)) {
          return { error: 'That is not a Project name.' }
        }
        if (isExcludedProject(target.project, excludedProjects)) {
          return {
            error: `${target.project} is excluded for now, so it has no hub.`,
          }
        }
      }
      const hub = await safeMetadataFolder(
        fs,
        projectsRoot,
        target.scope === 'project' ? target.project : null,
        'board.unifier-board',
        excludedProjects,
      )
      const workspaceId = await cli.ensureFolderWorkspace(hub)
      const file = boardFilePath(hub)
      if (!(await fs.exists(file))) {
        await excludeFromGit(fs, hub, excludedProjects, exec)
        await fs.mkdir(`${hub}/${BOARD_DIR}`)
        await fs.write(file, boardFileContents(target))
      }
      await orca.host.call('workspace.open', { workspaceId })
      await orca.host.call('editor.open', { workspaceId, path: BOARD_RELATIVE })
      return { ok: true as const }
    } catch (e) {
      orca.log(`unifier: hub.open failed: ${String(e)}`)
      return { error: 'The hub could not be opened. Try again.' }
    }
  }

  const global: HubTarget = { scope: 'global' }
  const subs = [
    orca.panels.handle('hub.open', (target) => openHub(target)),
    orca.commands.register('unifier.openHub', () => openHub(global)),
    orca.commands.register('unifier.openBoard', () => openHub(global)),
  ]
  return {
    dispose() {
      for (const s of subs) s.dispose()
    },
  }
}
