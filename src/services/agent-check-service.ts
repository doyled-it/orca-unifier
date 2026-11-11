import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { FsLike } from '../adapters/fs'
import { checkAgentSetup, REQUIRED_SKILLS } from '../core/agent-check'
import type { Tracker } from './tracker'

export function createAgentCheckService(
  orca: OrcaWorkerApi,
  deps: {
    fs: Pick<FsLike, 'exists' | 'read' | 'list'>
    home: string
    tracker: Pick<Tracker, 'launches'>
  },
): { dispose(): void } {
  const { fs, home, tracker } = deps

  async function list(path: string): Promise<string[]> {
    try {
      return await fs.list(path)
    } catch {
      return []
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      return await fs.exists(path)
    } catch {
      return false
    }
  }

  async function read(path: string): Promise<string | null> {
    try {
      return await fs.read(path)
    } catch {
      return null
    }
  }

  async function skills() {
    const claude = new Set<string>()
    const codex: string[] = []
    for (const name of REQUIRED_SKILLS) {
      const short = name.split(':')[1] as string
      if (await exists(join(home, '.claude/skills', short, 'SKILL.md')))
        claude.add(name)
      if (await exists(join(home, '.codex/skills', short, 'SKILL.md')))
        codex.push(short)
    }
    const cache = join(home, '.claude/plugins/cache')
    for (const marketplace of await list(cache)) {
      const market = join(cache, marketplace)
      for (const plugin of await list(market)) {
        const required = REQUIRED_SKILLS.filter(
          (name) => name.split(':')[0] === plugin,
        )
        if (required.length === 0) continue
        for (const version of await list(join(market, plugin))) {
          for (const name of required) {
            const short = name.split(':')[1] as string
            if (
              await exists(
                join(market, plugin, version, 'skills', short, 'SKILL.md'),
              )
            )
              claude.add(name)
          }
        }
      }
    }
    return { claudeSkills: [...claude], codexSkills: codex }
  }

  async function codexInstallHint(): Promise<string | undefined> {
    const readme = await read(
      join(home, 'projects/agentic-dev-setup/README.md'),
    )
    // Quote an available Codex-specific installer command, never execute it.
    const command = readme?.match(
      /^\s*(\.\/[\w./-]+(?:[ \t]+--[\w-]+)*[ \t]+--codex-only(?:[ \t]+--[\w-]+)*)[ \t]*$/m,
    )?.[1]
    if (!command) return undefined
    return `See ~/projects/agentic-dev-setup/README.md (github.com/doyled-it/agentic-dev-setup): from ~/projects/agentic-dev-setup, use ${command}.`
  }

  async function check(): Promise<string> {
    const found = await skills()
    const result = checkAgentSetup({
      ...found,
      codexRules: await read(join(home, '.codex/rules/default.rules')),
      codexInstallHint: await codexInstallHint(),
    })
    const lines = ['Agent setup check', ...result.lines]
    if (result.ok) lines.push('No missing skills or Codex rules found.')
    const latest = (await tracker.launches())
      .filter((launch) => launch.agent === 'codex')
      .reduce<Awaited<ReturnType<Tracker['launches']>>[number] | null>(
        (newest, launch) =>
          !newest || launch.at >= newest.at ? launch : newest,
        null,
      )
    if (!latest) {
      lines.push(
        'No recorded Codex launch is available to check the Orca permission override.',
      )
    } else if (latest.bypass.includes('--approve-for-me')) {
      lines.push(
        'The newest recorded Codex launch includes --approve-for-me. Ask the user to change the Codex permission override in Orca Settings to remove it.',
      )
    } else {
      lines.push(
        'The newest recorded Codex launch does not include --approve-for-me.',
      )
    }
    return lines.join('\n')
  }

  return orca.commands.register('unifier.checkAgents', check)
}
