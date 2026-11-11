import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { assert, test } from 'orca/testing'
import { evaluateRemoval } from '../core/cleanup'
import type { WorktreeRecord } from '../core/types'
import type { Exec, ExecResult } from './exec'
import { gatherFacts } from './git-facts'

const root = mkdtempSync(join(tmpdir(), 'unifier-git-facts-'))
const path = join(root, 'feature space;$(touch nope)', '~literal')
mkdirSync(path, { recursive: true })
after(() => rmSync(root, { recursive: true, force: true }))
const worktree: WorktreeRecord = {
  id: 'repo::feature',
  identityKey: 'wt2:local:feature',
  projectId: 'project',
  repoId: 'repo',
  path,
  branch: 'feature',
  displayName: 'Feature',
  isMainWorktree: false,
  isPinned: false,
  isUnread: false,
  isArchived: false,
  comment: '',
  workspaceStatus: 'completed',
  parentWorktreeId: null,
  childWorktreeIds: [],
  linkedGitLabMR: 279,
  linkedPR: null,
  lastActivityAt: 0,
}
const safe = {
  isMainWorktree: false,
  isPinned: false,
  isHub: false,
  dirty: false,
  hasUpstream: true,
  ahead: 0,
  merge: 'merged',
  liveAgent: false,
}
const status = [
  'status',
  '--porcelain',
  '--untracked-files=all',
  '-z',
  '--ignore-submodules=none',
]
const toplevel = ['rev-parse', '--show-toplevel']
const upstream = [
  'rev-parse',
  '--abbrev-ref',
  '--symbolic-full-name',
  '@{upstream}',
]
const ahead = ['rev-list', '--count', '@{upstream}..HEAD']
const head = ['rev-parse', 'HEAD']
const branch = ['rev-parse', '--abbrev-ref', 'HEAD']
const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const mergedMR = { state: 'merged', sha: shaA, source_branch: 'feature' }
const mergedPR = {
  state: 'MERGED',
  headRefOid: shaA,
  headRefName: 'feature',
  mergedAt: '2026-11-10T12:00:00Z',
}
const origin = ['remote', 'get-url', 'origin']
const defaultBranch = ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']
const ancestor = ['merge-base', '--is-ancestor', 'HEAD', 'origin/trunk']
const mr = [
  'api',
  'projects/team%2Fsubgroup%2Frepo/merge_requests/279',
  '--hostname',
  'gitlab.example.com',
]
const pr = [
  'pr',
  'view',
  '279',
  '--json',
  'state,headRefOid,headRefName,mergedAt',
  '-R',
  'github.com/team/repo',
]

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const failed: ExecResult = { code: 128, stdout: '', stderr: 'failed' }
type Call = { file: string; args: string[] }

function fake(worktreePath = path) {
  const calls: Call[] = []
  const results = new Map<string, ExecResult>()
  const set = (file: string, args: string[], result: ExecResult) => {
    results.set(JSON.stringify([file, args]), result)
  }
  const git = (args: string[], result: ExecResult) => {
    set('git', ['-C', worktreePath, ...args], result)
  }
  git(toplevel, ok(`${worktreePath}\n`))
  git(status, ok())
  git(upstream, ok('origin/feature\n'))
  git(ahead, ok('0\n'))
  git(head, ok(`${shaA}\n`))
  git(branch, ok('feature\n'))
  git(origin, ok('git@gitlab.example.com:team/subgroup/repo.git\n'))
  git(defaultBranch, ok('origin/trunk\n'))
  git(ancestor, ok())
  set('glab', mr, ok(JSON.stringify(mergedMR)))
  set('gh', pr, ok(JSON.stringify(mergedPR)))
  const exec: Exec = async (file, args) => {
    calls.push({ file, args })
    return results.get(JSON.stringify([file, args])) ?? failed
  }
  return { exec, calls, set, git }
}

