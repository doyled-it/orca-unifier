# Unifier

## What it does

- Opens a board tab with Projects, Repos, Worktrees and live agent status.
- Provides a global hub in the Projects folder and a hub for each Project.
- Starts one Orchestrator per Project with any available agent and model. The Orchestrator plans work, starts Workers and brings you Decisions.
- Saves Worker defaults for implementation, review, design and planning, and prose, with overrides for each Project.
- Gives tracked Codex Workers guarded auto-approval for commands and edits that pass its policy.
- Sets up new Worktrees for Python, TypeScript, Rust and Go, and reports setup gaps.
- Previews merged Worktree cleanup, then removes eligible Worktrees automatically after you arm it once.
- Checks agent skills, Codex rules and the latest recorded Codex launch with **Unifier: Check agent setup**.

## Install and approve

Use Orca 1.4.248 or newer. Orca hashes every file in a plugin folder and refuses symlinks, so do not load the working repo itself (its `.git`, tool caches and `node_modules` change or contain symlinks). Export the committed files to a clean folder and load that:

```sh
bun run orca:sync
orca plugin dev load ~/.local/share/orca-dev/unifier
```

Repeat the load with the fingerprint it prints:

```sh
orca plugin dev load ~/.local/share/orca-dev/unifier --approve <fingerprint>
```

After changing the plugin, commit, run `bun run orca:sync` again, then `orca plugin dev reload`. Set `UNIFIER_DEV_DIR` to export somewhere else.

Unifier runs as a trusted worker. It uses local files and the Orca and Git CLIs for hubs, setup and cleanup. It asks for nine capabilities:

- `workspace:read`: find Projects, Repos and Worktrees for the board.
- `workspace:write`: open hubs and Worktrees and update workspace status.
- `agent:read`: read agent status for the board and safety checks.
- `agent:launch`: start Orchestrators with the selected agent and model.
- `terminal:send`: send approval keys and messages to tracked agents, and start setup commands.
- `terminal:read`: read approval prompts and setup results, and check whether terminals are still open.
- `notifications:show`: report plugin results and problems in Orca.
- `storage:own`: keep tracking records, Project choices, cleanup arming and pending messages across worker restarts.
- `settings:own`: read and update Unifier's settings.

## First run

Before opening a hub, set `excludedProjects` to a comma-separated list of Project folder names Unifier must never touch. It defaults to empty. Set `protectedPaths` for any extra sensitive path names the approver must protect.

1. Open Orca's command palette and choose **Unifier: Open hub**, or press `Cmd+Shift+B` on macOS (`Ctrl+Shift+B` elsewhere). This opens the global board in the Projects folder.
2. Arrange the board on the left and chats on the right once. Orca remembers the layout.
3. Choose **Open hub** for a Project on the global board to open its Project hub.
4. Set the Project's Worker defaults for implementation, review, design and planning, and prose. Choose an agent and model for each kind, then **Save** each row. Unifier writes the effective choices to the Project's `.unifier/worker-defaults.json` for the Orchestrator to read.
5. Choose an agent and model, then **Start orchestrator**. Its terminal opens in the global hub. Tell it what to work on; use **Jump** on the Project board to return to its terminal.
6. Choose **Unifier: Show merged worktrees** in the command palette. Review what would be removed and why the others would be kept. This command deletes nothing.
7. Choose **Unifier: Remove merged worktrees now** once. It removes eligible Worktrees now and arms future automatic cleanup across Projects, even if none are eligible yet. Until this step, automatic cleanup only previews removals.
8. Choose **Unifier: Hide outside worktrees** to use Orca's external Worktree visibility setting for Repos in your Projects.
9. Choose **Unifier: Check agent setup**. Follow its suggestions for missing skills or Codex rules, and check its report on Orca's Codex permission override.

## Settings

Project Worker defaults override the four global Worker choices below. Each Worker choice is an `agent:model` string.

| Key                      | Default                  | Meaning                                                                                                                                  |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `excludedProjects`       | `""`                     | Comma-separated plain Project folder names Unifier never touches, no wildcards. Case-insensitive; empty by default.                      |
| `protectedPaths`         | `""`                     | Comma-separated plain sensitive path names, no wildcards, in addition to built-in `.env*`, `.envrc` and `.secrets` approver protections. |
| `projectsRoot`           | `~/projects`             | Folder whose immediate subfolders are Projects; also the global hub.                                                                     |
| `orchestratorAgent`      | `claude`                 | Default agent for a Project's first Orchestrator.                                                                                        |
| `orchestratorModel`      | `claude-opus-5-5`        | Default model for a Project's first Orchestrator. Later starts use its last successful choice.                                           |
| `workerImplementation`   | `codex:gpt-6.1-sol`      | Worker default for implementation.                                                                                                       |
| `workerReview`           | `codex:gpt-6.1-sol`      | Worker default for reviews and foremen.                                                                                                  |
| `workerDesign`           | `claude:claude-opus-4-8` | Worker default for design and planning.                                                                                                  |
| `workerProse`            | `claude:claude-opus-4-8` | Worker default for prose.                                                                                                                |
| `hideMainCheckouts`      | `true`                   | Hide each Repo's main checkout from the board.                                                                                           |
| `cleanupEnabled`         | `true`                   | Enable automatic cleanup. Removals require the one-time arming step above.                                                               |
| `cleanupIntervalMinutes` | `10`                     | Minutes between automatic cleanup checks; minimum 5.                                                                                     |
| `approverEnabled`        | `true`                   | Enable guarded auto-approval for tracked Codex Workers.                                                                                  |
| `setupEnabled`           | `true`                   | Run standard setup when a new Worktree is created.                                                                                       |

## Safety rules

- Projects listed in `excludedProjects` are never touched, including their Worktrees outside the Projects folder. Names are trimmed and matched without regard to case; empty entries and paths are ignored.
- Launch checks, Worker instructions and auto-approval act only on Workers linked to an Orchestrator Unifier started. Unifier never rewrites launch commands.
- The approver accepts only allowlisted commands whose arguments and paths pass its checks, and edits with a matching summary and destination inside the Worktree. It approves each request separately and never grants permanent command or file permissions.
- Unknown or unreadable commands, destructive commands, direct network tools, paths outside the Worktree, protected files such as `.env`, and paths inside `.git`, `.codex` or `.claude` escalate to the Orchestrator. The prompt stays pending.
- Cleanup removes only clean, pushed, merged Worktrees with an upstream branch and no live agent. It keeps main checkouts, pinned Worktrees and hubs, and keeps anything whose safety cannot be confirmed. Unchanged install files recorded by Unifier's setup do not count as user changes.
- The Orchestrator charter reserves merges for you. Workers push feature branches and open Draft merge or pull requests; Decisions outside the Project's rules come to you.

## Known limits

- Plugins cannot pin Orca's own board or change the left sidebar layout. Arrange Unifier's board and chats manually. See [Requests for Orca](docs/upstream-requests.md) for the remaining platform requests.
- The guarded approver supports Codex only.
- Codex approval prompts show no working directory. Commands with relative paths escalate, as do Git commands and searches that need a known working directory.
- Orca's Codex permission override should not add `--approve-for-me`. Change the override in Orca Settings if **Unifier: Check agent setup** reports it. Unifier records bypass flags and reports them; it does not strip them from launches.

## Development

TypeScript runs directly in Orca; there is no build step.

```sh
orca plugin test . --json
orca plugin types . --json
bun run typecheck
bunx biome check .
orca plugin validate . --json
```

Generate `.orca/types/` with `orca plugin types` before the first typecheck. `bun run typecheck` checks both the worker and editor code.
