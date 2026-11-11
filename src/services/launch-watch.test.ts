import { readFileSync } from 'node:fs'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi, PluginHooks } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { OrcaCli } from '../adapters/orca-cli'
import * as main from '../worker'
import { createTracker } from './tracker'

type LaunchEvent = PluginHooks['agent.launch.before']['event']
type PromptEvent = PluginHooks['agent.prompt.before']['event']

function fixture<T>(name: string): T {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        `../../test/fixtures/launch-events/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { event: T }
  return raw.event
}

const COORD = 'term_00000000-0000-4000-8000-000000000104'
const HUB = 'hub::/Users/m/projects'

function fakeCli(hang = false) {
  const sent: {
    fromTerminalId: string
    runId: string
    subject: string
    body: string
  }[] = []
  const typed: [string, string, boolean][] = []
  const cli = {
    async worktreeSummaries() {
      return { summaries: [], truncated: false }
    },
    async listWorktrees() {
      return []
    },
    async ensureFolderWorkspace() {
      return HUB
    },
    async findRunId() {
      return 'run_1'
    },
    async sendOrchestrationMessage(m: (typeof sent)[number]) {
      if (hang) await new Promise(() => {})
      sent.push(m)
    },
    async sendTerminalText(t: string, text: string, enter: boolean) {
      typed.push([t, text, enter])
    },
  } as unknown as OrcaCli
  return { cli, sent, typed }
}

async function setup(
  opts: {
    tracked?: boolean
    cli?: OrcaCli
    exec?: Exec
    now?: () => number
    hang?: boolean
    failOutboxWrites?: boolean
  } = {},
) {
  const fake = fakeCli(opts.hang)
  const host = mockHost({
    settings: { projectsRoot: '/Users/m/projects' },
    results: {
      'terminal.create': { terminalId: 'term_unifier' },
      'terminal.read': { lines: [], truncated: false },
    },
  })
  let api: OrcaWorkerApi | null = null
  const worker = await mountWorker(
    {
      default: (orca) => {
        api = {
          ...orca,
          storage: {
            ...orca.storage,
            async set(key, value) {
              if (key === 'messenger.v1' && opts.failOutboxWrites)
                throw new Error('outbox write failed')
              return orca.storage.set(key, value)
            },
          },
        }
        main.activateWith(api, {
          ...(opts.exec ? { exec: opts.exec } : { cli: opts.cli ?? fake.cli }),
          now: opts.now,
        })
      },
    },
    { host },
  )
  const tracker = createTracker((api as unknown as OrcaWorkerApi).storage)
  if (opts.tracked !== false) {
    await tracker.recordOrchestrator({
      project: 'demo',
      workspaceId: HUB,
      terminalId: COORD,
      agent: 'claude',
      model: 'claude-opus-5-5',
      runId: 'run_1',
    })
  }
  return { worker, host, tracker, ...fake }
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
}

const MARKER = '<!-- unifier:worker-brief v1 -->'

/** The hook continued with the prompt plus the Worker brief, nothing else changed. */
function assertBriefed(d: unknown, prompt: PromptEvent): void {
  const out = d as { kind: string; event: PromptEvent }
  assert.equal(out.kind, 'continue')
  assert.deepEqual({ ...out.event, prompt: '' }, { ...prompt, prompt: '' })
  assert.ok(out.event.prompt.startsWith(prompt.prompt))
  assert.equal(out.event.prompt.split(MARKER).length, 2)
  assert.ok(out.event.prompt.includes('# Worker brief'))
  assert.ok(out.event.prompt.includes('Report format'))
}

test('a tracked worker launched wrong is recorded and its orchestrator told once', async () => {
  const s = await setup()
  const launch = fixture<LaunchEvent>('worker-start-codex-launch')
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')

  const d1 = await s.worker.hooks.fire('agent.launch.before', launch)
  assert.deepEqual(d1, { kind: 'continue', event: launch })
  const d2 = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assertBriefed(d2, prompt)

  await waitFor(() => s.sent.length > 0)
  await settle()
  assert.equal(s.sent.length, 1)
  const m = s.sent[0]
  assert.equal(m?.runId, 'run_1')
  assert.equal(m?.fromTerminalId, 'term_unifier')
  assert.equal(m?.subject, '[unifier] Worker launched with the wrong settings')
  assert.ok(m?.body.includes(prompt.terminalId))
  assert.ok(m?.body.includes('--approve-for-me'))
  assert.ok(!m?.body.includes('worker-start --model'))
  assert.ok(!m?.body.includes('worker-stop'))
  assert.match(m?.body ?? '', /permission setting/)
  assert.match(m?.body ?? '', /Decision/)
  assert.equal(s.typed.length, 0)

  assert.deepEqual(await s.tracker.workers(), [
    {
      terminalId: prompt.terminalId,
      workspaceId: launch.workspaceId,
      agent: 'codex',
      model: null,
      project: 'demo',
      orchestratorTerminalId: COORD,
      taskId: 'task_000000000004',
    },
  ])
  await s.worker.deactivate()
})

test('a tracked worker launched right is recorded and nothing is sent', async () => {
  const s = await setup()
  const base = fixture<LaunchEvent>('worker-start-claude-launch')
  const launch = {
    ...base,
    command:
      "claude '--dangerously-skip-permissions' '--model' 'claude-opus-4-8'",
  }
  const prompt = fixture<PromptEvent>('worker-start-claude-dispatch-prompt')
  await s.worker.hooks.fire('agent.launch.before', launch)
  const d = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assertBriefed(d, prompt)
  await settle()
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.equal((await s.tracker.workers()).length, 1)
  await s.worker.deactivate()
})

test('an untracked coordinator is ignored entirely', async () => {
  const s = await setup({ tracked: false })
  const launch = fixture<LaunchEvent>('worker-start-codex-launch')
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')
  const d1 = await s.worker.hooks.fire('agent.launch.before', launch)
  const d2 = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assert.deepEqual(d1, { kind: 'continue', event: launch })
  assert.deepEqual(d2, { kind: 'continue', event: prompt })
  await settle()
  assert.deepEqual(await s.tracker.workers(), [])
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.equal(s.host.callsOf('terminal.create').length, 0)
  await s.worker.deactivate()
})

test('driving prompts pass unchanged and record nothing', async () => {
  const s = await setup()
  for (const name of [
    'terminal-send-prompt-coordinator',
    'terminal-send-prompt-claude',
  ]) {
    const e = fixture<PromptEvent>(name)
    assert.deepEqual(await s.worker.hooks.fire('agent.prompt.before', e), {
      kind: 'continue',
      event: e,
    })
  }
  await settle()
  assert.deepEqual(await s.tracker.workers(), [])
  assert.equal(s.sent.length, 0)
  await s.worker.deactivate()
})

test('every launch is recorded by terminal and passes unchanged', async () => {
  const s = await setup({ tracked: false })
  for (const name of [
    'plugin-agent-launch-claude',
    'plugin-agent-launch-codex',
    'orchestrator-launch-folder-workspace',
  ]) {
    const e = fixture<LaunchEvent>(name)
    assert.deepEqual(await s.worker.hooks.fire('agent.launch.before', e), {
      kind: 'continue',
      event: e,
    })
    const rec = await s.tracker.launchFor(e.terminalId ?? '')
    assert.equal(rec?.agent, e.agent)
    assert.equal(rec?.workspaceId, e.workspaceId)
  }
  await s.worker.deactivate()
})

test('a launch with no terminal id passes and records nothing', async () => {
  const s = await setup({ tracked: false })
  const { terminalId: _, ...rest } = fixture<LaunchEvent>(
    'plugin-agent-launch-claude',
  )
  const d = await s.worker.hooks.fire('agent.launch.before', rest)
  assert.deepEqual(d, { kind: 'continue', event: rest })
  assert.deepEqual(await s.tracker.launches(), [])
  await s.worker.deactivate()
})

test('the launch hook never runs a child process', async () => {
  const calls: string[][] = []
  const exec: Exec = async (_file, args) => {
    calls.push(args)
    return { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '' }
  }
  const s = await setup({ exec, tracked: false })
  await s.worker.hooks.fire(
    'agent.launch.before',
    fixture<LaunchEvent>('worker-start-codex-launch'),
  )
  await settle()
  assert.deepEqual(calls, [])
  await s.worker.deactivate()
})

test('a dispatch with no recorded launch records the worker and sends nothing', async () => {
  const s = await setup()
  const prompt = fixture<PromptEvent>('worker-start-current-dispatch-prompt')
  const d = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assertBriefed(d, prompt)
  await settle()
  assert.equal(s.sent.length, 0)
  const w = await s.tracker.workers()
  assert.equal(w.length, 1)
  assert.equal(w[0]?.agent, 'claude')
  assert.equal(w[0]?.workspaceId, null)
  await s.worker.deactivate()
})

/** The codex worker-start launch and dispatch, as another worker terminal. */
function codexWorker(terminalId: string, command?: string) {
  const launch = fixture<LaunchEvent>('worker-start-codex-launch')
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')
  return {
    launch: { ...launch, terminalId, command: command ?? launch.command },
    prompt: { ...prompt, terminalId },
  }
}

async function dispatch(
  s: Awaited<ReturnType<typeof setup>>,
  w: { launch: LaunchEvent; prompt: PromptEvent },
) {
  await s.worker.hooks.fire('agent.launch.before', w.launch)
  await s.worker.hooks.fire('agent.prompt.before', w.prompt)
  await settle()
}

test('a bypass flag alone asks for a Decision, not a relaunch', async () => {
  const s = await setup()
  await dispatch(
    s,
    codexWorker('term_w1', "codex '--approve-for-me' '--model' 'gpt-6.1-sol'"),
  )
  assert.equal(s.sent.length, 1)
  const body = s.sent[0]?.body ?? ''
  assert.match(body, /--approve-for-me/)
  assert.match(body, /Codex permission setting/)
  assert.match(body, /Do not relaunch/)
  assert.match(body, /Decision/)
  assert.ok(!body.includes('relaunch with worker-start'))
  await s.worker.deactivate()
})

test('an actual model outside defaults is recorded without sending a model message', async () => {
  const s = await setup()
  await dispatch(s, {
    launch: fixture<LaunchEvent>('worker-start-claude-launch'),
    prompt: fixture<PromptEvent>('worker-start-claude-dispatch-prompt'),
  })
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.equal((await s.tracker.workers())[0]?.model, 'claude-haiku-5-5')
  await s.worker.deactivate()
})

const BYPASS_ONLY = "codex '--approve-for-me' '--model' 'gpt-6.1-sol'"
const MODEL_ONLY = "codex '--model' 'gpt-5'"

test('bypass flags are reported once per orchestrator a day', async () => {
  let t = 1_000_000_000
  const s = await setup({ now: () => t })
  await dispatch(s, codexWorker('term_w1', BYPASS_ONLY))
  assert.equal(s.sent.length, 1)
  t += 60 * 60 * 1000
  await dispatch(s, codexWorker('term_w2', BYPASS_ONLY))
  assert.equal(s.sent.length, 1)
  // A day later the same flag is reported again.
  t += 24 * 60 * 60 * 1000
  await dispatch(s, codexWorker('term_w3', BYPASS_ONLY))
  assert.equal(s.sent.length, 2)
  assert.equal((await s.tracker.workers()).length, 3)
  await s.worker.deactivate()
})

test('model differences never send notices or leave model dedupe marks', async () => {
  const s = await setup()
  await dispatch(s, codexWorker('term_w1', MODEL_ONLY))
  await dispatch(s, codexWorker('term_w2', MODEL_ONLY))
  assert.equal(s.sent.length, 0)
  await dispatch(s, codexWorker('term_w3'))
  await dispatch(s, codexWorker('term_w4'))
  assert.equal(s.sent.length, 1)
  assert.ok(!s.sent[0]?.body.includes('--model'))
  const marks = s.host.data().storage['launch-watch.v1'] as {
    notified: Record<string, number>
  }
  assert.deepEqual(Object.keys(marks.notified), [`${COORD}|bypass`])
  await s.worker.deactivate()
})

test('the message is queued in storage before the prompt hook returns', async () => {
  const s = await setup({ hang: true })
  const w = codexWorker('term_w1')
  await s.worker.hooks.fire('agent.launch.before', w.launch)
  await s.worker.hooks.fire('agent.prompt.before', w.prompt)
  const stored = s.host.data().storage['messenger.v1'] as {
    outbox: { to: string }[]
  } | null
  assert.deepEqual(
    stored?.outbox.map((x) => x.to),
    [COORD],
  )
  await s.worker.deactivate()
})

test('no launch command or prompt text is stored', async () => {
  const s = await setup()
  await s.worker.hooks.fire(
    'agent.launch.before',
    fixture<LaunchEvent>('orchestrator-launch-folder-workspace'),
  )
  await dispatch(s, codexWorker('term_w1'))
  const raw = JSON.stringify(s.host.data().storage)
  assert.ok(!raw.includes('test coordinator'))
  assert.ok(!raw.includes('dispatched worker'))
  assert.ok(!raw.includes('"command"'))
  await s.worker.deactivate()
})

test('a tracked worker prompt that already has the brief passes unchanged', async () => {
  const s = await setup()
  const base = fixture<PromptEvent>('worker-start-claude-dispatch-prompt')
  const prompt = {
    ...base,
    prompt: `${base.prompt}\n\n${MARKER}\nAlready here.`,
  }
  const d = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assert.deepEqual(d, { kind: 'continue', event: prompt })
  await s.worker.deactivate()
})

test('the brief is appended for a tracked worker even when its check fails', async () => {
  const s = await setup()
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')
  // No recorded launch: nothing to verify, but it is still a tracked Worker.
  const d = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assertBriefed(d, prompt)
  await s.worker.deactivate()
})

test('an outbox write failure is caught and logged inside the prompt hook', async () => {
  const s = await setup({ failOutboxWrites: true })
  const launch = fixture<LaunchEvent>('worker-start-codex-launch')
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')
  await s.worker.hooks.fire('agent.launch.before', launch)
  const result = await s.worker.hooks.fire('agent.prompt.before', prompt)
  assertBriefed(result, prompt)
  assert.ok(
    s.worker.logs.some((line) =>
      line.includes('could not check a worker: Error: outbox write failed'),
    ),
  )
  assert.equal(s.sent.length, 0)
  assert.equal(s.typed.length, 0)
  assert.equal(s.host.data().storage['messenger.v1'], undefined)
  await s.worker.deactivate()
})

test('B3: foreman descendants are briefed and owned by the root Orchestrator', async () => {
  const s = await setup()
  await s.tracker.recordWorker({
    terminalId: 'term_foreman',
    workspaceId: 'repo::/foreman',
    agent: 'claude',
    model: 'm',
    project: 'demo',
    orchestratorTerminalId: COORD,
    taskId: 'foreman',
  })
  const launch = fixture<LaunchEvent>('worker-start-codex-launch')
  const prompt = fixture<PromptEvent>('worker-start-codex-dispatch-prompt')
  const descendant = {
    ...prompt,
    prompt: prompt.prompt.replace(COORD, 'term_foreman'),
  }
  await s.worker.hooks.fire('agent.launch.before', launch)
  assertBriefed(
    await s.worker.hooks.fire('agent.prompt.before', descendant),
    descendant,
  )
  const child = (await s.tracker.workers()).find(
    (w) => w.terminalId === prompt.terminalId,
  )
  assert.equal(child?.orchestratorTerminalId, COORD)
  assert.equal(child?.agent, 'codex')
  await waitFor(() => s.sent.length > 0)
  assert.equal(s.sent[0]?.runId, 'run_1')
  await s.worker.deactivate()
})
