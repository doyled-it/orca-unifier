import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { OrcaCli } from '../adapters/orca-cli'
import { withoutModelAdvice } from '../core/launch-notice'
import type { Schedule } from './board-service'
import { createConsentBackoff, isConsentError } from './retirement'
import type { Tracker } from './tracker'

/** `{ terminalId, outbox }`: the plugin's own sender terminal and unsent messages. */
const KEY = 'messenger.v1'
const TERMINAL_TITLE = 'unifier'
/** Sends tried per message, however each ended (a killed worker never reports back). */
const MAX_ATTEMPTS = 3
/** A send started this recently may still be running in another worker. */
const IN_FLIGHT_MS = 15_000

interface Pending {
  id: string
  to: string
  subject: string
  body: string
  attempts: number
  /** When the latest send started; null when none is running. */
  inFlightAt: number | null
}

interface State {
  terminalId: string | null
  outbox: Pending[]
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toPending(v: Record<string, unknown>, i: number): Pending | null {
  if (typeof v.to !== 'string') return null
  return {
    id: typeof v.id === 'string' ? v.id : `legacy-${i}`,
    to: v.to,
    subject: typeof v.subject === 'string' ? v.subject : '',
    body: typeof v.body === 'string' ? v.body : '',
    attempts: typeof v.attempts === 'number' ? v.attempts : 0,
    inFlightAt: typeof v.inFlightAt === 'number' ? v.inFlightAt : null,
  }
}

function toState(raw: unknown): State {
  if (!isObj(raw)) return { terminalId: null, outbox: [] }
  return {
    terminalId: typeof raw.terminalId === 'string' ? raw.terminalId : null,
    outbox: Array.isArray(raw.outbox)
      ? raw.outbox
          .filter(isObj)
          .map(toPending)
          .filter((p): p is Pending => p !== null)
      : [],
  }
}

/** Subject and body on one line, for typing into a terminal. */
function oneLine(subject: string, body: string): string {
  return `${subject}: ${body}`.replace(/\s+/g, ' ').trim()
}

/**
 * Messages Unifier's Orchestrators. A message is queued in storage first
 * (`enqueue`, cheap enough for a hook) and sent by `flush`, which also runs
 * on activation. The attempt count is stored before each send, so a worker
 * killed mid-send still uses up a try: at most 3 sends per message. Only
 * tracked Orchestrators are ever messaged.
 */
export function createMessenger(
  orca: OrcaWorkerApi,
  deps: {
    tracker: Tracker
    cli: OrcaCli
    globalHubWorkspaceId: () => Promise<string>
    now?: () => number
    schedule?: Schedule
  },
) {
  const { tracker, cli } = deps
  const now = deps.now ?? Date.now
  let disposed = false
  const backoff = createConsentBackoff(
    (message) => orca.log(message),
    deps.schedule,
    () => void flush(),
  )
  /** Storage mutations never wait on terminal or CLI delivery. */
  let chain: Promise<unknown> = Promise.resolve()
  let deliveries: Promise<unknown> = Promise.resolve()
  const settlements = new Map<string, (p: Pending) => Pending | null>()

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }

  async function read(): Promise<State> {
    return toState(await orca.storage.get(KEY).then(backoff.success))
  }

  async function write(s: State): Promise<void> {
    await orca.storage.set(KEY, s as unknown as JsonValue).then(backoff.success)
  }

  /** Applies `fn` to the stored entry `id` (null removes it). */
  async function updateEntry(
    id: string,
    fn: (p: Pending) => Pending | null,
  ): Promise<void> {
    await serial(async () => {
      const s = await read()
      const outbox = s.outbox.flatMap((p) => {
        if (p.id !== id) return [p]
        const next = fn(p)
        return next ? [next] : []
      })
      await write({ ...s, outbox })
    })
  }

  /** Keep a known delivery outcome until consent permits its storage write. */
  async function settleEntry(id: string, fn: (p: Pending) => Pending | null) {
    settlements.set(id, fn)
    await updateEntry(id, fn)
    settlements.delete(id)
  }

  /** The plugin's sender terminal in the global hub, created when missing or gone. */
  async function senderTerminal(): Promise<string> {
    const s = await read()
    if (s.terminalId) {
      try {
        await orca.host
          .call('terminal.read', {
            terminalId: s.terminalId,
            maxLines: 1,
          })
          .then(backoff.success)
        return s.terminalId
      } catch (error) {
        if (isConsentError(error)) throw error
        // Gone: create a new one below.
      }
    }
    const { terminalId } = await orca.host
      .call('terminal.create', {
        workspaceId: await deps.globalHubWorkspaceId(),
        title: TERMINAL_TITLE,
      })
      .then(backoff.success)
    await serial(async () => write({ ...(await read()), terminalId }))
    return terminalId
  }

