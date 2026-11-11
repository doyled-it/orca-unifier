import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi, PluginHooks } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { parseSettings } from '../core/settings'
import type { WorktreeRecord } from '../core/types'
import { activateWith } from '../worker'
import { createSetupService } from './setup-service'
import { createTracker } from './tracker'

const ROOT = '/Users/m/projects'
const PATH = "/Users/m/orca/workspaces/one space/it's demo"
const ID = `repo1::${PATH}`
const COMMON = '/Users/m/projects/demo/repo/.git'
const REPORT = `${PATH}/.unifier/setup-report.md`
const EXCLUDE = `${COMMON}/info/exclude`
type Event = PluginHooks['workspace.create.after']['event']
const event: Event = {
  workspaceId: ID,
  kind: 'worktree',
  path: PATH,
  branch: "feat/it's demo",
}

function record(path: string, main = false): WorktreeRecord {
  return {
    id: `repo1::${path}`,
    identityKey: `wt2:local:${main ? 'main' : 'child'}`,
    projectId: 'project1',
    repoId: 'repo1',
    path,
    branch: main ? 'main' : event.branch,
    displayName: 'demo',
    isMainWorktree: main,
    isPinned: false,
    isUnread: false,
    isArchived: false,
    comment: '',
    workspaceStatus: 'todo',
    parentWorktreeId: null,
    childWorktreeIds: [],
    linkedGitLabMR: null,
    linkedPR: null,
    lastActivityAt: 0,
  }
}

