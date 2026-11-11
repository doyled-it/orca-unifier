import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import {
  bypassFlags,
  checkWorkerLaunch,
  modelFlag,
  parseDispatchPrompt,
  parseLaunch,
} from './launch-policy'

type FixtureEvent = { command?: string; prompt?: string; agent: string | null }

function fixture(name: string): FixtureEvent {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        `../../test/fixtures/launch-events/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { event: FixtureEvent }
  return raw.event
}

test('modelFlag reads --model with a separate value', () => {
  assert.equal(
    modelFlag('claude', "claude '--model' 'claude-opus-4-8'"),
    'claude-opus-4-8',
  )
  assert.equal(
    modelFlag('codex', "codex '--model' 'gpt-6.1-sol'"),
    'gpt-6.1-sol',
  )
})

test('modelFlag reads --model=x', () => {
  assert.equal(
    modelFlag('claude', "claude '--model=claude-opus-4-8'"),
    'claude-opus-4-8',
  )
})

test('modelFlag reads codex -m x and -mx', () => {
  assert.equal(modelFlag('codex', "codex '-m' 'gpt-6.1-sol'"), 'gpt-6.1-sol')
  assert.equal(modelFlag('codex', "codex '-mgpt-6.1-sol'"), 'gpt-6.1-sol')
})

test('modelFlag does not read -m for claude', () => {
  assert.equal(modelFlag('claude', "claude '-m' 'x'"), null)
})

test('modelFlag ignores anything after a bare --', () => {
  assert.equal(modelFlag('claude', "claude '--' '--model' 'x'"), null)
  assert.equal(modelFlag('codex', 'codex -- -m x'), null)
  assert.equal(
    modelFlag('claude', "claude '--model' 'a' '--' '--model' 'b'"),
    'a',
  )
})

test('modelFlag does not read a flag inside a quoted prompt', () => {
  assert.equal(
    modelFlag(
      'claude',
      "claude '--dangerously-skip-permissions' 'run worker-start --model x'",
    ),
    null,
  )
})

test('modelFlag does not read the value of codex -c as a flag', () => {
  assert.equal(
    modelFlag('codex', "codex '-c' '-mbad' '--approve-for-me'"),
    null,
  )
})

test('modelFlag handles an escaped single quote and unquoted words', () => {
  assert.equal(
    modelFlag('claude', "claude --model claude-opus-4-8 'it'\\''s a prompt'"),
    'claude-opus-4-8',
  )
})

test('modelFlag reads the real fixture command shapes', () => {
  assert.equal(
    modelFlag('claude', fixture('worker-start-claude-launch').command ?? ''),
    'claude-haiku-5-5',
  )
  assert.equal(
    modelFlag(
      'claude',
      fixture('cli-agent-launch-claude-model-prompt').command ?? '',
    ),
    'claude-haiku-5-5',
  )
  assert.equal(
    modelFlag(
      'claude',
      fixture('orchestrator-launch-folder-workspace').command ?? '',
    ),
    'claude-haiku-5-5',
  )
  assert.equal(
    modelFlag('claude', fixture('plugin-agent-launch-claude').command ?? ''),
    null,
  )
  assert.equal(
    modelFlag('codex', fixture('worker-start-codex-launch').command ?? ''),
    null,
  )
})

test('bypassFlags finds each bypass flag', () => {
  assert.deepEqual(
    bypassFlags('claude', "claude '--dangerously-skip-permissions'"),
    ['--dangerously-skip-permissions'],
  )
  assert.deepEqual(
    bypassFlags('codex', "codex '--dangerously-bypass-approvals-and-sandbox'"),
    ['--dangerously-bypass-approvals-and-sandbox'],
  )
  assert.deepEqual(
    bypassFlags('codex', "codex '--sandbox' 'danger-full-access'"),
    ['--sandbox danger-full-access'],
  )
  assert.deepEqual(
    bypassFlags('codex', "codex '--sandbox=danger-full-access'"),
    ['--sandbox=danger-full-access'],
  )
  assert.deepEqual(bypassFlags('codex', "codex '--approve-for-me'"), [
    '--approve-for-me',
  ])
  assert.deepEqual(
    bypassFlags('codex', "codex '--sandbox' 'workspace-write'"),
    [],
  )
  assert.deepEqual(bypassFlags('codex', "codex '--' '--approve-for-me'"), [])
})

test('bypassFlags on the codex fixture yields --approve-for-me', () => {
  assert.deepEqual(
    bypassFlags('codex', fixture('worker-start-codex-launch').command ?? ''),
    ['--approve-for-me'],
  )
})

test('parseDispatchPrompt reads the worker-start dispatch fixtures', () => {
  assert.deepEqual(
    parseDispatchPrompt(
      fixture('worker-start-claude-dispatch-prompt').prompt ?? '',
    ),
    {
      coordinatorTerminal: 'term_00000000-0000-4000-8000-000000000104',
      taskId: 'task_000000000006',
      dispatchId: 'ctx_000000000001',
    },
  )
  assert.deepEqual(
    parseDispatchPrompt(
      fixture('worker-start-codex-dispatch-prompt').prompt ?? '',
    ),
    {
      coordinatorTerminal: 'term_00000000-0000-4000-8000-000000000104',
      taskId: 'task_000000000004',
      dispatchId: 'ctx_000000000003',
    },
  )
  assert.deepEqual(
    parseDispatchPrompt(
      fixture('worker-start-current-dispatch-prompt').prompt ?? '',
    ),
    {
      coordinatorTerminal: 'term_00000000-0000-4000-8000-000000000104',
      taskId: 'task_000000000005',
      dispatchId: 'ctx_000000000002',
    },
  )
})

test('parseDispatchPrompt is null for driving and plain prompts', () => {
  assert.equal(
    parseDispatchPrompt(
      fixture('terminal-send-prompt-coordinator').prompt ?? '',
    ),
    null,
  )
  assert.equal(
    parseDispatchPrompt(fixture('terminal-send-prompt-claude').prompt ?? ''),
    null,
  )
  assert.equal(parseDispatchPrompt('hello'), null)
})

test('parseDispatchPrompt ignores a handle quoted inside the task spec', () => {
  assert.equal(
    parseDispatchPrompt(
      "You are a dispatched worker.\n\n=== TASK ===\nYour coordinator's terminal handle is: term_x\n",
    ),
    null,
  )
})

test('parseDispatchPrompt gives a null task id when the line is missing', () => {
  assert.deepEqual(
    parseDispatchPrompt("Your coordinator's terminal handle is: term_x\n"),
    { coordinatorTerminal: 'term_x', taskId: null, dispatchId: null },
  )
})

test('modelFlag reads codex -c model=<id> in its quoted spellings', () => {
  assert.equal(
    modelFlag('codex', "codex '-c' 'model=gpt-6.1-sol'"),
    'gpt-6.1-sol',
  )
  assert.equal(
    modelFlag('codex', "codex '-c' 'model=\"gpt-6.1-sol\"'"),
    'gpt-6.1-sol',
  )
  assert.equal(
    modelFlag('codex', "codex '--config' 'model = \"gpt-6.1-sol\"'"),
    'gpt-6.1-sol',
  )
  assert.equal(
    modelFlag('codex', "codex '--config=model=gpt-6.1-sol'"),
    'gpt-6.1-sol',
  )
  assert.equal(modelFlag('codex', "codex '-cmodel=gpt-6.1-sol'"), 'gpt-6.1-sol')
})

test('modelFlag prefers an explicit --model over -c model', () => {
  assert.equal(modelFlag('codex', "codex '--model' 'a' '-c' 'model=b'"), 'a')
  assert.equal(modelFlag('codex', "codex '-c' 'model=b' '-m' 'a'"), 'a')
})

test('modelFlag skips the values of other codex value options', () => {
  for (const opt of [
    '-p',
    '-i',
    '-C',
    '-s',
    '-a',
    '--profile',
    '--cd',
    '--image',
  ]) {
    assert.equal(modelFlag('codex', `codex '${opt}' '-mbad'`), null, opt)
  }
  assert.equal(
    modelFlag('codex', "codex '-p' 'x' '--model' 'gpt-6.1-sol'"),
    'gpt-6.1-sol',
  )
})

test('bypassFlags finds the codex sandbox and approval bypasses', () => {
  const cases: [string, string][] = [
    ["codex '--yolo'", '--yolo'],
    ["codex '-s' 'danger-full-access'", '-s danger-full-access'],
    ["codex '-sdanger-full-access'", '-s danger-full-access'],
    ["codex '--sandbox' 'danger-full-access'", '--sandbox danger-full-access'],
    ["codex '--sandbox=danger-full-access'", '--sandbox=danger-full-access'],
    [
      "codex '-c' 'sandbox_mode=danger-full-access'",
      '-c sandbox_mode=danger-full-access',
    ],
    [
      "codex '-c' 'sandbox_mode=\"danger-full-access\"'",
      '-c sandbox_mode=danger-full-access',
    ],
    [
      'codex -c "sandbox_mode=\'danger-full-access\'"',
      '-c sandbox_mode=danger-full-access',
    ],
    ["codex '-c' 'approval_policy=never'", '-c approval_policy=never'],
    ["codex '-c' 'approval_policy=\"never\"'", '-c approval_policy=never'],
    ["codex '-a' 'never'", '-a never'],
    ["codex '--ask-for-approval' 'never'", '--ask-for-approval never'],
    ["codex '--ask-for-approval=never'", '--ask-for-approval=never'],
  ]
  for (const [command, flag] of cases) {
    assert.deepEqual(bypassFlags('codex', command), [flag], command)
  }
})

test('bypassFlags leaves safe codex sandbox and approval values alone', () => {
  assert.deepEqual(bypassFlags('codex', "codex '-s' 'workspace-write'"), [])
  assert.deepEqual(bypassFlags('codex', "codex '-a' 'on-request'"), [])
  assert.deepEqual(
    bypassFlags('codex', "codex '-c' 'sandbox_mode=workspace-write'"),
    [],
  )
  assert.deepEqual(bypassFlags('codex', "codex '--' '--yolo'"), [])
  assert.deepEqual(bypassFlags('codex', "codex '-p' '--yolo'"), [])
})

test('parseLaunch gives the model and bypass flags together', () => {
  assert.deepEqual(
    parseLaunch('codex', fixture('worker-start-codex-launch').command ?? ''),
    { model: null, bypass: ['--approve-for-me'] },
  )
  assert.deepEqual(
    parseLaunch('claude', fixture('worker-start-claude-launch').command ?? ''),
    { model: 'claude-haiku-5-5', bypass: ['--dangerously-skip-permissions'] },
  )
})

function launch(agent: string, command: string) {
  return { agent, ...parseLaunch(agent, command) }
}

function kinds(r: ReturnType<typeof checkWorkerLaunch>) {
  return r.ok ? [] : r.problems.map((p) => p.kind)
}

function texts(r: ReturnType<typeof checkWorkerLaunch>) {
  return r.ok ? '' : r.problems.map((p) => p.text).join(' ')
}

test('checkWorkerLaunch accepts a claude worker on the worker model', () => {
  assert.deepEqual(
    checkWorkerLaunch(
      launch(
        'claude',
        "claude '--dangerously-skip-permissions' '--model' 'claude-opus-4-8'",
      ),
    ),
    { ok: true },
  )
})

test('checkWorkerLaunch accepts a claude worker without --model', () => {
  const r = checkWorkerLaunch(
    launch('claude', "claude '--dangerously-skip-permissions'"),
  )
  assert.deepEqual(r, { ok: true })
})

test('checkWorkerLaunch accepts a claude worker on any model', () => {
  const r = checkWorkerLaunch(
    launch('claude', fixture('worker-start-claude-launch').command ?? ''),
  )
  assert.deepEqual(r, { ok: true })
})

test('checkWorkerLaunch flags a codex worker with --approve-for-me', () => {
  const r = checkWorkerLaunch(
    launch('codex', "codex '--approve-for-me' '--model' 'gpt-6.1-sol'"),
  )
  assert.deepEqual(kinds(r), ['bypass'])
  assert.match(texts(r), /--approve-for-me/)
})

test('checkWorkerLaunch accepts a codex worker on the right model with no bypass', () => {
  assert.deepEqual(
    checkWorkerLaunch(
      launch(
        'codex',
        "codex '-c' 'disable_paste_burst=true' '--model' 'gpt-6.1-sol'",
      ),
    ),
    { ok: true },
  )
})

test('checkWorkerLaunch lists every problem of the codex fixture by kind', () => {
  const r = checkWorkerLaunch(
    launch('codex', fixture('worker-start-codex-launch').command ?? ''),
  )
  assert.deepEqual(kinds(r), ['bypass'])
})

test('parseDispatchPrompt ignores a dispatch id quoted in the task spec', () => {
  const header =
    "Your coordinator's terminal handle is: term_1\nYour task ID is: task_1\n"
  assert.deepEqual(
    parseDispatchPrompt(`${header}=== TASK ===\nrun --dispatch-id ctx_spec`),
    { coordinatorTerminal: 'term_1', taskId: 'task_1', dispatchId: null },
  )
})

test('checkWorkerLaunch accepts arbitrary harnesses but still catches bypass flags', () => {
  assert.deepEqual(
    checkWorkerLaunch(
      launch('opencode2', 'opencode2 --model provider/model:level'),
    ),
    { ok: true },
  )
  assert.deepEqual(
    kinds(checkWorkerLaunch(launch('custom', 'custom --yolo'))),
    ['bypass'],
  )
})

test('bypass checking treats prototype-named harnesses as ordinary harnesses', () => {
  assert.deepEqual(
    kinds(checkWorkerLaunch(launch('constructor', 'constructor --yolo'))),
    ['bypass'],
  )
})
