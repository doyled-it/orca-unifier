import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import type { JsonValue, OrcaWorkerApi, PluginHooks } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { safeWorktreeMetadata } from '../adapters/project-writes'
import {
  recordSetupCreated,
  snapshotUntracked,
} from '../adapters/setup-created'
import { worktreeExclusionReason } from '../adapters/worktree-exclusion'
import { isExcludedProject, projectOfWorktree } from '../core/projects'
import {
  detectLanguages,
  gapReport,
  type Language,
  renderSetupCommand,
  setupArtifacts,
  setupCommands,
} from '../core/setup'
import type { UnifierSettings } from '../core/types'
import type { Schedule } from './board-service'
import type { Messenger } from './messenger'
import { createConsentBackoff } from './retirement'
import type { Tracker } from './tracker'

type CreatedWorktree = PluginHooks['workspace.create.after']['event']
type SetupTarget = Pick<CreatedWorktree, 'workspaceId' | 'path'>
interface Installation {
  terminalId: string
  artifacts?: string[]
  before: string[] | null
  report: string | null
  startedAt: number
}
interface Job extends SetupTarget {
  installation?: Installation
  id: string
  at: number
  /** Null until setup finishes; then only the gap note remains to deliver. */
  report: string | null
}

const KEY = 'setup.v1'
const NOTES_KEY = 'setup.notes.v1'
const MAX_NOTES = 500
const RETRY_MS = 1000
const KEEP_MS = 24 * 60 * 60 * 1000

function jobs(raw: unknown): Job[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (v): v is Job =>
      typeof v === 'object' &&
      v !== null &&
      typeof v.id === 'string' &&
      typeof v.path === 'string' &&
      typeof v.workspaceId === 'string' &&
      typeof v.at === 'number' &&
      Number.isFinite(v.at) &&
      (v.report === null || typeof v.report === 'string'),
  )
}

