import { assert, test } from 'orca/testing'
import type { AgentEntry } from './agents'
import { buildBoard, parseBoardFile } from './board-model'
import type { WorktreeRecord } from './types'

const root = '/Users/m/projects'
const opts = { projectsRoot: root, hideMainCheckouts: true }

function wt(over: Partial<WorktreeRecord> & { id: string }): WorktreeRecord {
  return {
    identityKey: 'wt2:local:x',
    projectId: 'p',
    repoId: 'r1',
    path: `${root}/demo/api/${over.id}`,
    branch: `b-${over.id}`,
    displayName: over.id,
    isMainWorktree: false,
    isPinned: false,
    isUnread: false,
    isArchived: false,
    comment: '',
    workspaceStatus: 'todo',
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedGitLabMR: null,
    linkedPR: null,
    lastActivityAt: 0,
    ...over,
  }
}

const global = { scope: 'global' } as const

function ag(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    paneKey: 'p1',
    parentPaneKey: null,
    terminalId: null,
    title: null,
    detail: null,
    state: 'working',
    since: 1,
    updatedAt: 1,
    agent: null,
    model: null,
    ...over,
  }
}

test('four columns always present in order with labels', () => {
  const b = buildBoard([], {}, global, opts)
  assert.deepEqual(
    b.columns.map((c) => [c.status, c.label]),
    [
      ['todo', 'Todo'],
      ['in-progress', 'Working'],
      ['in-review', 'Review'],
      ['completed', 'Done'],
    ],
  )
})

test('unknown workspaceStatus lands in todo', () => {
  const b = buildBoard(
    [wt({ id: 'a', workspaceStatus: 'weird' })],
    {},
    global,
    opts,
  )
  assert.equal(b.columns[0]?.cards[0]?.status, 'todo')
})

test('main checkouts are hidden and counted, or included', () => {
  const list = [wt({ id: 'a' }), wt({ id: 'm', isMainWorktree: true })]
  const hidden = buildBoard(list, {}, global, opts)
  assert.equal(hidden.hiddenMainCount, 1)
  assert.equal(hidden.columns[0]?.cards.length, 1)
  const shown = buildBoard(list, {}, global, {
    ...opts,
    hideMainCheckouts: false,
  })
  assert.equal(shown.hiddenMainCount, 0)
  assert.equal(shown.columns[0]?.cards.length, 2)
})

test('archived worktrees are excluded', () => {
  const b = buildBoard([wt({ id: 'a', isArchived: true })], {}, global, opts)
  assert.equal(b.columns[0]?.cards.length, 0)
})

test('project filter and sorted unique projects', () => {
  const list = [
    wt({ id: 'a', path: `${root}/zeta/r/a` }),
    wt({ id: 'b', path: `${root}/alpha/r/b` }),
    wt({ id: 'c', path: `${root}/alpha/r/c` }),
  ]
  const b = buildBoard(list, {}, { scope: 'project', project: 'alpha' }, opts)
  assert.deepEqual(b.columns[0]?.cards.map((c) => c.id).sort(), ['b', 'c'])
  assert.deepEqual(b.projects, ['alpha', 'zeta'])
})

test('sorts blocked and waiting before working, then recency', () => {
  const list = [
    wt({ id: 'w-old', workspaceStatus: 'in-progress', lastActivityAt: 1 }),
    wt({ id: 'w-new', workspaceStatus: 'in-progress', lastActivityAt: 9 }),
    wt({ id: 'bl', workspaceStatus: 'in-progress', lastActivityAt: 2 }),
    wt({ id: 'wa', workspaceStatus: 'in-progress', lastActivityAt: 5 }),
  ]
  const agents = {
    'w-old': [ag()],
    'w-new': [ag()],
    bl: [ag({ state: 'blocked' })],
    wa: [ag({ state: 'waiting' })],
  }
  const b = buildBoard(list, agents, global, opts)
  assert.deepEqual(
    b.columns[1]?.cards.map((c) => c.id),
    ['wa', 'bl', 'w-new', 'w-old'],
  )
})

