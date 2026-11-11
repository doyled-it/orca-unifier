import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import * as main from '../worker'

const ROOT = '/Users/m/projects'

function fakeFs(files: Record<string, string> = {}) {
  const dirs: string[] = []
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
    async list() {
      return []
    },
  }
  return { fs, files, dirs }
}

async function setup(
  files: Record<string, string> = {},
  excludedProjects = 'alpha,beta',
) {
  const f = fakeFs(files)
  const ensured: string[] = []
  const cli = {
    async ensureFolderWorkspace(p: string) {
      ensured.push(p)
      return `repo1::${p}`
    },
  } as unknown as OrcaCli
  const host = mockHost({
    settings: { excludedProjects, projectsRoot: ROOT },
    results: {
      'workspace.open': { opened: true },
      'editor.open': { opened: true },
    },
  })
  const worker = await mountWorker(
    { default: (orca) => main.activateWith(orca, { cli, fs: f.fs }) },
    { host },
  )
  return { worker, host, ensured, ...f }
}

const BOARD = `${ROOT}/demo/.unifier/board.unifier-board`

test('hub.open for a project writes the board file and opens it in order', async () => {
  const { worker, host, ensured, files } = await setup()
  const r = await worker.request('hub.open', {
    scope: 'project',
    project: 'demo',
  })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(ensured, [`${ROOT}/demo`])
  assert.equal(
    files[BOARD],
    '{\n  "scope": "project",\n  "project": "demo"\n}\n',
  )
  const calls = host.calls.filter(
    (c) => c.method === 'workspace.open' || c.method === 'editor.open',
  )
  assert.deepEqual(calls, [
    {
      method: 'workspace.open',
      params: { workspaceId: `repo1::${ROOT}/demo` },
    },
    {
      method: 'editor.open',
      params: {
        workspaceId: `repo1::${ROOT}/demo`,
        path: '.unifier/board.unifier-board',
      },
    },
  ])
  await worker.deactivate()
})

test('hub.open never overwrites an existing board file', async () => {
  const { worker, files } = await setup({ [BOARD]: 'mine' })
  const r = await worker.request('hub.open', {
    scope: 'project',
    project: 'demo',
  })
  assert.deepEqual(r, { ok: true })
  assert.equal(files[BOARD], 'mine')
  await worker.deactivate()
})

test('hub.open excludes .unifier in a git hub once', async () => {
  const { worker, files } = await setup({
    [`${ROOT}/demo/.git`]: '',
    [`${ROOT}/demo/.git/HEAD`]: 'ref',
    [`${ROOT}/demo/.git/info/exclude`]: '# x\n',
  })
  await worker.request('hub.open', { scope: 'project', project: 'demo' })
  await worker.request('hub.open', { scope: 'project', project: 'demo' })
  assert.equal(files[`${ROOT}/demo/.git/info/exclude`], '# x\n.unifier/\n')
  await worker.deactivate()
})

test('hub.open refuses a .git file whose common directory cannot be resolved', async () => {
  const { worker, files, dirs } = await setup({
    [`${ROOT}/demo/.git`]: 'gitdir: x',
  })
  const r = await worker.request('hub.open', {
    scope: 'project',
    project: 'demo',
  })
  assert.ok('error' in r)
  assert.ok(!dirs.some((d) => d.includes('.git/info')))
  assert.ok(!(`${ROOT}/demo/.git/info/exclude` in files))
  await worker.deactivate()
})

test('hub.open refuses excluded projects', async () => {
  const { worker, ensured, host } = await setup()
  for (const project of ['alpha', 'beta']) {
    const r = await worker.request('hub.open', { scope: 'project', project })
    assert.ok('error' in r && /excluded for now/.test(r.error))
  }
  assert.deepEqual(ensured, [])
  assert.equal(host.callsOf('workspace.open').length, 0)
  await worker.deactivate()
})

test('hub.open refuses project names that escape the root', async () => {
  const { worker, ensured } = await setup()
  for (const project of ['', '..', 'a/b', '../x']) {
    const r = await worker.request('hub.open', { scope: 'project', project })
    assert.ok('error' in r)
  }
  assert.deepEqual(ensured, [])
  await worker.deactivate()
})

test('hub.open returns a plain error when the workspace cannot be created', async () => {
  const f = fakeFs()
  const cli = {
    async ensureFolderWorkspace() {
      throw new Error('boom')
    },
  } as unknown as OrcaCli
  const host = mockHost({
    settings: { excludedProjects: 'alpha,beta', projectsRoot: ROOT },
  })
  const worker = await mountWorker(
    { default: (orca) => main.activateWith(orca, { cli, fs: f.fs }) },
    { host },
  )
  const r = await worker.request('hub.open', { scope: 'global' })
  assert.ok('error' in r && !/boom/.test(r.error))
  await worker.deactivate()
})

test('unifier.openHub and unifier.openBoard open the global hub', async () => {
  const { worker, host, ensured } = await setup()
  await worker.command('unifier.openHub')
  await worker.command('unifier.openBoard')
  assert.deepEqual(ensured, [ROOT, ROOT])
  assert.equal(host.callsOf('workspace.open').length, 2)
  assert.equal(
    (host.callsOf('editor.open')[0] as { path: string }).path,
    '.unifier/board.unifier-board',
  )
  await worker.deactivate()
})

test('hub.open reports a settings failure before any workspace or file changes', async () => {
  const s = await setup()
  s.host.respond('settings.get', () => {
    throw new Error('settings unavailable')
  })
  try {
    const result = await s.worker.request('hub.open', {
      scope: 'project',
      project: 'demo',
    })
    assert.ok('error' in result)
    assert.deepEqual(s.ensured, [])
    assert.deepEqual(s.files, {})
  } finally {
    await s.worker.deactivate()
  }
})

for (const excluded of ['', 'demo']) {
  test(`hub.open uses the configured list ${JSON.stringify(excluded)}`, async () => {
    const s = await setup({}, excluded)
    try {
      const result = await s.worker.request('hub.open', {
        scope: 'project',
        project: 'demo',
      })
      assert.equal('error' in result, excluded === 'demo')
      assert.equal(s.ensured.length, excluded === 'demo' ? 0 : 1)
    } finally {
      await s.worker.deactivate()
    }
  })
}

test('hub.open permits example excluded names with empty defaults', async () => {
  const s = await setup({}, '')
  try {
    for (const project of ['alpha', 'beta']) {
      assert.deepEqual(
        await s.worker.request('hub.open', { scope: 'project', project }),
        { ok: true },
      )
    }
    assert.equal(s.ensured.length, 2)
  } finally {
    await s.worker.deactivate()
  }
})
