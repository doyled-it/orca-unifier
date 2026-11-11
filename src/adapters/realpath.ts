import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Resolves links through the nearest existing ancestor. Empty means unresolved. */
export function resolveRealpath(path: string): string {
  try {
    let ancestor = resolve(path)
    const tail: string[] = []
    for (;;) {
      try {
        return join(realpathSync(ancestor), ...tail)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return ''
        // A dangling link exists, but its destination cannot be checked.
        try {
          lstatSync(ancestor)
          return ''
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return ''
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) return ''
        tail.unshift(basename(ancestor))
        ancestor = parent
      }
    }
  } catch {
    return ''
  }
}

/** Conservative write check: nested repo roots, their ancestors and their contents. */
export function containsNestedGit(path: string, worktree: string): boolean {
  const root = resolve(worktree)
  let current = resolve(path)
  if (current !== root && !current.startsWith(`${root}/`)) return true
  const exists = (p: string): boolean => {
    try {
      lstatSync(p)
      return true
    } catch (e) {
      if (
        ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')
      )
        return false
      throw e
    }
  }
  try {
    for (; current !== root; current = dirname(current)) {
      if (exists(join(current, '.git'))) return true
    }
    let remaining = 10000
    const scan = (p: string): boolean => {
      if (--remaining < 0) return true
      if (!exists(p)) return false
      const stat = lstatSync(p)
      if (stat.isSymbolicLink()) return true
      if (!stat.isDirectory()) return false
      return readdirSync(p).some(
        (name) => name.toLowerCase() === '.git' || scan(join(p, name)),
      )
    }
    return scan(path)
  } catch {
    return true
  }
}
