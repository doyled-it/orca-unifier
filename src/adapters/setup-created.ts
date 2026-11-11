import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Exec } from './exec'
import type { FsLike } from './fs'
import { safeWorktreeMetadata } from './project-writes'

const RECORD = '.unifier/setup-created.json'
const INSTALL_ARTIFACTS = new Set([
  'uv.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
])

function safePath(path: string): boolean {
  return (
    path !== '' &&
    !isAbsolute(path) &&
    !path.includes('\0') &&
    !path.split(/[\\/]/).some((p) => p === '..' || p === '.' || p === '')
  )
}

export function untrackedPaths(status: string): string[] {
  return status
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter(safePath)
}

export async function snapshotUntracked(
  exec: Exec,
  path: string,
): Promise<string[] | null> {
  const result = await exec('git', [
    '-C',
    path,
    'status',
    '--porcelain',
    '--untracked-files=all',
    '-z',
  ])
  return result.code === 0 && !result.error
    ? untrackedPaths(result.stdout)
    : null
}

async function fileHash(root: string, path: string): Promise<string | null> {
  if (!safePath(path)) return null
  const canonical = await realpath(root)
  const file = resolve(canonical, path)
  if (
    relative(canonical, file).startsWith('..') ||
    (await realpath(file)) !== file ||
    !(await lstat(file)).isFile()
  )
    return null
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

export async function recordSetupCreated(
  exec: Exec,
  fs: FsLike,
  path: string,
  before: string[] | null,
  artifacts: string[],
): Promise<void> {
  if (before === null) return
  const after = await snapshotUntracked(exec, path)
  if (after === null) return
  const files: Record<string, string> = {}
  for (const file of after) {
    if (
      before.includes(file) ||
      !artifacts.includes(file) ||
      !INSTALL_ARTIFACTS.has(file)
    )
      continue
    try {
      const hash = await fileHash(path, file)
      if (hash) files[file] = hash
    } catch {
      /* An unreadable file must remain dirty. */
    }
  }
  await safeWorktreeMetadata(fs, path, 'setup-created.json')
  await fs.write(
    join(path, RECORD),
    `${JSON.stringify({ version: 1, files }, null, 2)}\n`,
  )
}

/** A record can only exempt unchanged, regular files contained in this worktree. */
export async function dirtyWithSetupCreated(
  path: string,
  status: string,
): Promise<boolean> {
  if (status === '') return false
  try {
    const record = JSON.parse(await readFile(join(path, RECORD), 'utf8'))
    if (
      record?.version !== 1 ||
      !record.files ||
      typeof record.files !== 'object' ||
      Array.isArray(record.files) ||
      !Object.entries(record.files).every(
        ([p, h]) =>
          INSTALL_ARTIFACTS.has(p) &&
          safePath(p) &&
          typeof h === 'string' &&
          /^[a-f0-9]{64}$/.test(h),
      )
    )
      return true
    for (const entry of status.split('\0').filter(Boolean)) {
      if (!entry.startsWith('?? ')) return true
      const file = entry.slice(3)
      if (
        !Object.hasOwn(record.files, file) ||
        (await fileHash(path, file)) !== record.files[file]
      )
        return true
    }
    return false
  } catch {
    return true
  }
}
