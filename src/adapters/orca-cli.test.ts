import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import type { Exec } from './exec'
import { createOrcaCli, OrcaCliError } from './orca-cli'

const BIN = '/orca/bin/orca'

type Call = { file: string; args: string[] }

function fake(stdout: unknown, extra: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const exec: Exec = async (file, args) => {
    calls.push({ file, args })
    return {
      code: 0,
      stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
      stderr: '',
      ...extra,
    }
  }
  return { calls, exec }
}

const ok = (result: unknown) => ({ id: 'x', ok: true, result })

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof OrcaCliError) return e.code
    throw e
  }
  return 'resolved'
}

const sample = {
  id: 'repo1::/Users/x/projects/demo/wt one',
  identity: { key: 'wt2:local:abc' },
  repoId: 'repo1',
  projectId: 'git:example.com/demo/demo',
  path: '/Users/x/projects/demo/wt one',
  head: 'deadbeef',
  branch: 'refs/heads/feat/a',
  isMainWorktree: false,
  displayName: 'feat/a',
  comment: '',
  linkedPR: null,
  linkedGitLabMR: null,
  isArchived: false,
  isPinned: true,
  lastActivityAt: 1793914719060,
  workspaceStatus: 'in-review',
  parentWorktreeId: 'repo1::/Users/x/projects/demo',
  childWorktreeIds: ['c1'],
}

test('listWorktrees maps records and strips refs/heads/', async () => {
  const { calls, exec } = fake(
    ok({ worktrees: [sample, { ...sample, id: 'b', branch: null }] }),
  )
  const list = await createOrcaCli(exec, BIN).listWorktrees()
  assert.deepEqual(calls, [{ file: BIN, args: ['worktree', 'list', '--json'] }])
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], {
    id: 'repo1::/Users/x/projects/demo/wt one',
    identityKey: 'wt2:local:abc',
    projectId: 'git:example.com/demo/demo',
    repoId: 'repo1',
    path: '/Users/x/projects/demo/wt one',
    branch: 'feat/a',
    displayName: 'feat/a',
    isMainWorktree: false,
    isPinned: true,
    isUnread: false,
    isArchived: false,
    comment: '',
    workspaceStatus: 'in-review',
    parentWorktreeId: 'repo1::/Users/x/projects/demo',
    childWorktreeIds: ['c1'],
    linkedGitLabMR: null,
    linkedPR: null,
    lastActivityAt: 1793914719060,
  })
  assert.equal(list[1].branch, null)
})

test('listWorktrees maps isUnread and comment', async () => {
  const { exec } = fake(
    ok({
      worktrees: [
        { ...sample, isUnread: true, comment: 'Merged !279' },
        { ...sample, id: 'b', isUnread: 'yes', comment: 42 },
      ],
    }),
  )
  const list = await createOrcaCli(exec, BIN).listWorktrees()
  assert.equal(list[0]?.isUnread, true)
  assert.equal(list[0]?.comment, 'Merged !279')
  assert.equal(list[1]?.isUnread, false)
  assert.equal(list[1]?.comment, '')
})

test('setStatus keeps a path with a space in one arg', async () => {
  const { calls, exec } = fake(ok({}))
  await createOrcaCli(exec, BIN).setStatus('a::/p q', 'in-review')
  assert.deepEqual(calls[0].args, [
    'worktree',
    'set',
    '--worktree',
    'id:a::/p q',
    '--workspace-status',
    'in-review',
    '--json',
  ])
})

test('removeWorktree and hideExternalWorktrees args', async () => {
  const { calls, exec } = fake(ok({}))
  const cli = createOrcaCli(exec, BIN)
  await cli.removeWorktree('a::/p q')
  await cli.hideExternalWorktrees('repo1')
  assert.deepEqual(calls[0].args, [
    'worktree',
    'rm',
    '--worktree',
    'id:a::/p q',
    '--json',
  ])
  assert.deepEqual(calls[1].args, [
    'repo',
    'set',
    '--repo',
    'id:repo1',
    '--external-worktree-visibility',
    'hide',
    '--json',
  ])
})

