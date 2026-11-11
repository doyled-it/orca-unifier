import { assert, test } from 'orca/testing'
import { nodeExec } from '../adapters/exec'
import {
  detectLanguages,
  gapReport,
  type Language,
  renderSetupCommand,
  renderSetupScript,
  setupCommands,
} from './setup'

const detections: [string[], Language[]][] = [
  [[], []],
  [['README.md', 'src/package.json'], []],
  [['pyproject.toml'], ['python']],
  [['uv.lock'], ['python']],
  [['pyproject.toml', 'uv.lock'], ['python']],
  [['package.json'], ['typescript']],
  [['Cargo.toml'], ['rust']],
  [['go.mod'], ['go']],
  [
    ['go.mod', 'Cargo.toml', 'package.json', 'uv.lock'],
    ['python', 'typescript', 'rust', 'go'],
  ],
]
for (const [files, want] of detections) {
  test(`detectLanguages: ${files.join(', ') || 'empty'}`, () => {
    assert.deepEqual(detectLanguages(files), want)
  })
}

const installs: [Language[], string[], string[][]][] = [
  [[], [], []],
  [['python'], [], [['uv', 'sync']]],
  [['typescript'], [], [['bun', 'install']]],
  [['typescript'], ['bun.lock'], [['bun', 'install', '--frozen-lockfile']]],
  [['typescript'], ['bun.lockb'], [['bun', 'install', '--frozen-lockfile']]],
  [['typescript'], ['package-lock.json'], [['npm', 'ci']]],
  [['typescript'], ['npm-shrinkwrap.json'], [['npm', 'ci']]],
  [
    ['typescript'],
    ['pnpm-lock.yaml'],
    [['pnpm', 'install', '--frozen-lockfile']],
  ],
  [['typescript'], ['yarn.lock'], [['yarn', 'install', '--frozen-lockfile']]],
  [
    ['typescript'],
    ['package-lock.json', 'bun.lock'],
    [['bun', 'install', '--frozen-lockfile']],
  ],
  [['rust'], [], [['cargo', 'fetch']]],
  [['go'], [], [['go', 'mod', 'download']]],
  [
    ['python', 'typescript', 'rust', 'go'],
    [],
    [
      ['uv', 'sync'],
      ['bun', 'install'],
      ['cargo', 'fetch'],
      ['go', 'mod', 'download'],
    ],
  ],
]
for (const [langs, files, want] of installs) {
  test(`setupCommands: ${langs.join(', ')} with ${files.join(', ')}`, () => {
    assert.deepEqual(setupCommands(langs, files), want)
  })
}

test('gapReport lists each missing language config in stable order', () => {
  assert.deepEqual(gapReport(['python', 'typescript', 'rust', 'go'], []), [
    'Python: missing ruff configuration',
    'Python: missing .pre-commit-config.yaml',
    'TypeScript: missing biome.json',
    'Rust: missing .config/nextest.toml',
    'Go: missing .golangci.yml',
  ])
  assert.deepEqual(gapReport([], []), [])
})

for (const [files, text] of [
  [['ruff.toml'], ''],
  [[], '[tool.ruff]\nline-length = 88\n'],
  [[], ' [tool.ruff] # config\r\n'],
] as [string[], string][]) {
  test(`gapReport recognizes ruff configuration ${files.join(', ')} ${text}`, () => {
    assert.deepEqual(
      gapReport(['python'], [...files, '.pre-commit-config.yaml'], text),
      [],
    )
  })
}

test('gapReport does not mistake a comment for ruff configuration', () => {
  assert.deepEqual(
    gapReport(['python'], ['.pre-commit-config.yaml'], '# [tool.ruff]\n'),
    ['Python: missing ruff configuration'],
  )
})

for (const [lock, manager] of [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
]) {
  test(`gapReport flags the ${manager} mismatch without converting it`, () => {
    assert.deepEqual(gapReport(['typescript'], ['biome.json', lock]), [
      `TypeScript: uses ${manager}, not bun`,
    ])
  })
}

test('gapReport accepts all standard configs and bun lockfiles', () => {
  assert.deepEqual(
    gapReport(
      ['python', 'typescript', 'rust', 'go'],
      [
        'ruff.toml',
        '.pre-commit-config.yaml',
        'biome.json',
        'bun.lockb',
        '.config/nextest.toml',
        '.golangci.yml',
      ],
    ),
    [],
  )
})

test('renderSetupScript preserves spaces, apostrophes and shell syntax as arguments', async () => {
  const path = "/tmp/one space/it's $(printf injected); `printf injected`"
  const script = renderSetupScript([
    ['printf', '%s\n', path],
    ['printf', '%s\n', 'second'],
  ])
  assert.ok(script.includes('set -u'))
  const result = await nodeExec('/bin/sh', ['-c', script])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, `${path}\nsecond\nunifier setup: done\n`)
})

test('renderSetupScript stops on failure and prints the failing command', async () => {
  const result = await nodeExec('/bin/sh', [
    '-c',
    renderSetupScript([
      ['printf', '%s\n', 'first'],
      ['false'],
      ['printf', '%s\n', 'must not run'],
    ]),
  ])
  assert.ok(result.code !== 0)
  assert.equal(result.stdout, 'first\nunifier setup: failed at false\n')
})

test('renderSetupScript reports a missing program and handles no commands', async () => {
  const missing = await nodeExec('/bin/sh', [
    '-c',
    renderSetupScript([['unifier-nonexistent-program']]),
  ])
  assert.ok(missing.code !== 0)
  assert.equal(
    missing.stdout,
    'unifier setup: failed at unifier-nonexistent-program\n',
  )
  const empty = await nodeExec('/bin/sh', ['-c', renderSetupScript([])])
  assert.equal(empty.code, 0)
  assert.equal(empty.stdout, 'unifier setup: done\n')
})

test('renderSetupCommand explicitly selects POSIX sh and preserves script quoting', async () => {
  const value = "a space, an apostrophe ' and $(printf injected)"
  const command = renderSetupCommand([['printf', '%s\n', value]])
  assert.ok(command.startsWith("'/bin/sh' '-c' "))
  const result = await nodeExec('/bin/sh', ['-c', command])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, `${value}\nunifier setup: done\n`)
})
