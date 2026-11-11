import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaCli, WorktreeSummary } from '../adapters/orca-cli'
import type { AgentEntry } from '../core/agents'
import type { BoardModel } from '../core/board-model'
import type { BoardStatus } from '../core/types'
import * as main from '../worker'

const ROOT = '/Users/m/projects'

function wt(over: Partial<WorktreeSummary> & { id: string }): WorktreeSummary {
  return {
    identityKey: `wt2:local:${over.id}`,
    projectId: 'p',
    repoId: 'r1',
    path: `${ROOT}/demo/api/${over.id}`,
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
    agents: [],
    ...over,
  }
}

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

function fakeCli(
  list: () => Promise<WorktreeSummary[]>,
  setStatus?: (id: string, s: BoardStatus) => Promise<void>,
) {
  const statusCalls: [string, BoardStatus][] = []
  const cli = {
    worktreeSummaries: async () => ({
      summaries: await list(),
      truncated: false,
    }),
    listWorktrees: list,
    async setStatus(id: string, s: BoardStatus) {
      if (setStatus) await setStatus(id, s)
      statusCalls.push([id, s])
    },
  } as unknown as OrcaCli
  return { cli, statusCalls }
}

/** Manual scheduler: fires pending callbacks on demand, never sleeps. */
function manualScheduler() {
  const pending = new Map<number, () => void>()
  let n = 0
  return {
    schedule(fn: () => void, ms: number) {
      assert.equal(ms, 500)
      const id = ++n
      pending.set(id, fn)
      return () => {
        pending.delete(id)
      }
    },
    get size() {
      return pending.size
    },
    fire() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id)
        fn()
      }
    },
  }
}

async function setup(
  list: () => Promise<WorktreeSummary[]>,
  opts: {
    storage?: Record<string, never>
    setStatus?: (id: string, s: BoardStatus) => Promise<void>
  } = {},
) {
  const { cli, statusCalls } = fakeCli(list, opts.setStatus)
  const sched = manualScheduler()
  const host = mockHost({
    storage: opts.storage ?? {},
    settings: { projectsRoot: ROOT, hideMainCheckouts: true },
  })
  const worker = await mountWorker(
    {
      default: (orca) =>
        main.activateWith(orca, { cli, schedule: sched.schedule }),
    },
    { host },
  )
  return { worker, host, sched, statusCalls }
}

const global = { filter: { scope: 'global' } } as const

function cards(r: unknown) {
  const m = (r as { model: BoardModel }).model
  return m.columns.flatMap((c) => c.cards)
}

function changed(worker: { posts: readonly { event: string }[] }) {
  return worker.posts.filter((p) => p.event === 'board.changed').length
}

function stored(host: { data(): { storage: unknown } }, key: string) {
  return (host.data().storage as Record<string, unknown>)[key]
}

test('board.get builds from worktree summaries', async () => {
  const { worker } = await setup(async () => [
    wt({ id: 'a', workspaceStatus: 'in-progress' }),
  ])
  const r = await worker.request('board.get', global)
  assert.deepEqual(
    cards(r).map((c) => c.id),
    ['a'],
  )
  await worker.deactivate()
})

test('board.get does not use listWorktrees', async () => {
  const summaries = [wt({ id: 's' })]
  const cli = {
    worktreeSummaries: async () => ({ summaries, truncated: false }),
    listWorktrees: async () => {
      throw new Error('not this one')
    },
  } as unknown as OrcaCli
  const host = mockHost({
    settings: { projectsRoot: ROOT, hideMainCheckouts: true },
  })
  const worker = await mountWorker(
    { default: (orca) => main.activateWith(orca, { cli }) },
    { host },
  )
  const r = await worker.request('board.get', global)
  assert.deepEqual(
    cards(r).map((c) => c.id),
    ['s'],
  )
  await worker.deactivate()
})

test('board.get resolves a plain-English error when the CLI fails', async () => {
  const { worker } = await setup(async () => {
    throw new Error('orca worktree ps failed: dispatch gate pane Task Run')
  })
  const r = (await worker.request('board.get', global)) as { error: string }
  assert.equal(typeof r.error, 'string')
  assert.ok(r.error.length > 0)
  assert.ok(!/\b(run|dispatch|task|gate|pane|orca)\b/i.test(r.error))
  await worker.deactivate()
})

