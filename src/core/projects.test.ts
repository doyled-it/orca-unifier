import { assert, test } from 'orca/testing'
import { isExcludedProject, projectOf, projectOfWorktree } from './projects'

const root = '/Users/m/projects'

test('projectOf returns the first segment under the root', () => {
  assert.equal(projectOf('/Users/m/projects/alpha/app', root), 'alpha')
  assert.equal(
    projectOf('/Users/m/projects/orca/plugins/unifier', root),
    'orca',
  )
})

test('projectOf is null outside the root or for the root itself', () => {
  assert.equal(projectOf('/Users/m/other/x', root), null)
  assert.equal(projectOf('/Users/m/projects', root), null)
  assert.equal(projectOf('/Users/m/projects-extra/a', root), null)
})

test('projectOf handles spaces and dot-dot segments', () => {
  assert.equal(
    projectOf('/Users/m/my projects/a/b', '/Users/m/my projects'),
    'a',
  )
  assert.equal(projectOf('/Users/m/projects/../projects/a/b', root), 'a')
  assert.equal(projectOf('/Users/m/projects/../other/a', root), null)
})

test('isExcludedProject uses only configured names, case-insensitively', () => {
  const excluded = ['alpha', 'beta']
  assert.equal(isExcludedProject('ALPHA', excluded), true)
  assert.equal(isExcludedProject('Beta', excluded), true)
  assert.equal(isExcludedProject('demo', excluded), false)
  assert.equal(isExcludedProject('alpha', []), false)
  assert.equal(isExcludedProject('beta', []), false)
  assert.equal(isExcludedProject('alpha', []), false)
})

test('projectOfWorktree falls back to the project of its repo main checkout', () => {
  const mains = new Map([['r1', '/Users/m/projects/alpha/app']])
  assert.equal(
    projectOfWorktree(
      { path: '/Users/m/orca/workspaces/app/t2', repoId: 'r1' },
      mains,
      root,
    ),
    'alpha',
  )
  assert.equal(
    projectOfWorktree(
      { path: '/Users/m/projects/demo/api', repoId: 'r1' },
      mains,
      root,
    ),
    'demo',
  )
  assert.equal(
    projectOfWorktree(
      { path: '/Users/m/orca/workspaces/x/t', repoId: 'r9' },
      mains,
      root,
    ),
    null,
  )
})