async function setup(
  opts: {
    missingTools?: string[]
    toolFailure?: 'timeout' | 'throw'
    root?: string
    mainPath?: string
    fs?: FsLike
    link?: string
    canonical?: (path: string) => string
    screen?: string
    names?: string[]
    files?: Record<string, string>
    project?: string
    enabled?: boolean
    common?: string
    owner?: boolean
    fail?: 'settings' | 'list' | 'files' | 'git' | 'write' | 'message'
    hang?: boolean
    wired?: boolean
    path?: string
    paths?: string[]
    hangNote?: boolean
    beforeWrite?: (key: string) => Promise<void>
  } = {},
) {
  const files = { ...opts.files }
  const accessed: string[] = []
  const execCalls: { file: string; args: string[] }[] = []
  const toolCalls: { file: string; args: string[]; timeout?: number }[] = []
  const notes: { to: string; subject: string; body: string }[] = []
  const logs: string[] = []
  let listed = 0
  let hanging = opts.hang ?? false
  let hangingNote = opts.hangNote ?? false
  const path = opts.path ?? PATH
  const paths = opts.paths ?? [path]
  let api!: OrcaWorkerApi
  let dispose: (() => void) | undefined
  const names = opts.names ?? ['pyproject.toml']
  const fs: FsLike = opts.fs ?? {
    async realpath(p) {
      return opts.canonical?.(p) ?? p
    },
    async lstat(p) {
      return opts.link === p ? { isSymbolicLink: () => true } : null
    },
    async exists(p) {
      accessed.push(p)
      return p in files
    },
    async read(p) {
      accessed.push(p)
      if (!(p in files)) throw new Error(`missing ${p}`)
      return files[p] as string
    },
    async write(p, text) {
      if (opts.fail === 'write') throw new Error('write failed')
      accessed.push(p)
      files[p] = text
    },
    async append(p, text) {
      accessed.push(p)
      files[p] = (files[p] ?? '') + text
    },
    async mkdir(p) {
      accessed.push(p)
    },
    async list(p) {
      accessed.push(p)
      if (opts.fail === 'files') throw new Error('files failed')
      return [...names]
    },
  }
  if (names.includes('pyproject.toml')) files[`${path}/pyproject.toml`] ??= ''
  const exec: Exec = async (file, args, options) => {
    if (file === '/bin/sh') {
      toolCalls.push({ file, args, timeout: options?.timeoutMs })
      if (opts.toolFailure === 'throw') throw new Error('probe failed')
      const missing =
        opts.toolFailure === 'timeout' ||
        opts.missingTools?.includes(args.at(-1) ?? '')
      return {
        code: missing ? 1 : 0,
        stdout: missing ? '' : '/tools/tool',
        stderr: '',
        ...(opts.toolFailure === 'timeout'
          ? { error: 'timeout' as const }
          : {}),
      }
    }
    execCalls.push({ file, args })
    return {
      code: opts.fail === 'git' ? 1 : 0,
      stdout: args.includes('status') ? '' : `${opts.common ?? COMMON}\n`,
      stderr: '',
    }
  }
  const cli = {
    async listWorktrees() {
      listed++
      if (hanging) await new Promise(() => {})
      if (opts.fail === 'list') throw new Error('list failed')
      return [
        record(
          opts.mainPath ??
            `${opts.root ?? ROOT}/${opts.project ?? 'demo'}/repo`,
          true,
        ),
        ...paths.map((p) => record(p)),
      ]
    },
    async worktreeSummaries() {
      return { summaries: [], truncated: false }
    },
  } as unknown as OrcaCli
  const host = mockHost({
    settings: {
      excludedProjects: 'alpha,beta',
      projectsRoot: opts.root ?? ROOT,
      setupEnabled: opts.enabled ?? true,
    },
    results: {
      'terminal.create': { terminalId: 'term_setup' },
      'terminal.read': {
        lines: [opts.screen ?? 'unifier setup: done'],
        truncated: false,
      },
    },
  })
  const mount = () =>
    mountWorker(
      {
        default(orca) {
          api = orca
          const wrapped = {
            ...orca,
            log: (text: string) => logs.push(text),
            storage: {
              ...orca.storage,
              async set(
                key: string,
                value: Parameters<typeof orca.storage.set>[1],
              ) {
                await opts.beforeWrite?.(key)
                return orca.storage.set(key, value)
              },
            },
          }
          if (opts.wired) {
            dispose = activateWith(wrapped, { cli, exec, fs })
            return
          }
          dispose = createSetupService(wrapped, {
            cli,
            exec,
            fs,
            tracker: createTracker(orca.storage),
            messenger: {
              async toOrchestrator(to, subject, body) {
                if (opts.fail === 'message') throw new Error('enqueue failed')
                notes.push({ to, subject, body })
                if (hangingNote) await new Promise(() => {})
              },
            },
            settings: async () => {
              if (opts.fail === 'settings') throw new Error('settings failed')
              return parseSettings(await orca.settings.get(), '/Users/m')
            },
          }).dispose
        },
        deactivate() {
          dispose?.()
        },
      },
      { host },
    )
  let worker = await mount()
  const tracker = createTracker(api.storage)
  if (opts.owner !== false) {
    await tracker.recordOrchestrator({
      terminalId: 'term_owner',
      workspaceId: `hub::${ROOT}`,
      project: 'demo',
      agent: 'claude',
      model: 'claude-opus-5-5',
      runId: null,
    })
    for (const p of paths) {
      await tracker.recordWorker({
        terminalId: `term_worker_${p}`,
        agent: 'codex',
        project: 'demo',
        workspaceId: `repo1::${p}`,
        orchestratorTerminalId: 'term_owner',
        taskId: null,
      })
    }
  }
  return {
    get worker() {
      return worker
    },
    tracker,
    get storage() {
      return api.storage
    },
    async restart() {
      await worker.deactivate()
      hanging = false
      hangingNote = false
      worker = await mount()
    },
    host,
    files,
    accessed,
    execCalls,
    toolCalls,
    notes,
    logs,
    listed: () => listed,
  }
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

test('setup survives a restart immediately after the hook without running a timer', async () => {
  const s = await setup()
  try {
    const decision = await s.worker.hooks.fire('workspace.create.after', event)
    assert.equal(decision.kind, 'continue')
    assert.equal(s.listed(), 0)
    assert.deepEqual(s.execCalls, [])
    assert.deepEqual(s.accessed, [])
    assert.equal(s.host.callsOf('terminal.create').length, 0)
    await s.restart()
    await settle()
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    assert.equal(s.notes.length, 1)
    await s.restart()
    await settle()
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    assert.equal(s.notes.length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup does not replay a note accepted before job removal on restart', async () => {
  const s = await setup({ hangNote: true })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 1)
    assert.equal(((await s.storage.get('setup.v1')) as unknown[]).length, 1)
    await s.restart()
    await settle()
    assert.equal(s.notes.length, 1)
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    assert.deepEqual(await s.storage.get('setup.v1'), [])
  } finally {
    await s.worker.deactivate()
  }
})

test('setup retains note identities after delivery and distinguishes changed reports', async () => {
  const s = await setup()
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 1)
    await s.restart()
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 1)
    s.files[`${PATH}/pyproject.toml`] = '[tool.ruff]\n'
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 2)
    assert.ok(!s.files[REPORT]?.includes('missing ruff configuration'))
    await s.restart()
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 2)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup retains only the newest 500 note identities across restarts', async () => {
  const paths = Array.from({ length: 500 }, (_, i) => `${PATH}/${i}`)
  const s = await setup({ paths, names: ['go.mod'] })
  const created = (path: string): Event => ({
    ...event,
    path,
    workspaceId: `repo1::${path}`,
  })
  try {
    await Promise.all(
      paths.map((p) =>
        s.worker.hooks.fire('workspace.create.after', created(p)),
      ),
    )
    await settle()
    assert.equal(s.notes.length, 500)
    const newest = `${PATH}/500`
    paths.push(newest)
    const track = (path: string) =>
      s.tracker.recordWorker({
        terminalId: `term_worker_${path}`,
        agent: 'codex',
        project: 'demo',
        workspaceId: `repo1::${path}`,
        orchestratorTerminalId: 'term_owner',
        taskId: null,
      })
    await track(newest)
    await s.worker.hooks.fire('workspace.create.after', created(newest))
    await settle()
    assert.equal(s.notes.length, 501)
    await s.restart()
    await track(paths[0] as string)
    await s.worker.hooks.fire(
      'workspace.create.after',
      created(paths[0] as string),
    )
    await settle()
    assert.equal(s.notes.length, 502)
    await s.restart()
    await s.worker.hooks.fire(
      'workspace.create.after',
      created(paths[500] as string),
    )
    await settle()
    assert.equal(s.notes.length, 502)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup awaits exactly one storage write before acknowledging the hook', async () => {
  const opts: { beforeWrite?: (key: string) => Promise<void> } = {}
  const s = await setup(opts)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  let returned = false
  opts.beforeWrite = async (key) => {
    writes++
    assert.equal(key, 'setup.v1')
    await blocked
  }
  const fired = s.worker.hooks
    .fire('workspace.create.after', event)
    .then(() => {
      returned = true
    })
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(returned, false)
    assert.equal(writes, 1)
    release()
    await fired
    assert.equal(writes, 1)
    assert.equal(s.listed(), 0)
    assert.deepEqual(s.execCalls, [])
    assert.deepEqual(s.accessed, [])
    assert.equal(s.host.callsOf('terminal.create').length, 0)
  } finally {
    release()
    await fired
    await s.worker.deactivate()
  }
})

