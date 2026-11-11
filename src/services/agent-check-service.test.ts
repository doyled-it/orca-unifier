import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import * as main from '../worker'

const HOME = '/Users/test user'
const rules = `prefix_rule(pattern=['uv'], decision='allow')
prefix_rule(pattern=['git'], decision='allow')`
const names = [
  ['development-loop', 'development-loop'],
  ['codegraph', 'using-codegraph'],
  ['cross-repo-completeness', 'cross-repo-completeness'],
  ['nonfiction-superpowers', 'writing-nonfiction'],
  ['superpowers', 'brainstorming'],
  ['superpowers', 'writing-plans'],
  ['superpowers', 'test-driven-development'],
  ['superpowers', 'requesting-code-review'],
  ['superpowers', 'verification-before-completion'],
]

function installed() {
  const files: Record<string, string> = {
    [`${HOME}/.codex/rules/default.rules`]: rules,
  }
  for (const [plugin, skill] of names) {
    files[
      `${HOME}/.claude/plugins/cache/example/${plugin}/1.0.0/skills/${skill}/SKILL.md`
    ] = 'skill'
    files[`${HOME}/.codex/skills/${skill}/SKILL.md`] = 'skill'
  }
  return files
}

async function setup(files = installed()) {
  const reads: string[] = []
  let mutations = 0
  const mutate = async () => {
    mutations++
  }
  const fs: FsLike = {
    async realpath(p) {
      return p
    },
    async lstat() {
      return null
    },
    async exists(path) {
      reads.push(path)
      return (
        path in files ||
        Object.keys(files).some((p) => p.startsWith(`${path}/`))
      )
    },
    async read(path) {
      reads.push(path)
      if (!(path in files)) throw new Error('unavailable')
      return files[path] as string
    },
    async list(path) {
      reads.push(path)
      return [
        ...new Set(
          Object.keys(files)
            .filter((p) => p.startsWith(`${path}/`))
            .map((p) => p.slice(path.length + 1).split('/')[0] as string),
        ),
      ]
    },
    write: mutate,
    append: mutate,
    mkdir: mutate,
  }
  const host = mockHost({
    settings: { cleanupEnabled: false, approverEnabled: false },
  })
  let storage!: OrcaWorkerApi['storage']
  const worker = await mountWorker(
    {
      default: (orca) => {
        storage = orca.storage
        return main.activateWith(orca, {
          fs,
          home: HOME,
          cli: {} as OrcaCli,
          exec: async () => {
            throw new Error('No child processes allowed')
          },
        })
      },
    },
    { host },
  )
  return { worker, host, storage, reads, mutations: () => mutations }
}

test('checkAgents discovers installed plugin skills and returns a read-only text report', async () => {
  const { worker, mutations } = await setup()
  try {
    const report = await worker.command('unifier.checkAgents')
    assert.equal(typeof report, 'string')
    assert.match(report as string, /No missing skills or Codex rules/)
    assert.match(report as string, /No recorded Codex launch/)
    assert.equal(mutations(), 0)
  } finally {
    await worker.deactivate()
  }
})

test('checkAgents accepts local Claude skills and requires SKILL.md for each agent', async () => {
  const files = installed()
  for (const [plugin, skill] of names) {
    delete files[
      `${HOME}/.claude/plugins/cache/example/${plugin}/1.0.0/skills/${skill}/SKILL.md`
    ]
    files[`${HOME}/.claude/skills/${skill}/SKILL.md`] = 'skill'
  }
  delete files[`${HOME}/.codex/skills/using-codegraph/SKILL.md`]
  files[`${HOME}/.codex/skills/using-codegraph/README.md`] = 'not a skill'
  const { worker } = await setup(files)
  try {
    const report = (await worker.command('unifier.checkAgents')) as string
    assert.match(report, /Codex: missing using-codegraph/)
    assert.ok(!report.includes('Claude: missing'))
  } finally {
    await worker.deactivate()
  }
})

test('checkAgents cites Codex installation instructions from the local README', async () => {
  const files = installed()
  delete files[`${HOME}/.codex/skills/brainstorming/SKILL.md`]
  files[`${HOME}/projects/agentic-dev-setup/README.md`] =
    '# Setup\nFor Codex:\n```sh\n./install.sh --codex-only --skip-codegraph\n```'
  const { worker, mutations } = await setup(files)
  try {
    const report = (await worker.command('unifier.checkAgents')) as string
    assert.match(report, /~\/projects\/agentic-dev-setup\/README.md/)
    assert.match(report, /install.sh --codex-only --skip-codegraph/)
    assert.equal(mutations(), 0)
  } finally {
    await worker.deactivate()
  }
})

test('checkAgents uses fallback sources with unavailable folders or unreadable instructions', async () => {
  const { worker, reads, mutations } = await setup({})
  try {
    const report = (await worker.command('unifier.checkAgents')) as string
    assert.match(report, /github.com\/doyled-it\/claude-skills/)
    assert.match(report, /github.com\/obra\/superpowers/)
    assert.match(report, /missing ~\/.codex\/rules\/default.rules/)
    assert.ok(reads.every((path) => path.startsWith(`${HOME}/`)))
    assert.equal(mutations(), 0)
  } finally {
    await worker.deactivate()
  }
})

test('checkAgents warns the user about the newest recorded Codex permission override', async () => {
  const { worker, storage } = await setup()
  try {
    await storage.set('tracker.v1', {
      orchestrators: [],
      workers: [],
      launches: [
        {
          terminalId: 'old',
          workspaceId: null,
          agent: 'codex',
          model: null,
          bypass: [],
          at: 10,
        },
        {
          terminalId: 'new',
          workspaceId: null,
          agent: 'codex',
          model: null,
          bypass: ['--approve-for-me'],
          at: 20,
        },
        {
          terminalId: 'claude',
          workspaceId: null,
          agent: 'claude',
          model: null,
          bypass: [],
          at: 30,
        },
      ],
    })
    const report = (await worker.command('unifier.checkAgents')) as string
    assert.match(report, /the user.*Codex permission override.*Orca Settings/)
    assert.match(report, /--approve-for-me/)
  } finally {
    await worker.deactivate()
  }
})

test('checkAgents uses the newest Codex timestamp and rechecks on every call', async () => {
  const { worker, storage } = await setup()
  try {
    await storage.set('tracker.v1', {
      orchestrators: [],
      workers: [],
      launches: [
        {
          terminalId: 'new',
          workspaceId: null,
          agent: 'codex',
          model: null,
          bypass: [],
          at: 30,
        },
        {
          terminalId: 'old',
          workspaceId: null,
          agent: 'codex',
          model: null,
          bypass: ['--approve-for-me'],
          at: 20,
        },
      ],
    })
    const report = (await worker.command('unifier.checkAgents')) as string
    assert.match(report, /does not include --approve-for-me/)
    assert.ok(!report.includes('the user'))
    await storage.set('tracker.v1', {
      orchestrators: [],
      workers: [],
      launches: [],
    })
    assert.match(
      (await worker.command('unifier.checkAgents')) as string,
      /No recorded Codex launch/,
    )
  } finally {
    await worker.deactivate()
  }
})
