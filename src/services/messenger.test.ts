import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { OrcaCli } from '../adapters/orca-cli'
import { createMessenger } from './messenger'
import { createTracker } from './tracker'

const HUB = 'hub::/Users/m/projects'
const ORCH = 'term_orch'

function fakeCli(
  opts: { runId?: string | null; failSends?: number; hang?: boolean } = {},
) {
  const sent: {
    fromTerminalId: string
    runId: string
    subject: string
    body: string
  }[] = []
  const typed: [string, string, boolean][] = []
  const finds: string[] = []
  let failures = opts.failSends ?? 0
  const cli = {
    async findRunId(t: string) {
      finds.push(t)
      return opts.runId ?? null
    },
    async sendOrchestrationMessage(m: (typeof sent)[number]) {
      if (failures > 0) {
        failures--
        throw new Error('send failed')
      }
      sent.push(m)
      // Orca delivered it, but the worker is killed before it can settle.
      if (opts.hang) await new Promise(() => {})
    },
    async sendTerminalText(t: string, text: string, enter: boolean) {
      typed.push([t, text, enter])
    },
  } as unknown as OrcaCli
  return { cli, sent, typed, finds }
}

async function setup(
  opts: {
    runId?: string | null
    storedRunId?: string | null
    tracked?: boolean
    readFails?: boolean
    failSends?: number
    failOutboxWrites?: number
    hang?: boolean
    storage?: Record<string, never>
  } = {},
) {
  let created = 0
  const host = mockHost({
    storage: opts.storage ?? {},
    results: {
      'terminal.create': () => ({ terminalId: `term_unifier_${++created}` }),
      'terminal.read': () => {
        if (opts.readFails) throw hostError('invalid_params', 'no terminal')
        return { lines: [], truncated: false }
      },
    },
  })
  let orca: OrcaWorkerApi | null = null
  const worker = await mountWorker(
    {
      default: (o) => {
        orca = o
      },
    },
    { host },
  )
  const api = orca as unknown as OrcaWorkerApi
  const tracker = createTracker(api.storage)
  if (opts.tracked !== false) {
    await tracker.recordOrchestrator({
      project: 'demo',
      workspaceId: HUB,
      terminalId: ORCH,
      agent: 'claude',
      model: 'claude-opus-5-5',
      runId: opts.storedRunId ?? null,
    })
  }
  const fake = fakeCli({
    runId: opts.runId,
    failSends: opts.failSends,
    hang: opts.hang,
  })
  let failedWrites = opts.failOutboxWrites ?? 0
  const make = (now: () => number = Date.now) =>
    createMessenger(
      {
        ...api,
        storage: {
          ...api.storage,
          async set(key, value) {
            if (key === 'messenger.v1' && failedWrites > 0) {
              failedWrites--
              throw new Error('outbox write failed')
            }
            return api.storage.set(key, value)
          },
        },
      },
      {
        tracker,
        cli: fake.cli,
        globalHubWorkspaceId: async () => HUB,
        now,
      },
    )
  return { worker, host, api, tracker, make, ...fake }
}

test('sends through a unifier terminal created lazily in the global hub', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  const m = s.make()
  assert.equal(s.host.callsOf('terminal.create').length, 0)
  await m.toOrchestrator(ORCH, 'Subject', 'Body text')
  assert.deepEqual(s.host.callsOf('terminal.create'), [
    { workspaceId: HUB, title: 'unifier' },
  ])
  assert.deepEqual(s.sent, [
    {
      fromTerminalId: 'term_unifier_1',
      runId: 'run_1',
      subject: 'Subject',
      body: 'Body text',
    },
  ])
  assert.deepEqual(s.finds, [])
  const stored = s.host.data().storage['messenger.v1'] as {
    terminalId: string
  }
  assert.equal(stored.terminalId, 'term_unifier_1')
  await s.worker.deactivate()
})

