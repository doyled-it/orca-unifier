# Unifier

Orca plugin (TypeScript, no build step, `src/worker.ts` is the entry). It shows a project-level board across Repos and Worktrees and coordinates an Orchestrator and Workers.

## Commands

- Load into Orca: commit, `bun run orca:sync` (exports HEAD to `~/.local/share/orca-dev/unifier`), then `orca plugin dev load`/`reload` on that folder. Never dev-load the repo itself: Orca hashes every file (including `.git` and `.codegraph`, which change underneath it) and refuses symlinks (`node_modules/.bin`), which leaves the plugin errored with a pinned hash that never matches.
- Test: `orca plugin test . --json`
- Typecheck: `bun run typecheck` (`tsc -p .` and `tsc -p editor`; run `orca plugin types . --json` first to create `.orca/types/`)
- Lint: `bunx biome check .`
- Validate: `orca plugin validate . --json`

## Rules

- Layering: `core` (pure logic) <- `adapters` (execFile, orca CLI, storage) <- `services` (wiring). Core imports nothing from adapters or services.
- Act only on Unifier-tracked launches. Hooks and enforcement ignore everything else.
- Never touch Projects configured in `excludedProjects`, including their Worktrees outside the Projects folder.
- UI words: Project, Repo, Worktree, Orchestrator, Worker, Decision. Never Run, Dispatch, Task, gate or pane.
- Child processes only via `execFile` with an argument array.
- No em dashes and no emoji anywhere.

## Settings

- `excludedProjects` is a comma-separated string, default `""`: Projects Unifier never touches (setup, cleanup, hubs, orchestrators, approvals). Case-insensitive. `parseSettings` exposes it as `UnifierSettings.excludedProjects: string[]`, trimming and lower-casing plain folder names and dropping empty or invalid entries. Pass the list to every `isExcludedProject(project, excluded)` call, including canonical-path checks and metadata writes. Nothing is excluded by default.
- `protectedPaths` is a comma-separated string, default `""`, for extra sensitive path names. `parseSettings` exposes the trimmed, lower-case plain names as `UnifierSettings.protectedPaths: string[]`. The approver passes them as `ApprovalContext.protectedNames`; the policy checks them literally and case-insensitively, including split words, redirects, globs and resolved links. Built-in `.env*`, `.envrc` and `.secrets` protections always apply. Configure these two settings before relying on site-specific exclusions or protections.

## Platform facts

Verified by the Task 2 spike on Orca 1.4.255 (fixtures in `test/fixtures/`).

### Worker runtime

- The worker runs under Node 24 (`Orca Helper`), cwd `/`, with the login-shell PATH (`/opt/homebrew/bin`, `~/.local/bin`, `/usr/local/bin`, ...). `execFile` works for `/Applications/Orca.app/Contents/Resources/bin/orca` (also on PATH as `/usr/local/bin/orca`), `git`, `glab`, `gh`, `codex`, `claude`.
- `orca worktree list --json` from the worker is about 2.6 KB per worktree (240 KB for 91): pass a generous `maxBuffer`. A lookup takes about 0.2 s.
- Return plain JSON from `panels.handle` handlers: any `undefined` field fails with `action_failed: non-JSON value`.
- The worker restarts after every hook call, so in-memory state is lost: keep tracked terminals and orchestrators in `orca.storage`.
- `bunx tsc` needs `@types/node` for `node:child_process` and `node:fs`.

### Ids

- `workspace.list` ids: a git worktree is `identity:wt2:local:<instanceId>`; a folder is `<repoId>::<path>`.
- Hook events, `ORCA_WORKSPACE_ID` and `orca worktree list` use `<repoId>::<path>` for both kinds. Map between the two by `path`.
- `agent.launch.before` reports `workspaceKind: "worktree"` even for a folder workspace.

### Folder workspaces (hubs)

