import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { nodeFs } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { parseSettings } from '../core/settings'
import type { WorktreeRecord } from '../core/types'
import { createApproverService } from './approver-service'
import { createBoardService, type Schedule } from './board-service'
import { createCleanupService } from './cleanup-service'
import { createMessenger } from './messenger'
import { createSetupService } from './setup-service'
import { createTracker } from './tracker'
import { createWorkerDefaultsService } from './worker-defaults-service'

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

function scheduler() {
  const pending = new Set<{ fn: () => void; ms: number }>()
  const schedule: Schedule = (fn, ms) => {
    const entry = { fn, ms }
    pending.add(entry)
    return () => {
      pending.delete(entry)
    }
  }
  return {
    pending,
    schedule,
    async fire() {
      for (const entry of [...pending]) {
        pending.delete(entry)
        entry.fn()
      }
      await settle()
    },
  }
}

const loops = [
  'approver storage',
  'setup queue',
  'setup notes',
  'cleanup timer',
  'cleanup settings',
  'Worker defaults refresh',
  'messenger storage',
  'messenger host',
  'messenger liveness',
  'board storage',
  'board debounce',
] as const

type Loop = (typeof loops)[number]

function worktree(path: string, main = false): WorktreeRecord {
  return {
    id: `repo::${path}`,
    identityKey: `wt2:local:${main ? 'main' : 'child'}`,
    projectId: 'project',
    repoId: 'repo',
    path,
    branch: main ? 'main' : 'feature',
    displayName: 'demo',
    isMainWorktree: main,
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
  }
}

async function scenario(loop: Loop, failure: () => Error) {
  const host = mockHost()
  let api!: OrcaWorkerApi
  const worker = await mountWorker(
    {
      default: (orca) => {
        api = orca
      },
    },
    { host },
  )
  const sched = scheduler()
  const logs: string[] = []
  let attempts = 0
  let completed = 0
  let dispose = () => {}
  let now = 100_000
  const failTwice = () => {
    attempts++
    if (attempts <= 2) throw failure()
  }
  const settings = async () => parseSettings({}, '/Users/m')
  const base = {
    ...api,
    log: (message: string) => logs.push(`[instance] ${message}`),
  }

  if (loop === 'approver storage') {
    const service = createApproverService(
      {
        ...base,
        storage: {
          ...api.storage,
          get: async (key) => {
            failTwice()
            return api.storage.get(key)
          },
        },
      },
      {
        tracker: {
          workers: async () => {
            completed++
            return []
          },
        },
        cli: {} as OrcaCli,
        messenger: { toOrchestrator: async () => {} },
        board: { agentStates: async () => ({ states: {}, truncated: false }) },
        fs: nodeFs,
        settings,
        schedule: sched.schedule,
      },
    )
    dispose = service.dispose
    await service.tick()
  } else if (loop.startsWith('setup')) {
    await api.storage.set('setup.v1', [
      {
        id: 'job',
        at: Date.now(),
        workspaceId: 'repo::/worktree',
        path: '/worktree',
        report: '/worktree/.unifier/setup-report.md',
      },
    ])
    const service = createSetupService(
      {
        ...base,
        storage: {
          ...api.storage,
          get: async (key) => {
            if (loop === 'setup queue' && key === 'setup.v1') failTwice()
            return api.storage.get(key)
          },
        },
      },
      {
        cli: {
          listWorktrees: async () => [
            worktree('/worktree'),
            worktree('/Users/m/projects/demo/repo', true),
          ],
        },
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        fs: {
          ...nodeFs,
          realpath: async (p) => p,
          read: async () => 'Setup gaps',
        },
        settings,
        schedule: sched.schedule,
        tracker: { ownerOfWorkspace: async () => 'owner' },
        messenger: {
          toOrchestrator: async () => {
            if (loop === 'setup notes') failTwice()
            completed++
          },
        },
      },
    )
    dispose = service.dispose
    await sched.fire()
  } else if (loop.startsWith('cleanup')) {
    const service = createCleanupService(
      {
        ...base,
        storage: {
          ...api.storage,
          get: async (key) => {
            if (loop === 'cleanup timer' && key === 'cleanup.lastAutoAt.v1')
              failTwice()
            return api.storage.get(key)
          },
        },
      },
      {
        cli: {
          listWorktrees: async () => [],
          removeWorktree: async () => {},
          hideExternalWorktrees: async () => {},
        },
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        board: {
          agentStates: async () => {
            completed++
            return { states: {}, truncated: false }
          },
        },
        settings: async () => {
          if (loop === 'cleanup settings') failTwice()
          return settings()
        },
        schedule: sched.schedule,
        now: () => now,
      },
    )
    dispose = service.dispose
    await settle()
    if (loop === 'cleanup timer') await sched.fire()
  } else if (loop === 'Worker defaults refresh') {
    const service = createWorkerDefaultsService(
      {
        ...base,
        panels: {
          ...api.panels,
          post: () => {
            completed++
          },
        },
      },
      {
        settings: async () => {
          failTwice()
          return settings()
        },
        fs: { ...nodeFs, list: async () => [] },
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        home: '/Users/m',
        schedule: sched.schedule,
      },
    )
    dispose = service.dispose
    await api.settings.set('workerImplementation', 'codex:changed')
  } else if (loop.startsWith('messenger')) {
    const tracker = createTracker(api.storage)
    await tracker.recordOrchestrator({
      terminalId: 'owner',
      workspaceId: 'hub',
      project: 'demo',
      agent: 'claude',
      model: 'model',
      runId: 'run',
    })
    await api.storage.set('messenger.v1', {
      terminalId: loop === 'messenger liveness' ? 'sender' : null,
      outbox: [
        {
          id: 'message',
          to: 'owner',
          subject: 'Setup gaps',
          body: 'message',
          attempts: 0,
          inFlightAt: null,
        },
      ],
    })
    host.respond('terminal.read', () => {
      failTwice()
      return { lines: [], truncated: false }
    })
    host.respond('terminal.create', () => {
      if (loop === 'messenger host') failTwice()
      return { terminalId: 'sender' }
    })
    const service = createMessenger(
      {
        ...base,
        storage: {
          ...api.storage,
          get: async (key) => {
            if (loop === 'messenger storage' && key === 'messenger.v1')
              failTwice()
            return api.storage.get(key)
          },
        },
      },
      {
        tracker,
        cli: {
          sendOrchestrationMessage: async () => {
            completed++
          },
        } as unknown as OrcaCli,
        globalHubWorkspaceId: async () => 'hub',
        schedule: sched.schedule,
        now: () => now,
      },
    )
    dispose = service.dispose
    await service.flush()
  } else {
    await api.storage.set('agents.v1', { stale: true })
    const service = createBoardService(
      {
        ...base,
        storage: {
          ...api.storage,
          keys: async () => {
            if (loop === 'board storage') failTwice()
            return api.storage.keys()
          },
          delete: async (key) => {
            await api.storage.delete(key)
            if (loop === 'board storage' && key === 'agents.v1') completed++
          },
        },
        panels: {
          ...api.panels,
          post: () => {
            if (loop === 'board debounce') failTwice()
            if (loop === 'board debounce') completed++
          },
        },
      },
      {
        worktreeSummaries: async () => ({ summaries: [], truncated: false }),
      } as unknown as OrcaCli,
      settings,
      sched.schedule,
    )
    dispose = service.dispose
    await settle()
    if (loop === 'board debounce') {
      await worker.emit('workspace.changed', { context: null })
      await sched.fire()
    }
  }
  await settle()
  return {
    worker,
    host,
    sched,
    logs,
    get attempts() {
      return attempts
    },
    get completed() {
      return completed
    },
    dispose,
    async fire() {
      now += 60_000
      await sched.fire()
    },
    async close() {
      dispose()
      await worker.deactivate()
    },
  }
}

