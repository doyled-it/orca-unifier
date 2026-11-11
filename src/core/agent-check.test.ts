import { assert, test } from 'orca/testing'
import { checkAgentSetup } from './agent-check'

const claudeSkills = [
  'development-loop:development-loop',
  'codegraph:using-codegraph',
  'cross-repo-completeness:cross-repo-completeness',
  'nonfiction-superpowers:writing-nonfiction',
  'superpowers:brainstorming',
  'superpowers:writing-plans',
  'superpowers:test-driven-development',
  'superpowers:requesting-code-review',
  'superpowers:verification-before-completion',
]
const codexSkills = [
  'development-loop',
  'using-codegraph',
  'cross-repo-completeness',
  'writing-nonfiction',
  'brainstorming',
  'writing-plans',
  'test-driven-development',
  'requesting-code-review',
  'verification-before-completion',
]
const codexRules = `prefix_rule(pattern=["uv", "run"], decision="allow")
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=["git", "diff"], decision="allow")
prefix_rule(pattern=["git", "add"], decision="allow")
prefix_rule(pattern=["git", "commit"], decision="allow")`
const complete = { claudeSkills, codexSkills, codexRules }

test('agent check accepts all installed skills and allowed command prefixes', () => {
  assert.equal(checkAgentSetup(complete).ok, true)
})

test('agent check names every missing Codex skill with an install source', () => {
  const result = checkAgentSetup({ ...complete, codexSkills: [] })
  assert.equal(result.ok, false)
  assert.equal(result.lines.length, 9)
  for (const name of codexSkills) {
    const line = result.lines.find((line) =>
      line.includes(`Codex: missing ${name}.`),
    )
    assert.ok(line, name)
    assert.match(
      line,
      /github.com\/(doyled-it\/claude-skills|obra\/superpowers)/,
    )
  }
})

test('agent check uses the installed Claude names rather than plugin names', () => {
  const result = checkAgentSetup({
    ...complete,
    claudeSkills: [
      'codegraph',
      'nonfiction-superpowers',
      ...claudeSkills.slice(4),
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.lines.length, 4)
  assert.ok(
    result.lines.some((line) => line.includes('codegraph:using-codegraph')),
  )
  assert.ok(
    result.lines.some((line) =>
      line.includes('nonfiction-superpowers:writing-nonfiction'),
    ),
  )
})

test('agent check reports a missing Codex rules file', () => {
  const result = checkAgentSetup({ ...complete, codexRules: null })
  assert.equal(result.ok, false)
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0], /missing ~\/.codex\/rules\/default.rules/)
})

test('agent check reports git commit when only that allowed prefix is missing', () => {
  const result = checkAgentSetup({
    ...complete,
    codexRules: codexRules.split('\n').slice(0, -1).join('\n'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.lines.length, 1)
  assert.match(result.lines[0], /git commit/)
})

test('agent check recognizes multiline rules, single quotes and broader prefixes', () => {
  assert.equal(
    checkAgentSetup({
      ...complete,
      codexRules: `prefix_rule(\n decision = 'allow',\n pattern = ['uv'],\n)\n
prefix_rule(pattern = ['git'], decision = 'allow')`,
    }).ok,
    true,
  )
})

test('agent check recognizes command alternatives in a prefix rule', () => {
  assert.equal(
    checkAgentSetup({
      ...complete,
      codexRules: `prefix_rule(pattern=['uv', 'run'], decision='allow')
prefix_rule(pattern=['git', ['status', 'diff', 'add', 'commit']], decision='allow')`,
    }).ok,
    true,
  )
})

test('agent check ignores comments, text, non-allow rules and narrower commands', () => {
  const result = checkAgentSetup({
    ...complete,
    codexRules: `# prefix_rule(pattern=['git'], decision='allow')
example = "prefix_rule(pattern=['git'], decision='allow')"
prefix_rule(pattern=['git'], decision='prompt')
prefix_rule(pattern=['git', 'commit', '-m'], decision='allow')
prefix_rule(pattern=['uv', 'runner'], decision='allow')`,
  })
  assert.equal(result.ok, false)
  assert.equal(result.lines.length, 5)
})

test('agent check includes a supplied local Codex install reference', () => {
  const result = checkAgentSetup({
    ...complete,
    codexSkills: [],
    codexInstallHint:
      'See ~/projects/agentic-dev-setup/README.md: ./install.sh --codex-only.',
  })
  assert.ok(result.lines.every((line) => line.includes('README.md')))
  assert.ok(result.lines.every((line) => !line.includes('\u2014')))
})
