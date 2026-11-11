/** Node-free so the editor frame can import it. */
export type BoardFilter =
  | { scope: 'global' }
  | { scope: 'project'; project: string }

export function parseBoardFile(text: string): BoardFilter {
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.scope === 'project' && typeof o.project === 'string' && o.project) {
        return { scope: 'project', project: o.project }
      }
    }
  } catch {
    // fall through
  }
  return { scope: 'global' }
}
