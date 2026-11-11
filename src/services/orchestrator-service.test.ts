import { readFileSync } from 'node:fs'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli, WorktreeSummary } from '../adapters/orca-cli'
import * as main from '../worker'
import { createTracker } from './tracker'

const ROOT = '/Users/m/projects'
const HOME = '/Users/m'
const HUB = `hub1::${ROOT}`
const CATALOG_JSON = `${HOME}/Library/Application Support/orca/agent-model-catalog.json`
const CATALOG_DB = `${HOME}/Library/Application Support/orca/agent-model-catalog.db`

function fakeFs(files: Record<string, string> = {}, dirs: string[] = []) {
  const fs: FsLike = {
    async realpath(p) {
      return p
    },
    async lstat() {
      return null
    },
    async exists(p) {
      return p in files || dirs.includes(p)
    },
    async read(p) {
      if (!(p in files)) throw new Error('missing')
      return files[p] as string
    },
    async write(p, t) {
      files[p] = t
    },
    async append(p, t) {
      files[p] = (files[p] ?? '') + t
    },
    async mkdir(p) {
      dirs.push(p)
    },
    async list(dir) {
      const prefix = `${dir}/`
      return [
        ...new Set(
          [...Object.keys(files), ...dirs]
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split('/')[0] as string),
        ),
      ]
    },
  }
  return { fs, files, dirs }
}

interface Launch {
  workspacePath: string
  agent: string
  model: string
  prompt: string
}

function fakeCli(opts: {
  live?: string[]
  summaries?: WorktreeSummary[]
  launchFails?: boolean
}) {
  const launches: Launch[] = []
  const switched: string[] = []
  const live = new Set(opts.live ?? [])
  const cli = {
    async worktreeSummaries() {
      return { summaries: opts.summaries ?? [], truncated: false }
    },
    async listWorktrees() {
      return opts.summaries ?? []
    },
    async ensureFolderWorkspace(p: string) {
      return `hub1::${p}`
    },
    async launchAgent(l: Launch) {
      launches.push(l)
      if (opts.launchFails) throw new Error('agent launch: timed out')
      live.add('term_new')
      return { terminalId: 'term_new' }
    },
    async terminalInfo(id: string) {
      return live.has(id)
        ? { title: 'Claude Code', paneKey: `tab-${id}:leaf-${id}` }
        : null
    },
    async switchTerminal(id: string) {
      switched.push(id)
    },
  } as unknown as OrcaCli
  return { cli, launches, switched }
}

async function setup(
  opts: {
    live?: string[]
    files?: Record<string, string>
    dirs?: string[]
    exec?: Exec
    summaries?: WorktreeSummary[]
    settings?: Record<string, unknown>
    launchFails?: boolean
    failDefaultStorage?: boolean
  } = {},
) {
  const f = fakeFs(opts.files ?? {}, opts.dirs ?? [`${ROOT}/demo`])
  const c = fakeCli(opts)
  const host = mockHost({
    settings: {
      excludedProjects: 'alpha,beta',
      projectsRoot: ROOT,
      ...opts.settings,
    },
    results: {
      'terminal.create': { terminalId: 'term_unifier' },
      'terminal.read': { lines: [], truncated: false },
    },
  })
  let api: OrcaWorkerApi | null = null
  const worker = await mountWorker(
    {
      default: (orca) => {
        api = {
          ...orca,
          storage: {
            ...orca.storage,
            async set(key, value) {
              if (key === 'worker-defaults.v1' && opts.failDefaultStorage)
                throw new Error('storage unavailable')
              return orca.storage.set(key, value)
            },
          },
        }
        main.activateWith(api, {
          cli: c.cli,
          fs: f.fs,
          home: HOME,
          ...(opts.exec ? { exec: opts.exec } : {}),
        })
      },
    },
    { host },
  )
  const tracker = createTracker((api as unknown as OrcaWorkerApi).storage)
  return {
    worker,
    host,
    tracker,
    api: api as unknown as OrcaWorkerApi,
    ...f,
    ...c,
  }
}

