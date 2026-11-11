import { join } from 'node:path'
import { isPlainProjectName } from './hubs'
import type { UnifierSettings } from './types'
import { parseWorkerChoice } from './worker-defaults'

const DEFAULTS: UnifierSettings = {
  projectsRoot: '~/projects',
  excludedProjects: [],
  protectedPaths: [],
  orchestratorAgent: 'claude',
  orchestratorModel: 'claude-opus-5-5',
  workerImplementation: 'codex:gpt-6.1-sol',
  workerReview: 'codex:gpt-6.1-sol',
  workerDesign: 'claude:claude-opus-4-8',
  workerProse: 'claude:claude-opus-4-8',
  hideMainCheckouts: true,
  cleanupEnabled: true,
  cleanupIntervalMinutes: 10,
  approverEnabled: true,
  setupEnabled: true,
}

const MIN_CLEANUP_INTERVAL = 5

function str(raw: Record<string, unknown>, key: keyof UnifierSettings): string {
  const v = raw[key]
  return typeof v === 'string' && v.trim() !== ''
    ? v
    : (DEFAULTS[key] as string)
}

function bool(
  raw: Record<string, unknown>,
  key: keyof UnifierSettings,
): boolean {
  const v = raw[key]
  return typeof v === 'boolean' ? v : (DEFAULTS[key] as boolean)
}

function worker(
  raw: Record<string, unknown>,
  key: keyof UnifierSettings,
): string {
  return parseWorkerChoice(raw[key])
    ? (raw[key] as string)
    : (DEFAULTS[key] as string)
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function names(raw: unknown): string[] {
  return typeof raw === 'string'
    ? raw
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => isPlainProjectName(name) && !/[*?[\]{}]/.test(name))
    : []
}

export function parseSettings(
  raw: Record<string, unknown>,
  home: string,
): UnifierSettings {
  const interval = raw.cleanupIntervalMinutes
  return {
    projectsRoot: expandHome(str(raw, 'projectsRoot'), home),
    excludedProjects: names(raw.excludedProjects),
    protectedPaths: names(raw.protectedPaths),
    orchestratorAgent: str(raw, 'orchestratorAgent'),
    orchestratorModel: str(raw, 'orchestratorModel'),
    workerImplementation: worker(raw, 'workerImplementation'),
    workerReview: worker(raw, 'workerReview'),
    workerDesign: worker(raw, 'workerDesign'),
    workerProse: worker(raw, 'workerProse'),
    hideMainCheckouts: bool(raw, 'hideMainCheckouts'),
    cleanupEnabled: bool(raw, 'cleanupEnabled'),
    cleanupIntervalMinutes:
      typeof interval === 'number' &&
      Number.isInteger(interval) &&
      interval >= MIN_CLEANUP_INTERVAL
        ? interval
        : DEFAULTS.cleanupIntervalMinutes,
    approverEnabled: bool(raw, 'approverEnabled'),
    setupEnabled: bool(raw, 'setupEnabled'),
  }
}
