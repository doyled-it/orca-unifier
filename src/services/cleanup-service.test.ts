import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { type Exec, type ExecResult, nodeExec } from '../adapters/exec'
import type { AgentEntry, AgentState, AgentStates } from '../core/agents'
import { parseSettings } from '../core/settings'
import type { WorktreeRecord } from '../core/types'
import { activateWith } from '../worker'
import { createCleanupService } from './cleanup-service'

const ARMED = 'cleanup.armed.v1'
const LAST_AUTO_AT = 'cleanup.lastAutoAt.v1'
const COMMANDS = [
  'unifier.cleanupDryRun',
  'unifier.cleanupNow',
  'unifier.hideExternal',
]

function record(
  root: string,
  id: string,
  over: Partial<WorktreeRecord> = {},
): WorktreeRecord {
  return {
    id,
    identityKey: `wt2:local:${id}`,
    projectId: 'project',
    repoId: 'repo',
    path: join(root, 'demo', 'api', id),
    branch: id,
    displayName: id,
    isMainWorktree: false,
    isPinned: false,
    isUnread: false,
    isArchived: false,
    comment: '',
    workspaceStatus: 'completed',
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedGitLabMR: null,
    linkedPR: null,
    lastActivityAt: 0,
    ...over,
  }
}

function agent(state: AgentState, paneKey = state): AgentEntry {
  return {
    paneKey,
    parentPaneKey: null,
    terminalId: null,
    title: null,
    detail: null,
    state,
    since: 1,
    updatedAt: 1,
    agent: null,
    model: null,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await delay(1)
  }
  assert.fail('Cleanup did not settle')
}

function scheduler() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  return {
    pending,
    schedule(fn: () => void, ms: number) {
      const id = ++next
      pending.set(id, { fn, ms })
      return () => {
        pending.delete(id)
      }
    },
    fire() {
      const first = [...pending][0]
      assert.ok(first)
      const [id, timer] = first
      pending.delete(id)
      timer.fn()
    },
  }
}