test('gathers all-safe facts from a numeric GitLab MR and exact argument arrays', async () => {
  const f = fake()
  const facts = await gatherFacts(worktree, {
    ...f,
    liveAgent: false,
    isHub: false,
  })
  assert.deepEqual(facts, safe)
  assert.deepEqual(evaluateRemoval(facts), { remove: true })
  for (const args of [
    toplevel,
    status,
    upstream,
    ahead,
    head,
    branch,
    origin,
  ]) {
    assert.ok(
      f.calls.some(
        (c) =>
          c.file === 'git' &&
          JSON.stringify(c.args) === JSON.stringify(['-C', path, ...args]),
      ),
    )
  }
  assert.ok(
    f.calls.some(
      (c) => c.file === 'glab' && JSON.stringify(c.args) === JSON.stringify(mr),
    ),
  )
  assert.equal(
    f.calls.some((c) => c.args.includes('merge-base')),
    false,
  )
  assert.deepEqual(f.calls[0], {
    file: 'git',
    args: ['-C', path, 'rev-parse', '--show-toplevel'],
  })
})

for (const [name, result] of [
  ['nested directory inside a parent checkout', ok(`${dirname(path)}\n`)],
  ['failed toplevel query', failed],
  ['interrupted toplevel query', { ...ok(path), error: 'timeout' as const }],
  ['empty toplevel', ok(' \n')],
  ['unresolvable toplevel', ok(join(root, 'absent'))],
] as const) {
  test(`${name} makes every git fact unknown before further collection`, async () => {
    const f = fake()
    f.git(toplevel, result)
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.deepEqual(facts, {
      ...safe,
      dirty: 'unknown',
      hasUpstream: 'unknown',
      ahead: 'unknown',
      merge: 'unknown',
    })
    assert.equal(evaluateRemoval(facts).remove, false)
    assert.deepEqual(f.calls, [
      { file: 'git', args: ['-C', path, 'rev-parse', '--show-toplevel'] },
    ])
  })
}

test('a rejected toplevel lookup keeps the worktree without collecting facts', async () => {
  const f = fake()
  const exec: Exec = (file, args, opts) => {
    if (args.includes('--show-toplevel')) {
      return Promise.reject(new Error('directory missing'))
    }
    return f.exec(file, args, opts)
  }
  const facts = await gatherFacts(worktree, {
    exec,
    liveAgent: false,
    isHub: false,
  })
  assert.deepEqual(facts, {
    ...safe,
    dirty: 'unknown',
    hasUpstream: 'unknown',
    ahead: 'unknown',
    merge: 'unknown',
  })
  assert.equal(evaluateRemoval(facts).remove, false)
  assert.deepEqual(f.calls, [])
})

test('an unresolvable requested path keeps every git fact unknown', async () => {
  const absentPath = join(root, 'missing-worktree')
  const f = fake(absentPath)
  f.git(toplevel, ok(`${path}\n`))
  const facts = await gatherFacts(
    { ...worktree, path: absentPath },
    { ...f, liveAgent: false, isHub: false },
  )
  assert.deepEqual(facts, {
    ...safe,
    dirty: 'unknown',
    hasUpstream: 'unknown',
    ahead: 'unknown',
    merge: 'unknown',
  })
  assert.equal(evaluateRemoval(facts).remove, false)
})