const START = { project: 'demo', agent: 'claude', model: 'claude-haiku-5-5' }

test('orchestrator.start launches in the global hub and records the orchestrator', async () => {
  const s = await setup({ dirs: [`${ROOT}/demo`, `${ROOT}/demo/api/.git`] })
  const r = await s.worker.request('orchestrator.start', START)
  assert.deepEqual(r, { ok: true })
  assert.equal(s.launches.length, 1)
  const l = s.launches[0] as Launch
  assert.equal(l.workspacePath, ROOT)
  assert.equal(l.agent, 'claude')
  assert.equal(l.model, 'claude-haiku-5-5')
  assert.ok(l.prompt.includes('Orchestrator charter: demo'))
  assert.ok(l.prompt.includes(`${ROOT}/demo/api`))
  assert.ok(l.prompt.includes(`${ROOT}/demo/.unifier/rails.md`))
  assert.ok(l.prompt.includes(`${ROOT}/demo/.unifier/worker-defaults.json`))
  assert.equal(
    JSON.parse(s.files[`${ROOT}/demo/.unifier/worker-defaults.json`] ?? '{}')
      .implementation.model,
    'gpt-6.1-sol',
  )
  assert.ok(l.prompt.includes('Report format'))
  assert.ok(l.prompt.includes('Reviewer brief'))
  assert.ok(!l.prompt.includes('{{'))
  assert.deepEqual(await s.tracker.orchestrators(), [
    {
      project: 'demo',
      workspaceId: HUB,
      terminalId: 'term_new',
      agent: 'claude',
      model: 'claude-haiku-5-5',
      runId: null,
    },
  ])
  await s.worker.deactivate()
})

test('orchestrator.start refuses configured excluded projects without side effects', async () => {
  const s = await setup({ dirs: [`${ROOT}/alpha`, `${ROOT}/Beta`] })
  const hostCalls = () =>
    s.host.calls.filter(
      (c) => !c.method.startsWith('storage.') && c.method !== 'settings.get',
    )
  const before = hostCalls().length
  for (const project of ['alpha', 'Beta']) {
    const r = await s.worker.request('orchestrator.start', {
      ...START,
      project,
    })
    assert.ok('error' in r)
  }
  assert.equal(s.launches.length, 0)
  assert.equal(hostCalls().length, before, JSON.stringify(hostCalls()))
  assert.deepEqual(await s.tracker.orchestrators(), [])
  await s.worker.deactivate()
})

test('orchestrator.start refuses a project that already has a live orchestrator', async () => {
  const s = await setup({ live: ['term_old'] })
  await s.tracker.recordOrchestrator({
    project: 'demo',
    workspaceId: HUB,
    terminalId: 'term_old',
    agent: 'claude',
    model: 'claude-opus-5-5',
    runId: null,
  })
  const r = await s.worker.request('orchestrator.start', START)
  assert.ok('error' in r)
  assert.match((r as { error: string }).error, /already has an Orchestrator/)
  assert.equal(s.launches.length, 0)
  await s.worker.deactivate()
})

test('a closed orchestrator does not block a new one', async () => {
  const s = await setup({ live: [] })
  await s.tracker.recordOrchestrator({
    project: 'demo',
    workspaceId: HUB,
    terminalId: 'term_gone',
    agent: 'claude',
    model: 'claude-opus-5-5',
    runId: null,
  })
  assert.deepEqual(await s.worker.request('orchestrator.start', START), {
    ok: true,
  })
  assert.equal(s.launches.length, 1)
  await s.worker.deactivate()
})

test('orchestrator.start refuses bad names, a missing folder and odd models', async () => {
  const s = await setup()
  for (const input of [
    { ...START, project: '../etc' },
    { ...START, project: 'nowhere' },
    { ...START, model: '' },
    { ...START, model: 'a model; rm -rf' },
    { ...START, agent: '' },
  ]) {
    const r = await s.worker.request('orchestrator.start', input)
    assert.ok('error' in r, JSON.stringify(input))
  }
  assert.equal(s.launches.length, 0)
  await s.worker.deactivate()
})

