/** Consent failures belong to an obsolete worker instance and cannot be retried. */
export function isConsentError(error: unknown): boolean {
  if (typeof error === 'string')
    return error.includes('not enabled with current consent')
  if (!error || typeof error !== 'object') return false
  const { message, code } = error as { message?: unknown; code?: unknown }
  return (
    code === 'consent_required' ||
    code === 'not_permitted' ||
    (typeof message === 'string' &&
      message.includes('not enabled with current consent'))
  )
}

export function createRetirement(
  log: (message: string) => void,
  stop: () => void,
) {
  let retired = false
  return (error: unknown): boolean => {
    if (!isConsentError(error)) return false
    if (!retired) {
      retired = true
      stop()
      log('retired: consent changed')
    }
    return true
  }
}
