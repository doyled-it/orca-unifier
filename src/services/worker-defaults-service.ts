import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import { safeMetadataFolder } from '../adapters/project-writes'
import { BOARD_DIR, isPlainProjectName } from '../core/hubs'
import { isExcludedProject } from '../core/projects'
import type { UnifierSettings } from '../core/types'
import {
  globalWorkerDefaults,
  isModelChoice,
  isWorkerKind,
  type ModelChoice,
  type WorkerDefaults,
  type WorkerKind,
} from '../core/worker-defaults'
import { excludeFromGit } from './hub-service'
import { modelOptions } from './model-options'
import { createRetirement } from './retirement'
import type { Tracker } from './tracker'
import '../protocol'

const KEY = 'worker-defaults.v1'
type Overrides = Record<string, Partial<Record<WorkerKind, ModelChoice>>>

function readOverrides(raw: unknown, excluded: string[]): Overrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([project, values]) => {
      if (
        !isPlainProjectName(project) ||
        isExcludedProject(project, excluded) ||
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values)
      )
        return []
      return [
        [
          project.toLowerCase(),
          Object.fromEntries(
            Object.entries(values).filter(
              ([kind, choice]) => isWorkerKind(kind) && isModelChoice(choice),
            ),
          ),
        ],
      ]
    }),
  )
}

function projectError(project: string, excluded: string[]): string | null {
  if (typeof project !== 'string' || !isPlainProjectName(project))
    return 'That is not a Project name.'
  return isExcludedProject(project, excluded)
    ? 'That Project is excluded from Worker defaults.'
    : null
}

export interface WorkerDefaultsService {
  effective(
    project: string | null,
    settings?: UnifierSettings,
  ): Promise<WorkerDefaults>
  write(project: string, settings?: UnifierSettings): Promise<void>
  dispose(): void
}

export function createWorkerDefaultsService(
  orca: OrcaWorkerApi,
  deps: {
    settings: () => Promise<UnifierSettings>
    fs: FsLike
    exec: Exec
    tracker?: Tracker
    home: string
  },
): WorkerDefaultsService {
  const { fs } = deps
  let pending: Promise<unknown> = Promise.resolve()

  async function effective(
    project: string | null,
    settings?: UnifierSettings,
  ): Promise<WorkerDefaults> {
    const s = settings ?? (await deps.settings())
    const defaults = globalWorkerDefaults(s)
    if (project === null) return defaults
    const error = projectError(project, s.excludedProjects)
    if (error) throw new Error(error)
    const overrides = readOverrides(
      await orca.storage.get(KEY),
      s.excludedProjects,
    )
    return {
      ...defaults,
      ...(Object.hasOwn(overrides, project.toLowerCase())
        ? overrides[project.toLowerCase()]
        : {}),
    }
  }

  async function writeDefaults(
    project: string,
    s: UnifierSettings,
    defaults: WorkerDefaults,
  ) {
    const error = projectError(project, s.excludedProjects)
    if (error) throw new Error(error)
    const path = await safeMetadataFolder(
      fs,
      s.projectsRoot,
      project,
      'worker-defaults.json',
      s.excludedProjects,
    )
    if (!(await fs.exists(path)))
      throw new Error('That Project folder could not be found.')
    await excludeFromGit(fs, path, s.excludedProjects, deps.exec)
    await fs.mkdir(`${path}/${BOARD_DIR}`)
    await fs.write(
      `${path}/${BOARD_DIR}/worker-defaults.json`,
      `${JSON.stringify(defaults, null, 2)}\n`,
    )
  }

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = pending.then(fn)
    pending = next.catch(() => {})
    return next
  }

  async function write(
    project: string,
    settings?: UnifierSettings,
  ): Promise<void> {
    return serial(async () => {
      const s = settings ?? (await deps.settings())
      await writeDefaults(project, s, await effective(project, s))
    })
  }

  let disposed = false
  const retire = createRetirement(
    (message) => orca.log(message),
    () => {
      disposed = true
    },
  )
  const subs = [
    orca.settings.onDidChange(() => {
      void serial(async () => {
        if (disposed) return
        const s = await deps.settings()
        const projects = new Set(
          ((await deps.tracker?.orchestrators()) ?? []).map((o) => o.project),
        )
        for (const project of await fs.list(s.projectsRoot)) {
          if (
            !projectError(project, s.excludedProjects) &&
            (await fs.exists(
              `${s.projectsRoot}/${project}/${BOARD_DIR}/worker-defaults.json`,
            ))
          )
            projects.add(project)
        }
        for (const project of projects) {
          if (disposed || projectError(project, s.excludedProjects)) continue
          try {
            await writeDefaults(project, s, await effective(project, s))
          } catch (e) {
            if (retire(e)) return
            orca.log(`unifier: Worker defaults refresh failed: ${String(e)}`)
          }
        }
        if (!disposed) orca.panels.post('board.changed', { at: Date.now() })
      }).catch((e) => {
        if (!retire(e))
          orca.log(`unifier: Worker defaults refresh failed: ${String(e)}`)
      })
    }),
    orca.panels.handle('workerDefaults.get', async ({ project }) => {
      const s = await deps.settings()
      const defaults = await effective(project, s)
      const { agents } = await modelOptions(orca, deps, project, s, defaults)
      return { defaults, options: agents }
    }),
    orca.panels.handle('workerDefaults.set', (input) =>
      serial(async () => {
        const { project, kind, agent, model } = input
        try {
          const s = await deps.settings()
          const error = projectError(project, s.excludedProjects)
          if (error) return { error }
          if (!isWorkerKind(kind) || !isModelChoice({ agent, model }))
            return { error: 'Pick a kind of work, an agent and a model first.' }
          const current = await effective(project, s)
          const { agents, catalogAvailable } = await modelOptions(
            orca,
            deps,
            project,
            s,
            current,
          )
          if (
            catalogAvailable &&
            !agents.some(
              (a) => a.agent === agent && a.models.some((m) => m.id === model),
            )
          ) {
            return {
              error: 'Pick an agent and model from the available choices.',
            }
          }
          const choice = { agent, model }
          await writeDefaults(project, s, { ...current, [kind]: choice })
          const overrides = readOverrides(
            await orca.storage.get(KEY),
            s.excludedProjects,
          )
          const key = project.toLowerCase()
          const values = Object.hasOwn(overrides, key) ? overrides[key] : {}
          const updated = { ...overrides, [key]: { ...values, [kind]: choice } }
          try {
            await orca.storage.set(KEY, updated as unknown as JsonValue)
          } catch (e) {
            // A failed save must leave the Orchestrator and board in agreement.
            await writeDefaults(project, s, current)
            throw e
          }
          orca.panels.post('board.changed', { at: Date.now() })
          return { ok: true as const }
        } catch (e) {
          orca.log(`unifier: Worker defaults could not be saved: ${String(e)}`)
          return {
            error:
              'Worker defaults could not be saved. Check the Project folder and try again.',
          }
        }
      }),
    ),
  ]
  return {
    effective,
    write,
    dispose() {
      disposed = true
      for (const sub of subs) sub.dispose()
    },
  }
}