test('orchestrator.options reads the catalog file and selects the defaults', async () => {
  const raw = readFileSync(
    new URL('../../test/fixtures/model-catalog.json', import.meta.url),
    'utf8',
  )
  const s = await setup({ files: { [CATALOG_JSON]: raw } })
  const r = await s.worker.request('orchestrator.options', null)
  assert.deepEqual(r.defaults, { agent: 'claude', model: 'claude-opus-5-5' })
  assert.deepEqual(
    r.agents.map((a) => a.agent),
    ['claude', 'codex'],
  )
  const claude = r.agents[0]?.models.map((m) => m.id) ?? []
  assert.ok(claude.includes('claude-opus-5-5'))
  assert.ok(claude.includes('claude-haiku-5-5'))
  await s.worker.deactivate()
})

test('orchestrator.options reads the catalog database when there is no file', async () => {
  const raw = JSON.parse(
    readFileSync(
      new URL('../../test/fixtures/model-catalog.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: unknown[] }
  const calls: [string, string[]][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, args])
    return {
      code: 0,
      stdout: JSON.stringify(
        raw.entries.map((e) => ({ value: JSON.stringify(e) })),
      ),
      stderr: '',
    }
  }
  const s = await setup({ files: { [CATALOG_DB]: '' }, exec })
  const r = await s.worker.request('orchestrator.options', null)
  assert.ok(r.agents.some((a) => a.models.some((m) => m.id === 'gpt-6.1-sol')))
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.[0], '/usr/bin/sqlite3')
  assert.ok(calls[0]?.[1].includes('-readonly'))
  assert.ok(calls[0]?.[1].includes(CATALOG_DB))
  await s.worker.deactivate()
})

test('orchestrator.options falls back to the settings without a catalog', async () => {
  const s = await setup({
    settings: { orchestratorModel: 'my-model' },
  })
  const r = await s.worker.request('orchestrator.options', null)
  assert.deepEqual(r.defaults, { agent: 'claude', model: 'my-model' })
  const claude = r.agents.find((a) => a.agent === 'claude')
  assert.ok(claude?.models.some((m) => m.id === 'my-model'))
  const codex = r.agents.find((a) => a.agent === 'codex')
  assert.ok(codex?.models.some((m) => m.id === 'gpt-6.1-sol'))
  await s.worker.deactivate()
})

test('orchestrator.jump switches to the live orchestrator terminal', async () => {
  const s = await setup({ live: ['term_old'] })
  await s.tracker.recordOrchestrator({
    project: 'demo',
    workspaceId: HUB,
    terminalId: 'term_old',
    agent: 'claude',
    model: 'claude-opus-5-5',
    runId: null,
  })
  assert.deepEqual(
    await s.worker.request('orchestrator.jump', { project: 'demo' }),
    { ok: true },
  )
  assert.deepEqual(s.switched, ['term_old'])
  const r = await s.worker.request('orchestrator.jump', { project: 'other' })
  assert.ok('error' in r)
  assert.deepEqual(s.switched, ['term_old'])
  await s.worker.deactivate()
})

test('a project board carries its live orchestrator with its state', async () => {
  const summaries = [
    {
      id: HUB,
      identityKey: '',
      projectId: '',
      repoId: 'hub1',
      path: ROOT,
      branch: null,
      displayName: 'projects',
      isMainWorktree: false,
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
      agents: [
        {
          paneKey: 'tab-term_old:leaf-term_old',
          parentPaneKey: null,
          terminalId: null,
          title: 'Planning',
          detail: null,
          state: 'waiting' as const,
          since: 1,
          updatedAt: 1,
          agent: 'claude',
          model: null,
        },
      ],
    },
  ]
  const s = await setup({ live: ['term_old'], summaries })
  await s.tracker.recordOrchestrator({
    project: 'demo',
    workspaceId: HUB,
    terminalId: 'term_old',
    agent: 'claude',
    model: 'claude-opus-5-5',
    runId: null,
  })
  const r = await s.worker.request('board.get', {
    filter: { scope: 'project', project: 'demo' },
  })
  assert.ok('model' in r)
  assert.deepEqual(
    (r as { model: { orchestrator: unknown } }).model.orchestrator,
    {
      terminalId: 'term_old',
      name: 'Claude Code',
      agent: 'claude',
      model: 'claude-opus-5-5',
      state: 'waiting',
    },
  )
  const g = await s.worker.request('board.get', { filter: { scope: 'global' } })
  assert.equal(
    (g as { model: { orchestrator: unknown } }).model.orchestrator,
    null,
  )
  await s.worker.deactivate()
})

