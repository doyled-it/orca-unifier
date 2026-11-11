import type { BoardFilter } from './board-filter'

export type HubTarget = BoardFilter

/** The folder that is the hub's workspace: the projects root, or one project under it. */
export function hubFolder(target: HubTarget, projectsRoot: string): string {
  return target.scope === 'global'
    ? projectsRoot
    : `${projectsRoot.replace(/\/+$/, '')}/${target.project}`
}

export const BOARD_DIR = '.unifier'
export const BOARD_FILE = 'board.unifier-board'
/** The board file relative to the hub folder, as `editor.open` wants it. */
export const BOARD_RELATIVE = `${BOARD_DIR}/${BOARD_FILE}`

export function boardFilePath(hub: string): string {
  return `${hub.replace(/\/+$/, '')}/${BOARD_RELATIVE}`
}

export function boardFileContents(filter: BoardFilter): string {
  return `${JSON.stringify(filter, null, 2)}\n`
}

/** A project name is one plain folder name, never a path. */
export function isPlainProjectName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}