test('board.setStatus sets the status then posts board.changed', async () => {
  const { worker, sched, statusCalls } = await setup(async () => [
    wt({ id: 'a' }),
  ])
  const r = await worker.request('board.setStatus', {
    worktreeId: 'a',
    status: 'in-review',
  })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(statusCalls, [['a', 'in-review']])
  sched.fire()
  assert.equal(changed(worker), 1)
  await worker.deactivate()
})

test('board.setStatus reports a plain error when the CLI fails', async () => {
  const { worker } = await setup(async () => [], {
    setStatus: async () => {
      throw new Error('boom')
    },
  })
  const r = (await worker.request('board.setStatus', {
    worktreeId: 'a',
    status: 'completed',
  })) as { error: string }
  assert.equal(typeof r.error, 'string')
  assert.equal(worker.posts.length, 0)
  await worker.deactivate()
})

test('summary agents reach the cards with kind and detail', async () => {
  const { worker } = await setup(async () => [
    wt({
      id: 'a',
      agents: [
        ag({
          paneKey: 'lead',
          title: 'Ask coordinator',
          detail: 'Bash: ls',
          agent: 'codex',
          state: 'done',
          since: 7,
        }),
        ag({ paneKey: 'sub', parentPaneKey: 'lead', state: 'working' }),
      ],
    }),
  ])
  const c = cards(await worker.request('board.get', global))
  assert.deepEqual(c[0]?.agents[0], {
    state: 'done',
    since: 7,
    title: 'Ask coordinator',
    detail: 'Bash: ls',
    agent: 'codex',
    model: null,
  })
  assert.equal(c[0]?.agents.length, 2)
  await worker.deactivate()
})

test('a live event newer than the summary wins and posts board.changed', async () => {
  const now = Date.now()
  const { worker, sched } = await setup(async () => [
    wt({
      id: 'a',
      agents: [
        ag({
          paneKey: 'p1',
          state: 'working',
          title: 'Busy',
          updatedAt: now - 5000,
        }),
      ],
    }),
  ])
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'p1',
    terminalId: 't1',
    state: 'blocked',
    receivedAt: now,
  })
  const c = cards(await worker.request('board.get', global))
  assert.equal(c[0]?.agents[0]?.state, 'blocked')
  assert.equal(c[0]?.agents[0]?.title, 'Busy')
  sched.fire()
  assert.equal(changed(worker), 1)
  await worker.deactivate()
})

test('a live event older than the summary is ignored', async () => {
  const now = Date.now()
  const { worker } = await setup(async () => [
    wt({
      id: 'a',
      agents: [ag({ paneKey: 'p1', state: 'done', updatedAt: now })],
    }),
  ])
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'p1',
    state: 'working',
    receivedAt: now - 1000,
  })
  const c = cards(await worker.request('board.get', global))
  assert.equal(c[0]?.agents[0]?.state, 'done')
  await worker.deactivate()
})

test('a live event adds a pane the summary does not have yet', async () => {
  const now = Date.now()
  const { worker } = await setup(async () => [wt({ id: 'a' })])
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'new',
    title: 'Starting',
    state: 'working',
    receivedAt: now,
  })
  const c = cards(await worker.request('board.get', global))
  assert.deepEqual(
    c[0]?.agents.map((x) => [x.state, x.title]),
    [['working', 'Starting']],
  )
  await worker.deactivate()
})

test('the live overlay is short-lived', async () => {
  const { worker } = await setup(async () => [wt({ id: 'a' })])
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'old',
    state: 'working',
    receivedAt: Date.now() - 10 * 60 * 1000,
  })
  const c = cards(await worker.request('board.get', global))
  assert.deepEqual(c[0]?.agents, [])
  await worker.deactivate()
})

test('agent events never write storage and old agent keys are removed', async () => {
  const { worker, host } = await setup(async () => [wt({ id: 'a' })], {
    storage: {
      'agents.v1': { a: { state: 'waiting', since: 7 } },
      'agents.v2': { a: [] },
    } as never,
  })
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'p1',
    state: 'working',
    receivedAt: Date.now(),
  })
  await worker.request('board.get', global)
  assert.equal(stored(host, 'agents.v1'), undefined)
  assert.equal(stored(host, 'agents.v2'), undefined)
  await worker.deactivate()
})