  async function deliver(m: Pending): Promise<void> {
    const orchestrator = await tracker.orchestratorByTerminal(m.to)
    if (!orchestrator) {
      orca.log(`unifier: not messaging untracked terminal ${m.to}`)
      return
    }
    let runId = orchestrator.runId
    if (!runId) {
      runId = await cli.findRunId(m.to)
      if (runId) await tracker.setRunId(m.to, runId)
    }
    if (!runId) {
      await cli.sendTerminalText(m.to, oneLine(m.subject, m.body), true)
      return
    }
    await cli.sendOrchestrationMessage({
      fromTerminalId: await senderTerminal(),
      runId,
      subject: m.subject,
      body: m.body,
    })
  }

  async function attempt(m: Pending): Promise<void> {
    const attempts = m.attempts + 1
    await updateEntry(m.id, (p) => ({ ...p, attempts, inFlightAt: now() }))
    try {
      await deliver(m)
    } catch (e) {
      if (isConsentError(e)) {
        // Consent rejected delivery before sending. Keep the message retryable.
        await settleEntry(m.id, (p) => ({
          ...p,
          attempts: m.attempts,
          inFlightAt: null,
        }))
        throw e
      }
      orca.log(`unifier: message to ${m.to} failed: ${String(e)}`)
      if (attempts >= MAX_ATTEMPTS) {
        orca.log(
          `unifier: dropped a message to ${m.to} after ${attempts} tries`,
        )
        await updateEntry(m.id, () => null)
      } else {
        await updateEntry(m.id, (p) => ({ ...p, inFlightAt: null }))
      }
      return
    }
    await settleEntry(m.id, () => null)
  }

  /** Sends every queued message that is not being sent right now. */
  function flush(): Promise<void> {
    if (disposed || backoff.pending) return Promise.resolve()
    const next = deliveries
      .then(async () => {
        if (disposed || backoff.pending) return
        for (const [id, update] of settlements) {
          if (disposed) return
          await settleEntry(id, update)
        }
        for (const m of (await read()).outbox) {
          if (disposed) return
          const body = withoutModelAdvice(m.subject, m.body)
          if (body === null) {
            await updateEntry(m.id, () => null)
            continue
          }
          if (body !== m.body) {
            await updateEntry(m.id, (p) => ({ ...p, body }))
          }
          if (m.inFlightAt !== null && now() - m.inFlightAt < IN_FLIGHT_MS) {
            continue
          }
          if (m.attempts >= MAX_ATTEMPTS) {
            orca.log(
              `unifier: dropped a message to ${m.to} after ${m.attempts} tries`,
            )
            await updateEntry(m.id, () => null)
            continue
          }
          await attempt({ ...m, body })
        }
      })
      .catch((e) => {
        if (backoff.handle(e)) return
        orca.log(`unifier: message flush failed: ${String(e)}`)
      })
    deliveries = next
    return next
  }

  /** Queues a message in storage without sending it. */
  function enqueue(
    orchestratorTerminalId: string,
    subject: string,
    body: string,
  ): Promise<void> {
    return serial(async () => {
      if (disposed) throw new Error('Messenger is disposed')
      const s = await read()
      const duplicate = s.outbox.some(
        (p) =>
          p.to === orchestratorTerminalId &&
          p.subject === subject &&
          p.body === body,
      )
      if (duplicate) return
      const id = `${now()}-${Math.random().toString(36).slice(2, 10)}`
      const m: Pending = {
        id,
        to: orchestratorTerminalId,
        subject,
        body,
        attempts: 0,
        inFlightAt: null,
      }
      await write({ ...s, outbox: [...s.outbox, m] })
    }).catch((error) => {
      backoff.handle(error)
      throw error
    })
  }

  /** Queues durably, then sends. Enqueue errors propagate; delivery retries internally. */
  async function toOrchestrator(
    orchestratorTerminalId: string,
    subject: string,
    body: string,
  ): Promise<void> {
    await enqueue(orchestratorTerminalId, subject, body)
    await flush()
  }

  return {
    toOrchestrator,
    enqueue,
    flush,
    dispose() {
      disposed = true
      backoff.dispose()
    },
  }
}

export type Messenger = ReturnType<typeof createMessenger>