export function createSetupService(
  orca: OrcaWorkerApi,
  deps: {
    cli: Pick<OrcaCli, 'listWorktrees'>
    exec: Exec
    tracker: Pick<Tracker, 'ownerOfWorkspace'>
    messenger: Pick<Messenger, 'toOrchestrator'>
    fs: FsLike
    schedule?: Schedule
    settings: () => Promise<UnifierSettings>
  },
): { dispose(): void } {
  const { fs } = deps
  let disposed = false
  // Only serialization lives in memory. Jobs and deferred notes survive restarts.
  let pending: Promise<void> = Promise.resolve()
  let mutations: Promise<unknown> = Promise.resolve()
  let cancelRetry: (() => void) | null = null
  const retryNotes = new Set<string>()
  const schedule: Schedule =
    deps.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
  const backoff = createConsentBackoff(
    (message) => orca.log(message),
    schedule,
    () => queueDrain(),
  )

  async function read(): Promise<Job[]> {
    return jobs(await orca.storage.get(KEY).then(backoff.success))
  }

  function update(fn: (current: Job[]) => Job[]): Promise<void> {
    const next = mutations.then(async () => {
      await orca.storage
        .set(KEY, fn(await read()) as unknown as JsonValue)
        .then(backoff.success)
    })
    mutations = next.catch(() => {})
    return next
  }

  function remove(id: string) {
    return update((current) => current.filter((job) => job.id !== id))
  }

  async function readNotes(): Promise<string[]> {
    const raw = await orca.storage.get(NOTES_KEY).then(backoff.success)
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string')
      : []
  }

  async function note(owner: string, path: string, report: string) {
    const hash = createHash('sha256')
      .update(await fs.read(report))
      .digest('hex')
    const id = JSON.stringify([path, hash])
    const notified = await readNotes()
    if (notified.includes(id) && !retryNotes.has(id)) return
    // Claim before messaging: a restart during delivery must not enqueue it again.
    // Retain the claim after delivery, independently of the pending job.
    await orca.storage
      .set(
        NOTES_KEY,
        [...notified.filter((n) => n !== id), id].slice(-MAX_NOTES),
      )
      .then(backoff.success)
    try {
      await deps.messenger.toOrchestrator(
        owner,
        'Setup gaps',
        `Setup gaps: ${JSON.stringify(report).slice(1, -1)}`,
      )
      retryNotes.delete(id)
    } catch (e) {
      retryNotes.add(id)
      // Messenger rejects only when enqueue failed; leave that note retryable.
      await orca.storage
        .set(
          NOTES_KEY,
          (await readNotes()).filter((n) => n !== id),
        )
        .then(backoff.success)
      retryNotes.delete(id)
      throw e
    }
  }

  async function excludeReport(path: string, excluded: string[]) {
    const result = await deps.exec('git', [
      '-C',
      path,
      'rev-parse',
      '--git-common-dir',
    ])
    const commonDir = result.stdout.trim()
    if (result.code !== 0 || result.error || !commonDir) {
      throw new Error('git common directory lookup failed')
    }
    const common = resolve(path, commonDir)
    const excludedDirectory = (dir: string) =>
      dir.split(sep).some((name) => isExcludedProject(name, excluded))
    if (excludedDirectory(common))
      throw new Error('That repository belongs to an excluded Project.')
    const canonical = await fs.realpath(common)
    if (excludedDirectory(canonical))
      throw new Error('That repository belongs to an excluded Project.')
    const info = join(canonical, 'info')
    const exclude = join(info, 'exclude')
    const text = (await fs.exists(exclude)) ? await fs.read(exclude) : ''
    if (text.split(/\r?\n/).includes('.unifier/')) return
    await fs.mkdir(info)
    await fs.append(
      exclude,
      `${text && !text.endsWith('\n') ? '\n' : ''}.unifier/\n`,
    )
  }

  async function missingTools(languages: Language[]): Promise<string[]> {
    const tools: Record<Language, string[]> = {
      python: ['ruff', 'uv'],
      typescript: ['bun'],
      rust: ['cargo-nextest', 'cargo-clippy'],
      go: ['golangci-lint', 'gotestsum'],
    }
    const labels: Record<Language, string> = {
      python: 'Python',
      typescript: 'TypeScript',
      rust: 'Rust',
      go: 'Go',
    }
    const checks = languages.flatMap((language) =>
      tools[language].map(async (tool) => {
        try {
          const result = await deps.exec(
            '/bin/sh',
            ['-c', 'command -v "$1"', 'unifier-tool-check', tool],
            { timeoutMs: 3000 },
          )
          if (result.code === 0 && !result.error && result.stdout.trim())
            return []
        } catch {
          /* Failed discovery means the tool is missing. */
        }
        return [`${labels[language]}: missing tool ${tool}`]
      }),
    )
    return (await Promise.all(checks)).flat()
  }

  async function eligible(
    event: SetupTarget,
    settings: UnifierSettings,
  ): Promise<boolean> {
    const worktrees = await deps.cli.listWorktrees()
    const mainPaths = new Map(
      worktrees.filter((w) => w.isMainWorktree).map((w) => [w.repoId, w.path]),
    )
    const worktree = worktrees.find(
      (w) => resolve(w.path) === resolve(event.path),
    )
    if (!worktree) return false
    const project = projectOfWorktree(
      worktree,
      mainPaths,
      settings.projectsRoot,
    )
    if (
      !project ||
      isExcludedProject(project, settings.excludedProjects) ||
      (await worktreeExclusionReason(
        worktree,
        mainPaths,
        settings.projectsRoot,
        settings.excludedProjects,
        fs.realpath,
      )) ||
      disposed
    )
      return false
    return true
  }

  async function setup(
    event: SetupTarget,
    settings: UnifierSettings,
  ): Promise<Installation | null> {
    await safeWorktreeMetadata(fs, event.path, 'setup-report.md')

    const files = await fs.list(event.path)
    const langs = detectLanguages(files)
    if (langs.length === 0) return null
    if (
      langs.includes('rust') &&
      (await fs.exists(join(event.path, '.config/nextest.toml')))
    ) {
      files.push('.config/nextest.toml')
    }
    const pyproject = files.includes('pyproject.toml')
      ? await fs.read(join(event.path, 'pyproject.toml'))
      : ''
    const gaps = [
      ...gapReport(langs, files, pyproject),
      ...(await missingTools(langs)),
    ]
    await excludeReport(event.path, settings.excludedProjects)
    if (disposed) return null
    const dir = join(event.path, '.unifier')
    const report = join(dir, 'setup-report.md')
    await fs.mkdir(dir)
    await safeWorktreeMetadata(fs, event.path, 'setup-report.md')
    await fs.write(
      report,
      `# Setup report\n\n${gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : 'No setup gaps found.'}\n`,
    )
    if (disposed) return null
    const before = await snapshotUntracked(deps.exec, event.path)
    const { terminalId } = await orca.host
      .call('terminal.create', {
        workspaceId: event.workspaceId,
        title: 'setup',
        command: renderSetupCommand(setupCommands(langs, files)),
      })
      .then(backoff.success)
    return {
      terminalId,
      artifacts: setupArtifacts(langs, files),
      before,
      report: gaps.length ? report : null,
      startedAt: Date.now(),
    }
  }

  async function drain() {
    let retry = false
    for (let job of await read()) {
      if (disposed) return
      if (Date.now() - job.at >= KEEP_MS) {
        await remove(job.id)
        continue
      }
      try {
        const settings = await deps.settings().then(backoff.success)
        if (disposed) return
        if (!settings.setupEnabled) {
          await remove(job.id)
          continue
        }
        // Recheck durable jobs against current settings before resuming any stage.
        const allowed = await eligible(job, settings)
        if (disposed) return
        if (!allowed) {
          await remove(job.id)
          continue
        }
        if (job.report === null && !job.installation) {
          const installation = await setup(job, settings)
          if (disposed) return
          if (!installation) {
            await remove(job.id)
            continue
          }
          job = { ...job, installation }
          const started = job
          await update((current) =>
            current.map((j) => (j.id === started.id ? started : j)),
          )
        }
        if (job.installation) {
          const installation = job.installation
          const screen = await orca.host
            .call('terminal.read', {
              terminalId: installation.terminalId,
              maxLines: 200,
            })
            .then(backoff.success)
          if (disposed) return
          const done = screen.lines.some(
            (line) => line.trim() === 'unifier setup: done',
          )
          const failed = screen.lines.some((line) =>
            line.trim().startsWith('unifier setup: failed at '),
          )
          if (
            !done &&
            !failed &&
            Date.now() - installation.startedAt < 30 * 60_000
          ) {
            retry = true
            continue
          }
          if (done && !failed)
            await recordSetupCreated(
              deps.exec,
              fs,
              job.path,
              installation.before,
              installation.artifacts ?? [],
            )
          job = { ...job, report: installation.report }
          delete job.installation
          const finished = job
          await update((current) =>
            current.map((j) => (j.id === finished.id ? finished : j)),
          )
          if (job.report === null) {
            await remove(job.id)
            continue
          }
        }
        const report = job.report
        if (report === null) {
          await remove(job.id)
          continue
        }
        const owner = await deps.tracker.ownerOfWorkspace(job.workspaceId)
        if (disposed) return
        if (!owner) {
          // Worker tracking arrives with the later dispatch prompt.
          retry = true
          continue
        }
        await note(owner, job.path, report)
        if (!disposed) await remove(job.id)
      } catch (e) {
        if (backoff.handle(e)) return
        orca.log(
          `unifier: setup${job.report ? ' note' : ''} failed: ${String(e)}`,
        )
        retry = true
      }
    }
    if (retry) scheduleDrain(RETRY_MS)
  }

  function scheduleDrain(ms = 0) {
    if (disposed || backoff.pending) return
    if (cancelRetry !== null) {
      if (ms !== 0) return
      cancelRetry()
    }
    cancelRetry = schedule(() => {
      cancelRetry = null
      queueDrain()
    }, ms)
  }

  function queueDrain() {
    if (disposed || backoff.pending) return
    pending = pending
      .then(async () => {
        if (!disposed && !backoff.pending) await drain()
      })
      .catch((e) => {
        if (backoff.handle(e)) return
        orca.log(`unifier: setup queue failed: ${String(e)}`)
        scheduleDrain(RETRY_MS)
      })
  }

  const sub = orca.hooks.on('workspace.create.after', async (event) => {
    if (event.kind !== 'worktree' || disposed) return
    // Persist before acknowledging the hook. Settings, CLI and setup stay deferred.
    try {
      await update((current) => [
        ...current,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          workspaceId: event.workspaceId,
          path: event.path,
          at: Date.now(),
          report: null,
        },
      ])
      scheduleDrain()
    } catch (e) {
      if (backoff.handle(e)) return
      orca.log(`unifier: setup queue failed: ${String(e)}`)
    }
  })

  // Hooks restart this worker. Resume durable setup jobs and pending gap notes.
  scheduleDrain()

  return {
    dispose() {
      disposed = true
      backoff.dispose()
      sub.dispose()
      cancelRetry?.()
      cancelRetry = null
    },
  }
}
