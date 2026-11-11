/**
 * Approval policy for Codex approval prompts. Reads the prompt from a rendered
 * terminal screen and decides whether the plugin may answer it with `y` or
 * must hand it to the Orchestrator. Pure: no I/O.
 *
 * A wrong approve is the worst failure, so every rule fails closed: anything
 * the parser cannot read exactly, any program not on the allow list, and any
 * path that may leave the worktree escalates.
 *
 * Paths: relative paths resolve against `ctx.cwd`; when it is unknown (null),
 * any relative path escalates. Links are followed only through the caller's
 * `ctx.realpath` (see its contract on `ApprovalContext`); without it a link
 * inside the worktree that points outside looks inside.
 */
import { posix } from 'node:path'

export type ApprovalPrompt = {
  command: string
  kind: 'exec' | 'edit'
  path?: string
  /**
   * The screen lines of a `$` command (exec) or `Destination:` path (edit)
   * that wrapped. A wrap may stand for a space, nothing (a split word) or a
   * real newline, so `judge` approves only if every reading is allowed.
   */
  wrapped?: string[]
  /** Set when the screen shows something that must go to a person. */
  problem?: string
  /**
   * Edit only: the path in the patch summary bullet above the prompt
   * (`• Added <path>`). `judge` requires it to name the destination.
   */
  summary?: string
}

export type ApprovalVerdict =
  | { verdict: 'approve' }
  | { verdict: 'escalate'; reason: string }

export type ApprovalContext = {
  worktreePath: string
  /**
   * The command's working directory. Codex 0.163 does not show it in the
   * prompt, so pass null unless it is known; null escalates relative paths.
   */
  cwd: string | null
  /** Script names in the worktree's package.json; bun scripts need them. */
  packageScripts?: string[]
  /** Extra literal path names treated like built-in secret files. */
  protectedNames?: string[]
  /**
   * Resolves links, synchronously, for the worktree, `cwd`, edit
   * destinations, redirect targets and path arguments. It must resolve the
   * nearest existing ancestor and append the missing tail, so a file that
   * does not exist yet still resolves; it must not throw for one (a throw
   * escalates). When it is given, globbed arguments escalate, since a
   * pattern cannot be resolved.
   */
  containsGit?: (path: string) => boolean
  realpath?: (p: string) => string
}

// ---------------------------------------------------------------------------
// Screen parsing
// ---------------------------------------------------------------------------

const PRESS = 'Press enter to confirm or esc to cancel'
const EXEC_HEADER = 'Would you like to run the following command?'
const EDIT_HEADER = 'Would you like to make the following edits?'
const FIRST_OPTION = /^\S?\s*1\.\s+Yes\b/
const unreadable = (): ApprovalPrompt => ({ command: '', kind: 'exec' })

/**
 * Reads the last Codex approval prompt on a rendered screen. Returns null when
 * no prompt is waiting (the confirm line must be the last text on screen).
 * A prompt that is waiting but cannot be read exactly comes back with an
 * empty command, which `judge` escalates.
 */
export function parseApprovalPrompt(screen: string): ApprovalPrompt | null {
  const lines = screen.split('\n').map((l) => l.replace(/\r$/, '').trimEnd())
  let last = lines.length - 1
  while (last >= 0 && lines[last] === '') last--
  if (last < 0 || (lines[last] as string).trim() !== PRESS) return null

  let prev = last - 1
  while (prev >= 0 && (lines[prev] as string).trim() !== PRESS) prev--
  const region = lines.slice(prev + 1, last)

  const headers = indexesOf(region, (l) => {
    const t = l.trim()
    return t === EXEC_HEADER || t === EDIT_HEADER
  })
  const options = indexesOf(region, (l) => FIRST_OPTION.test(l))
  if (headers.length !== 1 || options.length !== 1) return unreadable()
  const header = headers[0] as number
  const option = options[0] as number
  if (option < header) return unreadable()
  const body = region.slice(header + 1, option)

  if ((region[header] as string).trim() === EXEC_HEADER) {
    const starts = indexesOf(body, (l) => /^\s*\$( |$)/.test(l))
    if (starts.length !== 1) return unreadable()
    const pieces = unwrap(body.slice(starts[0]), '$')
    const prompt: ApprovalPrompt = { command: pieces.join(' '), kind: 'exec' }
    if (pieces.length > 1) prompt.wrapped = pieces
    return prompt
  }

  const dests = indexesOf(body, (l) => /^\s*Destination:/.test(l))
  if (dests.length !== 1) {
    return {
      command: '',
      kind: 'edit',
      problem: 'The edit prompt does not show exactly one destination.',
    }
  }
  const pieces = unwrap(body.slice(dests[0]), 'Destination:')
  const description = body
    .find((l) => /^\s*Description:/.test(l))
    ?.replace(/^\s*Description:\s*/, '')
  const prompt: ApprovalPrompt = {
    command: description || 'edit',
    kind: 'edit',
    path: pieces.join(''),
  }
  if (pieces.length > 1) prompt.wrapped = pieces
  const summary = editSummary(region, header)
  if ('problem' in summary) prompt.problem = summary.problem
  else prompt.summary = summary.path
  return prompt
}

/**
 * The file named by the patch summary bullet just above the edit header
 * (`• Added <path> (+1 -0)`). Anything else there is a problem: no bullet,
 * an unknown verb, several files, or a home-relative path.
 */
function editSummary(
  region: string[],
  header: number,
): { path: string } | { problem: string } {
  for (let k = header - 1; k >= 0; k--) {
    const line = region[k] as string
    if (line === '' || /^\s/.test(line)) continue
    const m = /^\S\s+(?:Added|Edited|Deleted)\s+(.+?)\s+\(\+\d+ -\d+\)$/.exec(
      line,
    )
    if (!m) {
      return {
        problem: 'The edit prompt is not preceded by a summary of the change.',
      }
    }
    const path = m[1] as string
    if (/^\d+ files?$/.test(path)) {
      return { problem: 'The edit changes more than one file.' }
    }
    if (path.startsWith('~')) {
      return {
        problem: `The edit summary names ${path}, in the home directory.`,
      }
    }
    return { path }
  }
  return {
    problem: 'The edit prompt is not preceded by a summary of the change.',
  }
}

