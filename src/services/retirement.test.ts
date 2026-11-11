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

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}

for (const failure of [
  () => new Error('plugin is not enabled with current consent'),
  () => hostError('consent_required', 'Consent was changed'),
  () => hostError('not_permitted', 'Permission was removed'),
]) {
  for (const loop of [
    'approver storage',
    'setup queue',
    'setup notes',
    'cleanup timer',
    'messenger storage',
    'messenger enqueue',
    'messenger host',
    'messenger liveness',
    'board storage',
    'board request',
    'board debounce',
  ]) {
    test(`${loop} retires once and stops work for ${failure().message}`, async () => {
      const host = mockHost()
      let api!: OrcaWorkerApi
      const worker = await mountWorker(
        {
          default(orca) {
            api = orca
          },
        },
        { host },
      )
      const pending = new Set<() => void>()
      const schedule: Schedule = (fn) => {
        pending.add(fn)
        return () => {
          pending.delete(fn)
        }
      }
      const fire = () => {
        for (const fn of [...pending]) {
          pending.delete(fn)
          fn()
        }
      }
      const logs: string[] = []
      let calls = 0
      let broken = true
      const fail = () => {
        calls++
        throw failure()
      }
      const settings = async () => parseSettings({}, '/Users/m')
      let dispose = () => {}
      let again: () => Promise<unknown> = async () => {}
      let messenger: ReturnType<typeof createMessenger> | undefined
      const base = { ...api, log: (line: string) => logs.push(line) }
      try {
        if (loop === 'approver storage') {
          const service = createApproverService(
            { ...base, storage: { ...api.storage, get: async () => fail() } },
            {
              tracker: { workers: async () => [] },
              cli: {} as OrcaCli,
              messenger: { toOrchestrator: async () => {} },
              board: {
                agentStates: async () => ({ states: {}, truncated: false }),
              },
              fs: nodeFs,
              settings,
              schedule,
            },
          )
          dispose = service.dispose
          again = service.tick
          await service.tick()
        } else if (loop.startsWith('setup')) {
          const service = createSetupService(
            {
              ...base,
              storage: {
                ...api.storage,
                get: async (key) => {
                  if (loop === 'setup queue') return fail()
                  if (key === 'setup.v1')
                    return [
                      {
                        id: 'job',
                        at: Date.now(),
                        workspaceId: 'repo::/worktree',
                        path: '/worktree',
                        report: '/worktree/.unifier/setup-report.md',
                      },
                    ]
                  return api.storage.get(key)
                },
              },
            },
            {
              cli: {
                listWorktrees: async () =>
                  [
                    {
                      repoId: 'repo',
                      path: '/worktree',
                      isMainWorktree: false,
                    },
                    {
                      repoId: 'repo',
                      path: '/Users/m/projects/demo/repo',
                      isMainWorktree: true,
                    },
                  ] as WorktreeRecord[],
              },
              exec: async () => ({ code: 0, stdout: '', stderr: '' }),
              fs: {
                ...nodeFs,
                realpath: async (p) => p,
                read: async () => 'Setup gaps',
              },
              settings,
              schedule,
              tracker: { ownerOfWorkspace: async () => 'owner' },
              messenger: { toOrchestrator: async () => fail() },
            },
          )
          dispose = service.dispose
          again = async () => {
            await worker.hooks.fire('workspace.create.after', {
              workspaceId: 'repo::/worktree',
              path: '/worktree',
              kind: 'worktree',
              branch: 'feature',
            })
          }
          fire()
        } else if (loop === 'cleanup timer') {
          const service = createCleanupService(
            { ...base, storage: { ...api.storage, get: async () => fail() } },
            {
              cli: {
                listWorktrees: async () => [],
                removeWorktree: async () => {},
                hideExternalWorktrees: async () => {},
              },
              exec: async () => ({ code: 0, stdout: '', stderr: '' }),
              board: {
                agentStates: async () => ({ states: {}, truncated: false }),
              },
              settings,
              schedule,
            },
          )
          dispose = service.dispose
          await settle()
          fire()
          again = async () => {
            await worker.emit('workspace.changed', { context: null })
            await worker.emit('workspace.changed', { context: null })
          }
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
          const wrapped = {
            ...base,
            host: { ...api.host, call: async () => fail() },
            storage: {
              ...api.storage,
              get: async (key: string) => {
                if (
                  broken &&
                  (loop === 'messenger storage' || loop === 'messenger enqueue')
                )
                  return fail()
                return api.storage.get(key)
              },
            },
          } as OrcaWorkerApi
          messenger = createMessenger(wrapped, {
            tracker,
            cli: {} as OrcaCli,
            globalHubWorkspaceId: async () => 'hub',
          })
          if (loop === 'messenger liveness')
            await api.storage.set('messenger.v1', {
              terminalId: 'sender',
              outbox: [],
            })
          if (loop === 'messenger enqueue') {
            const m = messenger
            again = () =>
              assert.rejects(() => m.enqueue('owner', 'Setup gaps', 'message'))
            await again()
          } else {
            if (loop !== 'messenger storage')
              await messenger.enqueue('owner', 'Setup gaps', 'message')
            again = messenger.flush
            await messenger.flush()
          }
        } else {
          const service = createBoardService(
            {
              ...base,
              panels: { ...api.panels, post: () => fail() },
              storage: {
                ...api.storage,
                keys: async () => (loop === 'board storage' ? fail() : []),
              },
            },
            {
              async worktreeSummaries() {
                return { summaries: [], truncated: false }
              },
            } as unknown as OrcaCli,
            loop === 'board request' ? async () => fail() : settings,
            schedule,
          )
          dispose = service.dispose
          if (loop === 'board request')
            await worker.request('board.get', { filter: { scope: 'global' } })
          await settle()
          again = async () => {
            await worker.emit('workspace.changed', { context: null })
          }
          await again()
          fire()
        }
        await settle()
        assert.deepEqual(logs, ['retired: consent changed'])
        assert.equal(calls, 1)
        assert.equal(pending.size, 0)
        broken = false
        await again()
        fire()
        await settle()
        assert.equal(calls, 1)
        assert.equal(pending.size, 0)
        assert.deepEqual(logs, ['retired: consent changed'])
      } finally {
        dispose()
        messenger?.dispose?.()
        await worker.deactivate()
      }
    })
  }
}