async function setup(
  options: {
    enabled?: boolean
    worktrees?: (root: string, scratch: string) => WorktreeRecord[]
    armed?: boolean
    wholeWorker?: boolean
    exec?: Exec
    armingFails?: boolean
    truncated?: boolean
  } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), 'unifier-cleanup-'))
  const root = join(scratch, 'projects with spaces')
  let worktrees = options.worktrees?.(root, scratch) ?? [
    record(root, 'a'),
    record(root, 'b'),
  ]
  await mkdir(root, { recursive: true })
  const mainEvidence = record(root, 'main-evidence', { isMainWorktree: true })
  await mkdir(mainEvidence.path, { recursive: true })
  for (const w of worktrees) await mkdir(w.path, { recursive: true })
  const replies = new Map<string, Partial<ExecResult>>()
  const gitPaths: string[] = []
  let beforeExec = async () => {}
  const exec: Exec = async (file, args) => {
    assert.equal(file, 'git')
    assert.equal(args[0], '-C')
    const path = args[1] as string
    gitPaths.push(path)
    await beforeExec()
    const command = args.slice(2).join(' ')
    const stdout =
      command === 'rev-parse --show-toplevel'
        ? path
        : command.startsWith('status ')
          ? ''
          : command ===
              'rev-parse --abbrev-ref --symbolic-full-name @{upstream}'
            ? 'origin/feature'
            : command === 'rev-list --count @{upstream}..HEAD'
              ? '0'
              : command === 'symbolic-ref --short refs/remotes/origin/HEAD'
                ? 'origin/main'
                : ''
    assert.ok(
      [
        'rev-parse --show-toplevel',
        'status --porcelain --untracked-files=all -z --ignore-submodules=none',
        'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
        'rev-list --count @{upstream}..HEAD',
        'symbolic-ref --short refs/remotes/origin/HEAD',
        'merge-base --is-ancestor HEAD origin/main',
      ].includes(command),
    )
    return { code: 0, stdout, stderr: '', ...replies.get(`${path}:${command}`) }
  }
  const removed: string[] = []
  const hidden: string[] = []
  let onRemove = async (_id: string) => {}
  let listFails = false
  let listCalls = 0
  const cli = {
    async listWorktrees() {
      listCalls++
      if (listFails) throw new Error('unavailable')
      return worktrees.some((w) => w.repoId === 'repo') &&
        !worktrees.some((w) => w.repoId === 'repo' && w.isMainWorktree)
        ? [...worktrees, mainEvidence]
        : worktrees
    },
    async worktreeSummaries() {
      return {
        summaries: worktrees
          .filter((w) => !options.truncated || Object.hasOwn(states, w.id))
          .map((w) => ({ ...w, agents: states[w.id] ?? [] })),
        truncated: options.truncated ?? false,
      }
    },
    async removeWorktree(id: string) {
      removed.push(id)
      await onRemove(id)
    },
    async hideExternalWorktrees(id: string) {
      hidden.push(id)
    },
  }
  let states: AgentStates = Object.fromEntries(worktrees.map((w) => [w.id, []]))
  let statesFail = false
  const board = {
    async agentStates() {
      if (statesFail) throw new Error('agent states unavailable')
      return { states, truncated: false }
    },
  }
  const config = parseSettings(
    {
      excludedProjects: 'alpha,beta',
      projectsRoot: root,
      cleanupEnabled: options.enabled ?? true,
    },
    scratch,
  )
  const sched = scheduler()
  const host = mockHost({
    settings: {
      excludedProjects: 'alpha,beta',
      projectsRoot: root,
      cleanupEnabled: config.cleanupEnabled,
    },
    storage: options.armed === undefined ? {} : { [ARMED]: options.armed },
    results: { 'notifications.show': { delivered: true } },
  })
  let api!: OrcaWorkerApi
  let service!: ReturnType<typeof createCleanupService>
  let dispose!: () => void
  const clock = { now: 0 }
  let change!: () => unknown
  function startService() {
    service = createCleanupService(
      {
        ...api,
        events: {
          ...api.events,
          on(name, handler) {
            if (name === 'workspace.changed')
              change = () => handler({ context: null } as never)
            return api.events.on(name, handler)
          },
        },
      },
      {
        cli,
        exec: options.exec ?? exec,
        board,
        settings: async () => config,
        schedule: sched.schedule,
        now: () => clock.now,
      },
    )
  }
  const worker = await mountWorker(
    {
      default(orca) {
        api = options.armingFails
          ? {
              ...orca,
              storage: {
                ...orca.storage,
                async set(key, value) {
                  if (key === ARMED) throw new Error('storage unavailable')
                  return orca.storage.set(key, value)
                },
              },
            }
          : orca
        if (options.wholeWorker) {
          dispose = activateWith(api, {
            cli: cli as never,
            exec: options.exec ?? exec,
            cleanupSchedule: sched.schedule,
          })
        } else {
          startService()
          dispose = () => service.dispose()
        }
      },
      deactivate() {
        dispose()
      },
    },
    { host, ...(options.wholeWorker ? {} : { commands: COMMANDS }) },
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  return {
    worker,
    api,
    host,
    get service() {
      return service
    },
    clock,
    change: () => change(),
    listCalls: () => listCalls,
    async restart() {
      service.dispose()
      startService()
      await new Promise<void>((resolve) => setImmediate(resolve))
    },
    config,
    sched,
    root,
    scratch,
    removed,
    hidden,
    gitPaths,
    worktrees: () => worktrees,
    setWorktrees(value: WorktreeRecord[]) {
      worktrees = value
    },
    setStates(value: AgentStates) {
      states = value
    },
    failStates() {
      statesFail = true
    },
    failList() {
      listFails = true
    },
    onRemove(fn: typeof onRemove) {
      onRemove = fn
    },
    beforeExec(fn: typeof beforeExec) {
      beforeExec = fn
    },
    reply(id: string, command: string, value: Partial<ExecResult>) {
      const w = worktrees.find((w) => w.id === id)
      assert.ok(w)
      replies.set(`${w.path}:${command}`, value)
    },
    async close() {
      await worker.deactivate()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

test('dry cleanup reports candidates and kept reasons without removing or arming', async () => {
  const s = await setup()
  try {
    s.reply('b', 'merge-base --is-ancestor HEAD origin/main', { code: 1 })
    const result = await s.service.run('dry')
    assert.deepEqual(result.removed, ['a'])
    assert.equal(result.kept[0]?.id, 'b')
    assert.match(result.kept[0]?.reason ?? '', /merged/i)
    const text = await s.worker.command('unifier.cleanupDryRun')
    assert.equal(typeof text, 'string')
    assert.match(text as string, /Would remove.*a/)
    assert.match(text as string, /Keep.*b.*merged/i)
    assert.deepEqual(s.removed, [])
    assert.equal(await s.api.storage.get(ARMED), null)
    assert.equal(s.host.callsOf('notifications.show').length, 0)
  } finally {
    await s.close()
  }
})

test('unarmed timer only logs a dry pass and never arms', async () => {
  const s = await setup()
  try {
    assert.equal([...s.sched.pending.values()][0]?.ms, 10 * 60_000)
    s.sched.fire()
    await until(() => s.sched.pending.size === 1)
    assert.deepEqual(s.removed, [])
    assert.equal(await s.api.storage.get(ARMED), null)
    assert.ok(s.worker.logs.some((line) => /would remove/i.test(line)))
  } finally {
    await s.close()
  }
})

for (const armed of [false, true]) {
  test(`automatic ${armed ? 'live' : 'dry'} cleanup throttles workspace and timer triggers until the interval`, async () => {
    const s = await setup({ armed, worktrees: () => [] })
    try {
      for (let i = 0; i < 10; i++)
        await s.worker.emit('workspace.changed', { context: null })
      assert.equal(s.listCalls(), 1)
      assert.equal(await s.api.storage.get(LAST_AUTO_AT), 0)
      s.clock.now = 10 * 60_000 - 1
      s.sched.fire()
      await until(() => s.sched.pending.size === 1)
      assert.equal(s.listCalls(), 1)
      s.clock.now++
      s.sched.fire()
      await until(() => s.sched.pending.size === 1)
      assert.equal(s.listCalls(), 2)
      assert.equal(await s.api.storage.get(LAST_AUTO_AT), 10 * 60_000)
    } finally {
      await s.close()
    }
  })

  test(`pending automatic ${armed ? 'live' : 'dry'} triggers share one promise even after the interval`, async () => {
    const s = await setup({ armed })
    const hold = deferred()
    let entered = false
    s.beforeExec(async () => {
      assert.equal(await s.api.storage.get(LAST_AUTO_AT), 0)
      entered = true
      await hold.promise
    })
    const first = s.change()
    const second = s.change()
    try {
      assert.equal(first, second)
      await until(() => entered)
      s.clock.now = 20 * 60_000
      s.sched.fire()
      assert.equal(s.change(), first)
      hold.resolve()
      await first
      await until(() => s.sched.pending.size === 1)
      assert.equal(s.gitPaths.length, 12)
      assert.deepEqual(s.removed, armed ? ['a', 'b'] : [])
    } finally {
      hold.resolve()
      await Promise.allSettled([first, second])
      await s.close()
    }
  })
}

test('automatic throttle survives a new service over the same storage', async () => {
  const s = await setup({ worktrees: () => [] })
  try {
    await s.worker.emit('workspace.changed', { context: null })
    await s.restart()
    s.clock.now = 10 * 60_000 - 1
    await s.worker.emit('workspace.changed', { context: null })
    assert.equal(s.listCalls(), 1)
    s.clock.now++
    await s.worker.emit('workspace.changed', { context: null })
    assert.equal(s.listCalls(), 2)
  } finally {
    await s.close()
  }
})

test('manual dry and live commands ignore the automatic throttle without resetting it', async () => {
  const s = await setup()
  try {
    await s.worker.emit('workspace.changed', { context: null })
    s.clock.now = 1
    const dry = await s.worker.command('unifier.cleanupDryRun')
    assert.match(dry as string, /Would remove.*a/)
    assert.equal(s.listCalls(), 2)
    await s.worker.command('unifier.cleanupNow')
    assert.deepEqual(s.removed, ['a', 'b'])
    assert.equal(await s.api.storage.get(LAST_AUTO_AT), 0)
    const listings = s.listCalls()
    await s.worker.emit('workspace.changed', { context: null })
    assert.equal(s.listCalls(), listings)
  } finally {
    await s.close()
  }
})

test('cleanupNow persists arming before removing sequentially with one summary notification', async () => {
  const s = await setup()
  try {
    s.onRemove(async () => {
      assert.equal(await s.api.storage.get(ARMED), true)
    })
    const text = await s.worker.command('unifier.cleanupNow')
    assert.equal(typeof text, 'string')
    assert.match(text as string, /Removed.*a/)
    assert.match(text as string, /Removed.*b/)
    assert.deepEqual(s.removed, ['a', 'b'])
    assert.deepEqual(s.host.callsOf('notifications.show'), [
      { title: 'Removed 2 merged worktrees: a, b' },
    ])
    for (const id of ['a', 'b'])
      assert.ok(
        s.worker.logs.some((line) => line.includes(id) && /removed/.test(line)),
      )
  } finally {
    await s.close()
  }
})

test('armed timer runs live but a dry command remains dry and preserves arming', async () => {
  const s = await setup({ armed: true })
  try {
    await s.worker.command('unifier.cleanupDryRun')
    assert.deepEqual(s.removed, [])
    assert.equal(await s.api.storage.get(ARMED), true)
    s.sched.fire()
    await until(() => s.sched.pending.size === 1)
    assert.deepEqual(s.removed, ['a', 'b'])
  } finally {
    await s.close()
  }
})

test('live cleanup keeps every unsafe or unknown Git verdict and main or pinned worktree', async () => {
  const s = await setup({
    worktrees: (root) =>
      [
        'safe',
        'dirty',
        'upstream',
        'ahead',
        'unmerged',
        'unknown',
        'missing',
        'main',
        'pinned',
      ].map((id) =>
        record(root, id, {
          isMainWorktree: id === 'main',
          isPinned: id === 'pinned',
        }),
      ),
  })
  try {
    s.reply(
      'dirty',
      'status --porcelain --untracked-files=all -z --ignore-submodules=none',
      { stdout: '?? notes.txt\n' },
    )
    s.reply(
      'upstream',
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      { code: 1, stdout: '' },
    )
    s.reply('ahead', 'rev-list --count @{upstream}..HEAD', { stdout: '1' })
    s.reply('unmerged', 'merge-base --is-ancestor HEAD origin/main', {
      code: 1,
    })
    s.reply('unknown', 'merge-base --is-ancestor HEAD origin/main', {
      code: -1,
      error: 'timeout',
    })
    const missing = s.worktrees().find((w) => w.id === 'missing')
    assert.ok(missing)
    await rm(missing.path, {
      recursive: true,
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, ['safe'])
    assert.deepEqual(result.removed, ['safe'])
    assert.deepEqual(
      result.kept.filter((w) => w.id !== 'main-evidence').map((w) => w.id),
      [
        'dirty',
        'upstream',
        'ahead',
        'unmerged',
        'unknown',
        'missing',
        'main',
        'pinned',
      ],
    )
    assert.ok(s.listCalls() <= 1 + result.removed.length + 1)
  } finally {
    await s.close()
  }
})

test('safe facts cannot remove excluded projects, unresolvable projects or hub folders', async () => {
  const s = await setup({
    worktrees: (root, scratch) => [
      record(root, 'alpha', { path: join(root, 'ALPHA', 'repo', 'feature') }),
      record(root, 'beta-main', {
        repoId: 'beta',
        path: join(root, 'Beta', 'repo'),
        isMainWorktree: true,
      }),
      record(root, 'beta-outside', {
        repoId: 'beta',
        path: join(scratch, 'outside', 'beta'),
      }),
      record(root, 'unresolvable', {
        repoId: 'unknown',
        path: join(scratch, 'outside', 'unknown'),
      }),
      record(root, 'global-hub', { path: root }),
      record(root, 'project-hub', { path: join(root, 'demo', '.') }),
      record(root, 'demo-main', {
        repoId: 'demo',
        path: join(root, 'demo', 'api'),
        isMainWorktree: true,
      }),
      record(root, 'eligible-outside', {
        repoId: 'demo',
        path: join(scratch, 'outside', 'eligible'),
      }),
    ],
  })
  try {
    const result = await s.service.run('live')
    assert.deepEqual(result.removed, ['eligible-outside'])
    assert.deepEqual(s.removed, ['eligible-outside'])
    for (const w of s.worktrees().slice(0, 6)) {
      assert.ok(result.kept.some((k) => k.id === w.id && k.reason.length > 0))
      assert.ok(!s.gitPaths.includes(w.path))
    }
  } finally {
    await s.close()
  }
})

test('any working, blocked or waiting entry keeps a worktree even when another agent is done', async () => {
  const s = await setup({
    worktrees: (root) =>
      ['working', 'blocked', 'waiting', 'done'].map((id) => record(root, id)),
  })
  try {
    s.setStates({
      working: [agent('done'), agent('working')],
      blocked: [agent('done'), agent('blocked')],
      waiting: [agent('done'), agent('waiting')],
      done: [agent('done')],
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, ['done'])
    assert.deepEqual(
      result.kept.filter((w) => w.id !== 'main-evidence').map((w) => w.id),
      ['working', 'blocked', 'waiting'],
    )
  } finally {
    await s.close()
  }
})

test('agentStates failure keeps all worktrees', async () => {
  const s = await setup()
  try {
    s.failStates()
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.deepEqual(
      result.kept.filter((w) => w.id !== 'main-evidence').map((w) => w.id),
      ['a', 'b'],
    )
    assert.ok(result.kept.every((w) => /agent/i.test(w.reason)))
  } finally {
    await s.close()
  }
})

test('concurrent live calls return the same promise and remove only one worktree at a time', async () => {
  const s = await setup()
  const hold = deferred()
  try {
    s.onRemove(async (id) => {
      if (id === 'a') await hold.promise
    })
    const first = s.service.run('live')
    const second = s.service.run('live')
    assert.equal(first, second)
    await until(() => s.removed.length === 1)
    assert.deepEqual(s.removed, ['a'])
    assert.equal(s.service.run('live'), first)
    hold.resolve()
    await first
    assert.deepEqual(s.removed, ['a', 'b'])
    assert.equal(s.host.callsOf('notifications.show').length, 1)
    s.setWorktrees([])
    assert.deepEqual(await s.service.run('live'), { removed: [], kept: [] })
  } finally {
    hold.resolve()
    await s.close()
  }
})

test('disabled cleanup schedules no timer and workspace changes remove nothing', async () => {
  const s = await setup({ enabled: false, armed: true })
  try {
    assert.equal(s.sched.pending.size, 0)
    await s.worker.emit('workspace.changed', { context: null })
    assert.deepEqual(s.removed, [])
  } finally {
    await s.close()
  }
})

test('workspace changes respect arming before automatic live cleanup', async () => {
  const s = await setup()
  try {
    await s.worker.emit('workspace.changed', { context: null })
    assert.deepEqual(s.removed, [])
    await s.api.storage.set(ARMED, true)
    s.clock.now += s.config.cleanupIntervalMinutes * 60_000
    await s.worker.emit('workspace.changed', { context: null })
    assert.deepEqual(s.removed, ['a', 'b'])
  } finally {
    await s.close()
  }
})

test('dispose during fact gathering prevents deletion and cancels the timer', async () => {
  const s = await setup()
  const hold = deferred()
  let entered = false
  try {
    s.beforeExec(async () => {
      entered = true
      await hold.promise
    })
    const pass = s.service.run('live')
    await until(() => entered)
    s.service.dispose()
    assert.equal(s.sched.pending.size, 0)
    hold.resolve()
    await pass
    assert.deepEqual(s.removed, [])
  } finally {
    hold.resolve()
    await s.close()
  }
})

test('hideExternal lists only unique repos with a non-excluded main checkout under the root', async () => {
  const s = await setup({
    worktrees: (root, scratch) => [
      record(root, 'main', { isMainWorktree: true }),
      record(root, 'duplicate-main', { isMainWorktree: true }),
      record(root, 'feature', { repoId: 'no-main' }),
      record(root, 'project-root', {
        repoId: 'project-root',
        path: join(root, 'solo'),
        isMainWorktree: true,
      }),
      record(root, 'alpha', {
        repoId: 'alpha',
        path: join(root, 'Alpha', 'api'),
        isMainWorktree: true,
      }),
      record(root, 'beta', {
        repoId: 'beta',
        path: join(root, 'BETA', 'api'),
        isMainWorktree: true,
      }),
      record(root, 'outside', {
        repoId: 'outside',
        path: join(scratch, 'external'),
        isMainWorktree: true,
      }),
      record(root, 'hub', { repoId: 'hub', path: root, isMainWorktree: true }),
    ],
  })
  try {
    const text = await s.worker.command('unifier.hideExternal')
    assert.equal(typeof text, 'string')
    assert.match(text as string, /repo/)
    assert.deepEqual(s.hidden, ['repo', 'project-root'])
    assert.deepEqual(s.removed, [])
    assert.equal(await s.api.storage.get(ARMED), null)
  } finally {
    await s.close()
  }
})

test('a failed worktree listing never removes anything and releases the live pass', async () => {
  const s = await setup()
  try {
    s.failList()
    await assert.rejects(s.service.run('live'), /unavailable/)
    await assert.rejects(s.service.run('live'), /unavailable/)
    assert.deepEqual(s.removed, [])
  } finally {
    await s.close()
  }
})

test('worker activation wires cleanup commands, board agent states and disposal', async () => {
  const s = await setup({
    wholeWorker: true,
    worktrees: (root) => [record(root, 'a')],
  })
  try {
    s.setStates({ a: [agent('waiting')] })
    const kept = await s.worker.command('unifier.cleanupNow')
    assert.equal(typeof kept, 'string')
    assert.match(kept as string, /Keep.*a.*agent/i)
    assert.deepEqual(s.removed, [])
    s.setStates({})
    await s.worker.command('unifier.cleanupNow')
    assert.deepEqual(s.removed, ['a'])
    await s.worker.deactivate()
    assert.equal(s.sched.pending.size, 0)
  } finally {
    await s.close()
  }
})

test('a Worktree pinned while Git facts are pending is kept', async () => {
  const s = await setup({ worktrees: (root) => [record(root, 'a')] })
  try {
    s.beforeExec(async () => {
      s.setWorktrees(s.worktrees().map((w) => ({ ...w, isPinned: true })))
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.match(result.kept[0]?.reason ?? '', /pinned/i)
  } finally {
    await s.close()
  }
})

test('a changed identity while Git facts are pending is kept', async () => {
  const s = await setup({ worktrees: (root) => [record(root, 'a')] })
  try {
    s.beforeExec(async () => {
      s.setWorktrees(
        s.worktrees().map((w) => ({ ...w, identityKey: 'replacement' })),
      )
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.match(result.kept[0]?.reason ?? '', /identity/i)
  } finally {
    await s.close()
  }
})

test('cleanup rechecks the projects root after gathering Git facts', async () => {
  const s = await setup({ worktrees: (root) => [record(root, 'a')] })
  try {
    s.beforeExec(async () => {
      s.config.projectsRoot = join(s.scratch, 'different-root')
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.match(result.kept[0]?.reason ?? '', /Project/)
  } finally {
    await s.close()
  }
})

test('an agent starting while Git facts are pending keeps the Worktree', async () => {
  const s = await setup({ worktrees: (root) => [record(root, 'a')] })
  try {
    s.beforeExec(async () => {
      s.setStates({ a: [agent('working')] })
    })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.match(result.kept[0]?.reason ?? '', /agent/i)
  } finally {
    await s.close()
  }
})

test('links to an excluded Project or hub are kept before gathering Git facts', async () => {
  const s = await setup({
    worktrees: (root) => [
      record(root, 'excluded-link'),
      record(root, 'hub-link'),
    ],
  })
  try {
    await mkdir(join(s.root, 'Beta', 'api'), { recursive: true })
    await mkdir(join(s.root, 'other-project'), { recursive: true })
    for (const w of s.worktrees()) {
      await rm(w.path, { recursive: true })
      await symlink(
        w.id === 'excluded-link'
          ? join(s.root, 'Beta', 'api')
          : join(s.root, 'other-project'),
        w.path,
      )
    }
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.equal(result.kept.filter((w) => w.id !== 'main-evidence').length, 2)
    assert.deepEqual(s.gitPaths, [])
  } finally {
    await s.close()
  }
})

test('cleanupNow removes nothing when persistent arming fails', async () => {
  const s = await setup({ armingFails: true })
  try {
    const text = await s.worker.command('unifier.cleanupNow')
    assert.equal(typeof text, 'string')
    assert.match(text as string, /could not be completed/)
    assert.equal(await s.api.storage.get(ARMED), null)
    assert.deepEqual(s.removed, [])
    assert.deepEqual(s.gitPaths, [])
  } finally {
    await s.close()
  }
})

test('settings changes cancel disabled cleanup and reschedule the configured interval', async () => {
  const s = await setup()
  try {
    assert.equal(s.sched.pending.size, 1)
    s.config.cleanupEnabled = false
    await s.api.settings.set('cleanupEnabled', false)
    await until(() => s.sched.pending.size === 0)
    s.config.cleanupEnabled = true
    s.config.cleanupIntervalMinutes = 15
    await s.api.settings.set('cleanupEnabled', true)
    await until(() => s.sched.pending.size === 1)
    assert.equal([...s.sched.pending.values()][0]?.ms, 15 * 60_000)
    assert.deepEqual(s.removed, [])
  } finally {
    await s.close()
  }
})

test('sandbox dry command classifies real merged and unmerged Git worktrees without deletion', async () => {
  const s = await setup({
    exec: nodeExec,
    worktrees: (root, scratch) => [
      record(root, 'main', {
        isMainWorktree: true,
        path: join(root, 'demo', 'api'),
      }),
      record(root, 'merged', { path: join(scratch, 'worktrees', 'merged') }),
      record(root, 'unmerged', {
        path: join(scratch, 'worktrees', 'unmerged'),
      }),
    ],
  })
  async function git(path: string, ...args: string[]) {
    const r = await nodeExec('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-C',
      path,
      ...args,
    ])
    assert.equal(r.code, 0, r.stderr)
  }
  const main = join(s.root, 'demo', 'api')
  const merged = join(s.scratch, 'worktrees', 'merged')
  const unmerged = join(s.scratch, 'worktrees', 'unmerged')
  try {
    await git(main, 'init', '--initial-branch=main')
    await git(main, 'config', 'user.name', 'Cleanup test')
    await git(main, 'config', 'user.email', 'cleanup@example.invalid')
    await git(main, 'commit', '--allow-empty', '-m', 'base')
    await git(main, 'remote', 'add', 'origin', join(s.scratch, 'origin.git'))
    await git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await git(
      main,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    )
    await git(
      main,
      'worktree',
      'add',
      '-b',
      'merged',
      '--track',
      merged,
      'origin/main',
    )
    await git(
      main,
      'worktree',
      'add',
      '-b',
      'unmerged',
      '--track',
      unmerged,
      'origin/main',
    )
    await git(unmerged, 'commit', '--allow-empty', '-m', 'unfinished change')
    await git(unmerged, 'update-ref', 'refs/remotes/origin/unmerged', 'HEAD')
    await git(
      unmerged,
      'branch',
      '--set-upstream-to=origin/unmerged',
      'unmerged',
    )
    const text = await s.worker.command('unifier.cleanupDryRun')
    assert.equal(typeof text, 'string')
    assert.match(text as string, /Would remove: merged/)
    assert.match(text as string, /Keep: unmerged:.*[Mm]erged/)
    assert.match(text as string, /Keep: main:.*[Mm]ain/)
    assert.deepEqual(s.removed, [])
    assert.equal(await s.api.storage.get(ARMED), null)
    await git(merged, 'rev-parse', '--show-toplevel')
    await git(unmerged, 'rev-parse', '--show-toplevel')
  } finally {
    await s.close()
  }
})

test('disabling automatic cleanup during Git checks prevents pending timer deletions', async () => {
  const s = await setup({ armed: true })
  try {
    s.beforeExec(async () => {
      s.config.cleanupEnabled = false
    })
    s.sched.fire()
    await until(
      () =>
        s.sched.pending.size === 0 &&
        s.worker.logs.some((line) => /cleanup is disabled/i.test(line)),
    )
    assert.deepEqual(s.removed, [])
    assert.equal(s.host.callsOf('notifications.show').length, 0)
  } finally {
    await s.close()
  }
})

test('disabling automatic cleanup after one deletion keeps the remaining worktrees', async () => {
  const s = await setup({ armed: true })
  try {
    s.onRemove(async () => {
      s.config.cleanupEnabled = false
    })
    await s.worker.emit('workspace.changed', { context: null })
    assert.deepEqual(s.removed, ['a'])
    assert.equal(s.host.callsOf('notifications.show').length, 1)
  } finally {
    await s.close()
  }
})

test('explicit cleanupNow still works when automatic cleanup is disabled', async () => {
  const s = await setup({ enabled: false })
  try {
    await s.worker.command('unifier.cleanupNow')
    assert.deepEqual(s.removed, ['a', 'b'])
    assert.equal(s.sched.pending.size, 0)
  } finally {
    await s.close()
  }
})

test('C3: cleanup excludes a Beta repo Worktree located under projects/demo', async () => {
  const s = await setup({
    worktrees: (root) => [
      record(root, 'child'),
      record(root, 'main', {
        path: join(root, 'Beta', 'repo'),
        isMainWorktree: true,
      }),
    ],
  })
  try {
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, [])
    assert.deepEqual(s.gitPaths, [])
    assert.equal(result.kept.filter((w) => w.id !== 'main-evidence').length, 2)
  } finally {
    await s.close()
  }
})

test('D1: a candidate missing from agent summaries is kept', async () => {
  const s = await setup()
  try {
    s.setStates({ a: [] })
    const result = await s.service.run('live')
    assert.deepEqual(s.removed, ['a'])
    assert.ok(result.kept.some((w) => w.id === 'b' && /agent/i.test(w.reason)))
  } finally {
    await s.close()
  }
})

test('partial board summaries keep missing cleanup candidates and allow confirmed empty candidates', async () => {
  const s = await setup({ wholeWorker: true, truncated: true })
  try {
    s.setStates({ a: [] })
    const result = await s.worker.command('unifier.cleanupNow')
    assert.deepEqual(s.removed, ['a'])
    assert.match(result as string, /Keep.*b.*agent/i)
  } finally {
    await s.close()
  }
})
