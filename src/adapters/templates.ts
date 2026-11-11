import { readFileSync } from 'node:fs'

/** The prompt templates in the plugin's `templates/` folder. */
export interface Templates {
  charter: string
  workerBrief: string
  reviewerBrief: string
  reportFormat: string
}

const FILES: Record<keyof Templates, string> = {
  charter: 'orchestrator-charter.md',
  workerBrief: 'worker-brief.md',
  reviewerBrief: 'reviewer-brief.md',
  reportFormat: 'report-format.md',
}

let cached: Templates | null = null

/**
 * Reads the templates once per worker process (hooks restart the worker, so
 * each hook reads them at most once). Throws when a file is missing.
 */
export function loadTemplates(): Templates {
  if (cached) return cached
  const read = (name: string) =>
    readFileSync(new URL(`../../templates/${name}`, import.meta.url), 'utf8')
  cached = {
    charter: read(FILES.charter),
    workerBrief: read(FILES.workerBrief),
    reviewerBrief: read(FILES.reviewerBrief),
    reportFormat: read(FILES.reportFormat),
  }
  return cached
}

/** What the prompt hook appends to a tracked Worker's dispatch: the brief, then the report format. */
export function workerBriefText(t: Templates): string {
  return `${t.workerBrief.trimEnd()}\n\n${t.reportFormat.trimEnd()}\n`
}