test('setup retries a rejected note enqueue after restart', async () => {
  const opts: { fail?: 'message' } = { fail: 'message' }
  const s = await setup(opts)
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 0)
    delete opts.fail
    await s.restart()
    await settle()
    assert.equal(s.notes.length, 1)
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.notes.length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup escapes newline and tab characters in the note path', async () => {
  const path = `${PATH}\nnext\tpart`
  const s = await setup({ path })
  try {
    await s.worker.hooks.fire('workspace.create.after', {
      ...event,
      path,
      workspaceId: `repo1::${path}`,
    })
    await settle()
    assert.ok(s.files[`${path}/.unifier/setup-report.md`]?.includes('missing'))
    assert.equal(s.notes.length, 1)
    assert.equal(
      s.notes[0].body,
      `Setup gaps: ${PATH}\\nnext\\tpart/.unifier/setup-report.md`,
    )
    assert.ok(!/[\r\n\t]/.test(s.notes[0].body))
  } finally {
    await s.worker.deactivate()
  }
})

test('setup targets the created worktree, excludes its report and notes its owner', async () => {
  const s = await setup()
  try {
    const decision = await s.worker.hooks.fire('workspace.create.after', event)
    assert.equal(decision.kind, 'continue')
    await settle()
    assert.deepEqual(s.execCalls, [
      { file: 'git', args: ['-C', PATH, 'rev-parse', '--git-common-dir'] },
      {
        file: 'git',
        args: [
          '-C',
          PATH,
          'status',
          '--porcelain',
          '--untracked-files=all',
          '-z',
        ],
      },
      {
        file: 'git',
        args: [
          '-C',
          PATH,
          'status',
          '--porcelain',
          '--untracked-files=all',
          '-z',
        ],
      },
    ])
    assert.equal(s.files[EXCLUDE], '.unifier/\n')
    assert.ok(s.files[REPORT]?.includes('missing ruff configuration'))
    const calls = s.host.callsOf('terminal.create')
    assert.equal(calls.length, 1)
    const params = calls[0] as {
      workspaceId: string
      title: string
      command: string
    }
    assert.equal(params.workspaceId, ID)
    assert.equal(params.title, 'setup')
    assert.ok(params.command.startsWith("'/bin/sh' '-c' "))
    assert.deepEqual(s.notes, [
      {
        to: 'term_owner',
        subject: 'Setup gaps',
        body: `Setup gaps: ${REPORT}`,
      },
    ])
    assert.ok(!s.notes[0].body.includes('\n'))
  } finally {
    await s.worker.deactivate()
  }
})

