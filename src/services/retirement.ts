import type { Schedule } from './board-service'

/** Reload and activation can reject host calls briefly while consent is applied. */
export function isConsentError(error: unknown): boolean {
  if (typeof error === 'string')
    return (
      error.includes('not enabled with current consent') ||
      error.includes('consent_required')
    )
  if (!error || typeof error !== 'object') return false
  const { message, code } = error as { message?: unknown; code?: unknown }
  return (
    code === 'consent_required' ||
    code === 'not_permitted' ||
    (typeof message === 'string' &&
      (message.includes('not enabled with current consent') ||
        message.includes('consent_required')))
  )
}

const DELAYS = [1000, 2000, 5000, 15000, 60000] as const

const scheduleTimeout: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

export function createConsentBackoff(
  log: (message: string) => void,
  schedule: Schedule = scheduleTimeout,
  retry: () => void,
) {
  let disposed = false
  let step = 0
  let logged = -1
  let cancel: (() => void) | null = null
  return {
    get pending() {
      return cancel !== null
    },
    handle(error: unknown): boolean {
      if (!isConsentError(error)) return false
      if (disposed || cancel) return true
      const ms = DELAYS[step] as number
      if (logged < step) {
        log(`unifier: consent unavailable; retrying in ${ms / 1000}s`)
        logged = step
      }
      step = Math.min(step + 1, DELAYS.length - 1)
      cancel = schedule(() => {
        cancel = null
        if (!disposed) retry()
      }, ms)
      return true
    },
    /** Promise continuation for each successful host, storage or settings call. */
    success<T>(value: T): T {
      step = 0
      logged = -1
      return value
    },
    dispose() {
      disposed = true
      cancel?.()
      cancel = null
    },
  }
}
