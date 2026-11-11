import { execFile } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** Set when the process could not run to completion. */
  error?: 'timeout' | 'not_found'
}

export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>

const DEFAULT_TIMEOUT_MS = 15000
// `orca worktree list --json` is about 2.6 KB per worktree.
const MAX_BUFFER = 64 * 1024 * 1024

export const nodeExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const e = err as NodeJS.ErrnoException & {
          killed?: boolean
          signal?: string | null
        }
        if (e.code === 'ENOENT') {
          return resolve({
            code: -1,
            stdout: stdout ?? '',
            stderr: stderr || e.message,
            error: 'not_found',
          })
        }
        if (e.killed && e.signal) {
          return resolve({
            code: -1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: 'timeout',
          })
        }
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: stdout ?? '',
          stderr: stderr || e.message,
        })
      },
    )
  })
