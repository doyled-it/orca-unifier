import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { worktreeExclusionReason } from './worktree-exclusion'

for (const missing of ['worktree', 'main', 'main-record']) {
  test(`C3: unresolved identity ${missing} is excluded`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'unifier-exclusion-'))
    const path = join(root, 'demo', 'child')
    const main = join(root, 'demo', 'main')
    try {
      if (missing !== 'worktree') await mkdir(path, { recursive: true })
      if (missing !== 'main') await mkdir(main, { recursive: true })
      const reason = await worktreeExclusionReason(
        { path, repoId: 'r' },
        missing === 'main-record' ? new Map() : new Map([['r', main]]),
        root,
        [],
      )
      assert.ok(
        reason?.includes('could not be resolved'),
        reason ?? 'allowed an unresolved identity',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