for (const failure of [
  () => new Error('plugin is not enabled with current consent'),
  () => hostError('consent_required', 'Consent was changed'),
  () => hostError('not_permitted', 'Permission was removed'),
]) {
  for (const loop of loops) {
    test(`${loop} resumes after two transient failures: ${failure().message}`, async () => {
      const s = await scenario(loop, failure)
      try {
        assert.equal(s.attempts, 1)
        assert.equal(s.sched.pending.size, 1)
        assert.equal([...s.sched.pending][0]?.ms, 1000)
        await s.fire()
        assert.equal(s.attempts, 2)
        assert.equal(s.sched.pending.size, 1)
        const delay = [...s.sched.pending][0]?.ms
        assert.ok(delay === 1000 || delay === 2000)
        for (let i = 0; i < 4 && s.completed === 0; i++) await s.fire()
        assert.ok(s.attempts >= 3)
        assert.equal(s.completed, 1)
        assert.ok(s.logs.every((line) => line.startsWith('[instance] ')))
        assert.ok(!s.logs.some((line) => line.includes('retired')))
        if (loop.startsWith('setup'))
          assert.deepEqual(s.host.data().storage['setup.v1'], [])
        if (loop.startsWith('messenger')) {
          const stored = s.host.data().storage['messenger.v1'] as {
            outbox: unknown[]
          }
          assert.deepEqual(stored.outbox, [])
        }
      } finally {
        await s.close()
      }
    })

    test(`${loop} disposal cancels consent retries: ${failure().message}`, async () => {
      const s = await scenario(loop, failure)
      try {
        assert.equal(s.attempts, 1)
        assert.equal(s.sched.pending.size, 1)
        const callbacks = [...s.sched.pending].map((entry) => entry.fn)
        s.dispose()
        assert.equal(s.sched.pending.size, 0)
        for (const callback of callbacks) callback()
        await settle()
        assert.equal(s.attempts, 1)
        assert.equal(s.sched.pending.size, 0)
        assert.equal(s.completed, 0)
      } finally {
        await s.close()
      }
    })
  }
}