test('ensureFolderWorkspace returns repoId::dir', async () => {
  const { calls, exec } = fake(ok({ repo: { id: 'r9', kind: 'folder' } }))
  const id = await createOrcaCli(exec, BIN).ensureFolderWorkspace('/h/my hub')
  assert.equal(id, 'r9::/h/my hub')
  assert.deepEqual(calls[0].args, [
    'repo',
    'add',
    '--path',
    '/h/my hub',
    '--kind',
    'folder',
    '--json',
  ])
})

test('sendOrchestrationMessage args', async () => {
  const { calls, exec } = fake(ok({}))
  await createOrcaCli(exec, BIN).sendOrchestrationMessage({
    fromTerminalId: 'term_1',
    runId: 'run_2',
    subject: 'Decision needed',
    body: 'line1\nline2 $(x)',
  })
  assert.deepEqual(calls[0].args, [
    'orchestration',
    'send',
    '--from',
    'term_1',
    '--to',
    'run:run_2',
    '--subject',
    'Decision needed',
    '--body',
    'line1\nline2 $(x)',
    '--json',
  ])
})

test('findRunId matches the coordinator terminal', async () => {
  const runs = [
    { id: 'run_a', coordinator_handle: 'term_a' },
    { id: 'run_b', coordinator_handle: 'term_b' },
    { id: 'run_legacy_local', coordinator_handle: null },
  ]
  const { calls, exec } = fake(ok({ runs, nextCursor: null }))
  const cli = createOrcaCli(exec, BIN)
  assert.equal(await cli.findRunId('term_b'), 'run_b')
  assert.equal(await cli.findRunId('term_zzz'), null)
  assert.deepEqual(calls[0].args, [
    'orchestration',
    'run-list',
    '--full',
    '--json',
  ])
})

test('sendTerminalText adds --enter only when asked', async () => {
  const { calls, exec } = fake(ok({}))
  const cli = createOrcaCli(exec, BIN)
  await cli.sendTerminalText('term_1', 'y', false)
  await cli.sendTerminalText('term_1', 'hello world', true)
  assert.deepEqual(calls[0].args, [
    'terminal',
    'send',
    '--terminal',
    'term_1',
    '--text',
    'y',
    '--json',
  ])
  assert.deepEqual(calls[1].args, [
    'terminal',
    'send',
    '--terminal',
    'term_1',
    '--text',
    'hello world',
    '--enter',
    '--json',
  ])
})

test('launchAgent selects the workspace by path and returns the terminal', async () => {
  const { calls, exec } = fake(ok({ terminal: { handle: 'term_7' } }))
  const r = await createOrcaCli(exec, BIN).launchAgent({
    workspacePath: '/h/my hub',
    agent: 'claude',
    model: 'claude-opus-5-5',
    prompt: 'Do it; rm -rf',
  })
  assert.deepEqual(r, { terminalId: 'term_7' })
  assert.deepEqual(calls[0].args, [
    'agent',
    'launch',
    '--agent',
    'claude',
    '--worktree',
    'path:/h/my hub',
    '--model',
    'claude-opus-5-5',
    '--surface',
    'terminal',
    '--prompt',
    'Do it; rm -rf',
    '--json',
  ])
})

test('launchAgent without a terminal handle is bad_output', async () => {
  const { exec } = fake(ok({ outcome: { kind: 'chat' } }))
  assert.equal(
    await code(
      createOrcaCli(exec, BIN).launchAgent({
        workspacePath: '/p',
        agent: 'claude',
        model: 'm',
        prompt: 'p',
      }),
    ),
    'bad_output',
  )
})

test('non-JSON stdout is bad_output', async () => {
  const { exec } = fake('Orca is not running')
  assert.equal(
    await code(createOrcaCli(exec, BIN).listWorktrees()),
    'bad_output',
  )
})

test('ok:false and non-zero exit are failed', async () => {
  const a = fake({ ok: false, error: { code: 'x', message: 'nope' } })
  assert.equal(await code(createOrcaCli(a.exec, BIN).listWorktrees()), 'failed')
  const b = fake('', { code: 1, stderr: 'boom' })
  assert.equal(await code(createOrcaCli(b.exec, BIN).listWorktrees()), 'failed')
})