test('setup appends the exclude once across repeated and concurrent hooks', async () => {
  const s = await setup({ files: { [EXCLUDE]: '# existing' } })
  try {
    await Promise.all([
      s.worker.hooks.fire('workspace.create.after', event),
      s.worker.hooks.fire('workspace.create.after', event),
    ])
    await settle()
    assert.equal(s.files[EXCLUDE], '# existing\n.unifier/\n')
    assert.equal(s.host.callsOf('terminal.create').length, 2)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup resolves a relative git common directory against the worktree', async () => {
  const s = await setup({
    common: '../common git',
    files: {
      '/Users/m/orca/workspaces/one space/common git/info/exclude':
        '.unifier/\n',
    },
  })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(
      s.files['/Users/m/orca/workspaces/one space/common git/info/exclude'],
      '.unifier/\n',
    )
    assert.equal(s.files[`${PATH}/.git/info/exclude`], undefined)
  } finally {
    await s.worker.deactivate()
  }
})

for (const opts of [
  { enabled: false },
  { project: 'ALPHA' },
  { project: 'Beta' },
  { project: '../outside' },
  { names: ['README.md'] },
]) {
  test(`setup skips disabled, excluded, unresolved or unrecognized worktrees: ${JSON.stringify(opts)}`, async () => {
    const s = await setup(opts)
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      assert.equal(s.files[REPORT], undefined)
      assert.deepEqual(s.execCalls, [])
      assert.deepEqual(s.notes, [])
      assert.equal(s.host.callsOf('terminal.create').length, 0)
      if (!('names' in opts)) assert.deepEqual(s.accessed, [])
    } finally {
      await s.worker.deactivate()
    }
  })
}

test('setup ignores folder creation before accessing settings or the CLI', async () => {
  const s = await setup({ fail: 'settings' })
  try {
    await s.worker.hooks.fire('workspace.create.after', {
      ...event,
      kind: 'folder',
    })
    await settle()
    assert.equal(s.listed(), 0)
    assert.deepEqual(s.accessed, [])
    assert.deepEqual(s.logs, [])
  } finally {
    await s.worker.deactivate()
  }
})

test('setup returns from the hook without waiting for a hung CLI', async () => {
  const s = await setup({ hang: true })
  try {
    const decision = await s.worker.hooks.fire('workspace.create.after', event)
    assert.equal(decision.kind, 'continue')
    assert.equal(s.listed(), 0)
    await settle()
    assert.equal(s.listed(), 1)
    assert.deepEqual(s.accessed, [])
  } finally {
    await s.worker.deactivate()
  }
})

