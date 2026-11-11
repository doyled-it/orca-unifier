import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { type Exec, nodeExec } from './adapters/exec'
import { type FsLike, nodeFs } from './adapters/fs'
import { createOrcaCli, type OrcaCli } from './adapters/orca-cli'
import { loadTemplates, workerBriefText } from './adapters/templates'
import { createAgentCheckService } from './services/agent-check-service'
import { createApproverService } from './services/approver-service'
import {
  createBoardService,
  type Schedule,
  settingsReader,
} from './services/board-service'
import { createCleanupService } from './services/cleanup-service'
import { createHubService } from './services/hub-service'
import { createLaunchWatch } from './services/launch-watch'
import { createMessenger } from './services/messenger'
import { createOrchestratorService } from './services/orchestrator-service'
import { createSetupService } from './services/setup-service'
import { createTracker } from './services/tracker'
import { createWorkerDefaultsService } from './services/worker-defaults-service'

const ORCA_BIN = '/Applications/Orca.app/Contents/Resources/bin/orca'

export interface WorkerDeps {
  cli?: OrcaCli
  exec?: Exec
  schedule?: Schedule
  /** Separate cleanup timer, independent of board debounce and approval polling. */
  cleanupSchedule?: Schedule
  fs?: FsLike
  /** Clock for message retries and once-a-day notices. */
  now?: () => number
  /** Home folder, where Orca keeps its model catalog. */
  home?: string
}

export function activateWith(
  orca: OrcaWorkerApi,
  deps: WorkerDeps = {},
): () => void {
  const instance = randomBytes(3).toString('hex')
  const log = orca.log.bind(orca)
  orca = {
    ...orca,
    log: (message) =>
      log(
        message
          .split('\n')
          .map((line) => `[${instance}] ${line}`)
          .join('\n'),
      ),
  }
  const exec = deps.exec ?? nodeExec
  const fs = deps.fs ?? nodeFs
  const cli = deps.cli ?? createOrcaCli(exec, ORCA_BIN)
  const settings = settingsReader(orca)
  const tracker = createTracker(orca.storage)
  const workerDefaults = createWorkerDefaultsService(orca, {
    settings,
    tracker,
    fs,
    exec,
    home: deps.home ?? homedir(),
  })
  const agentCheck = createAgentCheckService(orca, {
    fs,
    home: deps.home ?? homedir(),
    tracker,
  })
  const messenger = createMessenger(orca, {
    tracker,
    cli,
    globalHubWorkspaceId: async () =>
      cli.ensureFolderWorkspace((await settings()).projectsRoot),
    now: deps.now,
  })
  const orchestrators = createOrchestratorService(orca, {
    cli,
    tracker,
    settings,
    workerDefaults,
    fs,
    exec,
    home: deps.home ?? homedir(),
    templates: loadTemplates,
  })
  const board = createBoardService(
    orca,
    cli,
    settings,
    deps.schedule,
    async () =>
      (await tracker.launches()).map((l) => ({
        terminalId: l.terminalId,
        agent: l.agent,
        model: l.model,
      })),
    (project, summaries) => orchestrators.view(project, summaries),
    {
      workers: () => tracker.workers(),
      defaults: (project) => workerDefaults.effective(project),
    },
  )
  createHubService(orca, cli, settings, fs, exec)
  createLaunchWatch(orca, {
    tracker,
    messenger,
    cli,
    settings,
    workerBrief: () => workerBriefText(loadTemplates()),
    now: deps.now,
  })
  const approver = createApproverService(orca, {
    tracker,
    cli,
    messenger,
    board,
    settings,
    fs,
    now: deps.now,
    schedule: deps.schedule,
  })
  const setup = createSetupService(orca, {
    cli,
    exec,
    tracker,
    messenger,
    fs,
    settings,
  })
  const cleanup = createCleanupService(orca, {
    cli,
    exec,
    board,
    settings,
    schedule: deps.cleanupSchedule,
  })
  void approver.tick()
  // Drop launch records that kept whole commands, then send what a restarted
  // worker could not finish sending.
  void tracker.migrate().catch(() => {})
  void messenger.flush()
  orca.log('unifier: activated')
  return () => {
    messenger.dispose()
    workerDefaults.dispose()
    orchestrators.dispose()
    agentCheck.dispose()
    cleanup.dispose()
    setup.dispose()
    approver.dispose()
    board.dispose()
  }
}

let disposeWorker: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  disposeWorker = activateWith(orca)
}

export function deactivate(): void {
  disposeWorker?.()
  disposeWorker = null
}
