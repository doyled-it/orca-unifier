import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { containsNestedGit, resolveRealpath } from './realpath'

test('resolves a real symlink and preserves a missing directory and file', () => {
  const root = mkdtempSync(join(tmpdir(), 'unifier-realpath-'))
  try {
    mkdirSync(join(root, 'actual'))
    symlinkSync(join(root, 'actual'), join(root, 'link'))
    const actual = resolveRealpath(join(root, 'actual'))
    assert.equal(resolveRealpath(join(root, 'link')), actual)
    assert.equal(
      resolveRealpath(join(root, 'link', 'new dir', 'file.txt')),
      join(actual, 'new dir', 'file.txt'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('never throws and reports unresolved paths instead of hiding broken links', () => {
  const root = mkdtempSync(join(tmpdir(), 'unifier-realpath-'))
  try {
    symlinkSync(join(root, 'absent'), join(root, 'broken'))
    symlinkSync(join(root, 'loop'), join(root, 'loop'))
    assert.equal(resolveRealpath(join(root, 'broken', 'file')), '')
    assert.equal(resolveRealpath(join(root, 'loop', 'file')), '')
    assert.equal(resolveRealpath('bad\u0000path'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A3: output safety finds nested repos and nested repo ancestors', () => {
  const root = mkdtempSync(join(tmpdir(), 'unifier-output-'))
  try {
    mkdirSync(join(root, 'vendor', 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'safe'))
    writeFileSync(join(root, 'safe', 'result.xml'), '')
    assert.equal(containsNestedGit(join(root, 'vendor'), root), true)
    assert.equal(
      containsNestedGit(join(root, 'vendor', 'repo', 'new'), root),
      true,
    )
    assert.equal(containsNestedGit(join(root, 'safe'), root), false)
    assert.equal(
      containsNestedGit(join(root, 'safe', 'result.xml'), root),
      false,
    )
    assert.equal(
      containsNestedGit(join(root, 'missing', 'out.xml'), root),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