function indexesOf(lines: string[], match: (l: string) => boolean): number[] {
  const out: number[] = []
  lines.forEach((l, i) => {
    if (match(l)) out.push(i)
  })
  return out
}

/** Strips the label from the first line and the block indent from the rest. */
function unwrap(block: string[], label: string): string[] {
  const first = block[0] as string
  const at = first.indexOf(label)
  const indent = ' '.repeat(at)
  const pieces = [first.slice(at + label.length).replace(/^ /, '')]
  if (label !== '$') pieces[0] = (pieces[0] as string).trimStart()
  for (const line of block.slice(1)) {
    pieces.push(line.startsWith(indent) ? line.slice(at) : line.trimStart())
  }
  return pieces
}

// ---------------------------------------------------------------------------
// Shell reading
// ---------------------------------------------------------------------------

type Word = {
  kind: 'word'
  text: string
  start: number
  end: number
  quoted: boolean
  expansion: boolean
  glob: boolean
  brace: boolean
  tilde: boolean
}
type Redirect = {
  kind: 'redirect'
  start: number
  end: number
  output: boolean
  dup: boolean
}
type Operator = { kind: 'op'; start: number; end: number }
type Token = Word | Redirect | Operator

const SUBSTITUTION =
  'The command runs another command inside $(...) or backticks, so what it does cannot be checked.'
const HEREDOC =
  'The command uses a heredoc or here-string, which the plugin does not read.'
const PROCESS_SUBSTITUTION =
  'The command uses process substitution, which runs hidden commands.'
const UNBALANCED = 'The command has quotes or escapes that do not close.'
const BACKGROUND = 'The command runs something in the background (&).'
const GROUPING = 'The command uses a subshell or grouping with parentheses.'
const COMMENT = 'The command contains a shell comment that could hide text.'
const CONTROL = 'The command contains control characters.'

/**
 * Reads a command into words, redirects and separators, or explains why it
 * cannot be read safely.
 */
function lex(command: string): { tokens: Token[] } | { error: string } {
  for (const ch of command) {
    const code = ch.charCodeAt(0)
    if ((code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f) {
      return { error: CONTROL }
    }
  }
  const tokens: Token[] = []
  let word: Word | null = null
  const open = (i: number): Word => {
    if (!word) {
      word = {
        kind: 'word',
        text: '',
        start: i,
        end: i,
        quoted: false,
        expansion: false,
        glob: false,
        brace: false,
        tilde: false,
      }
    }
    return word
  }
  const close = (i: number): void => {
    if (word) {
      word.end = i
      tokens.push(word)
      word = null
    }
  }
  const op = (start: number, end: number): void => {
    close(start)
    tokens.push({ kind: 'op', start, end })
  }

  let i = 0
  while (i < command.length) {
    const c = command[i] as string
    const next = command[i + 1]
    if (c === ' ' || c === '\t') {
      close(i)
      i++
    } else if (c === '\n' || c === ';') {
      op(i, i + 1)
      i++
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return { error: UNBALANCED }
      const w = open(i)
      w.text += command.slice(i + 1, end)
      w.quoted = true
      i = end + 1
    } else if (c === '"') {
      const w = open(i)
      w.quoted = true
      i++
      let closed = false
      while (i < command.length) {
        const d = command[i] as string
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === '`') return { error: SUBSTITUTION }
        if (d === '$') {
          if (command[i + 1] === '(') return { error: SUBSTITUTION }
          w.expansion = true
        }
        if (d === '\\' && '$`"\\\n'.includes(command[i + 1] ?? 'x')) {
          w.text += command[i + 1]
          i += 2
          continue
        }
        w.text += d
        i++
      }
      if (!closed) return { error: UNBALANCED }
    } else if (c === '\\') {
      if (next === undefined) return { error: UNBALANCED }
      if (next === '\n') {
        i += 2
        continue
      }
      const w = open(i)
      w.text += next
      w.quoted = true
      i += 2
    } else if (c === '`') {
      return { error: SUBSTITUTION }
    } else if (c === '(' || c === ')') {
      return { error: GROUPING }
    } else if (c === '#' && word === null) {
      return { error: COMMENT }
    } else if (c === '|') {
      const len = next === '|' || next === '&' ? 2 : 1
      op(i, i + len)
      i += len
    } else if (c === '&' && next === '&') {
      op(i, i + 2)
      i += 2
    } else if (c === '&' && next === '>') {
      close(i)
      let j = i + 2
      if (command[j] === '>') j++
      tokens.push({
        kind: 'redirect',
        start: i,
        end: j,
        output: true,
        dup: false,
      })
      i = j
    } else if (c === '&') {
      return { error: BACKGROUND }
    } else if (c === '<' || c === '>') {
      if (next === '(') return { error: PROCESS_SUBSTITUTION }
      if (c === '<' && next === '<') return { error: HEREDOC }
      let start = i
      const w = word as Word | null
      if (w && /^\d+$/.test(w.text) && !w.quoted) {
        start = w.start
        word = null
      } else {
        close(i)
      }
      let j = i + 1
      let output = c === '>'
      if (c === '>' && (command[j] === '>' || command[j] === '|')) j++
      else if (c === '<' && command[j] === '>') {
        output = true
        j++
      }
      let dup = false
      if (command[j] === '&') {
        dup = true
        j++
      }
      tokens.push({ kind: 'redirect', start, end: j, output, dup })
      i = j
    } else {
      const w = open(i)
      if (c === '$') {
        if (next === '(') return { error: SUBSTITUTION }
        w.expansion = true
      }
      if (c === '*' || c === '?' || c === '[') w.glob = true
      if (c === '{' || c === '}') w.brace = true
      if (c === '~' && (w.text === '' || /[=:]$/.test(w.text))) w.tilde = true
      w.text += c
      i++
    }
  }
  close(command.length)
  return { tokens }
}