- Create: `orca repo add --path <dir> --kind folder --json`. Its workspace id is `<result.repo.id>::<dir>`. `project setup-existing-folder` is not needed.
- Open: `host.call('workspace.open', { workspaceId: '<repoId>::<dir>' })`. The CLI cannot activate a folder workspace. Opening an empty folder workspace creates a `Terminal 1`.
- CLI selectors that work: `path:<dir>` and `id:<repoId>::<dir>`. `folder:<instanceId>` is refused.

### Board tab

- `editor.open` needs a path relative to the workspace root (`.unifier/board.unifier-board`). An absolute path fails with `invalid_params`.
- The file opens as a normal editor tab beside the terminals, with Orca's custom/source/diff toggle. The frame's `orca.plugin.request` reaches the worker on load.
- The tab survives an Orca app restart (quit and `orca open`). Orca restores it from `openFilesByWorktree` in its workspace session, and the editor reloads and calls the worker again. Development plugins stay loaded and approved across the restart. The plugin only reopens the board when the file is not already open.
- Dragging the tab into a split is unverified: `orca computer` needs the macOS Accessibility grant, and no API splits editor tabs.

### Launch commands (`agent.launch.before`)

- `command` is a shell string that Orca types into the user's login shell, with every argument single-quoted.
- `env` is always `{}`. Orca adds its own env (`ORCA_TERMINAL_HANDLE`, `ORCA_WORKSPACE_ID`, ...) after the hook, and there is never a Run id.
- Claude: `claude '--dangerously-skip-permissions' ['--model' '<id>'] ['<prompt>']`.
- Codex: `codex ['-c' 'check_for_update_on_startup=false'] '-c' 'disable_paste_burst=true' '--approve-for-me'`. The update flag is present only for orchestration launches.
- The permission flags come from the user's Orca settings: `agentPermissionDefault: full-access` adds Claude's bypass flag, and `agentPermissionOverrides.codex: auto` adds `--approve-for-me`.
- Orca never adds `--model` on its own. An explicit `--model` (`orca agent launch --model`, `worker-start --model`) appears as `'--model' '<id>'` right after the permission flag.
- `orca agent launch --prompt` appends the prompt as the last Claude argument, and no prompt hook fires for it.
- Orca injects more arguments after the hook (Claude `--plugin-dir ...`; Codex `--no-daemon -c shell_environment_policy.set.ORCA_*=...`). Rewrite only the hook's `command`.
- Rewriting with `next({ ...event, command })` works: stripping `'--approve-for-me'` reached the real process.
- Codex 0.163 accepts only `on-request` or `never` for `--ask-for-approval`.
- `agent.launch` from the worker drops its `prompt` (`agent_launch_terminal_not_running_agent`): send the prompt later, or launch with `orca agent launch --prompt`.
- Hooks fail open. One launch went through with no hook call at all: never assume every launch was seen.

### Prompts (`agent.prompt.before`)

- An orchestration dispatch arrives with `inputKind: "orchestration"` and `agent: null`, about 1 to 1.5 s after that worker's `agent.launch.before`.
- The dispatch prompt begins `You are working inside Orca ... You are a dispatched worker.`, then `Your coordinator's terminal handle is: <term>` and `Your task ID is: <task>`. The spec follows `=== TASK ===` at the end.
- `orca terminal send --enter` to an agent arrives as `inputKind: "driving"`.
- Orca's wake-ups to a coordinator (`You have 1 orchestration message. Run orca orchestration check --run <id>.`) are not hooked.

### Tracked-worker signal

