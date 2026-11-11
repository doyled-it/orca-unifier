import { assert, test } from 'orca/testing'
import { evaluateRemoval, type RemovalFacts } from './cleanup'

const safe: RemovalFacts = {
  isMainWorktree: false,
  isPinned: false,
  isHub: false,
  dirty: false,
  hasUpstream: true,
  ahead: 0,
  merge: 'merged',
  liveAgent: false,
}

test('removes only when every removal rule is safe', () => {
  assert.deepEqual(evaluateRemoval(safe), { remove: true })
})

const vetoes: [string, Partial<RemovalFacts>, RegExp][] = [
  ['main worktree', { isMainWorktree: true }, /main worktree/i],
  ['pinned', { isPinned: true }, /pinned/i],
  ['hub', { isHub: true }, /hub/i],
  ['dirty', { dirty: true }, /dirty/i],
  ['upstream', { hasUpstream: false }, /upstream/i],
  ['ahead', { ahead: 1 }, /ahead/i],
  ['merged', { merge: 'unmerged' }, /merg/i],
  ['live agent', { liveAgent: true }, /live agent/i],
  ['unknown dirty', { dirty: 'unknown' }, /dirty/i],
  ['unknown upstream', { hasUpstream: 'unknown' }, /upstream/i],
  ['unknown ahead', { ahead: 'unknown' }, /ahead/i],
  ['unknown merge', { merge: 'unknown' }, /merg/i],
]

for (const [rule, facts, reason] of vetoes) {
  test(`keeps a worktree when the ${rule} rule is unsafe`, () => {
    const result = evaluateRemoval({ ...safe, ...facts })
    assert.equal(result.remove, false)
    if (!result.remove) assert.match(result.reason, reason)
  })
}

for (const ahead of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`keeps an invalid ahead count of ${ahead}`, () => {
    assert.equal(evaluateRemoval({ ...safe, ahead }).remove, false)
  })
}