test('agent.status.changed without a workspace is ignored', async () => {
  const { worker, sched } = await setup(async () => [wt({ id: 'a' })])
  sched.fire()
  const before = changed(worker)
  await worker.emit('agent.status.changed', {
    workspaceId: null,
    paneKey: 'p1',
    state: 'working',
    receivedAt: 1,
  })
  sched.fire()
  assert.equal(changed(worker), before)
  await worker.deactivate()
})

test('events are debounced into one board.changed', async () => {
  const { worker, sched } = await setup(async () => [wt({ id: 'a' })])
  await worker.emit('workspace.created', {
    workspaceId: 'a',
    kind: 'worktree',
    path: '/x',
    branch: 'b',
  })
  await worker.emit('workspace.removed', {
    workspaceId: 'a',
    kind: 'worktree',
    path: '/x',
  })
  assert.equal(worker.posts.length, 0)
  sched.fire()
  assert.equal(changed(worker), 1)
  await worker.deactivate()
})

test('board.openWorktree opens the host workspace id', async () => {
  const { worker, host } = await setup(async () => [wt({ id: 'a' })])
  host.respond('workspace.open', { opened: true })
  const r = await worker.request('board.openWorktree', { worktreeId: 'a' })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(host.callsOf('workspace.open'), [
    { workspaceId: 'identity:wt2:local:a' },
  ])
  await worker.deactivate()
})

test('board.openWorktree reports an unknown worktree plainly', async () => {
  const { worker } = await setup(async () => [wt({ id: 'a' })])
  const r = (await worker.request('board.openWorktree', {
    worktreeId: 'nope',
  })) as { error: string }
  assert.equal(typeof r.error, 'string')
  await worker.deactivate()
})

test('a live terminal id with a recorded launch fills the model', async () => {
  const now = Date.now()
  const { worker } = await setup(
    async () => [
      wt({
        id: 'a',
        agents: [
          ag({ paneKey: 'p1', agent: 'claude', updatedAt: now - 5000 }),
          ag({ paneKey: 'p2', agent: 'codex', updatedAt: now - 5000 }),
        ],
      }),
    ],
    {
      storage: {
        'tracker.v1': {
          orchestrators: [],
          workers: [],
          launches: [
            {
              terminalId: 't1',
              workspaceId: null,
              agent: 'claude',
              model: 'claude-opus-4-8',
              bypass: [],
              at: 1,
            },
          ],
        },
      } as never,
    },
  )
  await worker.emit('agent.status.changed', {
    workspaceId: 'a',
    paneKey: 'p1',
    terminalId: 't1',
    state: 'working',
    receivedAt: now,
  })
  const c = cards(await worker.request('board.get', global))
  const models = Object.fromEntries(
    (c[0]?.agents ?? []).map((x) => [x.agent, x.model]),
  )
  assert.deepEqual(models, { claude: 'claude-opus-4-8', codex: null })
  await worker.deactivate()
})

test('tracked Workers resolve terminal identities after restart and compare every project default', async () => {
  const summaries = [
    wt({
      id: 'a',
      agents: [
        ag({ paneKey: 'p1', agent: 'codex' }),
        ag({ paneKey: 'p2', agent: 'codex', state: 'blocked' }),
      ],
    }),
    wt({
      id: 'untracked',
      agents: [
        ag({
          paneKey: 'p3',
          terminalId: 't3',
          agent: 'custom',
          model: 'outside',
        }),
      ],
    }),
  ]
  const cli = {
    worktreeSummaries: async () => ({ summaries, truncated: false }),
    listWorktrees: async () => summaries,
    terminalInfo: async (id: string) => ({
      title: id,
      paneKey: id === 't1' ? 'p1' : 'p2',
    }),
  } as unknown as OrcaCli
  const host = mockHost({
    settings: { projectsRoot: ROOT },
    storage: {
      'worker-defaults.v1': {
        demo: { prose: { agent: 'codex', model: 'custom-review' } },
      },
      'tracker.v1': {
        orchestrators: [],
        workers: ['t1', 't2'].map((terminalId) => ({
          terminalId,
          workspaceId: 'a',
          agent: 'codex',
          project: 'demo',
          orchestratorTerminalId: 'o',
          taskId: null,
        })),
        launches: [
          {
            terminalId: 't1',
            workspaceId: 'a',
            agent: 'codex',
            model: 'custom-review',
            bypass: [],
            at: 1,
          },
          {
            terminalId: 't2',
            workspaceId: 'a',
            agent: 'codex',
            model: 'outside',
            bypass: [],
            at: 1,
          },
        ],
      },
    },
  })
  const worker = await mountWorker(
    { default: (orca) => main.activateWith(orca, { cli }) },
    { host },
  )
  const result = cards(await worker.request('board.get', global))
  const agents = result.find((c) => c.id === 'a')?.agents ?? []
  assert.equal(agents[0]?.model, 'outside')
  assert.equal(agents[0]?.outsideDefaults, true)
  assert.equal(agents[1]?.model, 'custom-review')
  assert.ok(!agents[1]?.outsideDefaults)
  assert.ok(
    !result.find((c) => c.id === 'untracked')?.agents[0]?.outsideDefaults,
  )
  await worker.deactivate()
})