test('a failed launch says to check the global hub and records nothing', async () => {
  const s = await setup({ launchFails: true })
  const r = await s.worker.request('orchestrator.start', START)
  assert.ok('error' in r)
  const error = (r as { error: string }).error
  assert.match(error, /global hub/)
  assert.ok(!/Try again/.test(error), error)
  assert.equal(s.launches.length, 1)
  assert.deepEqual(await s.tracker.orchestrators(), [])
  assert.deepEqual(
    (await s.worker.request('orchestrator.options', { project: 'demo' }))
      .defaults,
    { agent: 'claude', model: 'claude-opus-5-5' },
  )
  await s.worker.deactivate()
})

test('the last started choice is the default for that project only', async () => {
  const s = await setup({ dirs: [`${ROOT}/demo`] })
  assert.deepEqual(
    await s.worker.request('orchestrator.start', {
      project: 'demo',
      agent: 'codex',
      model: 'gpt-7-new',
    }),
    { ok: true },
  )
  const demo = await s.worker.request('orchestrator.options', {
    project: 'demo',
  })
  assert.deepEqual(demo.defaults, { agent: 'codex', model: 'gpt-7-new' })
  const codex = demo.agents.find((a) => a.agent === 'codex')
  assert.ok(codex?.models.some((m) => m.id === 'gpt-7-new'))
  const other = await s.worker.request('orchestrator.options', {
    project: 'other',
  })
  assert.deepEqual(other.defaults, {
    agent: 'claude',
    model: 'claude-opus-5-5',
  })
  const none = await s.worker.request('orchestrator.options', null)
  assert.deepEqual(none.defaults, { agent: 'claude', model: 'claude-opus-5-5' })
  const stored = (s.host.data().storage as Record<string, unknown>)[
    'orchestrator-choice.v1'
  ]
  assert.deepEqual(stored, {
    choices: { demo: { agent: 'codex', model: 'gpt-7-new' } },
  })
  await s.worker.deactivate()
})

const WORKER_DEFAULTS = {
  implementation: { agent: 'codex', model: 'gpt-6.1-sol' },
  review: { agent: 'codex', model: 'gpt-6.1-sol' },
  design: { agent: 'claude', model: 'claude-opus-4-8' },
  prose: { agent: 'claude', model: 'claude-opus-4-8' },
}

const WORKER_PICK = {
  project: 'demo',
  kind: 'review',
  agent: 'opencode2',
  model: 'provider/model:level',
} as const

test('workerDefaults.get merges globals and project overrides and shares Start options', async () => {
  const s = await setup({ settings: { workerProse: 'custom:org/model@v1' } })
  const initial = await s.worker.request('workerDefaults.get', {
    project: 'demo',
  })
  assert.deepEqual(initial.defaults, {
    ...WORKER_DEFAULTS,
    prose: { agent: 'custom', model: 'org/model@v1' },
  })
  assert.deepEqual(await s.worker.request('workerDefaults.set', WORKER_PICK), {
    ok: true,
  })
  const r = await s.worker.request('workerDefaults.get', { project: 'DEMO' })
  assert.deepEqual(r.defaults.review, {
    agent: 'opencode2',
    model: 'provider/model:level',
  })
  assert.deepEqual(
    r.options,
    (await s.worker.request('orchestrator.options', { project: 'DEMO' }))
      .agents,
  )
  assert.deepEqual(s.host.data().storage['worker-defaults.v1'], {
    demo: { review: { agent: 'opencode2', model: 'provider/model:level' } },
  })
  assert.deepEqual(
    (await s.worker.request('workerDefaults.get', { project: 'other' }))
      .defaults.review,
    WORKER_DEFAULTS.review,
  )
  await s.worker.deactivate()
})