function segmentsOf(tokens: Token[]): Array<Array<Word | Redirect>> {
  const out: Array<Array<Word | Redirect>> = []
  let current: Array<Word | Redirect> = []
  for (const t of tokens) {
    if (t.kind === 'op') {
      if (current.length > 0) out.push(current)
      current = []
    } else {
      current.push(t)
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Splits a command on `&&`, `||`, `;`, `|` and newlines outside quotes.
 * Returns null for command or process substitution, backticks, heredocs,
 * unbalanced quotes, backgrounding, subshells and comments.
 */
export function splitSegments(command: string): string[] | null {
  const lexed = lex(command)
  if ('error' in lexed) return null
  return segmentsOf(lexed.tokens).map((seg) => {
    const first = seg[0] as Token
    const last = seg[seg.length - 1] as Token
    return command.slice(first.start, last.end).trim()
  })
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROTECTED_NAME = /\.env|\.secrets/i

function isProtected(text: string, names: string[]): boolean {
  const lower = text.toLowerCase()
  return (
    PROTECTED_NAME.test(text) ||
    names.some((name) => name !== '' && lower.includes(name.toLowerCase()))
  )
}
const PROTECTED_REASON =
  'The command touches a protected file (.env, .secrets or a protected path).'
/** Directories whose files change how git or the agents run, at any depth. */
const CONTROL_DIRS = new Set(['.git', '.codex', '.claude'])
/** Characters tried for each `?` or `[...]` slot of a glob. */
const GLOB_SLOT_CHARS = [...new Set('.envrcsecretsgitcodexclaude_-x')]
/** Whether text holds a non-ASCII space or an invisible formatting mark. */
function hasInvisible(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (
      c === 0xa0 ||
      c === 0x1680 ||
      c === 0x180e ||
      (c >= 0x2000 && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202f) ||
      (c >= 0x205f && c <= 0x2064) ||
      c === 0x3000 ||
      c === 0xfeff
    ) {
      return true
    }
  }
  return false
}

/** Where paths are checked: the worktree, the command's directory, links. */
type Place = {
  wt: string
  realWt: string
  /** The command's working directory, or null when it is unknown. */
  base: string | null
  containsGit?: (path: string) => boolean
  realpath?: (p: string) => string
  scripts?: Set<string>
  protectedNames: string[]
}

function inside(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(`${root}/`)
}

/** A glob component as a regular expression; null when it cannot be read. */
function globToRegExp(component: string): RegExp | null {
  let out = ''
  for (let i = 0; i < component.length; i++) {
    const c = component[i] as string
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      const end = component.indexOf(']', i + 1)
      if (end === -1) return null
      let body = component.slice(i + 1, end).replace(/\\/g, '\\\\')
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      out += `[${body}]`
      i = end
    } else out += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  try {
    return new RegExp(`^${out}$`, 'i')
  } catch {
    return null
  }
}

/**
 * Whether a glob could match a protected file or a control directory. A `*`
 * can hold any name, so it always could; `?` and `[...]` slots are tried
 * with every character those names use.
 */
function globHitsGuarded(piece: string, protectedNames: string[]): boolean {
  const slotChars = [
    ...new Set([...GLOB_SLOT_CHARS, ...protectedNames.join('').toLowerCase()]),
  ]
  for (const component of piece.split('/')) {
    if (!/[*?[]/.test(component)) continue
    if (component.includes('*')) return true
    const re = globToRegExp(component)
    if (!re) return true
    let names = ['']
    let slots = 0
    for (let i = 0; i < component.length; i++) {
      const c = component[i] as string
      if (c === '?' || c === '[') {
        if (c === '[') i = component.indexOf(']', i + 1)
        if (++slots > 3) return true
        names = names.flatMap((head) => slotChars.map((ch) => head + ch))
      } else {
        names = names.map((head) => head + c)
      }
    }
    const guarded = (name: string) =>
      isProtected(name, protectedNames) || CONTROL_DIRS.has(name.toLowerCase())
    if (names.some((name) => re.test(name) && guarded(name))) return true
  }
  return false
}

/** Why an absolute path is not allowed under `root`, or null. */
function placeReason(
  text: string,
  abs: string,
  root: string,
  write: boolean,
  who: string,
  protectedNames: string[],
): string | null {
  if (!inside(abs, root)) {
    return write
      ? `${who} writes to ${text}, outside the worktree.`
      : `${who} refers to ${text}, outside the worktree.`
  }
  if (write && abs === root) {
    return `${who} writes to the worktree directory itself.`
  }
  const rel = abs.slice(root.length + 1)
  const control = rel
    .split('/')
    .find((part) => CONTROL_DIRS.has(part.toLowerCase()))
  if (control) {
    return `${who} names ${text}, inside ${control}, which controls how git or the agents run.`
  }
  if (isProtected(rel, protectedNames)) {
    return `${who} touches a protected file (.env, .secrets or a protected path).`
  }
  return null
}

/**
 * Why a path is not allowed, or null. Relative paths resolve against the
 * working directory and fail when it is unknown; with `realpath`, the path
 * on disk must also stay inside the worktree.
 */
function pathReason(
  text: string,
  place: Place,
  write: boolean,
  who: string,
): string | null {
  if (text === '/dev/null') return null
  if (text.split('/').includes('..')) {
    return `${who} uses .. in ${text}, and the plugin does not follow parent-directory steps.`
  }
  let abs: string
  if (posix.isAbsolute(text)) abs = posix.resolve(text)
  else if (place.base === null) {
    return `${who} uses the relative path ${text}, but its working directory is unknown.`
  } else abs = posix.resolve(place.base, text)

  if (write && place.containsGit) {
    try {
      if (place.containsGit(abs))
        return `${who} writes to a directory containing nested git metadata.`
    } catch {
      return `${who} names ${text}, whose git metadata could not be checked.`
    }
  }
  const lexical = placeReason(
    text,
    abs,
    place.wt,
    write,
    who,
    place.protectedNames,
  )
  if (lexical || !place.realpath) return lexical
  let real: string
  try {
    real = posix.resolve(place.realpath(abs))
  } catch {
    return `${who} names ${text}, which could not be resolved on disk.`
  }
  if (!inside(real, place.realWt)) {
    return `${who} names ${text}, which links to ${real}, outside the worktree.`
  }
  return placeReason(text, real, place.realWt, write, who, place.protectedNames)
}

/** Why an argument may reach outside the worktree, or null. */
function argReason(arg: Word, place: Place): string | null {
  const text = arg.text
  const pieces = text.split(/[=:]/)
  if (text.startsWith('-')) {
    if (!text.includes('=') && (text.includes('/') || text.includes('..'))) {
      return `The option ${text} carries a path the plugin cannot check.`
    }
    pieces.shift()
  } else {
    pieces.unshift(text)
  }
  for (const piece of new Set(pieces)) {
    if (piece === '') continue
    if (arg.glob && /(^|\/)\.[^/]*[*?[]/.test(piece)) {
      return `The pattern ${piece} could match the parent directory.`
    }
    if (arg.glob && globHitsGuarded(piece, place.protectedNames)) {
      return `The pattern ${piece} could match a protected file or a control directory.`
    }
    const reason = pathReason(piece, place, false, 'The command')
    if (reason) return reason
  }
  return null
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

type Program = {
  rule: (args: string[], place: Place) => string | null
  /** The arguments that may name files; all of them unless set. */
  paths?: (args: Word[]) => Word[]
  /** Lists or searches the working directory when given no path. */
  implicitCwd?: boolean
}

const noRule = (): null => null
const noPaths = (): Word[] => []

/** Whether `arg` is a long option matching one of `options`, abbreviated or extended. */
function longMatches(arg: string, options: string[]): boolean {
  if (!arg.startsWith('--') || arg === '--') return false
  const name = arg.split('=')[0] as string
  return options.some((o) => o.startsWith(name) || name.startsWith(o))
}

/** Whether `args` hold a short flag from `shorts` or a long one from `longs`. */
function hasFlag(args: string[], shorts: string, longs: string[]): boolean {
  return args.some((a) =>
    a.startsWith('--')
      ? longMatches(a, longs)
      : a.startsWith('-') && [...a.slice(1)].some((c) => shorts.includes(c)),
  )
}

const REMOTE_GIT = new Set([
  'push',
  'fetch',
  'pull',
  'remote',
  'clone',
  'ls-remote',
  'submodule',
])
const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
])
const GIT_LOCAL = new Set(['add', 'commit', 'restore', 'merge', 'cherry-pick'])
const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'dev'])
const MERGE_STRATEGIES = new Set([
  'ort',
  'recursive',
  'resolve',
  'octopus',
  'ours',
  'subtree',
])

/** The protected branch an argument names (by its last ref component), or null. */
function protectedBranch(args: string[], branchOptions = ''): string | null {
  const attached = branchOptions
    ? new RegExp(`^-[^-]*?[${branchOptions}]`)
    : null
  for (const a of args) {
    // Branch-taking short flags may have a value attached, including in a group.
    const optionValue = attached ? a.replace(attached, '') : a
    const value = optionValue.includes('=')
      ? optionValue.slice(optionValue.indexOf('=') + 1)
      : optionValue
    const last = (value.split('/').pop() ?? '')
      .replace(/[~^@].*$/, '')
      .toLowerCase()
    if (PROTECTED_BRANCHES.has(last)) return last
  }
  return null
}

/** The merge strategy `args` ask for, '' when unreadable, or null for none. */
function strategyOf(args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a.startsWith('--')) {
      if (a.length > 4 && longMatches(a, ['--strategy'])) {
        return a.includes('=')
          ? a.slice(a.indexOf('=') + 1)
          : (args[k + 1] ?? '')
      }
      continue
    }
    if (!a.startsWith('-')) continue
    for (let i = 1; i < a.length; i++) {
      const c = a[i] as string
      if (c === 's')
        return i + 1 < a.length ? a.slice(i + 1) : (args[k + 1] ?? '')
      if ('XmFS'.includes(c)) break
    }
  }
  return null
}