test('a reported timeout is timeout, ENOENT is not_found', async () => {
  const t = fake('', { code: -1, error: 'timeout' })
  assert.equal(
    await code(createOrcaCli(t.exec, BIN).listWorktrees()),
    'timeout',
  )
  const n = fake('', { code: -1, error: 'not_found' })
  assert.equal(
    await code(createOrcaCli(n.exec, BIN).listWorktrees()),
    'not_found',
  )
  const thrown: Exec = async () => {
    throw Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' })
  }
  assert.equal(
    await code(createOrcaCli(thrown, BIN).listWorktrees()),
    'not_found',
  )
})

const PS = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/worktree-ps.json', import.meta.url),
    'utf8',
  ),
) as { result: { worktrees: Record<string, unknown>[] } }

test('worktreeSummaries reads worktree ps and maps records and agents', async () => {
  const { calls, exec } = fake(PS)
  const { summaries: list, truncated } = await createOrcaCli(
    exec,
    BIN,
  ).worktreeSummaries()
  assert.equal(truncated, false)
  assert.deepEqual(calls, [{ file: BIN, args: ['worktree', 'ps', '--json'] }])
  assert.equal(list.length, 4)
  const [a, b, c, main] = list
  assert.equal(
    a?.id,
    '00000000-0000-4000-8000-000000000016::/Users/example/projects/demo/repo/wt-a',
  )
  assert.equal(a?.identityKey, 'wt2:local:00000000-0000-4000-8000-000000000001')
  assert.equal(a?.branch, 'example/wt-a')
  assert.equal(a?.displayName, 'Example wt-a')
  assert.equal(a?.isUnread, true)
  assert.equal(a?.comment, 'Example note')
  assert.equal(a?.workspaceStatus, 'in-progress')
  assert.equal(a?.childWorktreeIds.length, 2)
  assert.deepEqual(a?.agents[0], {
    paneKey:
      '00000000-0000-4000-8000-000000000013:00000000-0000-4000-8000-000000000006',
    parentPaneKey: null,
    terminalId: null,
    title: 'Example conversationName 0.0',
    detail: 'Edit: example command --flag value',
    state: 'done',
    since: 1794323036847,
    updatedAt: 1794323036847,
    agent: 'claude',
    model: null,
  })
  assert.equal(
    a?.agents[1]?.parentPaneKey,
    '00000000-0000-4000-8000-000000000008:00000000-0000-4000-8000-000000000017',
  )
  assert.equal(b?.agents[0]?.agent, 'codex')
  assert.equal(b?.agents[0]?.detail, null)
  assert.equal(c?.agents[0]?.state, 'working')
  assert.equal(main?.isMainWorktree, true)
  assert.deepEqual(main?.agents, [])
})

test('worktreeSummaries falls back across title fields and formats detail', async () => {
  const base = PS.result.worktrees[0] as Record<string, unknown>
  const agent = (over: Record<string, unknown>) => ({
    paneKey: 'p',
    parentPaneKey: null,
    state: 'working',
    agentType: 'codex',
    conversationName: null,
    displayName: null,
    taskTitle: null,
    toolName: null,
    toolInput: null,
    stateStartedAt: 5,
    updatedAt: 6,
    ...over,
  })
  const { exec } = fake({
    id: 'x',
    ok: true,
    result: {
      worktrees: [
        {
          ...base,
          agents: [
            agent({ displayName: 'Shown', taskTitle: 'Not shown' }),
            agent({ taskTitle: 'Task title', toolName: 'Read' }),
            agent({
              toolName: 'Bash',
              toolInput: 'git status \\\n  --short\n',
            }),
            agent({
              state: 'done',
              mainAgent: { state: 'blocked', stateStartedAt: 1 },
            }),
          ],
        },
      ],
    },
  })
  const {
    summaries: [w],
    truncated,
  } = await createOrcaCli(exec, BIN).worktreeSummaries()
  assert.equal(truncated, false)
  const got = w?.agents.map((x) => [x.title, x.detail, x.state, x.since])
  assert.deepEqual(got, [
    ['Shown', null, 'working', 5],
    ['Task title', 'Read', 'working', 5],
    [null, 'Bash: git status \\ --short', 'working', 5],
    [null, null, 'blocked', 5],
  ])
})

test('worktreeSummaries without a worktrees list is bad_output', async () => {
  const { exec } = fake(ok({ rows: [] }))
  assert.equal(
    await code(createOrcaCli(exec, BIN).worktreeSummaries()),
    'bad_output',
  )
})