- At `agent.launch.before` time nothing marks a worker as an orchestrator's: no Run id in `env`, no lineage in the event, and the new worktree does not exist yet in any cached list.
- Reliable after launch: the dispatch prompt names the coordinator's terminal handle. Match it against the orchestrator terminal Unifier launched.
- `worker-start --worktree new-child` records explicit lineage (`lineage.parentWorktreeId` = coordinator workspace, `capture.confidence: "explicit"`) before the launch hook. `new-top-level` records none. A `current` worker launches in the coordinator's own workspace.
- `orca orchestration worker-list --run <id> --json` maps Run to worker terminals and workspaces.
- Decision (the user, 2026-11-10): charter + verify. Never rewrite launches. Record the parsed fields of every launch, recognize a tracked worker from its dispatch prompt's coordinator terminal, record its actual agent/model and check bypass flags. Model differences are shown only on the board, never messaged. Claude keeps `--dangerously-skip-permissions`; Codex runs without `--approve-for-me` (the user's Orca per-agent setting), with the guarded approver.

### Codex approval prompts

- Read the screen with `terminal.read` (it returns the rendered screen, identical to `orca terminal read --screen`).
- Detect a prompt by `Press enter to confirm or esc to cancel`, with header `Would you like to run the following command?` (then `Environment:`, `Reason:`, `$ <command>`) or `Would you like to make the following edits?` (then `Description:`, `Destination: <abs path>`).
- The `$` line wraps across screen lines: join wrapped lines before parsing.
- Approve: send `y` with no Enter. Decline: send Escape (`\u001b`); Codex prints `Conversation interrupted` and does nothing.
- Never send `p` (allow this command prefix) or `a` (allow these files).
- The Codex update modal (`enter continue · esc skip`) is not an approval prompt.
- `terminal.sendText` only reaches terminals in the focused workspace (`terminal is outside the active worktree`). Send keys with `execFile(orca, ['terminal', 'send', '--terminal', id, '--text', 'y'])`.
- With the user's Codex config (workspace-write with network, on-request, `~/.codex/rules/default.rules` allowing `git push`, `git add`, `cat` and more), most commands never prompt. Prompts appear for sandbox escalations and edits outside the worktree.
- Fixtures are raw screens with earlier scrollback: parsers must use only the last prompt block on screen.
- `src/core/approval-policy.ts` owns parsing and the verdict. Pass the whole `parseApprovalPrompt` result to `judge`: its `wrapped` lines make `judge` check every reading of a wrap (space, split word, newline). A prompt that is waiting but unreadable parses to an empty command, which escalates; never treat it as "no prompt".
- The policy fails closed: only programs in its `ALLOWED` table pass, every segment must pass, and no path may use `..`, leave the worktree, or touch `.git`/`.codex`/`.claude` at any depth. Widen it only by adding a table entry and a test row.
- `judge` context: `cwd` is the command's working directory. Codex 0.163 does not show one in the prompt, so pass null unless the plugin knows it. With null, every relative path escalates, as do git and `ls`/`find`/`rg` without an absolute path; argument-free toolchain commands (`uv run pytest`, `cargo test`, `make check`) still pass. A known `cwd` must be inside the worktree.
- `packageScripts` (script names from the worktree's package.json) is required for `bun run X` / `bun X`, which only pass from the worktree root.
- `realpath` contract: synchronous; resolve the nearest existing ancestor and append the missing tail, so a file that does not exist yet still resolves; never throw for one (a throw escalates). It is applied to the worktree, `cwd`, edit destinations, redirect targets and path arguments. When it is given, any globbed argument escalates; without it links are not followed.
- Globs: any `*` escalates (it could match a protected name); `?` and `[...]` pass only if no filling of them can name a protected file or control directory. Flags that follow symlinks (`rg -L`, `find -L/-H/-follow`, `ls -L/-H`, `grep -R/-S/-O`) escalate.
- Edit prompts need the `• Added|Edited|Deleted <path> (+n -m)` bullet directly above the header; it must name the destination by full path (with `cwd` null, a relative summary must equal the destination's worktree-relative path).

### Hubs and messaging

- One terminal belongs to exactly one workspace: no API moves, mirrors or attaches it elsewhere. Keep the orchestrator in the global hub and give the project hub a jump control: `execFile(orca, ['terminal', 'switch', '--terminal', id])` navigates the window there.
- To message a coordinator from the plugin, own a terminal (`terminal.create` in the hub) and run `orca orchestration send --from <that terminal> --to run:<runId> --subject ... --body ...`, optionally with `--type status` or `--type handoff`. Without `--from` it fails with `no_active_sender_terminal`.
- `--type escalation` from a non-worker fails with `sender_not_assignee`. Orca then wakes the coordinator by typing a check request into its terminal.
- Workers in `new-top-level` and `new-child` worktrees are kept open. `worker-stop` on a settled worker does nothing (`alreadySettled`); close its terminal with `orca orchestration worker-release --dispatch <id>`. A `current` worker closes on its own.

## Editor frame

- `editor/` runs in a sandboxed frame: no node builtins, no npm, no network. Import only node-free modules (`src/core/agents.ts`, `board-types.ts`, `board-filter.ts`, `types.ts`); `editor/tsconfig.json` has no node types, so a node import fails `tsc -p editor`.
- Icons are inline SVG strings in `editor/icons.ts` (Lucide, ISC, see `editor/LICENSE-lucide.txt`, plus a few drawn shapes). Column and state colors are CSS variables in `board.css`, with `html.light` overrides.
- `orca plugin shot . --editor <file>` captures right after the frame asks for its document, before `board.get` answers, so it usually shows "Loading board". For a visual check, temporarily fetch and paint before `orca.document.session()`, shoot, then revert. `--theme` only applies while Orca's window is hidden.

## Worker wiring

- Treat consent errors during activation or reload as transient. `src/services/retirement.ts` provides `createConsentBackoff`: retry after 1, 2, 5, 15, then every 60 seconds; log once per step through the instance logger. Reset with `success` after each successful host, storage or settings call. Keep normal timers and events from bypassing a pending retry, and dispose the backoff with its service. Approver, setup, cleanup, messenger, board and Worker defaults refresh all use it.
- `src/worker.ts` exports `activateWith(orca, { cli?, exec?, schedule? })`; tests inject a fake `OrcaCli` and a manual debounce scheduler. `src/protocol.ts` declares the panel requests (`board.get`, `board.setStatus`, `board.openWorktree`) and the `board.changed` event.
- The board reads `OrcaCli.worktreeSummaries()` (`orca worktree ps --json`, the native board's source): each worktree with `agents: AgentEntry[]` (`paneKey`, `parentPaneKey`, `terminalId`, `title`, `detail`, `state`, `since`, `updatedAt`, `agent`, `model`). Keep `listWorktrees()` for other callers.
- `agent.status.changed` only triggers a refresh and feeds an in-memory overlay (2 min): an event newer than the summary's `updatedAt` for that pane wins. Nothing is stored; old `agents.v1`/`agents.v2` keys are deleted on activation. `BoardService.agentStates()` returns fresh summary agents with the overlay applied.
- A sub-agent is an agent whose `parentPaneKey` is a pane in the same worktree; a parent pane elsewhere (a dispatching coordinator) still counts as top-level. Cards show the most urgent top-level agent; the rest count toward "+N".
- `enrichAgents(entries, launches, trackedTerminals)` in `src/core/agents.ts` fills agent/model by terminal id. Recorded launches take precedence for tracked Workers. The board resolves missing terminal ids with `terminalInfo().paneKey`, matched exactly against summary panes; it never guesses from the agent name or Worktree.
- `workspace.open` for a git worktree takes `identity:<identity.key>` (`WorktreeRecord.identityKey`), not `<repoId>::<path>`.
- Handler errors returned to the board are plain English: no Orca jargon.

## Hubs

- `src/services/hub-service.ts` owns the `hub.open` request and the `unifier.openHub` / `unifier.openBoard` commands (both open the global hub; palette commands take no arguments). Project hubs open from the "Open hub" chip buttons (`data-open-hub`) on the global board.
- `hub.open` order: `ensureFolderWorkspace(hub)`, write `.unifier/board.unifier-board` only if absent, `workspace.open`, then `editor.open` with the relative path. A git hub gets `.unifier/` appended to `.git/info/exclude` once; a `.git` file (worktree) is skipped. Projects in `excludedProjects` are refused.
- `src/adapters/fs.ts` (`FsLike`, `nodeFs`) is the injectable filesystem; tests pass a fake through `activateWith(orca, { fs })`.

## Launch watch and messaging

- One handler per hook, both in `src/services/launch-watch.ts` (`onError: "pass"`). `agent.launch.before` only records the parsed launch and never alters it. `agent.prompt.before` acts only on `inputKind: "orchestration"` prompts whose coordinator is a tracked Orchestrator; untracked coordinators are ignored entirely. `rewritePrompt` appends the Worker brief plus report format (`withWorkerBrief`, once, by `WORKER_BRIEF_MARKER`) and feeds `next({ ...event, prompt })`.
- Hooks await only storage and settings, never a child process. A message is queued in storage inside the hook (`messenger.enqueue`) and sent after it returns (`flush`).
- `src/core/launch-policy.ts`: `parseLaunch` reads Orca's quoted launch command into `{ model, bypass }`. Arguments after a bare `--` are positional and ignored. Codex value options (`-c`, `-m`, `-s`, `-a`, `-p`, `-i`, `-C` and long forms) never leak their value as a flag; `-c model=` counts as a model, `-c sandbox_mode=danger-full-access`, `-c approval_policy=never`, `-s`/`--sandbox danger-full-access`, `-a`/`--ask-for-approval never`, `--yolo` and `--approve-for-me` count as bypass. `checkWorkerLaunch` reports bypass problems only; any agent/model combination is allowed. Claude may keep `--dangerously-skip-permissions`.
- Codex bypass flags come from Orca's per-agent permission setting, so a relaunch cannot clear them: the message tells the Orchestrator not to relaunch for a bypass alone and to raise it once as a Decision. Dedupe in `launch-watch.v1`: bypass problems at most once per Orchestrator per 24 h. Model differences never enqueue notices; old model marks are dropped when claiming a bypass notice.
- `src/services/tracker.ts` keeps Orchestrators, parsed launches (`{ terminalId, workspaceId, agent, model, bypass, at }`, newest 200) and Workers (including the actual launch model) under `tracker.v1`, with no in-memory cache. Never store launch commands or prompt text; `migrate()` (on activation) drops older command records. `ownerOfWorkspace` is null for an Orchestrator workspace (the shared global hub). Create one tracker per worker and share it.
- `src/services/messenger.ts` is the only way to message an Orchestrator. It refuses untracked terminals, stores `attempts + 1` and `inFlightAt` before each send (a killed worker still uses a try), skips sends under 15 s old, drops after 3 tries, resolves the Run id through the tracker then `cli.findRunId`, and sends from its own `unifier` terminal in the global hub (`terminal.create`, liveness checked with `terminal.read`). With no Run yet it types one line into the Orchestrator's terminal.
- Before flushing persisted notices, `src/core/launch-notice.ts` removes obsolete model advice: model-only notices are dropped, and combined notices retain only their bypass advice.
- For tracked Workers, the board shows the actual recorded model and a muted `outside defaults` label only when the known (agent, model) pair matches none of that project's four effective defaults. Untracked agents and unknown models get no label.
- `isExcludedProject(project, excluded)` ignores case and uses only the configured list. Derive a worktree's Project with `projectOfWorktree` (own path, else its repo's main checkout): Orca worktrees live under `~/orca/workspaces`, outside the projects root.

## Orchestrators and templates

- `templates/` holds the charter, Worker brief, reviewer brief and report format. `src/adapters/templates.ts` reads them once per worker process (via `import.meta.url`); `renderCharter` throws on an unknown `{{placeholder}}`. Templates must pass Biome's Markdown formatter (it reindents list continuations) and carry no em dash, emoji or source-project names (`src/core/templates.test.ts`).
- The Orchestrator's first prompt is the rendered charter, then the report format and the reviewer brief (`orchestratorPrompt`). Before every Worker, the charter requires reading the project's `.unifier/worker-defaults.json`, choosing the work kind, and passing both `--agent` and `--model`. A deviation needs a one-line reason in the report. A foreman uses the `review` default.
- `orchestrator.start` launches with `orca agent launch --surface terminal --model <m> --prompt <charter>` in the global hub (`workspacePath = projectsRoot`), then records the Orchestrator. The real `--json` result keeps the handle at `result.outcome.handle` (`outcome.kind: "terminal"`, `outcome.paneKey`); fixture `test/fixtures/agent-launch-terminal.json`.
- Liveness: `OrcaCli.terminalInfo` (`orca terminal show`). A just-closed terminal still answers `ok: true` with `orphaned: true` and an `exitCause`; later its handle is `terminal_handle_stale`. Both read as gone. Any other failure counts as live, so a second Orchestrator is never started by mistake. `orca terminal close` can report `tab_not_found` while still closing the terminal.
- `orchestrator.options` takes `{ project }` (or null): a project's last successful start (`orchestrator-choice.v1`, keyed by lower-case project) is its default, else the settings. Once `launchAgent` is called, any failure returns an error that says to check the global hub first: a launch may have happened.
- `parseDispatchPrompt` reads coordinator, task and Dispatch ids from the header only. Model differences never cause a stop or relaunch message.
- Board state of an Orchestrator: match `terminalInfo().paneKey` (`<tabId>:<leafId>`) against `orca worktree ps` agent `paneKey`s. Only project boards show the strip (live: name, state, model, Jump; otherwise the agent/model form).
- The model catalog is a SQLite file in newer Orca (`~/Library/Application Support/orca/agent-model-catalog.db`, table `rows(key, seq, value)` with one JSON entry per discovery). `readCatalogText` prefers the old JSON file, else runs `/usr/bin/sqlite3 -readonly -json`; `readModelCatalog` keeps the newest entry per agent and resolves aliases to full ids. Both header editors share `src/services/model-options.ts`. With no readable, non-empty catalog, options fall back to effective Worker defaults and the Orchestrator choice. With a catalog, Worker saves require a listed agent/model pair.
- Plugin settings can only be changed from code (`orca.settings.set`); there is no CLI. For a live check against `~/projects/unifier-sandbox`, add a throwaway request handler, then restore `projectsRoot` and remove it.

## Worker defaults

- Global settings are `workerImplementation` and `workerReview` (both `codex:gpt-6.1-sol`), plus `workerDesign` and `workerProse` (both `claude:claude-opus-4-8`). Each is a string `agent:model`, split at the first colon and validated with the same safe-name patterns as Orchestrator start. Invalid strings fall back per setting. The former per-harness Worker model settings are ignored.
- `src/services/worker-defaults-service.ts` owns `workerDefaults.get` and `workerDefaults.set`. Storage `worker-defaults.v1` maps lower-case Project names to partial overrides for `implementation`, `review`, `design`, `prose`, each `{ agent, model }`. Any safe harness/model pair is accepted without a catalog; excluded Projects are refused.
- A successful save and each Orchestrator start write pretty JSON for all four effective defaults to `<projectsRoot>/<project>/.unifier/worker-defaults.json` through `FsLike`. The shared hub git exclude helper appends `.unifier/` once for a repo; it skips a `.git` worktree file. Excluded Projects are never written.
- Project boards show a compact Worker defaults editor, including when an Orchestrator is live. Each kind has an agent select, its filtered model select and Save. The global board has no defaults editor. The approver remains Codex only.
- Failed storage saves restore the defaults file to the previous effective choices. Saving one editor row preserves drafts in the other rows.
