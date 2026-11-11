import { assert, hostError, test } from 'orca/testing'
import { createConsentBackoff, isConsentError } from './retirement'

test('consent retry increases its delay, caps at 60 seconds and limits logs', () => {
  const pending = new Set<{ fn: () => void; ms: number }>()
  const logs: string[] = []
  let retries = 0
  const backoff = createConsentBackoff(
    (line) => logs.push(`[instance] ${line}`),
    (fn, ms) => {
      const entry = { fn, ms }
      pending.add(entry)
      return () => pending.delete(entry)
    },
    () => retries++,
  )
  const error = hostError('consent_required', 'Consent is being applied')
  for (const ms of [1000, 2000, 5000, 15000, 60000, 60000, 60000]) {
    assert.equal(backoff.handle(error), true)
    backoff.handle(error)
    assert.equal(pending.size, 1)
    const entry = [...pending][0]
    assert.equal(entry?.ms, ms)
    pending.clear()
    entry?.fn()
  }
  assert.equal(retries, 7)
  assert.equal(logs.length, 5)
  assert.ok(logs.every((line) => line.startsWith('[instance] ')))
  backoff.dispose()
})

test('a successful host call resets delay and logging without losing a retry', () => {
  let scheduled: { fn: () => void; ms: number } | null = null
  let retries = 0
  const logs: string[] = []
  const backoff = createConsentBackoff(
    (line) => logs.push(line),
    (fn, ms) => {
      scheduled = { fn, ms }
      return () => {
        scheduled = null
      }
    },
    () => retries++,
  )
  const error = new Error('plugin is not enabled with current consent')
  backoff.handle(error)
  ;(scheduled as { fn: () => void } | null)?.fn()
  backoff.handle(error)
  assert.equal((scheduled as { ms: number } | null)?.ms, 2000)
  assert.equal(backoff.success('host result'), 'host result')
  ;(scheduled as { fn: () => void } | null)?.fn()
  assert.equal(retries, 2)
  backoff.handle(error)
  assert.equal((scheduled as { ms: number } | null)?.ms, 1000)
  assert.equal(logs.length, 3)
  backoff.dispose()
})

test('dispose cancels consent retry and makes stale callbacks inert', () => {
  const pending = new Set<() => void>()
  let retries = 0
  const backoff = createConsentBackoff(
    () => {},
    (fn) => {
      pending.add(fn)
      return () => pending.delete(fn)
    },
    () => retries++,
  )
  backoff.handle('consent_required')
  const callback = [...pending][0]
  assert.equal(pending.size, 1)
  backoff.dispose()
  assert.equal(pending.size, 0)
  callback?.()
  backoff.handle('consent_required')
  assert.equal(retries, 0)
  assert.equal(pending.size, 0)
})

test('unrelated errors do not trigger consent retry', () => {
  const backoff = createConsentBackoff(
    () => assert.fail('unrelated error logged as consent'),
    () => {
      throw new Error('unrelated error scheduled as consent')
    },
    () => {},
  )
  assert.equal(backoff.handle(new Error('terminal disappeared')), false)
  assert.equal(isConsentError(null), false)
  assert.equal(isConsentError('consent_required'), true)
  assert.equal(
    isConsentError(hostError('not_permitted', 'Permission changed')),
    true,
  )
  backoff.dispose()
})