test('reuses the stored terminal while it exists', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  await s.make().toOrchestrator(ORCH, 'a', 'b')
  await s.make().toOrchestrator(ORCH, 'c', 'd')
  assert.equal(s.host.callsOf('terminal.create').length, 1)
  assert.deepEqual(
    s.sent.map((m) => m.fromTerminalId),
    ['term_unifier_1', 'term_unifier_1'],
  )
  await s.worker.deactivate()
})

test('recreates the terminal when the stored one is gone', async () => {
  const s = await setup({
    storedRunId: 'run_1',
    readFails: true,
    storage: {
      'messenger.v1': { terminalId: 'term_old', outbox: [] },
    } as never,
  })
  await s.make().toOrchestrator(ORCH, 'a', 'b')
  assert.equal(s.host.callsOf('terminal.create').length, 1)
  assert.equal(s.sent[0]?.fromTerminalId, 'term_unifier_1')
  await s.worker.deactivate()
})

test('finds the run id once and caches it on the orchestrator', async () => {
  const s = await setup({ runId: 'run_9' })
  await s.make().toOrchestrator(ORCH, 'a', 'b')
  await s.make().toOrchestrator(ORCH, 'c', 'd')
  assert.deepEqual(s.finds, [ORCH])
  assert.equal((await s.tracker.orchestratorByTerminal(ORCH))?.runId, 'run_9')
  assert.deepEqual(
    s.sent.map((m) => m.runId),
    ['run_9', 'run_9'],
  )
  await s.worker.deactivate()
})

test('types into the orchestrator terminal when no run exists yet', async () => {
  const s = await setup({ runId: null })
  await s.make().toOrchestrator(ORCH, '[unifier] Subject', 'Line one\nline two')
  assert.deepEqual(s.typed, [
    [ORCH, '[unifier] Subject: Line one line two', true],
  ])
  assert.equal(s.sent.length, 0)
  assert.equal(s.host.callsOf('terminal.create').length, 0)
  await s.worker.deactivate()
})

test('never messages an untracked terminal', async () => {
  const s = await setup({ tracked: false, runId: 'run_x' })
  await s.make().toOrchestrator('term_alpha', 'a', 'b')
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.deepEqual(s.finds, [])
  assert.equal(s.host.callsOf('terminal.create').length, 0)
  await s.worker.deactivate()
})

test('a failed outbox write rejects the caller and can be retried', async () => {
  const s = await setup({ storedRunId: 'run_1', failOutboxWrites: 1 })
  const m = s.make()
  await assert.rejects(
    () => m.toOrchestrator(ORCH, 'a', 'b'),
    /outbox write failed/,
  )
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.equal(s.host.data().storage['messenger.v1'], undefined)
  await m.toOrchestrator(ORCH, 'a', 'b')
  assert.deepEqual(s.sent, [
    {
      fromTerminalId: 'term_unifier_1',
      runId: 'run_1',
      subject: 'a',
      body: 'b',
    },
  ])
  await s.worker.deactivate()
})

test('a delivery failure resolves the caller and stays queued for the next flush', async () => {
  const s = await setup({ storedRunId: 'run_1', failSends: 1 })
  await s.make().toOrchestrator(ORCH, 'a', 'b')
  assert.equal(s.sent.length, 0)
  const stored = s.host.data().storage['messenger.v1'] as {
    outbox: {
      to: string
      subject: string
      body: string
      attempts: number
      inFlightAt: number | null
    }[]
  }
  assert.deepEqual(
    stored.outbox.map((p) => [
      p.to,
      p.subject,
      p.body,
      p.attempts,
      p.inFlightAt,
    ]),
    [[ORCH, 'a', 'b', 1, null]],
  )
  // A restarted worker flushes what the last one could not send.
  await s.make().flush()
  assert.equal(s.sent.length, 1)
  await s.make().flush()
  assert.equal(s.sent.length, 1)
  await s.worker.deactivate()
})

test('a message that keeps failing is dropped after three tries', async () => {
  const s = await setup({ storedRunId: 'run_1', failSends: 5 })
  const m = s.make()
  await m.toOrchestrator(ORCH, 'a', 'b')
  await m.flush()
  await m.flush()
  await m.flush()
  const stored = s.host.data().storage['messenger.v1'] as { outbox: unknown[] }
  assert.deepEqual(stored.outbox, [])
  assert.ok(s.worker.logs.some((l) => l.includes('dropped')))
  await s.worker.deactivate()
})

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

