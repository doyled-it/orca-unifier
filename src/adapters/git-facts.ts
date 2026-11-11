import { realpath } from 'node:fs/promises'
import type { RemovalFacts } from '../core/cleanup'
import type { WorktreeRecord } from '../core/types'
import type { Exec, ExecResult } from './exec'
import { dirtyWithSetupCreated } from './setup-created'

type Merge = RemovalFacts['merge']
type Remote = { host: string; project: string }

/** A failed or interrupted process can never provide affirmative evidence. */
async function run(
  exec: Exec,
  file: string,
  args: string[],
): Promise<ExecResult | null> {
  try {
    const result = await exec(file, args)
    return result.error ? null : result
  } catch {
    return null
  }
}

function output(result: ExecResult | null): string | null {
  return result?.code === 0 ? result.stdout : null
}

function linkId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // The object form is defensive; Orca normally returns a plain number.
    for (const id of [record.iid, record.number]) {
      if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        return id
    }
  }
  return null
}

function remoteOf(text: string): Remote | null {
  const remote = text.trim()
  let host: string
  let project: string
  try {
    if (remote.includes('://')) {
      const url = new URL(remote)
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol))
        return null
      // The API hostname flag cannot safely preserve HTTP or custom HTTPS ports.
      // Use ancestry rather than asking a potentially different GitLab instance.
      if (
        url.protocol === 'http:' ||
        (url.protocol === 'https:' && url.port !== '')
      ) {
        return null
      }
      host = url.hostname
      project = decodeURIComponent(url.pathname)
    } else {
      const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remote)
      if (!match) return null
      host = match[1] as string
      project = match[2] as string
    }
  } catch {
    return null
  }
  project = project.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  const parts = project.split('/')
  if (
    parts.length < 2 ||
    parts.some((p) => !p || p === '.' || p === '..' || /[\s?#]/.test(p))
  ) {
    return null
  }
  return { host: host.toLowerCase(), project }
}

function linkedMerge(
  text: string | null,
  host: string,
  head: string | undefined,
  branch: string | undefined,
): Merge {
  if (
    text === null ||
    !head ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
    !branch ||
    branch === 'HEAD'
  ) {
    return 'unknown'
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') return 'unknown'
    const { state, mergedAt, sha, source_branch, headRefOid, headRefName } =
      value as Record<string, unknown>
    if (host === 'github.com') {
      if (headRefOid !== head || headRefName !== branch) return 'unknown'
      if (
        state === 'MERGED' &&
        typeof mergedAt === 'string' &&
        mergedAt.trim()
      ) {
        return 'merged'
      }
      if ((state === 'OPEN' || state === 'CLOSED') && mergedAt === null) {
        return 'unmerged'
      }
    } else {
      if (sha !== head || source_branch !== branch) return 'unknown'
      if (state === 'merged') return 'merged'
      if (state === 'opened' || state === 'closed' || state === 'locked') {
        return 'unmerged'
      }
    }
  } catch {
    // An unreadable response is a failed lookup; try the git evidence instead.
  }
  return 'unknown'
}

async function gatherMerge(w: WorktreeRecord, exec: Exec): Promise<Merge> {
  const git = (args: string[]) => run(exec, 'git', ['-C', w.path, ...args])
  const mr = linkId(w.linkedGitLabMR)
  const pr = linkId(w.linkedPR)
  if (mr !== null || pr !== null) {
    const [originResult, headResult, branchResult] = await Promise.all([
      git(['remote', 'get-url', 'origin']),
      git(['rev-parse', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    const origin = output(originResult)
    const remote = origin === null ? null : remoteOf(origin)
    let result: ExecResult | null = null
    if (remote?.host.startsWith('gitlab.') && mr !== null) {
      result = await run(exec, 'glab', [
        'api',
        `projects/${encodeURIComponent(remote.project)}/merge_requests/${mr}`,
        '--hostname',
        remote.host,
      ])
    } else if (remote?.host === 'github.com' && pr !== null) {
      result = await run(exec, 'gh', [
        'pr',
        'view',
        String(pr),
        '--json',
        'state,headRefOid,headRefName,mergedAt',
        '-R',
        `github.com/${remote.project}`,
      ])
    }
    if (remote) {
      const merge = linkedMerge(
        output(result),
        remote.host,
        output(headResult)?.trim(),
        output(branchResult)?.trim(),
      )
      if (merge !== 'unknown') return merge
    }
  }

  const ref = output(
    await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  )?.trim()
  if (!ref || !/^origin\/\S+$/.test(ref)) return 'unknown'
  const defaultBranch = ref.slice('origin/'.length)
  const ancestor = await git([
    'merge-base',
    '--is-ancestor',
    'HEAD',
    `origin/${defaultBranch}`,
  ])
  if (ancestor?.code === 0) return 'merged'
  if (ancestor?.code === 1) return 'unmerged'
  return 'unknown'
}

export async function gatherFacts(
  w: WorktreeRecord,
  deps: { exec: Exec; liveAgent: boolean; isHub: boolean },
): Promise<RemovalFacts> {
  const git = (args: string[]) => run(deps.exec, 'git', ['-C', w.path, ...args])
  const facts: RemovalFacts = {
    isMainWorktree: w.isMainWorktree,
    isPinned: w.isPinned,
    isHub: deps.isHub,
    dirty: 'unknown',
    hasUpstream: 'unknown',
    ahead: 'unknown',
    merge: 'unknown',
    liveAgent: deps.liveAgent,
  }
  const toplevel = output(await git(['rev-parse', '--show-toplevel']))?.trim()
  if (!toplevel) return facts
  try {
    const [requestedRoot, gitRoot] = await Promise.all([
      realpath(w.path),
      realpath(toplevel),
    ])
    if (requestedRoot !== gitRoot) return facts
  } catch {
    return facts
  }
  const [status, upstream, aheadResult, merge] = await Promise.all([
    git([
      'status',
      '--porcelain',
      '--untracked-files=all',
      '-z',
      '--ignore-submodules=none',
    ]),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git(['rev-list', '--count', '@{upstream}..HEAD']),
    gatherMerge(w, deps.exec),
  ])
  const dirty = output(status)
  const hasUpstream = output(upstream)?.trim()
  const aheadText = output(aheadResult)?.trim()
  const ahead = aheadText && /^\d+$/.test(aheadText) ? Number(aheadText) : NaN
  return {
    ...facts,
    dirty:
      dirty === null ? 'unknown' : await dirtyWithSetupCreated(w.path, dirty),
    hasUpstream: hasUpstream ? true : 'unknown',
    ahead: Number.isSafeInteger(ahead) ? ahead : 'unknown',
    merge,
  }
}