for (const requestedLink of [false, true]) {
  test(`resolves both paths before comparing the worktree root (requested link: ${requestedLink})`, async () => {
    const linkPath = join(root, `linked-worktree-${requestedLink}`)
    symlinkSync(path, linkPath)
    const requestedPath = requestedLink ? linkPath : path
    const reportedPath = requestedLink ? path : linkPath
    const f = fake(requestedPath)
    f.git(toplevel, ok(`${reportedPath}\n`))
    const facts = await gatherFacts(
      { ...worktree, path: requestedPath },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.deepEqual(facts, safe)
    assert.deepEqual(f.calls[0], {
      file: 'git',
      args: ['-C', requestedPath, 'rev-parse', '--show-toplevel'],
    })
  })
}

test('preserves main, pinned, hub and live-agent inputs', async () => {
  const facts = await gatherFacts(
    { ...worktree, isMainWorktree: true, isPinned: true },
    { exec: fake().exec, liveAgent: true, isHub: true },
  )
  assert.deepEqual(facts, {
    ...safe,
    isMainWorktree: true,
    isPinned: true,
    isHub: true,
    liveAgent: true,
  })
})

test('status explicitly checks submodules even when git config ignores them', async () => {
  const f = fake()
  f.git(status, ok(' m submodule\n'))
  const facts = await gatherFacts(worktree, {
    ...f,
    liveAgent: false,
    isHub: false,
  })
  assert.deepEqual(
    f.calls.find((c) => c.args.includes('status')),
    {
      file: 'git',
      args: [
        '-C',
        path,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '-z',
        '--ignore-submodules=none',
      ],
    },
  )
  assert.equal(facts.dirty, true)
  assert.equal(evaluateRemoval(facts).remove, false)
})

for (const host of ['GitLab', 'GitHub'] as const) {
  const file = host === 'GitLab' ? 'glab' : 'gh'
  const args = host === 'GitLab' ? mr : pr
  const merged = host === 'GitLab' ? mergedMR : mergedPR
  const shaField = host === 'GitLab' ? 'sha' : 'headRefOid'
  const branchField = host === 'GitLab' ? 'source_branch' : 'headRefName'
  const linkedWorktree = {
    ...worktree,
    linkedGitLabMR: host === 'GitLab' ? 279 : null,
    linkedPR: host === 'GitHub' ? 279 : null,
  }
  const setup = () => {
    const f = fake()
    if (host === 'GitHub') {
      f.git(origin, ok('https://github.com/team/repo.git'))
    }
    return f
  }

  test(`${host} merged link proves the current HEAD and branch without ancestry`, async () => {
    const f = setup()
    f.git(ancestor, failed)
    const facts = await gatherFacts(linkedWorktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'merged')
    assert.ok(f.calls.some((c) => c.file === file))
    assert.equal(
      f.calls.some((c) => c.args.includes('merge-base')),
      false,
    )
  })

  for (const [name, changes] of [
    ['unrelated head commit', { [shaField]: shaB }],
    ['different source branch', { [branchField]: 'unrelated' }],
    ['missing head commit', { [shaField]: undefined }],
    ['missing source branch', { [branchField]: undefined }],
    ['missing state', { state: undefined }],
  ] as const) {
    test(`${host} ${name} falls back to ancestry and keeps uncovered HEAD`, async () => {
      const f = setup()
      f.set(file, args, ok(JSON.stringify({ ...merged, ...changes })))
      f.git(ancestor, { code: 1, stdout: '', stderr: '' })
      const facts = await gatherFacts(linkedWorktree, {
        ...f,
        liveAgent: false,
        isHub: false,
      })
      assert.equal(facts.merge, 'unmerged')
      assert.equal(evaluateRemoval(facts).remove, false)
      assert.ok(f.calls.some((c) => c.args.includes('merge-base')))
    })
  }

  for (const [code, merge] of [
    [0, 'merged'],
    [1, 'unmerged'],
    [128, 'unknown'],
  ] as const) {
    test(`${host} merged at A with HEAD now B uses ancestor exit ${code}`, async () => {
      const f = setup()
      f.git(head, ok(`${shaB}\n`))
      f.git(ancestor, { code, stdout: '', stderr: '' })
      const facts = await gatherFacts(linkedWorktree, {
        ...f,
        liveAgent: false,
        isHub: false,
      })
      assert.equal(facts.merge, merge)
      assert.equal(evaluateRemoval(facts).remove, code === 0)
      assert.ok(f.calls.some((c) => c.args.includes('merge-base')))
    })
  }

  test(`${host} checks the current git branch when the stored branch is stale`, async () => {
    const f = setup()
    f.git(branch, ok('renamed\n'))
    f.git(ancestor, failed)
    const facts = await gatherFacts(linkedWorktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'unknown')
    assert.equal(evaluateRemoval(facts).remove, false)
  })

  for (const [name, query, result] of [
    ['failed HEAD', head, failed],
    ['empty HEAD', head, ok(' \n')],
    ['invalid HEAD', head, ok('HEAD\n')],
    ['failed branch', branch, failed],
    ['empty branch', branch, ok(' \n')],
    ['detached HEAD', branch, ok('HEAD\n')],
  ] as const) {
    test(`${host} ${name} cannot authorize cleanup from a link`, async () => {
      const f = setup()
      f.git([...query], result)
      f.git(ancestor, failed)
      const facts = await gatherFacts(linkedWorktree, {
        ...f,
        liveAgent: false,
        isHub: false,
      })
      assert.equal(facts.merge, 'unknown')
      assert.equal(evaluateRemoval(facts).remove, false)
    })
  }
}

for (const throws of [false, true]) {
  test(`a deleted directory makes all git facts unknown (${throws ? 'rejection' : 'exit failure'})`, async () => {
    const exec: Exec = async () => {
      if (throws) throw new Error('directory missing')
      return failed
    }
    const facts = await gatherFacts(worktree, {
      exec,
      liveAgent: false,
      isHub: false,
    })
    assert.deepEqual(facts, {
      ...safe,
      dirty: 'unknown',
      hasUpstream: 'unknown',
      ahead: 'unknown',
      merge: 'unknown',
    })
    assert.equal(evaluateRemoval(facts).remove, false)
  })
}

for (const output of [' M tracked.ts\n', '?? untracked.txt\n', ' ']) {
  test(`nonempty porcelain output is dirty: ${JSON.stringify(output)}`, async () => {
    const f = fake()
    f.git(status, ok(output))
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.dirty, true)
    assert.equal(evaluateRemoval(facts).remove, false)
  })
}

