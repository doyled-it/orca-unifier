# Requests for Orca

Please support a board pinned in the main area while the user switches Worktrees. Unifier needs a persistent project overview beside the active work.

Please let a floating workspace dock into the main tab area, with its editors and terminals beside the board.

Please offer left sidebar nesting as Project > Repo > Worktree, with groups collapsed by default. This would keep a large collection of Worktrees manageable.

Please offer a filter that hides completed or merged Worktrees without deleting them.

Please add a plugin API to create splits and place editor and terminal tabs within them.

Please allow `terminal.sendText` and `terminal.create` to reach non-focused workspaces through explicit terminal or workspace ids. Unifier needs to message Workers and create helper terminals while the user keeps working in the focused workspace.

The Settings UI check on 2026-11-10 was blocked by macOS accessibility reads. Recheck Settings before treating these as missing options. Orca already provides per-Repo external Worktree visibility through `orca repo set --external-worktree-visibility hide`; Unifier exposes it as “Unifier: Hide outside worktrees”.