test('switchTerminal switches the window to the terminal', async () => {
  const { calls, exec } = fake(ok({ switched: true }))
  await createOrcaCli(exec, BIN).switchTerminal('term_9')
  assert.deepEqual(calls[0]?.args, [
    'terminal',
    'switch',
    '--terminal',
    'term_9',
    '--json',
  ])
})

const SHOW = {
  terminal: {
    handle: 'term_9',
    tabId: 'tab1',
    leafId: 'leaf1',
    title: 'Claude Code',
    connected: true,
  },
}

test('terminalInfo reads the title and pane key of a live terminal', async () => {
  const { calls, exec } = fake(ok(SHOW))
  assert.deepEqual(await createOrcaCli(exec, BIN).terminalInfo('term_9'), {
    title: 'Claude Code',
    paneKey: 'tab1:leaf1',
  })
  assert.deepEqual(calls[0]?.args, [
    'terminal',
    'show',
    '--terminal',
    'term_9',
    '--json',
  ])
})

test('terminalInfo is null for a closed terminal', async () => {
  const { exec } = fake(
    {
      id: 'x',
      ok: false,
      error: {
        code: 'terminal_handle_stale',
        message: 'terminal_handle_stale',
      },
    },
    { code: 1 },
  )
  assert.equal(await createOrcaCli(exec, BIN).terminalInfo('term_gone'), null)
})

test('terminalInfo is null for a terminal that exited but is still listed', async () => {
  // `orca terminal show` right after `orca terminal close` (Orca 1.4.255).
  const { exec } = fake(
    ok({
      terminal: {
        handle: 'term_d0c8',
        orphaned: true,
        tabId: 'tab1',
        leafId: 'leaf1',
        title: null,
        connected: false,
        writable: false,
        exitCause: { kind: 'operator_close' },
      },
    }),
  )
  assert.equal(await createOrcaCli(exec, BIN).terminalInfo('term_d0c8'), null)
})

test('terminalInfo still throws when orca itself fails', async () => {
  const { exec } = fake('', { code: -1, error: 'timeout' })
  assert.equal(
    await code(createOrcaCli(exec, BIN).terminalInfo('term_9')),
    'timeout',
  )
  const other = fake(
    {
      id: 'x',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'down' },
    },
    { code: 1 },
  )
  assert.equal(
    await code(createOrcaCli(other.exec, BIN).terminalInfo('term_9')),
    'failed',
  )
})

test('launchAgent reads the handle from a real launch result', async () => {
  const raw = readFileSync(
    new URL('../../test/fixtures/agent-launch-terminal.json', import.meta.url),
    'utf8',
  )
  const { exec } = fake(raw)
  const r = await createOrcaCli(exec, BIN).launchAgent({
    workspacePath: '/Users/example/projects/unifier-sandbox',
    agent: 'claude',
    model: 'claude-haiku-5-5',
    prompt: 'p',
  })
  assert.deepEqual(r, {
    terminalId: 'term_00000000-0000-4000-8000-000000000109',
  })
})

for (const worktrees of [[], PS.result.worktrees.slice(0, 2)]) {
  test(`truncated worktree ps returns its ${worktrees.length} available summaries`, async () => {
    const { exec } = fake(ok({ worktrees, truncated: true }))
    const result = await createOrcaCli(exec, BIN).worktreeSummaries()
    assert.equal(result.truncated, true)
    assert.deepEqual(
      result.summaries.map((w) => w.id),
      worktrees.length === 0
        ? []
        : [
            '00000000-0000-4000-8000-000000000016::/Users/example/projects/demo/repo/wt-a',
            '00000000-0000-4000-8000-000000000016::/Users/example/projects/demo/repo/wt-b',
          ],
    )
    if (worktrees.length > 0)
      assert.equal(result.summaries[1]?.agents[0]?.agent, 'codex')
  })
}

for (const agents of [
  undefined,
  {},
  [null],
  [{ paneKey: 'x', state: 'unreadable' }],
]) {
  test(`D1: malformed agent evidence remains unknown: ${JSON.stringify(agents)}`, async () => {
    const { exec } = fake(ok({ worktrees: [{ ...sample, agents }] }))
    assert.equal(
      await code(createOrcaCli(exec, BIN).worktreeSummaries()),
      'bad_output',
    )
  })
}