test('D1: agentStates preserves confirmed empty Worktrees', async () => {
  const { createBoardService } = await import('./board-service')
  const summaries = [wt({ id: 'empty' }), wt({ id: 'busy', agents: [ag()] })]
  const { cli } = fakeCli(async () => summaries)
  let service!: ReturnType<typeof createBoardService>
  const worker = await mountWorker({
    default(orca) {
      service = createBoardService(orca, cli, async () => ({}) as never)
    },
  })
  try {
    assert.deepEqual(await service.agentStates(), {
      states: {
        empty: [],
        busy: summaries[1]?.agents,
      },
      truncated: false,
    })
  } finally {
    service.dispose()
    await worker.deactivate()
  }
})

test('partial summaries load on global and project boards and retain truncation in agent states', async () => {
  const { createBoardService } = await import('./board-service')
  const summaries = [wt({ id: 'empty' }), wt({ id: 'busy', agents: [ag()] })]
  let truncated = true
  const cli = {
    worktreeSummaries: async () => ({ summaries, truncated }),
  } as unknown as OrcaCli
  let service!: ReturnType<typeof createBoardService>
  const worker = await mountWorker({
    default(orca) {
      service = createBoardService(
        orca,
        cli,
        async () => ({ projectsRoot: ROOT }) as never,
      )
    },
  })
  try {
    for (const filter of [
      global.filter,
      { scope: 'project', project: 'demo' },
    ] as const) {
      const result = await worker.request('board.get', { filter })
      assert.deepEqual(
        cards(result).map((c) => c.id),
        ['empty', 'busy'],
      )
      assert.equal(
        (result as { model: BoardModel }).model.notice,
        'Some worktrees could not be listed; the board may be incomplete.',
      )
    }
    assert.deepEqual(await service.agentStates(), {
      states: { empty: [], busy: summaries[1]?.agents },
      truncated: true,
    })
    truncated = false
    const result = await worker.request('board.get', global)
    assert.equal((result as { model: BoardModel }).model.notice, null)
    assert.equal((await service.agentStates()).truncated, false)
  } finally {
    service.dispose()
    await worker.deactivate()
  }
})

test('E1: main checkout visibility persists per board file and survives a service restart', async () => {
  const list = async () => [
    wt({ id: 'main', isMainWorktree: true }),
    wt({ id: 'child' }),
  ]
  const s = await setup(list)
  try {
    assert.equal(cards(await s.worker.request('board.get', global)).length, 1)
    assert.deepEqual(
      await s.worker.request('board.setMainCheckouts', {
        filter: global.filter,
        hidden: false,
      }),
      { ok: true },
    )
    assert.equal(cards(await s.worker.request('board.get', global)).length, 2)
    const project = { filter: { scope: 'project', project: 'demo' } } as const
    assert.equal(cards(await s.worker.request('board.get', project)).length, 1)
    const storage = s.host.data().storage as Record<string, never>
    const restarted = await setup(list, { storage })
    try {
      assert.equal(
        cards(await restarted.worker.request('board.get', global)).length,
        2,
      )
      assert.deepEqual(
        await restarted.worker.request('board.setMainCheckouts', {
          filter: global.filter,
          hidden: true,
        }),
        { ok: true },
      )
      assert.equal(
        cards(await restarted.worker.request('board.get', global)).length,
        1,
      )
    } finally {
      await restarted.worker.deactivate()
    }
  } finally {
    await s.worker.deactivate()
  }
})
