import { assert, mountWorker, test } from 'orca/testing'
import type { OrcaCli } from './adapters/orca-cli'
import * as main from './worker'

test('activates with no refusals', async () => {
  const worker = await mountWorker(main)
  assert.deepEqual(worker.refusals, [])
  assert.ok(
    worker.logs.some((line) =>
      /^\[[a-f0-9]{6}\] unifier: activated$/.test(line),
    ),
  )
  await worker.deactivate()
})

test('worker instances tag every service log with their own id', async () => {
  async function instance() {
    let stop = () => {}
    return mountWorker({
      default(orca) {
        stop = main.activateWith(orca, {
          cli: {
            async listWorktrees() {
              throw new Error('Unavailable\nTry later')
            },
          } as unknown as OrcaCli,
        })
      },
      deactivate() {
        stop()
      },
    })
  }
  const first = await instance()
  const second = await instance()
  try {
    const id = (logs: readonly string[]) =>
      /^\[([a-f0-9]{6})\]/.exec(
        logs.find((line) => line.includes('unifier: activated')) ?? '',
      )?.[1]
    assert.ok(id(first.logs))
    assert.ok(id(second.logs))
    assert.notEqual(id(first.logs), id(second.logs))
    for (const w of [first, second]) {
      await w.command('unifier.cleanupDryRun')
      assert.ok(
        w.logs
          .flatMap((message) => message.split('\n'))
          .every((line) => line.startsWith(`[${id(w.logs)}] `)),
      )
    }
  } finally {
    await first.deactivate()
    await second.deactivate()
  }
})