const BRANCH_CHANGING_LONG = [
  '--delete',
  '--force',
  '--move',
  '--copy',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--track',
]

const gitRule: Program['rule'] = (args, place) => {
  let k = 0
  while (k < args.length && (args[k] as string).startsWith('-')) {
    const a = args[k] as string
    if (a === '-C') {
      if (args[k + 1] !== '.')
        return 'Git -C must name the worktree itself (.).'
      k += 2
    } else if (a === '--no-pager') k++
    else return `The git option ${a} can change how git runs.`
  }
  const sub = args[k]
  const rest = args.slice(k + 1)
  if (sub === undefined) return 'The git command has no subcommand.'
  if (REMOTE_GIT.has(sub)) return `Git ${sub} talks to a remote repository.`
  if (place.base === null) {
    return 'Git would act on whichever repository the unknown working directory is in.'
  }
  if (sub === 'checkout' || sub === 'reset') {
    const branch = protectedBranch(rest, sub === 'checkout' ? 'bB' : '')
    const hard = sub === 'reset' && rest.includes('--hard') ? ' --hard' : ''
    if (branch)
      return `Git ${sub}${hard} targets the protected branch ${branch}.`
    return `Git ${sub}${hard} can discard work, so a person must approve it.`
  }
  if (sub === 'switch') {
    const branch = protectedBranch(rest, 'cC')
    if (branch) return `Git switch targets the protected branch ${branch}.`
    if (rest.includes('-') || rest.some((a) => a.includes('@{'))) {
      return 'Git switch to a previous branch may land on a protected branch.'
    }
    if (
      hasFlag(rest, 'fC', ['--force', '--force-create', '--discard-changes'])
    ) {
      return 'Git switch with force options can throw away local changes or reset a branch.'
    }
    return null
  }
  if (sub === 'branch') {
    for (const a of rest) {
      const changes = a.startsWith('--')
        ? longMatches(a, BRANCH_CHANGING_LONG)
        : a.startsWith('-') && /[^arlvq]/.test(a.slice(1))
      if (changes) return `Git branch ${a} changes or deletes branches.`
    }
    const branch = protectedBranch(rest, 'cCmM')
    if (branch) return `Git branch names the protected branch ${branch}.`
    return null
  }
  if (sub === 'stash') {
    const words = rest.filter((a) => !a.startsWith('-'))
    const action = words[0]
    if (action === 'drop' || action === 'clear') {
      return `Git stash ${action} deletes saved changes.`
    }
    const branch = action === 'branch' ? protectedBranch(words.slice(1)) : null
    if (branch) return `Git stash branch names the protected branch ${branch}.`
    return null
  }
  if (sub === 'restore' && hasFlag(rest, 's', ['--source'])) {
    return 'Git restore --source can overwrite files with old versions.'
  }
  if (sub === 'merge' || sub === 'cherry-pick') {
    const strategy = strategyOf(rest)
    if (strategy !== null && !MERGE_STRATEGIES.has(strategy)) {
      return `Git ${sub} with strategy "${strategy}" could run another program.`
    }
  }
  if (GIT_READ.has(sub) || GIT_LOCAL.has(sub)) return null
  return `Git ${sub} is not on the list of git commands the plugin may approve.`
}

