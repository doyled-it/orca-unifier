export type Language = 'python' | 'typescript' | 'rust' | 'go'

/** Top-level markers, in the order setup should run. */
export function detectLanguages(files: string[]): Language[] {
  const langs: Language[] = []
  if (files.includes('pyproject.toml') || files.includes('uv.lock')) {
    langs.push('python')
  }
  if (files.includes('package.json')) langs.push('typescript')
  if (files.includes('Cargo.toml')) langs.push('rust')
  if (files.includes('go.mod')) langs.push('go')
  return langs
}

function packageManager(files: string[]): 'bun' | 'npm' | 'pnpm' | 'yarn' {
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun'
  if (
    files.includes('package-lock.json') ||
    files.includes('npm-shrinkwrap.json')
  ) {
    return 'npm'
  }
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  return 'bun'
}

export function setupCommands(langs: Language[], files: string[]): string[][] {
  return langs.map((lang) => {
    switch (lang) {
      case 'python':
        return ['uv', 'sync']
      case 'typescript': {
        const manager = packageManager(files)
        if (manager === 'npm') return ['npm', 'ci']
        if (
          manager === 'bun' &&
          !files.includes('bun.lock') &&
          !files.includes('bun.lockb')
        ) {
          return ['bun', 'install']
        }
        return [manager, 'install', '--frozen-lockfile']
      }
      case 'rust':
        return ['cargo', 'fetch']
      case 'go':
        return ['go', 'mod', 'download']
    }
    throw new Error(`Unknown setup language: ${lang}`)
  })
}

/** Only lockfiles the selected install commands can produce are setup-owned. */
export function setupArtifacts(langs: Language[], files: string[]): string[] {
  return langs.flatMap((lang) => {
    switch (lang) {
      case 'python':
        return ['uv.lock']
      case 'typescript':
        return packageManager(files) === 'bun' ? ['bun.lock', 'bun.lockb'] : []
      case 'rust':
        return ['Cargo.lock']
      case 'go':
        return ['go.sum']
    }
    return []
  })
}

/** Plain lines describing missing configuration, without changing the repo. */
export function gapReport(
  langs: Language[],
  files: string[],
  pyprojectText = '',
): string[] {
  const gaps: string[] = []
  for (const lang of langs) {
    switch (lang) {
      case 'python':
        if (
          !files.includes('ruff.toml') &&
          !/^\s*\[tool\.ruff\][\t ]*(?:#.*)?\r?$/m.test(pyprojectText)
        ) {
          gaps.push('Python: missing ruff configuration')
        }
        if (!files.includes('.pre-commit-config.yaml')) {
          gaps.push('Python: missing .pre-commit-config.yaml')
        }
        break
      case 'typescript': {
        if (!files.includes('biome.json'))
          gaps.push('TypeScript: missing biome.json')
        const manager = packageManager(files)
        if (manager !== 'bun') gaps.push(`TypeScript: uses ${manager}, not bun`)
        break
      }
      case 'rust':
        if (!files.includes('.config/nextest.toml')) {
          gaps.push('Rust: missing .config/nextest.toml')
        }
        break
      case 'go':
        if (!files.includes('.golangci.yml'))
          gaps.push('Go: missing .golangci.yml')
        break
    }
  }
  return gaps
}

function quote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/** Each command stops the sequence on failure, with a readable final status. */
export function renderSetupScript(cmds: string[][]): string {
  const lines = ['#!/bin/sh', 'set -u']
  for (const cmd of cmds) {
    lines.push(
      `if ${cmd.map(quote).join(' ')}; then`,
      '  :',
      'else',
      `  printf '%s\\n' ${quote(`unifier setup: failed at ${cmd.join(' ')}`)}`,
      '  exit 1',
      'fi',
    )
  }
  lines.push("printf '%s\\n' 'unifier setup: done'")
  return `${lines.join('\n')}\n`
}

/** Select a POSIX interpreter even when the terminal's default shell differs. */
export function renderSetupCommand(cmds: string[][]): string {
  return ['/bin/sh', '-c', renderSetupScript(cmds)].map(quote).join(' ')
}
