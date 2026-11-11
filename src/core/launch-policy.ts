/**
 * Worker launch policy: reads the flags Orca put on a launch command and
 * checks approval and sandbox bypasses. Pure: never alters a launch.
 */

/**
 * Splits a POSIX shell command into words. Orca single-quotes every argument
 * (`'it'\''s'`); double quotes and backslashes are handled too. An
 * unterminated quote runs to the end of the string.
 */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  while (i < command.length) {
    const c = command[i] as string
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop + 1
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) i++
        word += command[i]
        i++
      }
      inWord = true
      i++
    } else if (c === '\\') {
      if (i + 1 < command.length) word += command[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  if (inWord) words.push(word)
  return words
}

/** The arguments after the program name, up to a bare `--` (the rest is positional). */
function options(command: string): string[] {
  const args = shellWords(command).slice(1)
  const end = args.indexOf('--')
  return end === -1 ? args : args.slice(0, end)
}

/** Flags that bypass approvals or the sandbox on their own, for any agent. */
const PLAIN_BYPASS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--approve-for-me',
  '--yolo',
])

/** Codex options that take a value, by spelling, with their canonical name. */
const CODEX_SHORT: Record<string, string> = {
  '-m': 'model',
  '-c': 'config',
  '-s': 'sandbox',
  '-a': 'approval',
  '-p': 'other',
  '-i': 'other',
  '-C': 'other',
}
const CODEX_LONG: Record<string, string> = {
  '--model': 'model',
  '--config': 'config',
  '--sandbox': 'sandbox',
  '--ask-for-approval': 'approval',
  '--profile': 'other',
  '--cd': 'other',
  '--image': 'other',
}

/** A TOML-ish config value without surrounding quotes or spaces. */
function configValue(v: string): string {
  return v.trim().replace(/^(["'])(.*)\1$/, '$2')
}

/** What a launch command asks for: its model and any bypass flags, in order. */
export function parseLaunch(
  agent: string,
  command: string,
): { model: string | null; bypass: string[] } {
  const args = options(command)
  const codex = agent === 'codex'
  let model: string | null = null
  let configModel: string | null = null
  const bypass: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    // An option that takes a value: its name, how it was written and the value.
    let name: string | undefined
    let spelled = a
    let value: string | undefined
    let joined = false
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      spelled = eq === -1 ? a : a.slice(0, eq)
      name = codex
        ? CODEX_LONG[spelled]
        : spelled === '--model'
          ? 'model'
          : undefined
      if (name && eq !== -1) {
        value = a.slice(eq + 1)
        joined = true
      }
    } else if (codex && a.length >= 2 && a[0] === '-') {
      spelled = a.slice(0, 2)
      name = CODEX_SHORT[spelled]
      if (name && a.length > 2) value = a.slice(2)
    }
    if (!name) {
      if (PLAIN_BYPASS.has(a)) bypass.push(a)
      continue
    }
    if (value === undefined) {
      value = args[i + 1]
      i++
    }
    if (value === undefined) break
    const written = `${spelled}${joined ? '=' : ' '}${value}`
    if (name === 'model') {
      model = value
    } else if (name === 'sandbox') {
      if (value === 'danger-full-access') bypass.push(written)
    } else if (name === 'approval') {
      if (value === 'never') bypass.push(written)
    } else if (name === 'config') {
      const eq = value.indexOf('=')
      if (eq === -1) continue
      const key = value.slice(0, eq).trim()
      const v = configValue(value.slice(eq + 1))
      if (key === 'model') configModel = v
      else if (key === 'sandbox_mode' && v === 'danger-full-access')
        bypass.push(`-c sandbox_mode=${v}`)
      else if (key === 'approval_policy' && v === 'never')
        bypass.push(`-c approval_policy=${v}`)
    }
  }
  const chosen = model ?? configModel
  return { model: chosen ? chosen : null, bypass }
}

/**
 * The model a launch command asks for (`--model x`, `--model=x`, and for
 * Codex `-m x`, `-mx` or `-c model=x`), the last explicit one when repeated,
 * or null.
 */
export function modelFlag(agent: string, command: string): string | null {
  return parseLaunch(agent, command).model
}

/** The approval or sandbox bypass flags on a launch command, in order. */
export function bypassFlags(agent: string, command: string): string[] {
  return parseLaunch(agent, command).bypass
}

const TASK_MARKER = '=== TASK ==='
const COORDINATOR_LINE = /^Your coordinator's terminal handle is: (\S+)\s*$/m
const TASK_LINE = /^Your task ID is: (\S+)\s*$/m
/** The preamble's own commands carry the Dispatch id. */
const DISPATCH_FLAG = /--dispatch-id (\S+)/

/**
 * Reads an orchestration dispatch prompt's coordinator terminal, task id and
 * Dispatch id.
 * Only the header before the task spec counts, so a spec quoting the line is
 * not mistaken for a dispatch. Null for any other prompt.
 */
export function parseDispatchPrompt(prompt: string): {
  coordinatorTerminal: string
  taskId: string | null
  dispatchId: string | null
} | null {
  const cut = prompt.indexOf(TASK_MARKER)
  const header = cut === -1 ? prompt : prompt.slice(0, cut)
  const coordinator = COORDINATOR_LINE.exec(header)?.[1]
  if (!coordinator) return null
  return {
    coordinatorTerminal: coordinator,
    taskId: TASK_LINE.exec(header)?.[1] ?? null,
    dispatchId: DISPATCH_FLAG.exec(header)?.[1] ?? null,
  }
}

/** Claude keeps its permission bypass (the user's choice); every other bypass is a problem. */
const ALLOWED_BYPASS: Record<string, readonly string[]> = {
  claude: ['--dangerously-skip-permissions'],
}

export type LaunchProblemKind = 'bypass'

export interface LaunchProblem {
  kind: LaunchProblemKind
  text: string
}

/** Checks bypass flags only. Any harness and model combination is allowed. */
export function checkWorkerLaunch(input: {
  agent: string
  model: string | null
  bypass: readonly string[]
}): { ok: true } | { ok: false; problems: LaunchProblem[] } {
  const problems: LaunchProblem[] = []
  const allowed = Object.hasOwn(ALLOWED_BYPASS, input.agent)
    ? (ALLOWED_BYPASS[input.agent] ?? [])
    : []
  for (const flag of input.bypass) {
    if (!allowed.includes(flag)) {
      problems.push({
        kind: 'bypass',
        text: `It was started with ${flag}, which skips approvals or the sandbox.`,
      })
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
