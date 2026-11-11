import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { nodeFs } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import type { AgentEntry, AgentStates } from '../core/agents'
import { judge, parseApprovalPrompt } from '../core/approval-policy'
import { parseSettings } from '../core/settings'
import type { WorktreeRecord } from '../core/types'
import * as main from '../worker'
import { createApproverService } from './approver-service'
import { createMessenger } from './messenger'
import { createTracker, type TrackedWorker } from './tracker'

const WT = '/Users/example/orca/workspaces/demo/spike-codex'
const WORKER: TrackedWorker = {
  terminalId: 'term_worker',
  workspaceId: `repo::${WT}`,
  agent: 'codex',
  project: 'demo',
  orchestratorTerminalId: 'term_orchestrator',
  taskId: 'task_12',
}

function worktree(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: WORKER.workspaceId as string,
    identityKey: 'wt2:local:worker',
    projectId: 'project',
    repoId: 'repo',
    path: WT,
    branch: 'worker',
    displayName: 'worker',
    isMainWorktree: false,
    isPinned: false,
    isUnread: false,
    isArchived: false,
    comment: '',
    workspaceStatus: 'in-progress',
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedGitLabMR: null,
    linkedPR: null,
    lastActivityAt: 0,
    ...over,
  }
}

function listedWorktrees(workspaceId = WORKER.workspaceId): WorktreeRecord[] {
  return [
    worktree({
      id: workspaceId ?? '',
      path: workspaceId?.slice(workspaceId.indexOf('::') + 2) ?? '',
    }),
    worktree({
      id: 'repo::/Users/m/projects/demo/main',
      path: '/Users/m/projects/demo/main',
      isMainWorktree: true,
    }),
  ]
}

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../test/fixtures/codex-prompts/${name}.txt`, import.meta.url),
    'utf8',
  )
}

function command(text: string): string {
  return fixture('read-only-command').replaceAll('uname -a', text)
}

function agent(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    paneKey: 'worker-pane',
    parentPaneKey: null,
    terminalId: WORKER.terminalId,
    title: null,
    detail: null,
    state: 'waiting',
    since: 1,
    updatedAt: 1,
    agent: 'codex',
    model: null,
    ...over,
  }
}

function scheduler() {
  const pending = new Set<{ fn: () => void; ms: number }>()
  return {
    pending,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, ms }
      pending.add(entry)
      return () => pending.delete(entry)
    },
    fire() {
      for (const entry of [...pending]) {
        pending.delete(entry)
        entry.fn()
      }
    },
  }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function setup(
  over: Partial<TrackedWorker> = {},
  options: {
    enabled?: boolean
    boardError?: boolean
    truncated?: boolean
  } = {},
) {
  const tracked = { ...WORKER, ...over }
  const host = mockHost()
  host.respond('terminal.read', {
    lines: fixture('read-only-command').split('\n'),
    truncated: false,
  })
  let api!: OrcaWorkerApi
  const worker = await mountWorker(
    {
      default: (o) => {
        api = o
      },
    },
    { host },
  )
  const keys: [string, string, boolean][] = []
  const messages: [string, string, string][] = []
  const files: string[] = []
  const sched = scheduler()
  const config = parseSettings(
    {
      excludedProjects: 'alpha,beta',
      approverEnabled: options.enabled ?? true,
    },
    '/Users/m',
  )
  let readPackage = async (_path: string) =>
    '{"scripts":{"lint":"biome check ."}}'
  let boardError = options.boardError ?? false
  let logFailure: 'read' | 'write' | null = null
  let storageWriteFailure: string | null = null
  let onClaim = () => {}
  let now = 1234
  let workers = [tracked]
  let worktrees = listedWorktrees(tracked.workspaceId)
  let worktreeError = false
  let listCalls = 0
  let enqueue = async (...args: [string, string, string]) => {
    messages.push(args)
  }
  let states: AgentStates = tracked.workspaceId
    ? { [tracked.workspaceId]: [agent()] }
    : {}
  const cli = {
    async listWorktrees() {
      listCalls++
      if (worktreeError) throw new Error('worktrees temporarily unavailable')
      return worktrees
    },
    async sendTerminalText(...args: [string, string, boolean]) {
      keys.push(args)
    },
    async terminalInfo() {
      return { paneKey: 'worker-pane', title: null }
    },
  } as unknown as OrcaCli
  const make = () =>
    createApproverService(
      {
        ...api,
        storage: {
          ...api.storage,
          async get(key) {
            if (key === 'approver.log' && logFailure === 'read')
              throw new Error('log read failed')
            return api.storage.get(key)
          },
          async set(key, value) {
            if (key === storageWriteFailure)
              throw new Error('storage write failed')
            if (key === 'approver.log' && logFailure === 'write')
              throw new Error('log write failed')
            await api.storage.set(key, value)
            if (
              key === 'approver.claims.v1' &&
              value &&
              typeof value === 'object' &&
              Object.keys(value).length > 0
            )
              onClaim()
          },
        },
      },
      {
        tracker: { workers: async () => workers },
        cli,
        messenger: {
          async toOrchestrator(...args: [string, string, string]) {
            await enqueue(...args)
          },
        },
        board: {
          agentStates: async () => {
            if (boardError) throw new Error('summary temporarily unavailable')
            return { states, truncated: options.truncated ?? false }
          },
        },
        settings: async () => config,
        fs: {
          ...nodeFs,
          realpath: async (p) => p,
          async read(path) {
            files.push(path)
            return readPackage(path)
          },
        },
        schedule: sched.schedule,
        now: () => now,
      },
    )
  const service = make()
  await service.tick()
  return {
    worker,
    api,
    host,
    keys,
    messages,
    files,
    config,
    sched,
    service,
    cli,
    make,
    listCalls: () => listCalls,
    setWorktrees(value: WorktreeRecord[]) {
      worktrees = value
    },
    setWorktreeError(value: boolean) {
      worktreeError = value
    },
    setEnqueue(value: typeof enqueue) {
      enqueue = value
    },
    setWorkers(value: TrackedWorker[]) {
      workers = value
    },
    setStates(value: AgentStates) {
      states = value
    },
    setReadPackage(value: typeof readPackage) {
      readPackage = value
    },
    setBoardError(value: boolean) {
      boardError = value
    },
    setLogFailure(value: typeof logFailure) {
      logFailure = value
    },
    setStorageWriteFailure(value: typeof storageWriteFailure) {
      storageWriteFailure = value
    },
    setOnClaim(value: typeof onClaim) {
      onClaim = value
    },
    setNow(value: number) {
      now = value
    },
    screen(value: string) {
      host.respond('terminal.read', {
        lines: value.split('\n'),
        truncated: false,
      })
    },
    async close() {
      service.dispose()
      await worker.deactivate()
    },
  }
}

test('approves once with y and no Enter, and logs a JSON line with the injected clock', async () => {
  const s = await setup()
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  const entry = {
    at: 1234,
    terminalId: WORKER.terminalId,
    command: 'uname -a',
    verdict: 'approve',
  }
  assert.deepEqual(s.host.data().storage['approver.log'], [entry])
  const seen = (await s.api.storage.get('approver.seen.v1')) as string[]
  assert.equal(seen.length, 1)
  assert.equal(typeof seen[0], 'string')
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
  assert.ok(s.worker.logs.includes(JSON.stringify(entry)))
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.equal(s.host.callsOf('terminal.sendText').length, 0)
  await s.close()
})

test('persists dedupe across service restarts and ignores changed scrollback', async () => {
  const s = await setup()
  s.service.dispose()
  s.setNow(1234 + 60_001)
  s.screen(`new scrollback\n${fixture('read-only-command')}`)
  const restarted = s.make()
  await restarted.tick()
  assert.equal(s.keys.length, 1)
  assert.deepEqual(s.messages, [])
  restarted.dispose()
  await s.close()
})

test('escalates a fixture with the exact policy reason and no keys', async () => {
  const s = await setup()
  s.screen(fixture('git-push'))
  await s.service.tick()
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.equal(s.messages.length, 1)
  const [owner, subject, body] = s.messages[0] as [string, string, string]
  assert.equal(owner, WORKER.orchestratorTerminalId)
  assert.equal(subject, '[approver] ASK: worker needs approval')
  assert.ok(body.includes(WORKER.terminalId))
  assert.ok(body.includes(WORKER.taskId as string))
  assert.ok(body.includes('git -C . push origin spike-codex'))
  const prompt = parseApprovalPrompt(fixture('git-push'))
  assert.ok(prompt)
  const verdict = judge(prompt, { worktreePath: WT, cwd: null })
  assert.equal(verdict.verdict, 'escalate')
  if (verdict.verdict === 'escalate') assert.ok(body.includes(verdict.reason))
  const logs = s.host.data().storage['approver.log'] as { verdict: string }[]
  assert.equal(logs[1]?.verdict, 'escalate')
  await s.close()
})

test('reads only tracked Codex workers and excludes protected projects', async () => {
  const s = await setup()
  const before = s.host.callsOf('terminal.read').length
  s.setWorkers([
    { ...WORKER, terminalId: 'claude', agent: 'claude' },
    { ...WORKER, terminalId: 'excluded', project: 'Beta' },
    { ...WORKER, terminalId: 'excluded2', project: 'ALPHA' },
  ])
  s.setStates({
    [WORKER.workspaceId as string]: [agent({ terminalId: 'untracked' })],
  })
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, before)
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('disabled settings stop reads and cancel polling', async () => {
  const s = await setup()
  const before = s.host.callsOf('terminal.read').length
  s.config.approverEnabled = false
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, before)
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('polls every 3 seconds only while waiting or blocked and stops on disposal', async () => {
  const s = await setup()
  const initialReads = s.host.callsOf('terminal.read').length
  assert.deepEqual(
    [...s.sched.pending].map((p) => p.ms),
    [3000],
  )
  s.sched.fire()
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, initialReads + 1)
  s.setStates({
    [WORKER.workspaceId as string]: [
      agent({ state: 'working', updatedAt: 1234 }),
    ],
  })
  await s.service.tick()
  assert.equal(s.sched.pending.size, 0)
  await s.worker.emit('agent.status.changed', {
    workspaceId: WORKER.workspaceId,
    terminalId: WORKER.terminalId,
    paneKey: 'worker-pane',
    state: 'blocked',
    receivedAt: 1234,
  })
  await s.service.tick()
  assert.equal(s.sched.pending.size, 1)
  s.service.dispose()
  assert.equal(s.sched.pending.size, 0)
  const before = s.host.callsOf('terminal.read').length
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, before)
  await s.close()
})

test('an unknown worktree is skipped even with a live waiting event', async () => {
  const s = await setup({ workspaceId: null })
  await s.worker.emit('agent.status.changed', {
    workspaceId: null,
    terminalId: WORKER.terminalId,
    paneKey: 'worker-pane',
    state: 'waiting',
    receivedAt: 1234,
  })
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.deepEqual(s.messages, [])
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  await s.close()
})

test('passes unknown cwd and the wrapped prompt through policy unchanged', async () => {
  const s = await setup()
  s.screen(command('cat relative.txt'))
  await s.service.tick()
  assert.match(s.messages[0]?.[2] ?? '', /working directory is unknown/)
  s.screen(command('uv run pytest\n  -q'))
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.match(s.messages[1]?.[2] ?? '', /wraps across screen lines/)
  s.screen(command('uv run pytest'))
  await s.service.tick()
  assert.equal(s.keys.length, 2)
  assert.deepEqual(s.files, Array(4).fill(`${WT}/package.json`))
  await s.close()
})

test('hashes the prompt block so changed context for the same command is handled', async () => {
  const s = await setup()
  s.screen(
    fixture('read-only-command').replace(
      'Reason: spike test',
      'Reason: another request',
    ),
  )
  await s.service.tick()
  assert.equal(s.keys.length, 2)
  await s.close()
})

test('ignores an update modal and escalates an unreadable waiting prompt', async () => {
  const s = await setup()
  s.screen(fixture('update-notice'))
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.deepEqual(s.messages, [])
  s.screen('Press enter to confirm or esc to cancel')
  await s.service.tick()
  assert.equal(s.messages.length, 1)
  assert.match(s.messages[0]?.[2] ?? '', /could not be read/)
  await s.close()
})

test('unreadable prompt dedupe excludes a completed prompt above it', async () => {
  const s = await setup()
  const unreadable =
    '\nCurrent prompt unavailable\nPress enter to confirm or esc to cancel'
  s.screen(`${fixture('read-only-command')}${unreadable}`)
  await s.service.tick()
  s.screen(
    `${fixture('read-only-command').replace('Reason: spike test', 'Reason: old text changed')}${unreadable}`,
  )
  await s.service.tick()
  assert.equal(s.messages.length, 1)
  await s.close()
})

test('starts disabled without reading any terminal and wakes when enabled', async () => {
  const s = await setup({}, { enabled: false })
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  assert.equal(s.sched.pending.size, 0)
  s.config.approverEnabled = true
  await s.api.settings.set('approverEnabled', true)
  await s.service.tick()
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  await s.close()
})

test('matches a summary without terminal ids by the tracked terminal pane', async () => {
  const s = await setup()
  const initialReads = s.host.callsOf('terminal.read').length
  s.setStates({
    [WORKER.workspaceId as string]: [
      agent({ terminalId: null, state: 'working' }),
      agent({ terminalId: null, paneKey: 'someone-else', state: 'waiting' }),
    ],
  })
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, initialReads)
  s.setStates({ [WORKER.workspaceId as string]: [agent({ terminalId: null })] })
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, initialReads + 1)
  await s.close()
})

test('a newer summary without terminal ids overrides a stale waiting event', async () => {
  const s = await setup()
  s.setStates({
    [WORKER.workspaceId as string]: [
      agent({
        terminalId: null,
        state: 'working',
        updatedAt: 1235,
      }),
    ],
  })
  const before = s.host.callsOf('terminal.read').length
  await s.worker.emit('agent.status.changed', {
    workspaceId: WORKER.workspaceId,
    terminalId: WORKER.terminalId,
    paneKey: 'worker-pane',
    state: 'waiting',
    receivedAt: 1234,
  })
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, before)
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('a transient board failure keeps polling an already waiting worker', async () => {
  const s = await setup()
  const initialReads = s.host.callsOf('terminal.read').length
  s.setBoardError(true)
  s.sched.fire()
  await s.service.tick()
  assert.equal(s.sched.pending.size, 1)
  assert.deepEqual(
    [...s.sched.pending].map((p) => p.ms),
    [3000],
  )
  s.setBoardError(false)
  s.sched.fire()
  await s.service.tick()
  assert.equal(s.host.callsOf('terminal.read').length, initialReads + 1)
  await s.close()
})

test('retries failed state discovery on activation before reading a terminal', async () => {
  const s = await setup({}, { boardError: true })
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  assert.equal(s.sched.pending.size, 1)
  s.setBoardError(false)
  s.sched.fire()
  await s.service.tick()
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  await s.close()
})

test('realpath checks block an escaping link including a file that does not exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unifier-approver-'))
  try {
    const worktree = join(root, 'work tree')
    mkdirSync(worktree)
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(worktree, 'escape'))
    symlinkSync(join(root, 'absent'), join(worktree, 'broken'))
    const s = await setup({ workspaceId: `repo::${worktree}` })
    s.screen(command(`cat '${worktree}/escape/new-file.txt'`))
    await s.service.tick()
    assert.equal(s.keys.length, 1)
    assert.match(s.messages[0]?.[2] ?? '', /outside the worktree/)
    s.screen(command(`cat '${worktree}/broken/new-file.txt'`))
    await s.service.tick()
    assert.equal(s.keys.length, 1)
    assert.match(s.messages[1]?.[2] ?? '', /worktree path is unknown/)
    await s.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scripts come from injected fs and missing or unreadable scripts are omitted', async () => {
  const s = await setup()
  s.screen(command('bun run lint'))
  await s.service.tick()
  assert.match(s.messages[0]?.[2] ?? '', /worktree root/)
  for (const [i, read] of [
    async () => {
      throw new Error('unreadable')
    },
    async () => '{invalid json',
    async () => '{"scripts":[]}',
    async () => '{}',
  ].entries()) {
    s.setReadPackage(read)
    s.screen(
      command('bun run lint').replace(
        'Reason: spike test',
        `Reason: missing scripts ${i}`,
      ),
    )
    await s.service.tick()
    assert.match(
      s.messages[i + 1]?.[2] ?? '',
      /package.json scripts are unknown/,
    )
  }
  assert.equal(s.keys.length, 1)
  await s.close()
})

test('worktree ids use the first separator and preserve spaces in paths', async () => {
  const path = '/tmp/unifier test::worker'
  const s = await setup({ workspaceId: `repo::${path}` })
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  assert.deepEqual(s.files, [`${path}/package.json`])
  await s.close()
})

test('invalid workspace ids are skipped without reading a terminal or package file', async () => {
  for (const workspaceId of [
    'identity:wt2:local:unknown',
    'repo::relative',
    'repo::',
  ]) {
    const s = await setup({ workspaceId })
    assert.deepEqual(s.keys, [])
    assert.deepEqual(s.files, [])
    assert.deepEqual(s.messages, [])
    assert.deepEqual(s.host.callsOf('terminal.read'), [])
    await s.close()
  }
})

test('dedupe is per terminal and both histories keep the newest 500', async () => {
  const s = await setup()
  await s.api.storage.set(
    'approver.seen.v1',
    Array.from({ length: 500 }, (_, i) => `old-${i}`),
  )
  await s.api.storage.set(
    'approver.log',
    Array.from({ length: 500 }, (_, i) => ({
      at: i,
      terminalId: 'old',
      command: String(i),
      verdict: 'approve',
    })),
  )
  s.setWorkers([{ ...WORKER, terminalId: 'another-worker' }])
  s.setStates({
    [WORKER.workspaceId as string]: [agent({ terminalId: 'another-worker' })],
  })
  await Promise.all([s.service.tick(), s.service.tick(), s.service.tick()])
  assert.deepEqual(s.keys, [
    [WORKER.terminalId, 'y', false],
    ['another-worker', 'y', false],
  ])
  const seen = s.host.data().storage['approver.seen.v1'] as string[]
  const logs = s.host.data().storage['approver.log'] as { command: string }[]
  assert.equal(seen.length, 500)
  assert.equal(logs.length, 500)
  assert.equal(seen[0], 'old-1')
  assert.equal(logs[0]?.command, '1')
  assert.equal(logs[499]?.command, 'uname -a')
  await s.close()
})

test('B1: a different prompt clears the oldest handled prompt without losing its history', async () => {
  const s = await setup()
  const [handled] = (await s.api.storage.get('approver.seen.v1')) as (
    | string
    | { key: string }
  )[]
  const oldest = typeof handled === 'string' ? handled : handled?.key
  assert.ok(oldest)
  const history = [oldest, ...Array.from({ length: 499 }, (_, i) => `old-${i}`)]
  await s.api.storage.set('approver.seen.v1', history)
  let reads = 0
  s.host.respond('terminal.read', () => {
    if (++reads === 2) throw new Error('terminal temporarily unavailable')
    return { lines: command('uv run pytest').split('\n'), truncated: false }
  })
  await s.service.tick()
  assert.equal(reads, 2)
  assert.equal(s.keys.length, 1)
  assert.deepEqual(await s.api.storage.get('approver.seen.v1'), history)
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
  s.service.dispose()
  s.screen(fixture('read-only-command'))
  const restarted = s.make()
  await restarted.tick()
  assert.equal(s.keys.length, 1)
  assert.deepEqual(await s.api.storage.get('approver.seen.v1'), history)
  assert.equal(s.messages.length, 1)
  assert.match(s.messages[0]?.[2] ?? '', /previously approved/)
  restarted.dispose()
  await s.close()
})

for (const expired of [false, true]) {
  test(`startup migrates a ${expired ? 'stranded' : 'recent'} legacy claim without losing handled prompts or existing claims`, async () => {
    const s = await setup()
    const [handled] = (await s.api.storage.get('approver.seen.v1')) as (
      | string
      | { key: string }
    )[]
    const key = typeof handled === 'string' ? handled : handled?.key
    assert.ok(key)
    s.service.dispose()
    await s.api.storage.set('approver.seen.v1', [
      'older-prompt',
      { key, claimedAt: 1234 },
    ])
    await s.api.storage.set('approver.claims.v1', { 'another-claim': 1000 })
    s.config.approverEnabled = false
    const restarted = s.make()
    await restarted.tick()
    assert.deepEqual(await s.api.storage.get('approver.seen.v1'), [
      'older-prompt',
    ])
    assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {
      'another-claim': 1000,
      [key]: 1234,
    })
    if (expired) s.setNow(1234 + 60_001)
    s.config.approverEnabled = true
    await restarted.tick()
    await restarted.tick()
    assert.equal(s.keys.length, 1)
    assert.equal(s.messages.length, expired ? 1 : 0)
    assert.deepEqual(
      await s.api.storage.get('approver.seen.v1'),
      expired ? ['older-prompt', key] : ['older-prompt'],
    )
    assert.deepEqual(
      await s.api.storage.get('approver.claims.v1'),
      expired
        ? { 'another-claim': 1000 }
        : { 'another-claim': 1000, [key]: 1234 },
    )
    if (expired)
      assert.match(s.messages[0]?.[2] ?? '', /Approval was interrupted/)
    restarted.dispose()
    await s.close()
  })
}

for (const failure of ['approver.claims.v1', 'approver.seen.v1']) {
  test(`startup retries migration after a transient ${failure} write failure`, async () => {
    const s = await setup()
    const [key] = (await s.api.storage.get('approver.seen.v1')) as string[]
    assert.ok(key)
    s.service.dispose()
    const legacy = ['older-prompt', { key, claimedAt: 1234 }]
    await s.api.storage.set('approver.seen.v1', legacy)
    s.setNow(1234 + 60_001)
    s.setStorageWriteFailure(failure)
    const restarted = s.make()
    await restarted.tick()
    assert.equal(s.keys.length, 1)
    assert.deepEqual(s.messages, [])
    assert.deepEqual(await s.api.storage.get('approver.seen.v1'), legacy)
    assert.equal(s.sched.pending.size, 1)
    s.setStorageWriteFailure(null)
    s.sched.fire()
    await restarted.tick()
    await restarted.tick()
    assert.equal(s.keys.length, 1)
    assert.equal(s.messages.length, 1)
    assert.match(s.messages[0]?.[2] ?? '', /Approval was interrupted/)
    assert.deepEqual(await s.api.storage.get('approver.seen.v1'), [
      'older-prompt',
      key,
    ])
    assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
    restarted.dispose()
    await s.close()
  })
}

test('edit approvals log the destination and hash the patch for dedupe', async () => {
  const s = await setup()
  const destination = `${WT}/new-file.txt`
  const screen = fixture('edit-outside-worktree')
    .replace('~/projects/unifier-sandbox/outside.txt', destination)
    .replace('/Users/example/projects/unifier-sandbox/outside.txt', destination)
  s.screen(screen)
  await s.service.tick()
  assert.equal(s.keys.length, 2)
  s.screen(`new scrollback\n${screen}`)
  await s.service.tick()
  assert.equal(s.keys.length, 2)
  s.screen(screen.replace('1 +outside', '1 +new content'))
  await s.service.tick()
  assert.equal(s.keys.length, 3)
  const logs = s.host.data().storage['approver.log'] as { command: string }[]
  assert.equal(logs[1]?.command, destination)
  await s.close()
})

test('a terminal read failure does not send keys and is retried on the next poll', async () => {
  const s = await setup()
  s.host.respond('terminal.read', () => {
    throw new Error('terminal unavailable')
  })
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.equal(s.sched.pending.size, 1)
  s.screen(command('uv run pytest'))
  s.sched.fire()
  await s.service.tick()
  assert.equal(s.keys.length, 2)
  await s.close()
})

for (const failure of ['read', 'write'] as const) {
  test(`a log ${failure} failure does not claim an untouched approval prompt`, async () => {
    const s = await setup()
    s.screen(command('uv run pytest'))
    s.setLogFailure(failure)
    await s.service.tick()
    assert.equal(s.keys.length, 1)
    assert.equal(
      (s.host.data().storage['approver.seen.v1'] as string[]).length,
      1,
    )
    s.setLogFailure(null)
    await s.service.tick()
    assert.equal(s.keys.length, 2)
    await s.close()
  })
}

test('disposal while a screen is being read prevents an approval', async () => {
  const s = await setup()
  let release!: (screen: { lines: string[]; truncated: boolean }) => void
  s.host.respond(
    'terminal.read',
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = s.service.tick()
  await settle()
  s.service.dispose()
  release({ lines: command('uv run pytest').split('\n'), truncated: false })
  await pending
  assert.equal(s.keys.length, 1)
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('a prompt replaced by git push before delivery sends no key', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  let reads = 0
  s.host.respond('terminal.read', () => ({
    lines: fixture(++reads === 1 ? 'read-only-command' : 'git-push').split(
      '\n',
    ),
    truncated: false,
  }))
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(reads, 2)
  assert.deepEqual(s.messages, [])
  await s.service.tick()
  assert.equal(s.messages.length, 1)
  assert.match(s.messages[0]?.[2] ?? '', /push origin/)
  await s.close()
})

test('a prompt replaced during the claim write sends no key and removes only its claim', async () => {
  const s = await setup({}, { enabled: false })
  await s.api.storage.set('approver.seen.v1', ['older-prompt'])
  s.config.approverEnabled = true
  s.setOnClaim(() => {
    s.setOnClaim(() => {})
    s.screen(command('git push --force origin main'))
  })
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.deepEqual(await s.api.storage.get('approver.seen.v1'), [
    'older-prompt',
  ])
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
  assert.deepEqual(s.messages, [])
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(s.messages.length, 1)
  assert.match(s.messages[0]?.[2] ?? '', /git push --force origin main/)
  await s.close()
})

for (const replacement of ['disappeared', 'unreadable', 'failed'] as const) {
  test(`a ${replacement} prompt on the final read sends no key`, async () => {
    const s = await setup({}, { enabled: false })
    s.config.approverEnabled = true
    let reads = 0
    s.host.respond('terminal.read', () => {
      if (++reads === 1)
        return {
          lines: fixture('read-only-command').split('\n'),
          truncated: false,
        }
      if (replacement === 'failed') throw new Error('terminal unavailable')
      return {
        lines:
          replacement === 'unreadable'
            ? ['Press enter to confirm or esc to cancel']
            : ['Working'],
        truncated: false,
      }
    })
    await s.service.tick()
    assert.deepEqual(s.keys, [])
    assert.equal(reads, 2)
    const seen = await s.api.storage.get('approver.seen.v1')
    assert.ok(!Array.isArray(seen) || seen.length === 0)
    assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
    await s.close()
  })
}

test('a final read that throws once retries the unchanged prompt on the next tick exactly once', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  let reads = 0
  let claimAtFinalRead: unknown
  s.host.respond('terminal.read', () => {
    if (++reads === 2) {
      claimAtFinalRead = s.host.data().storage['approver.claims.v1']
      throw new Error('terminal temporarily unavailable')
    }
    return {
      lines: fixture('read-only-command').split('\n'),
      truncated: false,
    }
  })
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(reads, 2)
  assert.ok(claimAtFinalRead && typeof claimAtFinalRead === 'object')
  assert.deepEqual(Object.values(claimAtFinalRead), [1234])
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
  const seen = await s.api.storage.get('approver.seen.v1')
  assert.ok(!Array.isArray(seen) || seen.length === 0)
  assert.equal(s.sched.pending.size, 1)
  s.sched.fire()
  await s.service.tick()
  await s.service.tick()
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  assert.equal(
    (s.host.data().storage['approver.seen.v1'] as string[]).length,
    1,
  )
  await s.close()
})

for (const currentAgent of ['claude', null]) {
  test(`a tracked Codex worker with current agent ${currentAgent} is never read`, async () => {
    const s = await setup({}, { enabled: false })
    s.config.approverEnabled = true
    s.setStates({
      [WORKER.workspaceId as string]: [agent({ agent: currentAgent })],
    })
    await s.worker.emit('agent.status.changed', {
      workspaceId: WORKER.workspaceId,
      terminalId: WORKER.terminalId,
      paneKey: 'worker-pane',
      state: 'waiting',
      receivedAt: 1234,
    })
    await s.service.tick()
    assert.deepEqual(s.host.callsOf('terminal.read'), [])
    assert.deepEqual(s.keys, [])
    await s.close()
  })
}

test('a summary matched by pane must also identify Codex before any read', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.setStates({
    [WORKER.workspaceId as string]: [
      agent({ terminalId: null, agent: 'claude' }),
    ],
  })
  await s.service.tick()
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  await s.close()
})

for (const project of ['alpha', 'Beta']) {
  test(`a worker whose repo main checkout is in ${project} is never read`, async () => {
    const s = await setup({}, { enabled: false })
    s.config.approverEnabled = true
    s.setWorktrees([
      worktree(),
      worktree({
        id: 'protected-main',
        path: `/Users/m/projects/${project}/api`,
        isMainWorktree: true,
      }),
    ])
    await s.service.tick()
    assert.deepEqual(s.host.callsOf('terminal.read'), [])
    assert.deepEqual(s.keys, [])
    assert.deepEqual(s.files, [])
    assert.equal(s.listCalls(), 1)
    await s.close()
  })
}

for (const missing of ['project', 'list'] as const) {
  test(`an unknown worker ${missing} skips terminal reads and retries discovery`, async () => {
    const s = await setup({}, { enabled: false })
    s.config.approverEnabled = true
    if (missing === 'project') s.setWorktrees([worktree()])
    if (missing === 'list') s.setWorktreeError(true)
    await s.service.tick()
    assert.deepEqual(s.host.callsOf('terminal.read'), [])
    assert.deepEqual(s.keys, [])
    assert.equal(s.sched.pending.size, 1)
    s.setWorktreeError(false)
    s.setWorktrees(listedWorktrees())
    s.sched.fire()
    await s.service.tick()
    assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
    await s.close()
  })
}

test('worktree discovery is shared by every worker in a poll', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.setWorkers([WORKER, { ...WORKER, terminalId: 'another-worker' }])
  s.setStates({
    [WORKER.workspaceId as string]: [
      agent(),
      agent({ terminalId: 'another-worker' }),
    ],
  })
  await s.service.tick()
  assert.equal(s.listCalls(), 1)
  assert.deepEqual(s.keys, [
    [WORKER.terminalId, 'y', false],
    ['another-worker', 'y', false],
  ])
  await s.close()
})

test('an escalation is marked seen only after durable enqueue resolves', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.screen(fixture('git-push'))
  let seenDuringEnqueue: unknown
  let release!: () => void
  s.setEnqueue(async () => {
    seenDuringEnqueue = await s.api.storage.get('approver.seen.v1')
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const pending = s.service.tick()
  await settle()
  assert.equal(typeof release, 'function')
  release()
  await pending
  assert.ok(!Array.isArray(seenDuringEnqueue) || seenDuringEnqueue.length === 0)
  assert.equal(
    (s.host.data().storage['approver.seen.v1'] as string[]).length,
    1,
  )
  await s.close()
})

test('a failed escalation enqueue is retried after a service restart', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.screen(fixture('git-push'))
  let attempts = 0
  s.setEnqueue(async (...args) => {
    if (++attempts === 1) throw new Error('enqueue unavailable')
    s.messages.push(args)
  })
  await s.service.tick()
  const seen = await s.api.storage.get('approver.seen.v1')
  assert.ok(!Array.isArray(seen) || seen.length === 0)
  s.service.dispose()
  const restarted = s.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(attempts, 2)
  assert.equal(s.messages.length, 1)
  restarted.dispose()
  await s.close()
})

test('a real messenger outbox failure leaves the escalation available after restart', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.screen(fixture('git-push'))
  const tracker = createTracker(s.api.storage)
  await tracker.recordOrchestrator({
    project: 'demo',
    workspaceId: 'hub::/Users/m/projects',
    terminalId: WORKER.orchestratorTerminalId,
    agent: 'claude',
    model: 'claude-opus-5-5',
    runId: null,
  })
  const delivered: [string, string, boolean][] = []
  let failWrite = true
  const messengerApi: OrcaWorkerApi = {
    ...s.api,
    storage: {
      ...s.api.storage,
      async set(key, value) {
        if (key === 'messenger.v1' && failWrite) {
          failWrite = false
          throw new Error('outbox write failed')
        }
        return s.api.storage.set(key, value)
      },
    },
  }
  const makeMessenger = () =>
    createMessenger(messengerApi, {
      tracker,
      cli: {
        async findRunId() {
          return null
        },
        async sendTerminalText(...args: [string, string, boolean]) {
          delivered.push(args)
        },
      } as unknown as OrcaCli,
      globalHubWorkspaceId: async () => 'hub::/Users/m/projects',
    })
  s.setEnqueue(makeMessenger().toOrchestrator)
  await s.service.tick()
  const seen = await s.api.storage.get('approver.seen.v1')
  assert.ok(!Array.isArray(seen) || seen.length === 0)
  assert.deepEqual(delivered, [])
  s.service.dispose()
  s.setEnqueue(makeMessenger().toOrchestrator)
  const restarted = s.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.[0], WORKER.orchestratorTerminalId)
  assert.match(delivered[0]?.[1] ?? '', /git -C \. push origin spike-codex/)
  assert.deepEqual(s.keys, [])
  assert.equal(
    (s.host.data().storage['approver.seen.v1'] as string[]).length,
    1,
  )
  restarted.dispose()
  await s.close()
})

test('an approval stays claimed when key delivery fails', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  let attempts = 0
  let claimedBeforeSend = false
  s.cli.sendTerminalText = async () => {
    attempts++
    const claims = await s.api.storage.get('approver.claims.v1')
    claimedBeforeSend =
      claims !== null &&
      typeof claims === 'object' &&
      Object.values(claims).length === 1
    throw new Error('uncertain key delivery')
  }
  await s.service.tick()
  s.service.dispose()
  const restarted = s.make()
  await restarted.tick()
  await restarted.tick()
  assert.ok(claimedBeforeSend)
  assert.equal(attempts, 1)
  const seen = await s.api.storage.get('approver.seen.v1')
  assert.ok(!Array.isArray(seen) || seen.length === 0)
  restarted.dispose()
  await s.close()
})

test('a restart between claiming an approval and sending its key never sends again', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.setOnClaim(() => s.service.dispose())
  await s.service.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(
    Object.keys(s.host.data().storage['approver.claims.v1'] as object).length,
    1,
  )
  const restarted = s.make()
  await restarted.tick()
  s.setNow(1234 + 60_000)
  await restarted.tick()
  assert.deepEqual(s.keys, [])
  assert.deepEqual(s.messages, [])
  s.setNow(1234 + 60_001)
  await restarted.tick()
  await restarted.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(s.messages.length, 1)
  assert.deepEqual(s.messages[0], [
    WORKER.orchestratorTerminalId,
    '[approver] ASK: worker needs approval',
    `Worker terminal: ${WORKER.terminalId}\nWorker assignment: ${WORKER.taskId}\nCommand: uname -a\nReason: Approval was interrupted; please check this prompt`,
  ])
  const logs = s.host.data().storage['approver.log'] as { verdict: string }[]
  assert.equal(logs.at(-1)?.verdict, 'escalate')
  restarted.dispose()
  const again = s.make()
  await again.tick()
  assert.deepEqual(s.keys, [])
  assert.equal(s.messages.length, 1)
  again.dispose()
  await s.close()
})

test('a stranded claim retries failed enqueue and is marked escalated only after enqueue resolves', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  s.setOnClaim(() => s.service.dispose())
  await s.service.tick()
  const claim = await s.api.storage.get('approver.claims.v1')
  s.setOnClaim(() => {})
  s.setNow(1234 + 60_001)
  let attempts = 0
  s.setEnqueue(async () => {
    attempts++
    throw new Error('enqueue unavailable')
  })
  const restarted = s.make()
  await restarted.tick()
  assert.equal(attempts, 1)
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), claim)
  restarted.dispose()
  let release!: () => void
  let seenDuringEnqueue: unknown
  s.setEnqueue(async (...args) => {
    attempts++
    seenDuringEnqueue = await s.api.storage.get('approver.claims.v1')
    await new Promise<void>((resolve) => {
      release = resolve
    })
    s.messages.push(args)
  })
  const again = s.make()
  const pending = again.tick()
  await settle()
  assert.equal(typeof release, 'function')
  assert.deepEqual(seenDuringEnqueue, claim)
  release()
  await pending
  await again.tick()
  assert.equal(attempts, 2)
  assert.equal(s.messages.length, 1)
  assert.deepEqual(s.keys, [])
  assert.deepEqual(await s.api.storage.get('approver.claims.v1'), {})
  assert.equal(
    ((await s.api.storage.get('approver.seen.v1')) as string[]).length,
    1,
  )
  again.dispose()
  const last = s.make()
  await last.tick()
  assert.equal(s.messages.length, 1)
  assert.deepEqual(s.keys, [])
  last.dispose()
  await s.close()
})

test('cursor moves and ANSI option highlights produce one escalation', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  const screen = fixture('git-push')
  s.screen(screen)
  await s.service.tick()
  const esc = String.fromCharCode(27)
  for (const marker of ['›', '>', '❯']) {
    for (const selected of [1, 2]) {
      s.screen(
        screen
          .replace('› 1.', '   1.')
          .replace(`  ${selected}.`, `  ${marker} ${esc}[7m${selected}.`)
          .replace(' (p)', ` (p)${esc}[0m   `),
      )
      await s.service.tick()
    }
  }
  assert.deepEqual(s.keys, [])
  assert.equal(s.messages.length, 1)
  s.screen(screen.replaceAll('push origin', 'push upstream'))
  await s.service.tick()
  assert.equal(s.messages.length, 2)
  await s.close()
})

test('cursor movement during final validation still approves the same prompt', async () => {
  const s = await setup({}, { enabled: false })
  s.config.approverEnabled = true
  let reads = 0
  s.host.respond('terminal.read', () => ({
    lines: (++reads === 1
      ? fixture('read-only-command')
      : fixture('read-only-command')
          .replace('› 1.', '  1.')
          .replace('  2.', '> 2.')
    ).split('\n'),
    truncated: false,
  }))
  await s.service.tick()
  assert.equal(reads, 2)
  assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
  await s.close()
})

test('worker activation wires tracker, board states and the approver', async () => {
  const keys: unknown[] = []
  const sched = scheduler()
  const host = mockHost({
    settings: { projectsRoot: '/Users/m/projects' },
    storage: {
      'tracker.v1': { workers: [WORKER], orchestrators: [], launches: [] },
    } as never,
  })
  host.respond('terminal.read', {
    lines: command('uv run pytest').split('\n'),
    truncated: false,
  })
  const cli = {
    async listWorktrees() {
      return listedWorktrees()
    },
    async worktreeSummaries() {
      return {
        summaries: [{ id: WORKER.workspaceId, agents: [agent()] }],
        truncated: false,
      }
    },
    async sendTerminalText(...args: unknown[]) {
      keys.push(args)
    },
  } as unknown as OrcaCli
  let dispose!: () => void
  const worker = await mountWorker(
    {
      default: (orca) => {
        dispose = main.activateWith(orca, {
          cli,
          schedule: sched.schedule,
          fs: { ...nodeFs, realpath: async (p) => p, read: async () => '{}' },
        })
      },
      deactivate: () => dispose(),
    },
    { host },
  )
  await settle()
  assert.deepEqual(keys, [[WORKER.terminalId, 'y', false]])
  await worker.deactivate()
  assert.equal(sched.pending.size, 0)
})

for (const error of [
  new Error('plugin is not enabled with current consent'),
  hostError('consent_required', 'Consent changed'),
  hostError('not_permitted', 'Permission changed'),
]) {
  test(`approval terminal polling retires without another read: ${error.message}`, async () => {
    const s = await setup()
    try {
      const start = s.worker.logs.length
      let reads = 0
      s.host.respond('terminal.read', () => {
        reads++
        throw error
      })
      s.sched.fire()
      await settle()
      await s.service.tick()
      assert.equal(reads, 1)
      assert.equal(s.sched.pending.size, 0)
      assert.deepEqual(s.worker.logs.slice(start), ['retired: consent changed'])
    } finally {
      await s.close()
    }
  })
}

test('B1: a cleared approved prompt occurrence escalates after restart', async () => {
  const s = await setup()
  s.screen('working')
  await s.service.tick()
  s.service.dispose()
  s.screen(fixture('read-only-command'))
  const restarted = s.make()
  await restarted.tick()
  assert.equal(s.keys.length, 1)
  assert.equal(s.messages.length, 1)
  assert.match(s.messages[0]?.[2] ?? '', /previously approved/)
  await restarted.tick()
  assert.equal(s.messages.length, 1)
  restarted.dispose()
  await s.close()
})

for (const source of ['event', 'poll'] as const) {
  for (const state of ['working', 'done'] as const) {
    for (const first of ['approved', 'escalated'] as const) {
      test(`resuming via ${source} ${state} ends an ${first} prompt occurrence`, async () => {
        const s = await setup({}, { enabled: false })
        const screen = fixture(
          first === 'approved' ? 'read-only-command' : 'git-push',
        )
        s.screen(screen)
        s.config.approverEnabled = true
        await s.service.tick()
        const reads = s.host.callsOf('terminal.read').length
        const initialMessages = first === 'approved' ? 0 : 1
        assert.equal(s.messages.length, initialMessages)
        if (source === 'event') {
          // Events must persist the boundary even if summary discovery fails.
          s.setBoardError(true)
          await s.worker.emit('agent.status.changed', {
            workspaceId: WORKER.workspaceId,
            terminalId: WORKER.terminalId,
            paneKey: 'worker-pane',
            state,
            receivedAt: 1234,
          })
        } else {
          s.setStates({
            [WORKER.workspaceId as string]: [agent({ state, updatedAt: 1234 })],
          })
        }
        await s.service.tick()
        assert.equal(s.host.callsOf('terminal.read').length, reads)
        s.service.dispose()
        s.setBoardError(false)
        s.setStates({ [WORKER.workspaceId as string]: [agent()] })
        const restarted = s.make()
        try {
          await restarted.tick()
          await restarted.tick()
          assert.equal(s.keys.length, first === 'approved' ? 1 : 0)
          assert.equal(s.messages.length, initialMessages + 1)
          if (first === 'approved')
            assert.match(s.messages.at(-1)?.[2] ?? '', /previously approved/)
        } finally {
          restarted.dispose()
          await s.close()
        }
      })
    }
  }
}

test('B1: a different prompt clears the prior occurrence, including escalations', async () => {
  const s = await setup()
  s.screen(fixture('git-push'))
  await s.service.tick()
  s.screen(fixture('read-only-command'))
  await s.service.tick()
  assert.equal(s.keys.length, 1)
  assert.equal(s.messages.length, 2)
  s.screen(fixture('git-push'))
  await s.service.tick()
  assert.equal(s.messages.length, 3)
  await s.close()
})

test('B4: a removed worktree stops polling even when agent summaries fail', async () => {
  const s = await setup({}, { enabled: false, boardError: true })
  s.config.approverEnabled = true
  s.setWorktrees([])
  await s.service.tick()
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('partial agent summaries approve a present Worker and skip an absent Worker', async () => {
  const s = await setup({}, { enabled: false, truncated: true })
  const missing = {
    ...WORKER,
    terminalId: 'term_absent',
    workspaceId: 'repo::/Users/m/projects/demo/absent',
  }
  s.setWorkers([missing, WORKER])
  s.setWorktrees([
    ...listedWorktrees(),
    worktree({
      id: missing.workspaceId,
      path: '/Users/m/projects/demo/absent',
    }),
  ])
  s.config.approverEnabled = true
  try {
    await s.service.tick()
    assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
    assert.deepEqual(s.messages, [])
    assert.ok(s.host.callsOf('terminal.read').length > 0)
    assert.ok(
      s.host
        .callsOf('terminal.read')
        .every(
          (c) => (c as { terminalId: string }).terminalId === WORKER.terminalId,
        ),
    )
    const reads = s.host.callsOf('terminal.read').length
    s.setWorkers([missing])
    await s.service.tick()
    assert.equal(s.host.callsOf('terminal.read').length, reads)
    assert.equal(s.sched.pending.size, 1)
  } finally {
    await s.close()
  }
})

test('keeps polling a waiting Worker missing from a truncated summary until its prompt is handled', async () => {
  const s = await setup({}, { enabled: false, truncated: true })
  s.setStates({})
  s.config.approverEnabled = true
  try {
    await s.service.tick()
    assert.deepEqual(s.host.callsOf('terminal.read'), [])
    assert.deepEqual(s.keys, [])
    assert.deepEqual(
      [...s.sched.pending].map((p) => p.ms),
      [3000],
    )

    s.setStates({ [WORKER.workspaceId as string]: [agent()] })
    s.sched.fire()
    await s.service.tick()
    assert.deepEqual(s.keys, [[WORKER.terminalId, 'y', false]])
    assert.deepEqual(s.messages, [])
  } finally {
    await s.close()
  }
})

test('B2: manual relaunch of a retained Worker terminal removes approver ownership', async () => {
  const s = await setup({}, { enabled: false })
  const tracker = createTracker(s.api.storage)
  await tracker.recordWorker(WORKER)
  await tracker.recordLaunch({
    terminalId: WORKER.terminalId,
    workspaceId: WORKER.workspaceId,
    agent: 'codex',
    model: null,
    bypass: [],
    at: 10,
  })
  s.setWorkers(await tracker.workers())
  s.config.approverEnabled = true
  await s.service.tick()
  assert.deepEqual(await tracker.workers(), [])
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  await s.close()
})

test('B1: an enqueue failure on a later occurrence remains retryable', async () => {
  const s = await setup()
  s.screen(fixture('git-push'))
  await s.service.tick()
  s.screen('working')
  await s.service.tick()
  s.screen(fixture('git-push'))
  s.setEnqueue(async () => {
    throw new Error('storage unavailable')
  })
  await s.service.tick()
  s.setEnqueue(async (...args) => {
    s.messages.push(args)
  })
  await s.service.tick()
  assert.equal(s.messages.length, 2)
  await s.close()
})

test('C3: approver excludes a Beta repo Worktree located under projects/demo', async () => {
  const path = '/Users/m/projects/demo/manual'
  const s = await setup({ workspaceId: `repo::${path}` }, { enabled: false })
  s.setWorktrees([
    worktree({ id: `repo::${path}`, path }),
    worktree({
      id: 'repo::/Users/m/projects/Beta/main',
      path: '/Users/m/projects/Beta/main',
      isMainWorktree: true,
    }),
  ])
  s.setStates({ [`repo::${path}`]: [agent()] })
  s.config.approverEnabled = true
  await s.service.tick()
  assert.deepEqual(s.host.callsOf('terminal.read'), [])
  assert.equal(s.sched.pending.size, 0)
  await s.close()
})

test('approver passes configured protected names to the policy', async () => {
  const s = await setup()
  s.config.protectedPaths = ['vault']
  s.screen(command(`cat ${WT}/vault/key`))
  const before = s.keys.length
  await s.service.tick()
  assert.equal(s.keys.length, before)
  assert.equal(s.messages.length, 1)
  assert.ok(s.messages[0]?.[2].includes('protected path'))
  await s.close()
})