/** Git arguments after its global options (`-C .`, `--no-pager`). */
const gitPaths = (args: Word[]): Word[] => {
  let k = 0
  while (k < args.length && (args[k] as Word).text.startsWith('-')) {
    k += (args[k] as Word).text === '-C' ? 2 : 1
  }
  return args.slice(k)
}

/** uv arguments after the subcommand and tool name. */
const uvPaths = (args: Word[]): Word[] => {
  if (args[0]?.text !== 'run') return args.slice(1)
  let k = 1
  while (k < args.length && (args[k] as Word).text.startsWith('-')) {
    k += UV_RUN_VALUE_FLAGS.has((args[k] as Word).text) ? 2 : 1
  }
  const tool = args[k]?.text
  k++
  if (tool === 'pre-commit' && args[k]?.text === 'run') k++
  return args.slice(k)
}

const UV_RUN_FLAGS = new Set([
  '--frozen',
  '--locked',
  '--no-sync',
  '--offline',
  '--native-tls',
  '--all-extras',
  '--dev',
  '--no-dev',
  '-q',
  '--quiet',
])
const UV_RUN_VALUE_FLAGS = new Set(['--extra', '--group', '--package'])

const uvRule: Program['rule'] = (args) => {
  if (args[0] === 'sync') return null
  if (args[0] !== 'run') {
    return `The uv command ${args[0] ?? ''} is not on the allowed list.`
  }
  let k = 1
  while (k < args.length && (args[k] as string).startsWith('-')) {
    const a = args[k] as string
    if (UV_RUN_FLAGS.has(a)) k++
    else if (UV_RUN_VALUE_FLAGS.has(a)) {
      const value = args[k + 1] ?? ''
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
        return `The uv run option ${a} needs a plain name, not ${value || 'nothing'}.`
      }
      k += 2
    } else return `The uv run option ${a} is not on the allowed list.`
  }
  const tool = args[k]
  if (tool === 'pytest' || tool === 'ruff') return null
  if (tool === 'pre-commit') {
    const sub = args[k + 1]
    if (sub === undefined || sub === 'run') return null
    return `The pre-commit command ${sub} is not on the allowed list.`
  }
  return `The program uv run ${tool ?? ''} is not on the allowed list; only pytest, ruff and pre-commit are.`
}

/** Bun's own commands, which win over a package.json script of the same name. */
const BUN_BUILTINS = new Set([
  'run',
  'test',
  'x',
  'exec',
  'repl',
  'install',
  'i',
  'add',
  'a',
  'remove',
  'rm',
  'update',
  'outdated',
  'link',
  'unlink',
  'publish',
  'patch',
  'patch-commit',
  'pm',
  'init',
  'create',
  'c',
  'upgrade',
  'build',
  'audit',
  'info',
  'why',
  'completions',
  'help',
  'feedback',
])

const bunRule: Program['rule'] = (args, place) => {
  const sub = args[0]
  if (sub === undefined) return 'The bun command has no subcommand.'
  if (sub === 'test') return null
  if (sub === 'x') return bunxRule(args.slice(1), place)
  if (sub === 'install') {
    if (args.some((a) => a === '-g' || a === '--global')) {
      return 'The bun install is global, outside the worktree.'
    }
    if (args.slice(1).some((a) => !a.startsWith('-'))) {
      return 'The bun install names packages, which adds dependencies.'
    }
    return null
  }
  if (sub !== 'run' && BUN_BUILTINS.has(sub)) {
    return `The bun command ${sub} is not on the allowed list.`
  }
  const script = sub === 'run' ? args[1] : sub
  if (script === undefined || script.startsWith('-')) {
    return 'The bun run command has options the plugin does not check.'
  }
  if (!place.scripts) {
    return 'The worktree package.json scripts are unknown, so the plugin cannot tell what bun would run.'
  }
  if (!place.scripts.has(script)) {
    return `The name ${script} is not a script in the worktree package.json, so bun could run a program or file instead.`
  }
  if (place.base !== place.wt) {
    return 'The bun script would not run from the worktree root, so a different package.json could apply.'
  }
  return null
}

/** bun arguments after the subcommand (and the script name for run). */
const bunPaths = (args: Word[]): Word[] =>
  args.slice(args[0]?.text === 'run' ? 2 : args[0]?.text === 'x' ? 3 : 1)

const bunxRule: Program['rule'] = (args) =>
  args[0] === '@biomejs/biome'
    ? null
    : `The bunx package ${args[0] ?? ''} is not on the allowed list; only @biomejs/biome is.`

const CARGO_SUBS = new Set([
  'build',
  'test',
  'fetch',
  'clippy',
  'fmt',
  'nextest',
])
const cargoRule: Program['rule'] = (args) => {
  if (!CARGO_SUBS.has(args[0] ?? '')) {
    return `The cargo command ${args[0] ?? ''} is not on the allowed list.`
  }
  const bad = args.find((a) => /^--config(=|$)|^-Z/.test(a))
  return bad ? `The cargo option ${bad} can run other commands.` : null
}

const GO_BOOL_FLAGS = new Set(['v', 'race', 'short', 'cover', 'failfast'])
const GO_VALUE_FLAGS = new Set([
  'run',
  'count',
  'covermode',
  'tags',
  'timeout',
  'p',
])
/** Go flags whose value is a file the command writes. */
const GO_FILE_FLAGS = new Set(['coverprofile', 'o'])

function goPackageReason(pattern: string, place: Place): string | null {
  if (!(pattern === '.' || pattern.startsWith('./')) || pattern.includes('@')) {
    return `The go package ${pattern} is not a relative path inside the worktree.`
  }
  return pathReason(
    pattern.replace(/\/\.\.\.$/, ''),
    place,
    false,
    'The command',
  )
}

