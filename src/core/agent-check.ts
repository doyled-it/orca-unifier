export const REQUIRED_SKILLS = [
  'development-loop:development-loop',
  'codegraph:using-codegraph',
  'cross-repo-completeness:cross-repo-completeness',
  'nonfiction-superpowers:writing-nonfiction',
  'superpowers:brainstorming',
  'superpowers:writing-plans',
  'superpowers:test-driven-development',
  'superpowers:requesting-code-review',
  'superpowers:verification-before-completion',
] as const

const COMMANDS = [
  ['uv', 'run'],
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'add'],
  ['git', 'commit'],
]

type Literal = string | Literal[]

/** Reads only literal lists and strings, without executing the rules file. */
function literal(
  tokens: string[],
  start: number,
): { value: Literal; end: number } | null {
  const token = tokens[start] ?? ''
  if (/^(['"])[^\\]*\1$/.test(token)) {
    return { value: token.slice(1, -1), end: start + 1 }
  }
  if (token !== '[') return null
  const values: Literal[] = []
  let i = start + 1
  while (tokens[i] !== ']') {
    const item = literal(tokens, i)
    if (!item) return null
    values.push(item.value)
    i = item.end
    if (tokens[i] === ',') i++
    else if (tokens[i] !== ']') return null
  }
  return { value: values, end: i + 1 }
}

function allowedPrefixes(text: string): Literal[][] {
  const tokens = (
    text.match(
      /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith('#'))
  const patterns: Literal[][] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'prefix_rule' || tokens[i + 1] !== '(') continue
    let pattern: Literal | undefined
    let decision: Literal | undefined
    let j = i + 2
    // Recognize named literal arguments only. Unknown expressions never count.
    while (tokens[j] !== ')') {
      const name = tokens[j]
      if (tokens[j + 1] !== '=') break
      const item = literal(tokens, j + 2)
      if (!item) break
      if (name === 'pattern') pattern = item.value
      if (name === 'decision') decision = item.value
      j = item.end
      if (tokens[j] === ',') j++
      else if (tokens[j] !== ')') break
    }
    if (
      tokens[j] === ')' &&
      decision === 'allow' &&
      Array.isArray(pattern) &&
      pattern.length > 0
    ) {
      patterns.push(pattern)
    }
  }
  return patterns
}

/** Reports setup gaps only; the caller supplies every filesystem fact. */
export function checkAgentSetup(input: {
  claudeSkills: string[]
  codexSkills: string[]
  codexRules: string | null
  codexInstallHint?: string
}): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  for (const name of REQUIRED_SKILLS) {
    const short = name.split(':')[1] as string
    const source = name.startsWith('superpowers:')
      ? 'github.com/obra/superpowers'
      : 'github.com/doyled-it/claude-skills'
    const hint = `Install from ${source}.`
    if (!input.claudeSkills.includes(name)) {
      lines.push(`Claude: missing ${name}. ${hint}`)
    }
    if (!input.codexSkills.includes(short)) {
      lines.push(`Codex: missing ${short}. ${input.codexInstallHint ?? hint}`)
    }
  }
  const file = '~/.codex/rules/default.rules'
  if (input.codexRules === null) {
    lines.push(
      `Codex: missing ${file}. Add allow rules for uv run, git status, git diff, git add and git commit.`,
    )
  } else {
    const patterns = allowedPrefixes(input.codexRules)
    for (const command of COMMANDS) {
      const covered = patterns.some(
        (pattern) =>
          pattern.length <= command.length &&
          pattern.every((part, i) =>
            typeof part === 'string'
              ? part === command[i]
              : part.includes(command[i] as string),
          ),
      )
      if (!covered) {
        lines.push(
          `Codex: missing an allow rule for ${command.join(' ')}. Add it to ${file}.`,
        )
      }
    }
  }
  return { ok: lines.length === 0, lines }
}