test('a send killed after delivery is retried at most three times in all', async () => {
  const s = await setup({ storedRunId: 'run_1', hang: true })
  let t = 1_000_000
  // Each make() is a fresh worker after a restart; the old one never settles.
  void s.make(() => t).toOrchestrator(ORCH, 'a', 'b')
  await settle()
  for (let i = 0; i < 6; i++) {
    t += 20_000
    void s.make(() => t).flush()
    await settle()
  }
  assert.equal(s.sent.length, 3)
  const stored = s.host.data().storage['messenger.v1'] as { outbox: unknown[] }
  assert.deepEqual(stored.outbox, [])
  await s.worker.deactivate()
})

test('a flush skips a message another worker is sending right now', async () => {
  const s = await setup({ storedRunId: 'run_1', hang: true })
  let t = 1_000_000
  void s.make(() => t).toOrchestrator(ORCH, 'a', 'b')
  await settle()
  t += 5_000
  void s.make(() => t).flush()
  await settle()
  assert.equal(s.sent.length, 1)
  await s.worker.deactivate()
})

test('consent failures saving a delivered message retry storage without sending again', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  const pending = new Set<() => void>()
  let failures = 0
  const m = createMessenger(
    {
      ...s.api,
      storage: {
        ...s.api.storage,
        async set(key, value) {
          if (
            key === 'messenger.v1' &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Array.isArray(value.outbox) &&
            value.outbox.length === 0 &&
            s.sent.length > 0 &&
            failures++ < 2
          )
            throw hostError('consent_required', 'Consent is being applied')
          return s.api.storage.set(key, value)
        },
      },
    },
    {
      tracker: s.tracker,
      cli: s.cli,
      globalHubWorkspaceId: async () => HUB,
      now: () => 100_000,
      schedule: (fn) => {
        pending.add(fn)
        return () => pending.delete(fn)
      },
    },
  )
  try {
    await m.toOrchestrator(ORCH, 'Subject', 'Body')
    assert.equal(s.sent.length, 1)
    for (let i = 0; i < 2; i++) {
      assert.equal(pending.size, 1)
      const callbacks = [...pending]
      pending.clear()
      for (const fn of callbacks) fn()
      await settle(1)
      assert.equal(s.sent.length, 1)
    }
    assert.deepEqual(
      ((await s.api.storage.get('messenger.v1')) as { outbox: unknown[] })
        .outbox,
      [],
    )
  } finally {
    m.dispose()
    await s.worker.deactivate()
  }
})

test('consent recovery retries a delivery even when its rollback was rejected', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  const pending = new Set<() => void>()
  let rejected = false
  const error = hostError('consent_required', 'Consent is being applied')
  s.host.respond('terminal.create', () => {
    if (!rejected) {
      rejected = true
      throw error
    }
    return { terminalId: 'sender' }
  })
  let rollbackFailed = false
  const m = createMessenger(
    {
      ...s.api,
      storage: {
        ...s.api.storage,
        async set(key, value) {
          if (key === 'messenger.v1' && rejected && !rollbackFailed) {
            rollbackFailed = true
            throw error
          }
          return s.api.storage.set(key, value)
        },
      },
    },
    {
      tracker: s.tracker,
      cli: s.cli,
      globalHubWorkspaceId: async () => HUB,
      now: () => 100_000,
      schedule: (fn) => {
        pending.add(fn)
        return () => pending.delete(fn)
      },
    },
  )
  try {
    await m.toOrchestrator(ORCH, 'Subject', 'Body')
    assert.equal(s.sent.length, 0)
    assert.equal(pending.size, 1)
    const callbacks = [...pending]
    pending.clear()
    for (const fn of callbacks) fn()
    await settle(1)
    assert.equal(s.sent.length, 1)
    assert.deepEqual(
      ((await s.api.storage.get('messenger.v1')) as { outbox: unknown[] })
        .outbox,
      [],
    )
  } finally {
    m.dispose()
    await s.worker.deactivate()
  }
})

