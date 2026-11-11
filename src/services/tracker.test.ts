import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { createTracker } from './tracker'

type Storage = OrcaWorkerApi['storage']

/** In-memory storage that keeps JSON copies, as the host does. */
function memoryStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(k) {
      return data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null
    },
    async set(k, v) {
      data.set(k, JSON.parse(JSON.stringify(v)))
    },
    async delete(k) {
      data.delete(k)
    },
    async keys() {
      return [...data.keys()]
    },
    onDidChange() {
      return { dispose() {} }
    },
  }
}

const orch = {
  project: 'demo',
  workspaceId: 'hub::/Users/m/projects',
  terminalId: 'term_orch',
  agent: 'claude',
  model: 'claude-opus-5-5',
  runId: null,
}

test('records survive a fresh tracker over the same storage', async () => {
  const storage = memoryStorage()
  const a = createTracker(storage)
  await a.recordOrchestrator(orch)
  await a.recordLaunch({
    terminalId: 'term_w',
    workspaceId: 'r::/w',
    agent: 'codex',
    model: null,
    bypass: ['--approve-for-me'],
    at: 5,
  })
  await a.recordWorker({
    terminalId: 'term_w',
    workspaceId: 'r::/w',
    agent: 'codex',
    project: 'demo',
    orchestratorTerminalId: 'term_orch',
    taskId: 'task_1',
  })

  const b = createTracker(storage)
  assert.deepEqual(await b.orchestrators(), [orch])
  assert.deepEqual(await b.orchestratorByTerminal('term_orch'), orch)
  assert.equal(await b.orchestratorByTerminal('term_other'), null)
  assert.deepEqual(await b.launchFor('term_w'), {
    agent: 'codex',
    model: null,
    bypass: ['--approve-for-me'],
    workspaceId: 'r::/w',
    at: 5,
  })
  assert.equal(await b.launchFor('term_none'), null)
  assert.equal((await b.workers()).length, 1)
  assert.ok(storage.data.has('tracker.v1'))
})

test('setRunId updates a tracked orchestrator', async () => {
  const storage = memoryStorage()
  const t = createTracker(storage)
  await t.recordOrchestrator(orch)
  await t.setRunId('term_orch', 'run_1')
  assert.equal(
    (await createTracker(storage).orchestratorByTerminal('term_orch'))?.runId,
    'run_1',
  )
})

test('recording an orchestrator or worker again replaces it', async () => {
  const t = createTracker(memoryStorage())
  await t.recordOrchestrator(orch)
  await t.recordOrchestrator({ ...orch, model: 'other' })
  assert.deepEqual(
    (await t.orchestrators()).map((o) => o.model),
    ['other'],
  )
  const w = {
    terminalId: 'term_w',
    workspaceId: null,
    agent: 'claude',
    project: 'demo',
    orchestratorTerminalId: 'term_orch',
    taskId: null,
  }
  await t.recordWorker(w)
  await t.recordWorker({ ...w, taskId: 'task_2' })
  assert.deepEqual(
    (await t.workers()).map((x) => x.taskId),
    ['task_2'],
  )
})

test('launch records keep only the newest 200', async () => {
  const storage = memoryStorage()
  const t = createTracker(storage)
  for (let i = 0; i < 205; i++) {
    await t.recordLaunch({
      terminalId: `term_${i}`,
      workspaceId: null,
      agent: 'claude',
      model: null,
      bypass: [],
      at: i,
    })
  }
  const fresh = createTracker(storage)
  assert.equal(await fresh.launchFor('term_4'), null)
  assert.equal((await fresh.launchFor('term_5'))?.at, 5)
  assert.equal((await fresh.launchFor('term_204'))?.at, 204)
  assert.equal((await fresh.launches()).length, 200)
})

test('concurrent writes are not lost', async () => {
  const t = createTracker(memoryStorage())
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      t.recordLaunch({
        terminalId: `term_${i}`,
        workspaceId: null,
        agent: 'claude',
        model: null,
        bypass: [],
        at: i,
      }),
    ),
  )
  assert.equal((await t.launches()).length, 10)
})

test('ownerOfWorkspace finds the orchestrator of a worker workspace', async () => {
  const t = createTracker(memoryStorage())
  await t.recordOrchestrator(orch)
  await t.recordWorker({
    terminalId: 'term_w',
    workspaceId: 'r::/w',
    agent: 'codex',
    project: 'demo',
    orchestratorTerminalId: 'term_orch',
    taskId: null,
  })
  assert.equal(await t.ownerOfWorkspace('r::/w'), 'term_orch')
  // Every orchestrator shares the global hub, so the hub has no single owner,
  // even when a `current` Worker runs there.
  await t.recordWorker({
    terminalId: 'term_cur',
    workspaceId: orch.workspaceId,
    agent: 'claude',
    project: 'demo',
    orchestratorTerminalId: 'term_orch',
    taskId: null,
  })
  assert.equal(await t.ownerOfWorkspace(orch.workspaceId), null)
  assert.equal(await t.ownerOfWorkspace('r::/other'), null)
})

test('bad stored data reads as empty', async () => {
  const storage = memoryStorage()
  await storage.set('tracker.v1', 'garbage')
  const t = createTracker(storage)
  assert.deepEqual(await t.orchestrators(), [])
  assert.deepEqual(await t.workers(), [])
  assert.equal(await t.launchFor('x'), null)
})

test('old launch records that kept the command are dropped', async () => {
  const storage = memoryStorage()
  await storage.set('tracker.v1', {
    orchestrators: [orch],
    workers: [],
    launches: [
      {
        terminalId: 'term_old',
        workspaceId: null,
        agent: 'claude',
        command: "claude 'a secret prompt'",
        at: 1,
      },
      {
        terminalId: 'term_new',
        workspaceId: null,
        agent: 'claude',
        model: 'm',
        bypass: [],
        at: 2,
      },
    ],
  })
  const t = createTracker(storage)
  assert.equal(await t.launchFor('term_old'), null)
  await t.migrate()
  const raw = JSON.stringify(storage.data.get('tracker.v1'))
  assert.ok(!raw.includes('secret'))
  assert.ok(!raw.includes('command'))
  assert.equal((await t.launchFor('term_new'))?.model, 'm')
  assert.deepEqual(await t.orchestrators(), [orch])
})

test('launch records keep no command text', async () => {
  const storage = memoryStorage()
  const t = createTracker(storage)
  await t.recordLaunch({
    terminalId: 'term_x',
    workspaceId: null,
    agent: 'claude',
    model: 'm',
    bypass: [],
    at: 1,
    // A caller passing extra fields must not get them stored.
    ...({ command: "claude 'prompt text'" } as object),
  })
  assert.ok(!JSON.stringify(storage.data.get('tracker.v1')).includes('prompt'))
})

test('B3: root ownership follows at most three Worker links and rejects cycles', async () => {
  const t = createTracker(memoryStorage())
  await t.recordOrchestrator(orch)
  const worker = (terminalId: string, parent: string) => ({
    terminalId,
    workspaceId: null,
    agent: 'claude',
    project: 'demo',
    orchestratorTerminalId: parent,
    taskId: null,
  })
  await t.recordWorker(worker('one', orch.terminalId))
  await t.recordWorker(worker('two', 'one'))
  await t.recordWorker(worker('three', 'two'))
  await t.recordWorker(worker('four', 'three'))
  assert.deepEqual(await t.rootOrchestrator('three'), orch)
  assert.equal(await t.rootOrchestrator('four'), null)
  await t.recordWorker(worker('one', 'two'))
  assert.equal(await t.rootOrchestrator('one'), null)
})
