import { assert, test } from 'orca/testing'
import { parseSettings } from './settings'

test('parseSettings fills every default and expands the root', () => {
  assert.deepEqual(parseSettings({}, '/Users/m'), {
    projectsRoot: '/Users/m/projects',
    excludedProjects: [],
    protectedPaths: [],
    orchestratorAgent: 'claude',
    orchestratorModel: 'claude-opus-5-5',
    workerImplementation: 'codex:gpt-6.1-sol',
    workerReview: 'codex:gpt-6.1-sol',
    workerDesign: 'claude:claude-opus-4-8',
    workerProse: 'claude:claude-opus-4-8',
    hideMainCheckouts: true,
    cleanupEnabled: true,
    cleanupIntervalMinutes: 10,
    approverEnabled: true,
    setupEnabled: true,
  })
})

test('parseSettings keeps valid values and expands ~', () => {
  const s = parseSettings(
    { projectsRoot: '~/work', cleanupIntervalMinutes: 30, setupEnabled: false },
    '/Users/m',
  )
  assert.equal(s.projectsRoot, '/Users/m/work')
  assert.equal(s.cleanupIntervalMinutes, 30)
  assert.equal(s.setupEnabled, false)
  assert.equal(
    parseSettings({ projectsRoot: '~' }, '/Users/m').projectsRoot,
    '/Users/m',
  )
  assert.equal(
    parseSettings({ projectsRoot: '/abs/p' }, '/Users/m').projectsRoot,
    '/abs/p',
  )
})

test('parseSettings falls back on wrong types and out-of-range values', () => {
  const s = parseSettings(
    {
      projectsRoot: 5,
      orchestratorModel: '',
      cleanupEnabled: 'yes',
      cleanupIntervalMinutes: 'x',
      approverEnabled: null,
    },
    '/Users/m',
  )
  assert.equal(s.projectsRoot, '/Users/m/projects')
  assert.equal(s.orchestratorModel, 'claude-opus-5-5')
  assert.equal(s.cleanupEnabled, true)
  assert.equal(s.cleanupIntervalMinutes, 10)
  assert.equal(s.approverEnabled, true)
  assert.equal(
    parseSettings({ cleanupIntervalMinutes: 2 }, '/Users/m')
      .cleanupIntervalMinutes,
    10,
  )
  assert.equal(
    parseSettings({ cleanupIntervalMinutes: 7.5 }, '/Users/m')
      .cleanupIntervalMinutes,
    10,
  )
})

test('worker defaults accept any safe harness and model, splitting at the first colon', () => {
  const s = parseSettings(
    {
      workerImplementation: 'opencode2:provider/model:level',
      workerReview: 'claude:gpt-6.1-sol',
      workerDesign: 'codex:claude-opus-4-8',
      workerProse: 'custom-agent:org/model@v1',
    },
    '/Users/m',
  )
  assert.equal(s.workerImplementation, 'opencode2:provider/model:level')
  assert.equal(s.workerReview, 'claude:gpt-6.1-sol')
  assert.equal(s.workerDesign, 'codex:claude-opus-4-8')
  assert.equal(s.workerProse, 'custom-agent:org/model@v1')
})

test('invalid worker settings fall back independently and ignore the old settings', () => {
  for (const invalid of [
    null,
    2,
    '',
    'codex',
    ':model',
    'codex:',
    'Codex:model',
    'a b:model',
    'codex:a model',
    'codex:;bad',
    `${'a'.repeat(33)}:model`,
    `codex:${'a'.repeat(101)}`,
  ]) {
    const s = parseSettings(
      {
        workerImplementation: invalid,
        workerReview: invalid,
        workerDesign: invalid,
        workerProse: invalid,
        codexWorkerModel: 'old',
      },
      '/m',
    )
    assert.equal(s.workerImplementation, 'codex:gpt-6.1-sol')
    assert.equal(s.workerReview, 'codex:gpt-6.1-sol')
    assert.equal(s.workerDesign, 'claude:claude-opus-4-8')
    assert.equal(s.workerProse, 'claude:claude-opus-4-8')
  }
})

test('project and protected names parse comma-separated plain folder names', () => {
  const s = parseSettings(
    {
      excludedProjects:
        ' Alpha, BETA, , ../outside, /abs, a/b, a\\b, ., .., Team Space, bad\0name ',
      protectedPaths: ' Deploy-Secrets, .private, , ../outside ',
    },
    '/Users/m',
  )
  assert.deepEqual(s.excludedProjects, ['alpha', 'beta', 'team space'])
  assert.deepEqual(s.protectedPaths, ['deploy-secrets', '.private'])
  for (const invalid of [null, 3, [], {}]) {
    const empty = parseSettings(
      { excludedProjects: invalid, protectedPaths: invalid },
      '/Users/m',
    )
    assert.deepEqual(empty.excludedProjects, [])
    assert.deepEqual(empty.protectedPaths, [])
  }
})