/** Checks go build/test/vet arguments against the allowed flags and packages. */
function goArgsReason(args: string[], place: Place): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (!a.startsWith('-')) {
      const reason = goPackageReason(a, place)
      if (reason) return reason
      continue
    }
    const m = /^--?([a-z]+)(?:=(.*))?$/.exec(a)
    const name = m?.[1] ?? ''
    if (m && GO_BOOL_FLAGS.has(name)) {
      const value = m[2]
      if (value !== undefined && value !== 'true' && value !== 'false') {
        return `The go option ${a} has a value the plugin does not accept.`
      }
      continue
    }
    if (m && (GO_VALUE_FLAGS.has(name) || GO_FILE_FLAGS.has(name))) {
      let value = m[2]
      if (value === undefined) {
        k++
        value = args[k]
      }
      if (value === undefined) return `The go option ${a} needs a value.`
      if (value.startsWith('-')) {
        return `The go option ${a} has a value that looks like another option (${value}).`
      }
      if (GO_FILE_FLAGS.has(name)) {
        const reason = pathReason(value, place, true, 'The command')
        if (reason) return reason
      }
      continue
    }
    return `The go option ${a} is not on the allowed list.`
  }
  return null
}

const goRule: Program['rule'] = (args, place) => {
  const sub = args[0]
  if (sub === 'mod') {
    return args[1] === 'download' && args.length === 2
      ? null
      : 'Only go mod download, with nothing else, is allowed.'
  }
  if (sub === 'build' || sub === 'test' || sub === 'vet') {
    return goArgsReason(args.slice(1), place)
  }
  return `The go command ${sub ?? ''} is not on the allowed list.`
}

const gotestsumRule: Program['rule'] = (args, place) => {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a === '--') return goArgsReason(args.slice(k + 1), place)
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    const name = m?.[1]
    if (name === 'rerun-fails') {
      if (m?.[2] !== undefined && !/^\d+$/.test(m[2])) {
        return `The gotestsum option ${a} has a value the plugin does not accept.`
      }
      continue
    }
    if (name === 'format' || name === 'packages') {
      let value = m?.[2]
      if (value === undefined) {
        k++
        value = args[k]
      }
      if (value === undefined) return `The gotestsum option ${a} needs a value.`
      if (name === 'packages') {
        for (const pkg of value.split(/\s+/).filter(Boolean)) {
          const reason = goPackageReason(pkg, place)
          if (reason) return reason
        }
      }
      continue
    }
    return `The gotestsum option ${a} is not on the allowed list.`
  }
  return null
}

const makeRule: Program['rule'] = (args) =>
  args.length === 1 && (args[0] === 'check' || args[0] === 'test')
    ? null
    : 'Only make check and make test, with nothing else, are allowed.'

const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
])
const findRule: Program['rule'] = (args) => {
  const follow = args.find((a) => a === '-L' || a === '-H' || a === '-follow')
  if (follow) return `The find option ${follow} follows symbolic links.`
  const bad = args.find((a) => FIND_ACTIONS.has(a))
  return bad
    ? `The find action ${bad} can delete files or run other commands.`
    : null
}

const SED_ADDRESS = String.raw`(?:\d+|\$|/[^/\\]*/)`
const SED_PRINT = new RegExp(`^(?:${SED_ADDRESS}(?:,${SED_ADDRESS})?)?p$`)
const sedRule: Program['rule'] = (args) => {
  let script: string | undefined
  let quiet = false
  for (const a of args) {
    if (a.startsWith('-') && a !== '-') {
      if (script === undefined && /^-[nEr]+$/.test(a)) {
        if (a.includes('n')) quiet = true
        continue
      }
      return `The sed option ${a} is not allowed; only sed -n that prints lines is.`
    }
    if (script === undefined) script = a
  }
  if (!quiet || script === undefined || !SED_PRINT.test(script)) {
    return 'Only sed -n that prints lines is allowed.'
  }
  return null
}

/** Whether `a` is a short option cluster holding one of `letters`. */
function shortHas(a: string, letters: string): boolean {
  return /^-[^-]/.test(a) && [...a.slice(1)].some((c) => letters.includes(c))
}

const lsRule: Program['rule'] = (args) => {
  const bad = args.find(
    (a) => shortHas(a, 'LH') || longMatches(a, ['--dereference']),
  )
  return bad ? `The ls option ${bad} follows symbolic links.` : null
}

const grepRule: Program['rule'] = (args) => {
  const follow = args.find((a) => shortHas(a, 'SO'))
  if (follow) return `The grep option ${follow} follows symbolic links.`
  const bad = args.find(
    (a) =>
      longMatches(a, [
        '--recursive',
        '--dereference-recursive',
        '--directories',
      ]) ||
      (/^-[^-]/.test(a) && /[rRd]/.test(a)),
  )
  return bad
    ? `The grep option ${bad} searches whole directories, which can reach protected files.`
    : null
}

/** The globs given to rg with -g, --glob or --iglob. */
function rgGlobs(args: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    if (a.startsWith('--')) {
      if (longMatches(a, ['--glob', '--iglob'])) {
        out.push(
          a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++k] ?? ''),
        )
      }
    } else if (/^-[^-]/.test(a) && a.includes('g')) {
      const rest = a.slice(a.indexOf('g') + 1)
      out.push(rest || (args[++k] ?? ''))
    }
  }
  return out
}

const rgRule: Program['rule'] = (args, place) => {
  if (args.some((a) => longMatches(a, ['--type-add']))) {
    return 'The rg option --type-add defines file types the plugin cannot check.'
  }
  for (const glob of rgGlobs(args)) {
    if (globHitsGuarded(glob.replace(/^!/, ''), place.protectedNames)) {
      return `The rg glob ${glob} could match a protected file or a control directory.`
    }
  }
  for (const a of args) {
    if (longMatches(a, ['--follow']) || shortHas(a, 'L')) {
      return `The rg option ${a} follows symbolic links.`
    }
    if (longMatches(a, ['--pre', '--hostname-bin'])) {
      return `The rg option ${a} runs another program.`
    }
    const reveals = a.startsWith('--')
      ? longMatches(a, ['--hidden', '--unrestricted', '--no-ignore'])
      : /^-[^-]/.test(a) && /[u.]/.test(a)
    if (reveals) {
      return `The rg option ${a} searches hidden or ignored files, which can reach protected files.`
    }
  }
  return null
}

const golangciRule: Program['rule'] = (args) =>
  args[0] === 'run'
    ? null
    : `The golangci-lint command ${args[0] ?? ''} is not on the allowed list.`