test('setup reads nested Rust config and Python text without proposing existing configs', async () => {
  const s = await setup({
    names: [
      'pyproject.toml',
      '.pre-commit-config.yaml',
      'Cargo.toml',
      '.config',
    ],
    files: {
      [`${PATH}/pyproject.toml`]: '[tool.ruff]\n',
      [`${PATH}/.config/nextest.toml`]: '',
    },
  })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.ok(s.files[REPORT]?.includes('No setup gaps'))
    assert.deepEqual(s.notes, [])
    assert.equal(s.host.callsOf('terminal.create').length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup does not note gaps when the worktree has no owning orchestrator', async () => {
  const s = await setup({ owner: false })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.ok(s.files[REPORT]?.includes('missing'))
    assert.deepEqual(s.notes, [])
    assert.equal(s.host.callsOf('terminal.create').length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

for (const fail of [
  'settings',
  'list',
  'files',
  'git',
  'write',
  'message',
] as const) {
  test(`setup catches and logs ${fail} failures after the hook returns`, async () => {
    const s = await setup({ fail })
    try {
      const decision = await s.worker.hooks.fire(
        'workspace.create.after',
        event,
      )
      assert.equal(decision.kind, 'continue')
      await settle()
      assert.ok(
        s.logs.some(
          (line) => line.includes('setup') && /failed|enqueue/.test(line),
        ),
      )
      assert.equal(
        s.host.callsOf('terminal.create').length,
        fail === 'message' ? 1 : 0,
      )
    } finally {
      await s.worker.deactivate()
    }
  })
}

test('activateWith wires the setup hook using injected adapters', async () => {
  const s = await setup({
    wired: true,
    owner: false,
    names: ['go.mod', '.golangci.yml'],
  })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.ok(s.files[REPORT]?.includes('No setup gaps'))
    assert.equal(s.host.callsOf('terminal.create').length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup replays every queued event after a restart during a slow lookup', async () => {
  const s = await setup({ hang: true, owner: false })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.listed(), 1)
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    await s.restart()
    await settle()
    assert.equal(s.host.callsOf('terminal.create').length, 2)
    assert.equal(s.files[EXCLUDE], '.unifier/\n')
    assert.ok(s.files[REPORT]?.includes('missing'))
  } finally {
    await s.worker.deactivate()
  }
})

test('setup notes an owner recorded after creation without repeating installation', async () => {
  const s = await setup({ owner: false })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    assert.deepEqual(s.notes, [])
    await s.tracker.recordOrchestrator({
      terminalId: 'term_late_owner',
      workspaceId: `hub::${ROOT}`,
      project: 'demo',
      agent: 'claude',
      model: 'claude-opus-5-5',
      runId: null,
    })
    await s.tracker.recordWorker({
      terminalId: 'term_late_worker',
      workspaceId: ID,
      agent: 'codex',
      project: 'demo',
      orchestratorTerminalId: 'term_late_owner',
      taskId: null,
    })
    await s.restart()
    await settle()
    assert.deepEqual(s.notes, [
      {
        to: 'term_late_owner',
        subject: 'Setup gaps',
        body: `Setup gaps: ${REPORT}`,
      },
    ])
    assert.equal(s.host.callsOf('terminal.create').length, 1)
    await s.restart()
    await settle()
    assert.equal(s.notes.length, 1)
  } finally {
    await s.worker.deactivate()
  }
})

test('setup records only new untracked files after its terminal confirms success, across restarts', async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import(
    'node:fs/promises'
  )
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { nodeFs } = await import('../adapters/fs')
  const root = await mkdtemp(join(tmpdir(), 'unifier-setup-created-'))
  const path = join(root, 'demo/repo')
  await mkdir(path, { recursive: true })
  await mkdir(join(root, 'git'))
  await writeFile(join(path, 'pyproject.toml'), '')
  await writeFile(join(path, 'existing.txt'), 'existing')
  let started = false
  let done = false
  const exec: Exec = async (_file, args) => ({
    code: 0,
    stderr: '',
    stdout: args.includes('status')
      ? started
        ? '?? existing.txt\0?? uv.lock\0?? notes.md\0?? Cargo.lock\0?? ../escape\0'
        : '?? existing.txt\0'
      : join(root, 'git'),
  })
  const host = mockHost()
  let stop: (() => void) | undefined
  const mount = () =>
    mountWorker(
      {
        default(orca) {
          const service = createSetupService(
            {
              ...orca,
              host: {
                ...orca.host,
                async call(method, params) {
                  if (method === 'terminal.create') {
                    started = true
                    await writeFile(join(path, 'uv.lock'), 'lock')
                    await writeFile(join(path, 'notes.md'), 'notes')
                    await writeFile(join(path, 'Cargo.lock'), 'unrelated')
                    return { terminalId: 'setup' } as never
                  }
                  if (method === 'terminal.read')
                    return {
                      lines: done ? ['unifier setup: done'] : ['working'],
                      truncated: false,
                    } as never
                  return orca.host.call(method, params)
                },
              },
            },
            {
              cli: {
                async listWorktrees() {
                  return [record(path, true)]
                },
              },
              exec,
              fs: nodeFs,
              tracker: {
                async ownerOfWorkspace() {
                  return null
                },
              },
              messenger: { async toOrchestrator() {} },
              settings: async () => parseSettings({ projectsRoot: root }, root),
            },
          )
          stop = service.dispose
        },
        deactivate() {
          stop?.()
        },
      },
      { host },
    )
  let worker = await mount()
  try {
    await worker.hooks.fire('workspace.create.after', {
      ...event,
      path,
      workspaceId: `repo1::${path}`,
    })
    await settle()
    const recordPath = join(path, '.unifier/setup-created.json')
    assert.equal(await nodeFs.exists(recordPath), false)
    await worker.deactivate()
    done = true
    worker = await mount()
    await settle()
    assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), {
      version: 1,
      files: {
        'uv.lock':
          '0c030586945fe504b604ecc2e875c38ede400cd5cd73da9730302162e6b02c6f',
      },
    })
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

for (const screen of ['working', 'unifier setup: failed at uv sync']) {
  test(`setup records nothing without a success marker: ${screen}`, async () => {
    const s = await setup({ screen })
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      assert.equal(s.files[`${PATH}/.unifier/setup-created.json`], undefined)
    } finally {
      await s.worker.deactivate()
    }
  })
}

for (const target of [`${PATH}/.unifier`, REPORT]) {
  test(`C1: setup refuses symlink metadata at ${target}`, async () => {
    const s = await setup({ link: target })
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      assert.equal(s.files[REPORT], undefined)
      assert.equal(s.host.callsOf('terminal.create').length, 0)
    } finally {
      await s.worker.deactivate()
    }
  })
}

