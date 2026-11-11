import { assert, test } from 'orca/testing'
import { boardFileContents, boardFilePath, hubFolder } from './hubs'

test('hubFolder is the projects root for the global hub', () => {
  assert.equal(hubFolder({ scope: 'global' }, '/r/projects'), '/r/projects')
})

test('hubFolder is a subfolder for a project hub', () => {
  assert.equal(
    hubFolder({ scope: 'project', project: 'demo app' }, '/r/projects'),
    '/r/projects/demo app',
  )
})

test('boardFilePath sits in .unifier', () => {
  assert.equal(
    boardFilePath('/r/projects/demo'),
    '/r/projects/demo/.unifier/board.unifier-board',
  )
})

test('boardFileContents is pretty JSON with a trailing newline', () => {
  assert.equal(
    boardFileContents({ scope: 'project', project: 'demo' }),
    '{\n  "scope": "project",\n  "project": "demo"\n}\n',
  )
  assert.equal(
    boardFileContents({ scope: 'global' }),
    '{\n  "scope": "global"\n}\n',
  )
})