for (const [name, args, fact] of [
  ['status', status, 'dirty'],
  ['upstream', upstream, 'hasUpstream'],
  ['ahead', ahead, 'ahead'],
] as const) {
  test(`a failing ${name} call makes only that fact unknown`, async () => {
    const f = fake()
    f.git([...args], failed)
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.deepEqual(facts, { ...safe, [fact]: 'unknown' })
  })
}

for (const error of ['timeout', 'not_found'] as const) {
  test(`process ${error} never counts as a successful call`, async () => {
    const f = fake()
    f.git(status, { ...ok(), error })
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.dirty, 'unknown')
  })
}

for (const output of [
  '',
  ' ',
  '-1',
  '0garbage',
  '1.5',
  '0\n1',
  '9007199254740992',
]) {
  test(`malformed ahead output stays unknown: ${JSON.stringify(output)}`, async () => {
    const f = fake()
    f.git(ahead, ok(output))
    assert.equal(
      (await gatherFacts(worktree, { ...f, liveAgent: false, isHub: false }))
        .ahead,
      'unknown',
    )
  })
}

test('reports positive ahead counts and keeps unpushed commits', async () => {
  const f = fake()
  f.git(ahead, ok('2\n'))
  const facts = await gatherFacts(worktree, {
    ...f,
    liveAgent: false,
    isHub: false,
  })
  assert.equal(facts.ahead, 2)
  assert.equal(evaluateRemoval(facts).remove, false)
})

test('an empty upstream response is unknown', async () => {
  const f = fake()
  f.git(upstream, ok(' \n'))
  assert.equal(
    (await gatherFacts(worktree, { ...f, liveAgent: false, isHub: false }))
      .hasUpstream,
    'unknown',
  )
})