test('C1: setup refuses a metadata target resolved outside the Worktree', async () => {
  const s = await setup({
    canonical: (p) => (p === REPORT ? '/outside/report.md' : p),
  })
  try {
    await s.worker.hooks.fire('workspace.create.after', event)
    await settle()
    assert.equal(s.files[REPORT], undefined)
  } finally {
    await s.worker.deactivate()
  }
})

test('C3: setup excludes a Beta repo Worktree located under projects/demo', async () => {
  const path = `${ROOT}/demo/manual`
  const s = await setup({ project: 'Beta', path })
  try {
    await s.worker.hooks.fire('workspace.create.after', {
      ...event,
      path,
      workspaceId: `repo1::${path}`,
    })
    await settle()
    assert.deepEqual(s.execCalls, [])
    assert.deepEqual(s.accessed, [])
    assert.equal(s.host.callsOf('terminal.create').length, 0)
  } finally {
    await s.worker.deactivate()
  }
})

for (const target of ['directory', 'file', 'dangling']) {
  test(`C1: real setup metadata symlink ${target} leaves its destination untouched`, async () => {
    const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } = await import(
      'node:fs/promises'
    )
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { nodeFs } = await import('../adapters/fs')
    const root = await mkdtemp(join(tmpdir(), 'unifier-setup-links-'))
    const path = join(root, 'worktree')
    const outside = join(root, 'outside')
    await mkdir(path)
    await mkdir(outside)
    const destination = join(outside, 'setup-report.md')
    await writeFile(destination, 'untouched')
    if (target === 'directory') await symlink(outside, join(path, '.unifier'))
    else {
      await mkdir(join(path, '.unifier'))
      await symlink(
        target === 'dangling' ? join(outside, 'missing') : destination,
        join(path, '.unifier/setup-report.md'),
      )
    }
    const s = await setup({ path, fs: nodeFs, root, mainPath: path })
    try {
      await s.worker.hooks.fire('workspace.create.after', {
        ...event,
        path,
        workspaceId: `repo1::${path}`,
      })
      await settle()
      assert.equal(await readFile(destination, 'utf8'), 'untouched')
      assert.equal(await nodeFs.exists(join(outside, 'missing')), false)
      assert.deepEqual(s.execCalls, [])
      assert.equal(s.host.callsOf('terminal.create').length, 0)
    } finally {
      await s.worker.deactivate()
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const [marker, tools] of [
  ['pyproject.toml', ['ruff', 'uv']],
  ['package.json', ['bun']],
  ['Cargo.toml', ['cargo-nextest', 'cargo-clippy']],
  ['go.mod', ['golangci-lint', 'gotestsum']],
] as const) {
  test(`E2: missing tools for ${marker} appear in the setup report`, async () => {
    const s = await setup({ names: [marker], missingTools: [...tools] })
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      for (const tool of tools)
        assert.ok(s.files[REPORT]?.includes(`missing tool ${tool}`), tool)
      assert.deepEqual(
        s.toolCalls.map((c) => c.args.at(-1)),
        [...tools],
      )
      for (const call of s.toolCalls) {
        assert.equal(call.file, '/bin/sh')
        assert.deepEqual(call.args.slice(0, 2), ['-c', 'command -v "$1"'])
        assert.equal(call.timeout, 3000)
      }
    } finally {
      await s.worker.deactivate()
    }
  })
}
for (const toolFailure of ['timeout', 'throw'] as const) {
  test(`E2: a ${toolFailure} during tool discovery counts as missing`, async () => {
    const s = await setup({ toolFailure })
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      assert.ok(s.files[REPORT]?.includes('missing tool ruff'))
      assert.ok(s.files[REPORT]?.includes('missing tool uv'))
    } finally {
      await s.worker.deactivate()
    }
  })
}