/** Programs the plugin may approve, with their argument rules. */
const ALLOWED: Record<string, Program> = {
  ls: { rule: lsRule, implicitCwd: true },
  cat: { rule: noRule },
  head: { rule: noRule },
  tail: { rule: noRule },
  wc: { rule: noRule },
  pwd: { rule: noRule, paths: noPaths },
  echo: { rule: noRule, paths: noPaths },
  printf: {
    rule: (args) =>
      args[0]?.startsWith('-') && args[0] !== '--'
        ? 'The printf option can change shell state or run code.'
        : null,
    paths: noPaths,
  },
  uname: { rule: noRule, paths: noPaths },
  grep: { rule: grepRule },
  rg: { rule: rgRule, implicitCwd: true },
  find: { rule: findRule, implicitCwd: true },
  sed: { rule: sedRule },
  git: { rule: gitRule, paths: gitPaths },
  uv: { rule: uvRule, paths: uvPaths },
  ruff: { rule: noRule, paths: (args) => args.slice(1) },
  bun: { rule: bunRule, paths: bunPaths },
  bunx: { rule: bunxRule, paths: (args) => args.slice(2) },
  cargo: {
    rule: cargoRule,
    paths: (args) => args.slice(args[0]?.text === 'nextest' ? 2 : 1),
  },
  go: { rule: goRule, paths: noPaths },
  'golangci-lint': { rule: golangciRule, paths: (args) => args.slice(1) },
  gotestsum: { rule: gotestsumRule, paths: noPaths },
  make: { rule: makeRule, paths: noPaths },
}

const NETWORK = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'ftp',
  'gh',
  'glab',
])
const ELEVATED = new Set(['sudo', 'doas', 'su'])
const SHELL_STATE = new Set(
  'cd pushd popd export unset set declare typeset local readonly read alias unalias source . eval exec trap builtin command hash ulimit umask shopt setopt emulate'.split(
    ' ',
  ),
)
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'exec',
  'source',
  '.',
])
const WRAPPERS = new Set([
  'env',
  'xargs',
  'nohup',
  'command',
  'builtin',
  'time',
  'timeout',
  'nice',
  'watch',
  'parallel',
])
const AGENTS = new Set(['codex', 'claude'])

function programReason(
  name: string,
  args: string[],
  place: Place,
): string | null {
  if (name.includes('/')) {
    return `The command runs a program by path (${name}), which is not on the allowed list.`
  }
  if (NETWORK.has(name)) return `The command reaches the network (${name}).`
  if (ELEVATED.has(name)) {
    return `The command asks for administrator rights (${name}).`
  }
  if (SHELL_STATE.has(name)) {
    return `The command changes shell state or runs code (${name}).`
  }
  if (SHELLS.has(name)) {
    return `The command runs a shell or eval (${name}), so the real command cannot be checked.`
  }
  if (WRAPPERS.has(name)) {
    return `The command runs another program through ${name}, so the real command cannot be checked.`
  }
  if (AGENTS.has(name)) {
    const bypass = args.some((a) => /bypass|dangerously|full-auto|yolo/.test(a))
    return bypass
      ? `The command starts ${name} with flags that bypass its approvals or sandbox.`
      : `The command starts another agent (${name}).`
  }
  if (name === 'rm') return 'The command deletes files (rm).'
  if (name === 'tee') return 'The command writes files with tee.'
  const program = Object.hasOwn(ALLOWED, name) ? ALLOWED[name] : undefined
  if (!program) {
    return `The program ${name} is not on the list of commands the plugin may approve.`
  }
  return program.rule(args, place)
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

function wordReason(w: Word, place: Place): string | null {
  if (w.expansion) {
    return 'The command uses shell variables ($...), so the real command cannot be known in advance.'
  }
  if (w.tilde) {
    return 'The command refers to the home directory (~), outside the worktree.'
  }
  if (w.brace) return 'The command uses brace expansion ({...}).'
  if (isProtected(w.text, place.protectedNames)) return PROTECTED_REASON
  return null
}

const TOOLCHAINS = new Set([
  'uv',
  'ruff',
  'bun',
  'bunx',
  'cargo',
  'go',
  'golangci-lint',
  'gotestsum',
])

function toolchainWrites(args: Word[], place: Place): string | null {
  for (let k = 0; k < args.length; k++) {
    const text = (args[k] as Word).text
    const attached = /^-o[^=]/.test(text)
    const [flag] = attached ? ['-o'] : text.split('=')
    if (flag === '--basetemp')
      return 'The --basetemp option deletes its destination.'
    if (
      !/^(?:-o|--output[^=]*|--target-dir|--manifest-path|--cov-report|--junitxml|-coverprofile)$/.test(
        flag ?? '',
      )
    )
      continue
    const value = attached
      ? text.slice(2)
      : text.includes('=')
        ? text.slice(text.indexOf('=') + 1)
        : args[++k]?.text
    if (!value || value.startsWith('-'))
      return `The option ${flag} needs an output path.`
    // Coverage reports can prefix the destination with a format, such as html:path.
    const path =
      flag === '--cov-report' && value.includes(':')
        ? value.slice(value.indexOf(':') + 1)
        : value
    const reason = pathReason(path, place, true, 'The command')
    if (reason) return reason
  }
  return null
}

function segmentReason(
  seg: Array<Word | Redirect>,
  place: Place,
): string | null {
  const words: Word[] = []
  const redirects: Array<{ r: Redirect; target: Word }> = []
  for (let k = 0; k < seg.length; k++) {
    const t = seg[k] as Word | Redirect
    if (t.kind === 'word') {
      words.push(t)
      continue
    }
    const target = seg[k + 1]
    if (target?.kind !== 'word') {
      return 'The command has a redirect with no target.'
    }
    redirects.push({ r: t, target })
    k++
  }

  for (const w of [...words, ...redirects.map((x) => x.target)]) {
    const reason = wordReason(w, place)
    if (reason) return reason
    if (w.glob && place.realpath) {
      return `The pattern ${w.text} cannot be checked for links, since only literal paths can be resolved.`
    }
  }

  const [name, ...args] = words
  if (name) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name.text)) {
      return 'The command sets environment variables before running.'
    }
    const reason = programReason(
      name.text,
      args.map((a) => a.text),
      place,
    )
    if (reason) return reason
    if (TOOLCHAINS.has(name.text)) {
      const writeReason = toolchainWrites(args, place)
      if (writeReason) return writeReason
    }
    const program = ALLOWED[name.text] as Program
    if (
      place.base === null &&
      program.implicitCwd &&
      !args.some((a) => a.text.startsWith('/'))
    ) {
      return 'The command lists or searches its working directory, which is unknown.'
    }
    for (const a of program.paths ? program.paths(args) : args) {
      const outside = argReason(a, place)
      if (outside) return outside
    }
  }

  for (const { r, target } of redirects) {
    if (r.dup && /^(\d+-?|-)$/.test(target.text)) continue
    if (target.glob) return 'The command redirects to a file pattern.'
    const reason = r.output
      ? pathReason(target.text, place, true, 'The command')
      : argReason(target, place)
    if (reason) return reason
  }
  return null
}