for (const link of [279, { iid: 279 }, { number: 279 }]) {
  test(`accepts GitLab link ${JSON.stringify(link)}`, async () => {
    const f = fake()
    const facts = await gatherFacts(
      { ...worktree, linkedGitLabMR: link },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, 'merged')
    assert.equal(
      f.calls.some((c) => c.file === 'glab'),
      true,
    )
  })
}

for (const remote of [
  'https://gitlab.example.com/team/subgroup/repo.git',
  'ssh://git@gitlab.example.com:2222/team/subgroup/repo.git',
]) {
  test(`derives and encodes the GitLab project from ${remote}`, async () => {
    const f = fake()
    f.git(origin, ok(remote))
    assert.equal(
      (await gatherFacts(worktree, { ...f, liveAgent: false, isHub: false }))
        .merge,
      'merged',
    )
    assert.ok(
      f.calls.some(
        (c) =>
          c.file === 'glab' && JSON.stringify(c.args) === JSON.stringify(mr),
      ),
    )
  })
}

test('an HTTPS origin with a custom port uses ancestry instead of another GitLab instance', async () => {
  const f = fake()
  f.git(origin, ok('https://gitlab.example.com:8443/team/subgroup/repo.git'))
  f.git(ancestor, { code: 1, stdout: '', stderr: '' })
  const facts = await gatherFacts(worktree, {
    ...f,
    liveAgent: false,
    isHub: false,
  })
  assert.equal(facts.merge, 'unmerged')
  assert.equal(evaluateRemoval(facts).remove, false)
  assert.equal(
    f.calls.some((c) => c.file === 'glab'),
    false,
  )
})

for (const remote of [
  'http://gitlab.example.com/team/subgroup/repo.git',
  'http://gitlab.example.com:8080/team/subgroup/repo.git',
]) {
  test(`an HTTP origin uses ancestry instead of a different HTTPS instance: ${remote}`, async () => {
    const f = fake()
    f.git(origin, ok(remote))
    f.git(ancestor, { code: 1, stdout: '', stderr: '' })
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'unmerged')
    assert.equal(evaluateRemoval(facts).remove, false)
    assert.equal(
      f.calls.some((c) => c.file === 'glab'),
      false,
    )
  })
}

for (const state of ['opened', 'closed', 'locked']) {
  test(`a linked GitLab MR with state ${state} is unmerged even if HEAD is an ancestor`, async () => {
    const f = fake()
    f.set('glab', mr, ok(JSON.stringify({ ...mergedMR, state })))
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'unmerged')
    assert.equal(evaluateRemoval(facts).remove, false)
  })
}

for (const result of [
  { code: 1, stdout: '', stderr: 'HTTP 403 Forbidden' },
  { code: 1, stdout: '', stderr: 'HTTP 404 Not Found' },
  { code: 1, stdout: '', stderr: 'network unavailable' },
  { ...ok('{"state":"merged"}'), error: 'timeout' as const },
  ok('not JSON'),
  ok('null'),
  ok('{}'),
  ok('{"state":"unexpected"}'),
]) {
  test(`a failed GitLab lookup falls back to ancestry: ${JSON.stringify(result)}`, async () => {
    const f = fake()
    f.set('glab', mr, result)
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'merged')
    assert.ok(
      f.calls.some((c) => c.file === 'git' && c.args.includes('merge-base')),
    )
  })
}

test('a rejected MR lookup falls back to ancestry', async () => {
  const f = fake()
  const exec: Exec = (file, args, opts) => {
    if (file === 'glab') return Promise.reject(new Error('network failure'))
    return f.exec(file, args, opts)
  }
  assert.equal(
    (await gatherFacts(worktree, { exec, liveAgent: false, isHub: false }))
      .merge,
    'merged',
  )
})