test('worker defaults persist across activation and simultaneous kind changes', async () => {
  const s = await setup()
  const results = await Promise.all([
    s.worker.request('workerDefaults.set', WORKER_PICK),
    s.worker.request('workerDefaults.set', {
      ...WORKER_PICK,
      kind: 'implementation',
      agent: 'claude',
      model: 'gpt-custom',
    }),
  ])
  assert.deepEqual(results, [{ ok: true }, { ok: true }])
  await s.worker.deactivate()
  const worker = await mountWorker(
    {
      default: (orca) =>
        main.activateWith(orca, { cli: s.cli, fs: s.fs, home: HOME }),
    },
    { host: s.host },
  )
  const r = await worker.request('workerDefaults.get', { project: 'demo' })
  assert.deepEqual(r.defaults.review, {
    agent: 'opencode2',
    model: 'provider/model:level',
  })
  assert.deepEqual(r.defaults.implementation, {
    agent: 'claude',
    model: 'gpt-custom',
  })
  await worker.deactivate()
})

test('worker defaults write a pretty file and exclude it once before starting', async () => {
  const root = '/Users/m/Projects with spaces'
  const path = `${root}/demo`
  const s = await setup({
    settings: { projectsRoot: root },
    dirs: [path],
    files: {
      [`${path}/.git/HEAD`]: 'ref: refs/heads/main\n',
      [`${path}/.git`]: '',
      [`${path}/.git/info/exclude`]: '# local',
    },
  })
  assert.deepEqual(await s.worker.request('workerDefaults.set', WORKER_PICK), {
    ok: true,
  })
  const expected = {
    ...WORKER_DEFAULTS,
    review: { agent: 'opencode2', model: 'provider/model:level' },
  }
  assert.equal(
    s.files[`${path}/.unifier/worker-defaults.json`],
    `${JSON.stringify(expected, null, 2)}\n`,
  )
  assert.equal(s.files[`${path}/.git/info/exclude`], '# local\n.unifier/\n')
  assert.deepEqual(await s.worker.request('orchestrator.start', START), {
    ok: true,
  })
  assert.equal(s.files[`${path}/.git/info/exclude`], '# local\n.unifier/\n')
  assert.deepEqual(
    JSON.parse(s.files[`${path}/.unifier/worker-defaults.json`] ?? '{}'),
    expected,
  )
  assert.ok(
    s.launches[0]?.prompt.includes(`${path}/.unifier/worker-defaults.json`),
  )
  await s.worker.deactivate()
})

test('worker defaults refuse excluded projects and unsafe or unknown selections without writing', async () => {
  const s = await setup({
    dirs: [`${ROOT}/demo`, `${ROOT}/alpha`, `${ROOT}/Beta`],
  })
  for (const project of ['alpha', 'ALPHA', 'beta', 'Beta', '../elsewhere']) {
    const r = await s.worker.request('workerDefaults.set', {
      ...WORKER_PICK,
      project,
    })
    assert.ok('error' in r)
    await assert.rejects(() =>
      s.worker.request('workerDefaults.get', { project }),
    )
  }
  for (const over of [
    { agent: 'Bad' },
    { model: 'a model' },
    { agent: '' },
    { model: '' },
    { kind: 'other' },
    { project: 'missing' },
  ]) {
    assert.ok(
      'error' in
        (await s.worker.request('workerDefaults.set', {
          ...WORKER_PICK,
          ...over,
        } as typeof WORKER_PICK)),
    )
  }
  assert.deepEqual(s.files, {})
  assert.equal(s.host.data().storage['worker-defaults.v1'], undefined)
  await s.worker.deactivate()
})