test('enqueue stores the message without sending it', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  const m = s.make()
  await m.enqueue(ORCH, 'a', 'b')
  assert.equal(s.sent.length, 0)
  const stored = s.host.data().storage['messenger.v1'] as {
    outbox: { to: string; subject: string; body: string }[]
  }
  assert.deepEqual(
    stored.outbox.map((x) => [x.to, x.subject, x.body]),
    [[ORCH, 'a', 'b']],
  )
  await m.flush()
  assert.equal(s.sent.length, 1)
  await s.worker.deactivate()
})

const LEGACY_SUBJECT = '[unifier] Worker launched with the wrong settings'
const LEGACY_MODEL_BODY = [
  'Worker terminal term_w (task task_1, codex) launched with the wrong settings:',
  '- It was started with --model old (expected gpt-6.1-sol).',
  'Stop it (orca orchestration worker-stop --dispatch ctx_1) and relaunch with worker-start --model gpt-6.1-sol.',
].join('\n')

test('flush drops persisted model-only launch notices before any send', async () => {
  const s = await setup({
    storedRunId: 'run_1',
    storage: {
      'messenger.v1': {
        terminalId: null,
        outbox: [
          {
            id: 'old-model',
            to: ORCH,
            subject: LEGACY_SUBJECT,
            body: LEGACY_MODEL_BODY,
            attempts: 0,
            inFlightAt: null,
          },
        ],
      },
    } as never,
  })
  await s.make().flush()
  assert.deepEqual(s.sent, [])
  assert.deepEqual(s.typed, [])
  assert.equal(s.host.callsOf('terminal.create').length, 0)
  assert.deepEqual(
    (s.host.data().storage['messenger.v1'] as { outbox: unknown[] }).outbox,
    [],
  )
  await s.worker.deactivate()
})

test('flush retains bypass advice from a combined legacy launch notice', async () => {
  const body = `${LEGACY_MODEL_BODY}\n- It was started with --approve-for-me, which skips approvals or the sandbox.\nThe bypass flag comes from Orca's Codex permission setting, not from worker-start, so a relaunch keeps it. Do not relaunch the Worker for this alone. Raise it once with the user as a Decision.`
  const s = await setup({
    storedRunId: 'run_1',
    storage: {
      'messenger.v1': {
        terminalId: null,
        outbox: [
          {
            id: 'combined',
            to: ORCH,
            subject: LEGACY_SUBJECT,
            body,
            attempts: 0,
            inFlightAt: null,
          },
        ],
      },
    } as never,
  })
  await s.make().flush()
  assert.equal(s.sent.length, 1)
  assert.match(s.sent[0]?.body ?? '', /--approve-for-me/)
  assert.match(s.sent[0]?.body ?? '', /Decision/)
  assert.ok(!s.sent[0]?.body.includes('--model'))
  assert.ok(!s.sent[0]?.body.includes('worker-stop'))
  await s.worker.deactivate()
})

test('D2: enqueue persists while CLI delivery is still pending', async () => {
  const s = await setup({ storedRunId: 'run_1' })
  let release!: () => void
  let started!: () => void
  const delivering = new Promise<void>((resolve) => {
    started = resolve
  })
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  s.cli.sendOrchestrationMessage = async () => {
    started()
    await slow
  }
  const m = s.make()
  await m.enqueue(ORCH, 'first', 'first body')
  const flush = m.flush()
  await delivering
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const quick = await Promise.race([
      m.enqueue(ORCH, 'second', 'second body').then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 100)
      }),
    ])
    assert.equal(quick, true, 'enqueue must not wait for CLI delivery')
    const outbox = (await s.api.storage.get('messenger.v1')) as {
      outbox: { subject: string }[]
    }
    assert.deepEqual(
      outbox.outbox.map((x) => x.subject),
      ['first', 'second'],
    )
  } finally {
    clearTimeout(timer)
    release()
    await flush
    m.dispose()
    await s.worker.deactivate()
  }
})
