import type { OrcaWorkerApi } from 'orca/worker'
import type { Exec } from '../adapters/exec'
import type { FsLike } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import type { Templates } from '../adapters/templates'
import type { OrchestratorView } from '../core/board-types'
import { BOARD_DIR, hubFolder, isPlainProjectName } from '../core/hubs'
import { isExcludedProject } from '../core/projects'
import { parseSettings } from '../core/settings'
import { type CharterVars, renderCharter } from '../core/templates'
import type { UnifierSettings, WorktreeSummary } from '../core/types'
import { AGENT_ID, MODEL_ID } from '../core/worker-defaults'
import { modelOptions, rememberChoice } from './model-options'
import type { Tracker } from './tracker'
import type { WorkerDefaultsService } from './worker-defaults-service'
import '../protocol'

const CHECK_HUB =
  'The Orchestrator may have started anyway. Check the global hub for it before starting another.'

export interface OrchestratorService {
  /**
   * The project's live Orchestrator, newest first, or null. A terminal whose
   * liveness cannot be checked counts as live, so a second one is never started
   * by mistake. `summaries` supply the agent state when given.
   */
  view(
    project: string,
    summaries?: readonly WorktreeSummary[],
  ): Promise<OrchestratorView | null>
  dispose(): void
}

/** The Orchestrator's first prompt: the charter, then the report format and the reviewer brief. */
export function orchestratorPrompt(t: Templates, vars: CharterVars): string {
  return `${[renderCharter(t.charter, vars), t.reportFormat, t.reviewerBrief]
    .map((s) => s.trimEnd())
    .join('\n\n')}\n`
}

export function createOrchestratorService(
  orca: OrcaWorkerApi,
  deps: {
    cli: OrcaCli
    tracker: Tracker
    workerDefaults: WorkerDefaultsService
    settings: () => Promise<UnifierSettings>
    fs: FsLike
    exec: Exec
    home: string
    templates: () => Templates
  },
): OrchestratorService {
  const { cli, tracker, fs } = deps
  /** Projects with a start in flight, so a double click launches once. */
  const starting = new Set<string>()

  async function view(
    project: string,
    summaries: readonly WorktreeSummary[] = [],
  ): Promise<OrchestratorView | null> {
    const key = project.toLowerCase()
    const mine = (await tracker.orchestrators()).filter(
      (o) => o.project.toLowerCase() === key,
    )
    for (let i = mine.length - 1; i >= 0; i--) {
      const o = mine[i]
      if (!o) continue
      const base = {
        terminalId: o.terminalId,
        agent: o.agent,
        model: o.model,
      }
      let info: Awaited<ReturnType<OrcaCli['terminalInfo']>>
      try {
        info = await cli.terminalInfo(o.terminalId)
      } catch {
        return { ...base, name: 'Orchestrator', state: null }
      }
      if (!info) continue
      const pane = info.paneKey
      const agent = pane
        ? summaries.flatMap((w) => w.agents).find((a) => a.paneKey === pane)
        : undefined
      return {
        ...base,
        name: info.title ?? 'Orchestrator',
        state: agent?.state ?? null,
      }
    }
    return null
  }

  /** Repo folders of a project: the folder itself when it is a repo, then repo subfolders. */
  async function reposOf(projectPath: string): Promise<string[]> {
    const out: string[] = []
    if (await fs.exists(`${projectPath}/.git`)) out.push(projectPath)
    let names: string[] = []
    try {
      names = await fs.list(projectPath)
    } catch {
      return out
    }
    for (const name of [...names].sort()) {
      if (name.startsWith('.')) continue
      const dir = `${projectPath}/${name}`
      if (await fs.exists(`${dir}/.git`)) out.push(dir)
    }
    return out
  }

  async function options(input: { project: string } | null) {
    let s: UnifierSettings
    try {
      s = await deps.settings()
    } catch {
      s = parseSettings({}, deps.home)
    }
    const project = input?.project ?? null
    const workers = await deps.workerDefaults.effective(project, s)
    const { agents, defaults } = await modelOptions(
      orca,
      deps,
      project,
      s,
      workers,
    )
    return { agents, defaults }
  }

  async function start(input: {
    project: string
    agent: string
    model: string
  }): Promise<{ ok: true } | { error: string }> {
    const { project, agent, model } = input
    if (!isPlainProjectName(project)) {
      return { error: 'That is not a Project name.' }
    }
    if (!AGENT_ID.test(agent) || !MODEL_ID.test(model)) {
      return { error: 'Pick an agent and a model first.' }
    }
    const key = project.toLowerCase()
    if (starting.has(key)) {
      return { error: `The ${project} Orchestrator is already starting.` }
    }
    starting.add(key)
    try {
      const s = await deps.settings()
      if (isExcludedProject(project, s.excludedProjects)) {
        return {
          error: `${project} is excluded for now, so it has no Orchestrator.`,
        }
      }
      const projectPath = hubFolder(
        { scope: 'project', project },
        s.projectsRoot,
      )
      if (!(await fs.exists(projectPath))) {
        return {
          error: `There is no ${project} folder in the Projects folder.`,
        }
      }
      if (await view(project)) {
        return { error: `${project} already has an Orchestrator.` }
      }
      await deps.workerDefaults.write(project, s)
      const prompt = orchestratorPrompt(deps.templates(), {
        project,
        projectPath,
        repos: await reposOf(projectPath),
        railsPath: `${projectPath}/${BOARD_DIR}/rails.md`,
      })
      // One terminal belongs to one workspace: Orchestrators live in the global hub.
      const hub = hubFolder({ scope: 'global' }, s.projectsRoot)
      const workspaceId = await cli.ensureFolderWorkspace(hub)
      // From here a launch may have happened even when a call throws.
      try {
        const { terminalId } = await cli.launchAgent({
          workspacePath: hub,
          agent,
          model,
          prompt,
        })
        await tracker.recordOrchestrator({
          project,
          workspaceId,
          terminalId,
          agent,
          model,
          runId: null,
        })
        orca.log(
          `unifier: started the ${project} orchestrator in ${terminalId}`,
        )
      } catch (e) {
        orca.log(`unifier: orchestrator.start launch failed: ${String(e)}`)
        return { error: CHECK_HUB }
      }
      await rememberChoice(orca, project, { agent, model })
      return { ok: true as const }
    } catch (e) {
      orca.log(`unifier: orchestrator.start failed: ${String(e)}`)
      return { error: 'The Orchestrator could not be started. Try again.' }
    } finally {
      starting.delete(key)
    }
  }

  async function jump(
    project: string,
  ): Promise<{ ok: true } | { error: string }> {
    if (!isPlainProjectName(project)) {
      return { error: 'That Project has no Orchestrator.' }
    }
    try {
      const s = await deps.settings()
      if (isExcludedProject(project, s.excludedProjects)) {
        return { error: 'That Project has no Orchestrator.' }
      }
      const live = await view(project)
      if (!live) return { error: `${project} has no Orchestrator running.` }
      await cli.switchTerminal(live.terminalId)
      return { ok: true as const }
    } catch (e) {
      orca.log(`unifier: orchestrator.jump failed: ${String(e)}`)
      return { error: 'Could not show the Orchestrator. Try again.' }
    }
  }

  const subs = [
    orca.panels.handle('orchestrator.options', (input) => options(input)),
    orca.panels.handle('orchestrator.start', (input) => start(input)),
    orca.panels.handle('orchestrator.jump', ({ project }) => jump(project)),
  ]

  return {
    view,
    dispose() {
      for (const s of subs) s.dispose()
    },
  }
}