for (const link of [279, { number: 279 }, { iid: 279 }]) {
  test(`origin host chooses GitHub with PR link ${JSON.stringify(link)}`, async () => {
    const f = fake()
    f.git(origin, ok('git@github.com:team/repo.git\n'))
    const facts = await gatherFacts(
      { ...worktree, linkedPR: link },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, 'merged')
    assert.ok(
      f.calls.some(
        (c) => c.file === 'gh' && JSON.stringify(c.args) === JSON.stringify(pr),
      ),
    )
    assert.equal(
      f.calls.some((c) => c.file === 'glab'),
      false,
    )
  })
}

for (const remote of [
  'git@github.com:team/repo.git',
  'ssh://git@github.com/team/repo.git',
  'https://github.com/team/repo.git',
]) {
  test(`GitHub lookup explicitly selects github.com for ${remote}`, async () => {
    const f = fake()
    f.git(origin, ok(remote))
    f.git(ancestor, failed)
    const facts = await gatherFacts(
      { ...worktree, linkedGitLabMR: null, linkedPR: 279 },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.deepEqual(
      f.calls.find((c) => c.file === 'gh'),
      {
        file: 'gh',
        args: [
          'pr',
          'view',
          '279',
          '--json',
          'state,headRefOid,headRefName,mergedAt',
          '-R',
          'github.com/team/repo',
        ],
      },
    )
    assert.equal(facts.merge, 'merged')
    assert.equal(
      f.calls.some((c) => c.args.includes('merge-base')),
      false,
    )
  })
}

for (const remote of [
  'git@other.example:team/repo.git',
  'ssh://git@github.example.com/team/repo.git',
  'https://github.example.com/team/repo.git',
  'https://github.com.other.example/team/repo.git',
]) {
  test(`a GitHub-style link on another host stays unknown without ancestry: ${remote}`, async () => {
    const f = fake()
    f.git(origin, ok(remote))
    f.git(ancestor, failed)
    const facts = await gatherFacts(
      { ...worktree, linkedGitLabMR: null, linkedPR: 279 },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, 'unknown')
    assert.equal(evaluateRemoval(facts).remove, false)
    assert.equal(
      f.calls.some((c) => c.file !== 'git'),
      false,
    )
  })
}

for (const state of ['OPEN', 'CLOSED']) {
  test(`a ${state} GitHub PR keeps the worktree`, async () => {
    const f = fake()
    f.git(origin, ok('https://github.com/team/repo.git'))
    f.set('gh', pr, ok(JSON.stringify({ ...mergedPR, state, mergedAt: null })))
    assert.equal(
      (
        await gatherFacts(
          { ...worktree, linkedPR: 279 },
          { ...f, liveAgent: false, isHub: false },
        )
      ).merge,
      'unmerged',
    )
  })
}

for (const result of [
  failed,
  ok('invalid JSON'),
  ok('{}'),
  ok('{"state":"MERGED","mergedAt":null}'),
]) {
  test(`a failed or unreadable GitHub lookup falls back: ${JSON.stringify(result)}`, async () => {
    const f = fake()
    f.git(origin, ok('https://github.com/team/repo.git'))
    f.set('gh', pr, result)
    const facts = await gatherFacts(
      { ...worktree, linkedPR: 279 },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, 'merged')
    assert.ok(f.calls.some((c) => c.args.includes('merge-base')))
  })
}

for (const [code, merge] of [
  [0, 'merged'],
  [1, 'unmerged'],
  [2, 'unknown'],
  [128, 'unknown'],
] as const) {
  test(`without a link ancestor exit ${code} gives ${merge}`, async () => {
    const f = fake()
    f.git(ancestor, { code, stdout: '', stderr: '' })
    const facts = await gatherFacts(
      { ...worktree, linkedGitLabMR: null },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, merge)
    assert.equal(evaluateRemoval(facts).remove, code === 0)
    assert.equal(
      f.calls.some((c) => c.file !== 'git'),
      false,
    )
  })
}

test('a squash-merged branch without a link stays unmerged and is kept', async () => {
  const f = fake()
  f.git(ancestor, { code: 1, stdout: '', stderr: '' })
  const facts = await gatherFacts(
    { ...worktree, linkedGitLabMR: null },
    { ...f, liveAgent: false, isHub: false },
  )
  assert.equal(facts.merge, 'unmerged')
  assert.equal(evaluateRemoval(facts).remove, false)
})

for (const result of [failed, ok(''), ok('trunk\n'), ok('origin/\n')]) {
  test(`an unavailable default branch makes merge unknown: ${JSON.stringify(result)}`, async () => {
    const f = fake()
    f.git(defaultBranch, result)
    const facts = await gatherFacts(
      { ...worktree, linkedGitLabMR: null },
      { ...f, liveAgent: false, isHub: false },
    )
    assert.equal(facts.merge, 'unknown')
  })
}

test('ancestor timeout with code 1 is unknown rather than unmerged', async () => {
  const f = fake()
  f.git(ancestor, { code: 1, stdout: '', stderr: '', error: 'timeout' })
  const facts = await gatherFacts(
    { ...worktree, linkedGitLabMR: null },
    { ...f, liveAgent: false, isHub: false },
  )
  assert.equal(facts.merge, 'unknown')
})

for (const remote of ['git@other.example:team/repo.git', 'not a remote']) {
  test(`an unsupported origin uses ancestry: ${remote}`, async () => {
    const f = fake()
    f.git(origin, ok(remote))
    const facts = await gatherFacts(worktree, {
      ...f,
      liveAgent: false,
      isHub: false,
    })
    assert.equal(facts.merge, 'merged')
    assert.equal(
      f.calls.some((c) => c.file !== 'git'),
      false,
    )
  })
}

for (const scenario of [
  'unchanged',
  'changed',
  'other',
  'malformed',
  'tracked',
  'missing',
  'escape',
  'symlink',
  'unowned',
]) {
  test(`setup-created files count as clean only when unchanged: ${scenario}`, async () => {
    const folder = join(root, scenario)
    mkdirSync(join(folder, '.unifier'), { recursive: true })
    writeFileSync(
      join(folder, 'uv.lock'),
      scenario === 'changed' ? 'changed' : 'lock',
    )
    if (scenario === 'unowned') writeFileSync(join(folder, 'notes.md'), 'lock')
    const files = {
      'uv.lock':
        '0c030586945fe504b604ecc2e875c38ede400cd5cd73da9730302162e6b02c6f',
    }
    if (scenario === 'symlink') {
      rmSync(join(folder, 'uv.lock'))
      symlinkSync(join(path, 'outside.lock'), join(folder, 'uv.lock'))
      writeFileSync(join(path, 'outside.lock'), 'lock')
    }
    if (scenario !== 'missing')
      writeFileSync(
        join(folder, '.unifier/setup-created.json'),
        scenario === 'malformed'
          ? '{bad'
          : JSON.stringify({
              version: 1,
              files:
                scenario === 'escape'
                  ? { '../outside.lock': files['uv.lock'] }
                  : scenario === 'unowned'
                    ? { 'notes.md': files['uv.lock'] }
                    : files,
            }),
      )
    const exec: Exec = async (_file, args) => {
      if (args.includes('--show-toplevel')) return ok(folder)
      if (args.includes('status'))
        return ok(
          scenario === 'unowned'
            ? '?? notes.md\0'
            : scenario === 'tracked'
              ? ' M tracked\0?? uv.lock\0'
              : `?? uv.lock\0${scenario === 'other' ? '?? other.txt\0' : ''}`,
        )
      return { code: 1, stdout: '', stderr: '' }
    }
    const facts = await gatherFacts(
      { ...worktree, path: folder },
      { exec, liveAgent: false, isHub: false },
    )
    assert.equal(facts.dirty, scenario !== 'unchanged')
  })
}