test('parentTitle, childCount, agent, mr', () => {
  const list = [
    wt({ id: 'p', displayName: 'Parent', childWorktreeIds: ['c'] }),
    wt({
      id: 'c',
      parentWorktreeId: 'p',
      linkedGitLabMR: { iid: 217 },
      linkedPR: { number: 12 },
    }),
    wt({ id: 'g', linkedPR: { number: 12 } }),
    wt({ id: 'x', linkedPR: 'junk' }),
    wt({ id: 'n1', linkedGitLabMR: 279 }),
    wt({ id: 'n2', linkedPR: 12 }),
  ]
  const cards = buildBoard(
    list,
    { c: [ag({ state: 'done', since: 3, title: 'Wrap up' })] },
    global,
    opts,
  ).columns[0]?.cards
  const by = (id: string) => cards?.find((c) => c.id === id)
  assert.equal(by('c')?.parentTitle, 'Parent')
  assert.equal(by('p')?.childCount, 1)
  assert.equal(by('p')?.parentTitle, null)
  assert.deepEqual(by('c')?.agents, [
    {
      state: 'done',
      since: 3,
      title: 'Wrap up',
      detail: null,
      agent: null,
      model: null,
    },
  ])
  assert.equal(by('c')?.mr, '!217')
  assert.equal(by('g')?.mr, '#12')
  assert.equal(by('x')?.mr, null)
  assert.equal(by('n1')?.mr, '!279')
  assert.equal(by('n2')?.mr, '#12')
  assert.deepEqual(by('x')?.agents, [])
})

test('repo name from path, main checkout, or displayName', () => {
  const list = [
    wt({ id: 'a', path: `${root}/alpha/app` }),
    wt({ id: 'b', path: `${root}/alpha/app/wt/b` }),
    wt({
      id: 'main',
      repoId: 'r9',
      path: '/Users/m/elsewhere/tool',
      isMainWorktree: true,
    }),
    wt({ id: 'o1', repoId: 'r9', path: '/tmp/wt/o1', displayName: 'Disp' }),
    wt({ id: 'o2', repoId: 'r8', path: '/tmp/wt/o2', displayName: 'Disp2' }),
  ]
  const cards = buildBoard(list, {}, global, {
    ...opts,
    hideMainCheckouts: false,
  }).columns[0]?.cards
  const by = (id: string) => cards?.find((c) => c.id === id)
  assert.equal(by('a')?.repo, 'app')
  assert.equal(by('b')?.repo, 'app')
  assert.equal(by('main')?.repo, 'tool')
  assert.equal(by('o1')?.repo, 'tool')
  assert.equal(by('o2')?.repo, 'Disp2')
  assert.equal(by('o1')?.project, null)
})

test('parseBoardFile round-trips and falls back to global', () => {
  assert.deepEqual(parseBoardFile('{"scope":"project","project":"demo"}'), {
    scope: 'project',
    project: 'demo',
  })
  assert.deepEqual(parseBoardFile('nope'), { scope: 'global' })
  assert.deepEqual(parseBoardFile('{"scope":"project"}'), { scope: 'global' })
  assert.deepEqual(parseBoardFile('{"scope":"global"}'), { scope: 'global' })
})

test('cards carry kind, unread, pinned and note flags', () => {
  const list = [
    wt({ id: 'mr', linkedGitLabMR: 5, isUnread: true, comment: ' note ' }),
    wt({ id: 'plain', comment: '   ' }),
  ]
  const cards = buildBoard(list, {}, global, opts).columns[0]?.cards
  const by = (id: string) => cards?.find((c) => c.id === id)
  assert.equal(by('mr')?.kind, 'mr')
  assert.equal(by('mr')?.isUnread, true)
  assert.equal(by('mr')?.hasNote, true)
  assert.equal(by('mr')?.isPinned, false)
  assert.equal(by('plain')?.kind, 'branch')
  assert.equal(by('plain')?.isUnread, false)
  assert.equal(by('plain')?.hasNote, false)
})