for (const stage of ['installation', 'report']) {
  for (const location of ['own', 'main', 'canonical']) {
    test(`resumed setup ${stage} refuses a currently excluded ${location} Project`, async () => {
      const path = location === 'own' ? `${ROOT}/Beta/repo/feature` : PATH
      const report = `${path}/.unifier/setup-report.md`
      const s = await setup({
        path,
        project: location === 'main' ? 'Beta' : 'demo',
        canonical:
          location === 'canonical'
            ? (p) => p.replace(`${ROOT}/demo`, `${ROOT}/Beta`)
            : undefined,
        files: { [report]: 'Setup gaps' },
      })
      try {
        await settle()
        await s.storage.set('setup.v1', [
          {
            id: 'persisted',
            at: Date.now(),
            workspaceId: `repo1::${path}`,
            path,
            report: stage === 'report' ? report : null,
            ...(stage === 'installation'
              ? {
                  installation: {
                    terminalId: 'term_setup',
                    before: [],
                    artifacts: [],
                    report: null,
                    startedAt: Date.now(),
                  },
                }
              : {}),
          },
        ])
        await s.restart()
        await settle()
        assert.equal(s.host.callsOf('terminal.read').length, 0)
        assert.deepEqual(s.execCalls, [])
        assert.deepEqual(s.accessed, [])
        assert.deepEqual(s.notes, [])
        assert.deepEqual(await s.storage.get('setup.v1'), [])
      } finally {
        await s.worker.deactivate()
      }
    })
  }
}

for (const redirected of [false, true]) {
  test(`setup refuses excluded git metadata (${redirected ? 'canonical' : 'direct'} path)`, async () => {
    const protectedGit = `${ROOT}/Beta/repo/.git`
    const s = await setup({
      common: redirected ? COMMON : protectedGit,
      canonical: redirected
        ? (p) => (p === COMMON ? protectedGit : p)
        : undefined,
    })
    try {
      await s.worker.hooks.fire('workspace.create.after', event)
      await settle()
      assert.equal(s.host.callsOf('terminal.create').length, 0)
      assert.ok(!s.accessed.some((p) => p.startsWith(`${ROOT}/Beta/`)))
      assert.ok(!(EXCLUDE in s.files))
      assert.ok(!(REPORT in s.files))
    } finally {
      await s.worker.deactivate()
    }
  })
}