function commandReason(command: string, place: Place): string | null {
  if (command.trim() === '') {
    return 'The command could not be read from the screen.'
  }
  if (command.includes('…')) {
    return 'The command is cut off on screen, so the full command is unknown.'
  }
  if (hasInvisible(command)) {
    return 'The command contains invisible or unusual space characters.'
  }
  if (isProtected(command, place.protectedNames)) return PROTECTED_REASON
  const lexed = lex(command)
  if ('error' in lexed) return lexed.error
  for (const seg of segmentsOf(lexed.tokens)) {
    const reason = segmentReason(seg, place)
    if (reason) return reason
  }
  return null
}

const MAX_WRAPS = 5

/** Every way the wrapped screen lines could join back into the original. */
function readings(pieces: string[], seps: string[]): string[] {
  let out = [pieces[0] as string]
  for (const piece of pieces.slice(1)) {
    out = out.flatMap((head) => seps.map((sep) => head + sep + piece))
  }
  return out
}

function worktreeOf(path: string): string | null {
  if (!path || !posix.isAbsolute(path) || /[~$]/.test(path)) return null
  const wt = posix.resolve(path)
  return wt.split('/').filter(Boolean).length >= 2 ? wt : null
}

function placeOf(ctx: ApprovalContext): Place | string {
  const wt = worktreeOf(ctx.worktreePath)
  if (!wt) return 'The worktree path is unknown, so no path can be checked.'
  const realpath = ctx.realpath
  let realWt = wt
  if (realpath) {
    try {
      realWt = posix.resolve(realpath(wt))
    } catch {
      return 'The worktree path could not be resolved on disk.'
    }
  }
  const cwd = ctx.cwd ?? null
  let base: string | null = null
  if (cwd !== null) {
    if (
      !posix.isAbsolute(cwd) ||
      /[~$]/.test(cwd) ||
      cwd.split('/').includes('..')
    ) {
      return `The command runs in ${cwd}, which is not a plain absolute path.`
    }
    base = posix.resolve(cwd)
    if (!inside(base, wt)) {
      return `The command runs in ${cwd}, outside the worktree.`
    }
    if (realpath) {
      let real: string
      try {
        real = posix.resolve(realpath(base))
      } catch {
        return `The command runs in ${cwd}, which could not be resolved on disk.`
      }
      if (!inside(real, realWt)) {
        return `The command runs in ${cwd}, which links outside the worktree.`
      }
    }
  }
  return {
    wt,
    realWt,
    base,
    realpath,
    containsGit: ctx.containsGit,
    protectedNames: ctx.protectedNames ?? [],
    scripts: ctx.packageScripts ? new Set(ctx.packageScripts) : undefined,
  }
}

/**
 * Whether the summary path names the same file as `destination`, comparing
 * full resolved paths. With an unknown cwd a relative summary must equal the
 * destination's path relative to the worktree.
 */
function summaryNames(
  summary: string,
  destination: string,
  place: Place,
): boolean {
  let dest: string
  if (posix.isAbsolute(destination)) dest = posix.resolve(destination)
  else if (place.base !== null) dest = posix.resolve(place.base, destination)
  else return false
  if (posix.isAbsolute(summary)) return posix.resolve(summary) === dest
  if (place.base !== null) return posix.resolve(place.base, summary) === dest
  return summary === posix.relative(place.wt, dest)
}

function escalate(reason: string): ApprovalVerdict {
  return { verdict: 'escalate', reason }
}

/**
 * Decides whether the plugin may approve a prompt. Approves only when every
 * part of the command is on the allow list and stays inside the worktree.
 */
export function judge(
  prompt: ApprovalPrompt,
  ctx: ApprovalContext,
): ApprovalVerdict {
  const place = placeOf(ctx)
  if (typeof place === 'string') return escalate(place)
  if (prompt.problem) return escalate(prompt.problem)
  const wraps = prompt.wrapped?.length ?? 0
  if (wraps > MAX_WRAPS + 1) {
    return escalate('The prompt is too long to read reliably from the screen.')
  }

  if (prompt.kind === 'edit') {
    if (!prompt.path) {
      return escalate('The edit destination could not be read from the screen.')
    }
    const paths = new Set([prompt.path])
    if (prompt.wrapped) {
      for (const p of readings(prompt.wrapped, ['', ' '])) paths.add(p)
    }
    for (const p of paths) {
      if (p.includes('…')) {
        return escalate('The edit destination is cut off on screen.')
      }
      if (p.startsWith('~') || p.includes('$')) {
        return escalate(
          'The edit destination uses ~ or a variable, which the plugin treats as outside the worktree.',
        )
      }
      if (hasInvisible(p)) {
        return escalate(
          'The edit destination contains invisible or unusual space characters.',
        )
      }
      const reason = pathReason(p, place, true, 'The edit')
      if (reason) return escalate(reason)
    }
    const summary = prompt.summary
    if (summary === undefined) {
      return escalate(
        'The edit prompt has no summary of the change to compare with its destination.',
      )
    }
    if (![...paths].some((p) => summaryNames(summary, p, place))) {
      return escalate(
        `The edit summary names ${summary}, but the destination is ${prompt.path}.`,
      )
    }
    return { verdict: 'approve' }
  }

  const first = commandReason(prompt.command, place)
  if (first) return escalate(first)
  if (prompt.wrapped) {
    for (const reading of readings(prompt.wrapped, [' ', '', '\n'])) {
      const reason = commandReason(reading, place)
      if (reason) {
        return escalate(
          `The command wraps across screen lines and could also be read another way. ${reason}`,
        )
      }
    }
  }
  return { verdict: 'approve' }
}
