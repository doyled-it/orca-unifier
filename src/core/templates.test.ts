import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import {
  readModelCatalog,
  renderCharter,
  WORKER_BRIEF_MARKER,
  withWorkerBrief,
} from './templates'

const FILES = [
  'orchestrator-charter.md',
  'worker-brief.md',
  'reviewer-brief.md',
  'report-format.md',
]

function template(name: string): string {
  return readFileSync(
    new URL(`../../templates/${name}`, import.meta.url),
    'utf8',
  )
}

const VARS = {
  project: 'demo',
  projectPath: '/Users/m/projects/demo',
  repos: ['/Users/m/projects/demo/api', '/Users/m/projects/demo/web'],
  railsPath: '/Users/m/projects/demo/.unifier/rails.md',
}

const EMOJI = /\p{Extended_Pictographic}/u

test('templates carry no em dash, emoji or source-project names', () => {
  for (const name of FILES) {
    const text = template(name)
    assert.ok(text.trim().length > 0, `${name} is empty`)
    assert.ok(!text.includes('\u2014'), `${name} has an em dash`)
    assert.ok(!EMOJI.test(text), `${name} has an emoji`)
    for (const banned of ['treectl', 'run slot', 'epic']) {
      assert.ok(
        !text.toLowerCase().includes(banned),
        `${name} mentions ${banned}`,
      )
    }
  }
})

test('the worker brief starts with its marker line', () => {
  assert.equal(template('worker-brief.md').split('\n')[0], WORKER_BRIEF_MARKER)
  assert.equal(WORKER_BRIEF_MARKER, '<!-- unifier:worker-brief v1 -->')
})

test('renderCharter fills every placeholder', () => {
  const out = renderCharter(template('orchestrator-charter.md'), VARS)
  assert.ok(!out.includes('{{'), 'a placeholder is left')
  assert.ok(!out.includes('}}'), 'a placeholder is left')
  assert.ok(out.includes('demo'))
  assert.ok(out.includes('/Users/m/projects/demo/api'))
  assert.ok(out.includes('/Users/m/projects/demo/web'))
  assert.ok(out.includes('/Users/m/projects/demo/.unifier/rails.md'))
})

test('the charter reads per-kind defaults and always passes agent and model', () => {
  const out = renderCharter(template('orchestrator-charter.md'), VARS)
  assert.ok(
    out.includes('/Users/m/projects/demo/.unifier/worker-defaults.json'),
  )
  assert.match(out, /Before starting any Worker, read/)
  assert.ok(out.includes('--agent <agent> --model <model>'))
  for (const kind of ['implementation', 'review', 'design', 'prose'])
    assert.ok(out.includes(kind))
  assert.match(out, /one-line reason in the report/)
  assert.match(out, /foreman uses the `review` default/)
  assert.ok(!out.includes('wrong model'))
  assert.ok(!out.includes('claudeWorkerModel'))
  assert.ok(!out.includes('codexWorkerModel'))
  assert.match(out, /bypass flag/)
  assert.match(out, /Do not relaunch for this alone/)
})

test('renderCharter replaces repeated placeholders and lists no repos plainly', () => {
  assert.equal(
    renderCharter('{{project}} and {{project}}', { ...VARS, repos: [] }),
    'demo and demo',
  )
  assert.match(renderCharter('{{repos}}', { ...VARS, repos: [] }), /none/)
})

test('renderCharter throws on an unknown placeholder', () => {
  assert.throws(() => renderCharter('Hi {{nobody}}', VARS), /nobody/)
})

test('withWorkerBrief appends the brief once', () => {
  const brief = `${WORKER_BRIEF_MARKER}\n# Worker brief\nRules.`
  const once = withWorkerBrief('Do the task.', brief)
  assert.ok(once.startsWith('Do the task.'))
  assert.ok(once.endsWith('Rules.'))
  assert.equal(once.split(WORKER_BRIEF_MARKER).length, 2)
  assert.equal(withWorkerBrief(once, brief), once)
})

test('readModelCatalog lists the real catalog by agent with full ids', () => {
  const raw = readFileSync(
    new URL('../../test/fixtures/model-catalog.json', import.meta.url),
    'utf8',
  )
  const agents = readModelCatalog(raw)
  assert.deepEqual(
    agents.map((a) => a.agent),
    ['claude', 'codex'],
  )
  const claude = agents.find((a) => a.agent === 'claude')?.models ?? []
  const ids = claude.map((m) => m.id)
  assert.ok(ids.includes('claude-opus-5-5'))
  assert.ok(ids.includes('claude-opus-4-8'))
  assert.ok(!ids.includes('opus'), 'aliases resolve to full ids')
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids')
  for (const m of claude) assert.ok(!/alias/i.test(m.label), m.label)
  const codex = agents.find((a) => a.agent === 'codex')?.models ?? []
  assert.ok(codex.some((m) => m.id === 'gpt-6.1-sol'))
})

test('readModelCatalog keeps the newest entry per agent', () => {
  const raw = JSON.stringify({
    entries: [
      {
        agent: 'claude',
        discovered: { models: [{ id: 'old', label: 'Old' }] },
      },
      {
        agent: 'claude',
        discovered: { models: [{ id: 'new', label: 'New' }] },
      },
    ],
  })
  assert.deepEqual(readModelCatalog(raw), [
    { agent: 'claude', models: [{ id: 'new', label: 'New' }] },
  ])
})

test('readModelCatalog never throws on bad input', () => {
  for (const raw of [
    '',
    'not json',
    'null',
    '[]',
    '{"entries": 3}',
    '{"entries": [null, 1, {"agent": 2}, {"agent": "x"}]}',
  ]) {
    assert.deepEqual(readModelCatalog(raw), [])
  }
})

test('the charter confines the Orchestrator to its own project', () => {
  const raw = template('orchestrator-charter.md')
  const head = raw.split('## Starting Workers')[0] ?? ''
  assert.ok(head.includes('{{projectPath}}'))
  assert.match(head, /opens in the Projects folder/)
  assert.match(head, /read and write only inside `\{\{projectPath\}\}`/)
  assert.match(
    head,
    /never read, modify or run commands in any other project's folders/,
  )
})

test('the bypass rule binds Codex and allows Claude skip-permissions', () => {
  for (const name of ['orchestrator-charter.md', 'worker-brief.md']) {
    const text = template(name)
    assert.match(
      text,
      /Codex Workers never run with a sandbox or approval bypass/,
      name,
    )
    assert.match(text, /--dangerously-skip-permissions/, name)
    assert.ok(!/Never run any agent with a sandbox/.test(text), name)
  }
})

test('the charter says where the dispatch id comes from', () => {
  const text = template('orchestrator-charter.md')
  assert.match(text, /worker-list/)
  assert.match(text, /worker-start --json/)
})

test('the charter asks directly when a Decision has no task', () => {
  const text = template('orchestrator-charter.md')
  assert.match(text, /no task/)
  assert.match(text, /gate-resolve --id <gate id> --resolution/)
})

test('templates name skills by their installed names', () => {
  for (const name of ['orchestrator-charter.md', 'worker-brief.md']) {
    const text = template(name)
    for (const skill of [
      'development-loop:development-loop',
      'codegraph:using-codegraph',
      'cross-repo-completeness:cross-repo-completeness',
      'nonfiction-superpowers:writing-nonfiction',
      'superpowers:brainstorming',
      'superpowers:writing-plans',
      'superpowers:test-driven-development',
      'superpowers:requesting-code-review',
      'superpowers:verification-before-completion',
    ]) {
      assert.ok(text.includes(`\`${skill}\``), `${name} lacks ${skill}`)
    }
  }
})