test('pinned worktrees go to the pinned list, not the columns', () => {
  const list = [
    wt({ id: 'pin', isPinned: true, workspaceStatus: 'in-review' }),
    wt({ id: 'other', path: `${root}/zeta/r/other`, isPinned: true }),
    wt({ id: 'free' }),
  ]
  const b = buildBoard(list, {}, { scope: 'project', project: 'demo' }, opts)
  assert.deepEqual(
    b.pinned.map((c) => [c.id, c.isPinned, c.status]),
    [['pin', true, 'in-review']],
  )
  assert.deepEqual(
    b.columns.flatMap((c) => c.cards.map((x) => x.id)),
    ['free'],
  )
  assert.deepEqual(buildBoard([], {}, global, opts).pinned, [])
})

test('card agents are sorted most urgent first, then newest', () => {
  const b = buildBoard(
    [wt({ id: 'a' })],
    {
      a: [
        ag({ paneKey: 'd', state: 'done', since: 50 }),
        ag({ paneKey: 'w', state: 'working', since: 10, model: 'm1' }),
        ag({ paneKey: 'b', state: 'blocked', since: 5, title: 'Needs you' }),
        ag({ paneKey: 'w2', state: 'working', since: 20 }),
      ],
    },
    global,
    opts,
  )
  const agents = b.columns[0]?.cards[0]?.agents ?? []
  assert.deepEqual(
    agents.map((a) => [a.state, a.since]),
    [
      ['blocked', 5],
      ['working', 20],
      ['working', 10],
      ['done', 50],
    ],
  )
  assert.equal(agents[0]?.title, 'Needs you')
  assert.equal(agents[2]?.model, 'm1')
})

test('hiddenMainCount only counts main checkouts in the filtered project', () => {
  const list = [
    wt({ id: 'm1', path: `${root}/alpha/r1`, isMainWorktree: true }),
    wt({
      id: 'm2',
      path: `${root}/zeta/r2`,
      repoId: 'r2',
      isMainWorktree: true,
    }),
    wt({
      id: 'm3',
      path: `${root}/zeta/r3`,
      repoId: 'r3',
      isMainWorktree: true,
    }),
  ]
  const alpha = buildBoard(
    list,
    {},
    { scope: 'project', project: 'alpha' },
    opts,
  )
  assert.equal(alpha.hiddenMainCount, 1)
  assert.equal(buildBoard(list, {}, global, opts).hiddenMainCount, 3)
})

test('card agents put the top-level agent first, sub-agents after', () => {
  const b = buildBoard(
    [wt({ id: 'a' })],
    {
      a: [
        ag({ paneKey: 'sub', parentPaneKey: 'lead', state: 'blocked' }),
        ag({
          paneKey: 'lead',
          state: 'done',
          agent: 'claude',
          detail: 'Bash: ls',
        }),
      ],
    },
    global,
    opts,
  )
  const agents = b.columns[0]?.cards[0]?.agents ?? []
  assert.deepEqual(
    agents.map((a) => [a.state, a.agent, a.detail]),
    [
      ['done', 'claude', 'Bash: ls'],
      ['blocked', null, null],
    ],
  )
})

test('a worker worktree outside the projects root takes its repo project', () => {
  const list = [
    wt({
      id: 'main',
      repoId: 'r5',
      path: `${root}/alpha/app`,
      isMainWorktree: true,
    }),
    wt({ id: 't2', repoId: 'r5', path: '/Users/m/orca/workspaces/app/t2' }),
    wt({ id: 'other', repoId: 'r1', path: `${root}/demo/api/other` }),
  ]
  const all = buildBoard(list, {}, global, opts).columns[0]?.cards
  const t2 = all?.find((c) => c.id === 't2')
  assert.equal(t2?.project, 'alpha')
  assert.equal(t2?.repo, 'app')
  const scoped = buildBoard(
    list,
    {},
    { scope: 'project', project: 'alpha' },
    opts,
  )
  assert.deepEqual(
    scoped.columns[0]?.cards.map((c) => c.id),
    ['t2'],
  )
})
