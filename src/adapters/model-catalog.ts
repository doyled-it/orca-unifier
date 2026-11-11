import { join } from 'node:path'
import type { Exec } from './exec'
import type { FsLike } from './fs'

const SQLITE = '/usr/bin/sqlite3'
const TIMEOUT_MS = 3000

export function catalogPaths(home: string): { json: string; db: string } {
  const dir = join(home, 'Library', 'Application Support', 'orca')
  return {
    json: join(dir, 'agent-model-catalog.json'),
    db: join(dir, 'agent-model-catalog.db'),
  }
}

/**
 * Orca's model catalog as JSON text (`{ entries: [...] }`), or null when it
 * cannot be read. Older Orca keeps a JSON file; newer Orca keeps one row per
 * agent discovery in a SQLite database, read here read-only, oldest first.
 */
export async function readCatalogText(
  fs: FsLike,
  exec: Exec,
  home: string,
): Promise<string | null> {
  const { json, db } = catalogPaths(home)
  try {
    if (await fs.exists(json)) return await fs.read(json)
    if (!(await fs.exists(db))) return null
    const res = await exec(
      SQLITE,
      ['-readonly', '-json', db, 'SELECT value FROM rows ORDER BY seq'],
      { timeoutMs: TIMEOUT_MS },
    )
    if (res.code !== 0 || res.error) return null
    const rows: unknown = JSON.parse(res.stdout.trim() || '[]')
    if (!Array.isArray(rows)) return null
    const entries = rows.flatMap((r) => {
      const value = (r as { value?: unknown } | null)?.value
      if (typeof value !== 'string') return []
      try {
        return [JSON.parse(value) as unknown]
      } catch {
        return []
      }
    })
    return JSON.stringify({ entries })
  } catch {
    return null
  }
}
