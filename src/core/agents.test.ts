import { assert, test } from 'orca/testing'
import {
  type AgentEntry,
  applyAgentEvent,
  enrichAgents,
  orderForCard,
  overlayAgents,
  sortAgents,
} from './agents'

function entry(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    paneKey: 'p1',
    parentPaneKey: null,
    terminalId: null,
    title: null,
    detail: null,
    state: 'working',
    since: 0,
    updatedAt: 0,
    agent: null,
    model: null,
    ...over,
  }
}

test('applyAgentEvent adds one entry per pane with title and terminal', () => {
  const one = applyAgentEvent([], {
    paneKey: 'p1',
    terminalId: 't1',
    title: 'Fix login - reading files',
    state: 'working',
    receivedAt: 10,
  })
  const two = applyAgentEvent(one, {
    paneKey: 'p2',
    state: 'blocked',
    receivedAt: 20,
  })
  assert.deepEqual(two, [
    entry({
      paneKey: 'p1',
      terminalId: 't1',
      title: 'Fix login - reading files',
      since: 10,
      updatedAt: 10,
    }),
    entry({ paneKey: 'p2', state: 'blocked', since: 20, updatedAt: 20 }),
  ])
})

test('applyAgentEvent prefers mainAgent state and start time', () => {
  const out = applyAgentEvent([], {
    paneKey: 'p1',
    state: 'working',
    receivedAt: 50,
    mainAgent: { state: 'waiting', stateStartedAt: 30 },
  })
  assert.equal(out[0]?.state, 'waiting')
  assert.equal(out[0]?.since, 30)
  assert.equal(out[0]?.updatedAt, 50)
})

test('applyAgentEvent updates a pane in place and keeps known fields', () => {
  const start = [
    entry({
      paneKey: 'p1',
      terminalId: 't1',
      title: 'Old title',
      agent: 'claude',
      model: 'claude-opus-4-8',
    }),
  ]
  const out = applyAgentEvent(start, {
    paneKey: 'p1',
    state: 'done',
    receivedAt: 99,
  })
  assert.deepEqual(out, [
    entry({
      paneKey: 'p1',
      terminalId: 't1',
      title: 'Old title',
      state: 'done',
      since: 99,
      updatedAt: 99,
      agent: 'claude',
      model: 'claude-opus-4-8',
    }),
  ])
  assert.equal(start[0]?.state, 'working', 'input is not mutated')
})

test('overlayAgents lets a newer event win over the summary', () => {
  const summary = [
    entry({
      paneKey: 'p1',
      title: 'From summary',
      detail: 'Bash: ls',
      agent: 'claude',
      parentPaneKey: 'outside',
      state: 'working',
      since: 5,
      updatedAt: 10,
    }),
  ]
  const out = overlayAgents(summary, [
    entry({
      paneKey: 'p1',
      terminalId: 't1',
      title: null,
      state: 'blocked',
      since: 20,
      updatedAt: 20,
    }),
  ])
  assert.deepEqual(out, [
    entry({
      paneKey: 'p1',
      terminalId: 't1',
      title: 'From summary',
      detail: 'Bash: ls',
      agent: 'claude',
      parentPaneKey: 'outside',
      state: 'blocked',
      since: 20,
      updatedAt: 20,
    }),
  ])
})

test('overlayAgents ignores an event older than the summary', () => {
  const summary = [entry({ paneKey: 'p1', state: 'done', updatedAt: 30 })]
  const out = overlayAgents(summary, [
    entry({ paneKey: 'p1', terminalId: 't1', state: 'working', updatedAt: 20 }),
  ])
  assert.equal(out[0]?.state, 'done')
  assert.equal(out[0]?.terminalId, 't1', 'the terminal id is still learned')
})

test('overlayAgents adds panes the summary does not know yet', () => {
  const out = overlayAgents(
    [entry({ paneKey: 'p1' })],
    [entry({ paneKey: 'p2', state: 'waiting', updatedAt: 9 })],
  )
  assert.deepEqual(
    out.map((e) => [e.paneKey, e.state]),
    [
      ['p1', 'working'],
      ['p2', 'waiting'],
    ],
  )
  assert.deepEqual(overlayAgents([], []), [])
})

test('sortAgents orders blocked, waiting, working, done, then newest', () => {
  const out = sortAgents([
    entry({ paneKey: 'done', state: 'done', since: 9 }),
    entry({ paneKey: 'work-old', state: 'working', since: 1 }),
    entry({ paneKey: 'wait', state: 'waiting', since: 1 }),
    entry({ paneKey: 'work-new', state: 'working', since: 5 }),
    entry({ paneKey: 'block', state: 'blocked', since: 1 }),
  ])
  assert.deepEqual(
    out.map((e) => e.paneKey),
    ['block', 'wait', 'work-new', 'work-old', 'done'],
  )
})

test('orderForCard puts top-level agents first and sub-agents after', () => {
  const out = orderForCard([
    entry({ paneKey: 'sub', parentPaneKey: 'lead', state: 'blocked' }),
    entry({ paneKey: 'lead', parentPaneKey: 'elsewhere', state: 'done' }),
    entry({ paneKey: 'solo', state: 'working', since: 3 }),
  ])
  assert.deepEqual(
    out.map((e) => e.paneKey),
    ['solo', 'lead', 'sub'],
  )
})

test('enrichAgents fills agent and model by terminal id and is a no-op without launches', () => {
  const entries = [
    entry({ paneKey: 'p1', terminalId: 't1' }),
    entry({ paneKey: 'p2', terminalId: 't2', agent: 'codex', model: 'x' }),
    entry({ paneKey: 'p3', terminalId: null }),
  ]
  assert.deepEqual(enrichAgents(entries, []), entries)
  const out = enrichAgents(entries, [
    { terminalId: 't1', agent: 'claude', model: 'claude-opus-4-8' },
    { terminalId: 't2', agent: 'claude', model: 'y' },
  ])
  assert.equal(out[0]?.agent, 'claude')
  assert.equal(out[0]?.model, 'claude-opus-4-8')
  assert.equal(out[1]?.agent, 'codex', 'known values win')
  assert.equal(out[1]?.model, 'x')
  assert.equal(out[2]?.agent, null)
})

test('tracked terminal launches supply actual values over stale summary models', () => {
  const out = enrichAgents(
    [entry({ terminalId: 't1', agent: 'claude', model: 'stale' })],
    [{ terminalId: 't1', agent: 'custom', model: 'actual' }],
    new Set(['t1']),
  )
  assert.equal(out[0]?.agent, 'custom')
  assert.equal(out[0]?.model, 'actual')
})
