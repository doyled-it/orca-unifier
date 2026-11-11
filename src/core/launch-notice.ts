/** Notice content shared by launch checks and queued-message migration. */
export const WRONG_LAUNCH_SUBJECT =
  '[unifier] Worker launched with the wrong settings'

/** Retire pre-defaults model advice while preserving applicable bypass advice. */
export function withoutModelAdvice(
  subject: string,
  body: string,
): string | null {
  if (
    subject !== WRONG_LAUNCH_SUBJECT ||
    !/^- It was started (?:with|without) --model\b/m.test(body)
  )
    return body
  const lines = body.split('\n')
  const bypass = lines.filter(
    (line) =>
      line.startsWith('- It was started with ') &&
      line.endsWith('which skips approvals or the sandbox.'),
  )
  if (bypass.length === 0) return null
  return [
    (lines[0] ?? 'Worker').replace('the wrong settings', 'a bypass flag'),
    ...bypass,
    ...lines.filter((line) => line.startsWith('The bypass flag comes from ')),
  ].join('\n')
}