test('worker defaults require catalog membership for the selected agent and model', async () => {
  const raw = readFileSync(
    new URL('../../test/fixtures/model-catalog.json', import.meta.url),
    'utf8',
  )
  const s = await setup({ files: { [CATALOG_JSON]: raw } })
  for (const over of [
    {},
    { agent: 'codex', model: 'unknown' },
    { agent: 'claude', model: 'gpt-6.1-sol' },
  ]) {
    assert.ok(
      'error' in
        (await s.worker.request('workerDefaults.set', {
          ...WORKER_PICK,
          ...over,
        })),
    )
  }
  assert.deepEqual(
    await s.worker.request('workerDefaults.set', {
      ...WORKER_PICK,
      agent: 'codex',
      model: 'gpt-6.1-terra',
    }),
    { ok: true },
  )
  const r = await s.worker.request('workerDefaults.get', { project: 'demo' })
  assert.equal(r.defaults.review.model, 'gpt-6.1-terra')
  assert.deepEqual(
    r.options,
    (await s.worker.request('orchestrator.options', { project: 'demo' }))
      .agents,
  )
  await s.worker.deactivate()
})

test('orchestrator start refreshes effective defaults after global settings change', async () => {
  const s = await setup({
    settings: { workerImplementation: 'custom:new-model' },
  })
  assert.deepEqual(await s.worker.request('orchestrator.start', START), {
    ok: true,
  })
  const file = JSON.parse(
    s.files[`${ROOT}/demo/.unifier/worker-defaults.json`] ?? '{}',
  )
  assert.deepEqual(file.implementation, { agent: 'custom', model: 'new-model' })
  await s.worker.deactivate()
})

test('a failed defaults storage save restores the file to the persisted defaults', async () => {
  const s = await setup({ failDefaultStorage: true })
  const r = await s.worker.request('workerDefaults.set', WORKER_PICK)
  assert.ok('error' in r)
  assert.deepEqual(
    (await s.worker.request('workerDefaults.get', { project: 'demo' }))
      .defaults,
    WORKER_DEFAULTS,
  )
  assert.deepEqual(
    JSON.parse(s.files[`${ROOT}/demo/.unifier/worker-defaults.json`] ?? '{}'),
    WORKER_DEFAULTS,
  )
  assert.equal(s.host.data().storage['worker-defaults.v1'], undefined)
  await s.worker.deactivate()
})

test('settings mutation refreshes files for live orchestrators and saved defaults', async () => {
  const s = await setup({ dirs: [`${ROOT}/demo`, `${ROOT}/saved`] })
  try {
    await s.worker.request('orchestrator.start', START)
    await s.worker.request('workerDefaults.set', {
      ...WORKER_PICK,
      project: 'saved',
    })
    await s.api.settings.set('workerImplementation', 'custom:changed')
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (const project of ['demo', 'saved']) {
      const file = JSON.parse(
        s.files[`${ROOT}/${project}/.unifier/worker-defaults.json`] ?? '{}',
      )
      assert.deepEqual(file.implementation, {
        agent: 'custom',
        model: 'changed',
      })
    }
  } finally {
    await s.worker.deactivate()
  }
})

for (const request of [
  'orchestrator.start',
  'orchestrator.jump',
  'workerDefaults.set',
] as const) {
  test(`${request} reports settings failures without side effects`, async () => {
    const s = await setup()
    s.host.respond('settings.get', () => {
      throw new Error('settings unavailable')
    })
    try {
      const result =
        request === 'orchestrator.start'
          ? await s.worker.request(request, START)
          : request === 'orchestrator.jump'
            ? await s.worker.request(request, { project: 'demo' })
            : await s.worker.request(request, {
                project: 'demo',
                kind: 'review',
                agent: 'codex',
                model: 'gpt-6.1-sol',
              })
      assert.ok('error' in result)
      assert.equal(s.launches.length, 0)
      assert.equal(s.switched.length, 0)
    } finally {
      await s.worker.deactivate()
    }
  })
}
