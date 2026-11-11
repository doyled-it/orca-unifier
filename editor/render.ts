import type { BoardFilter } from '../src/core/board-filter'
import type {
  AgentModels,
  AgentState,
  BoardCard,
  BoardModel,
  CardAgent,
  OrchestratorView,
} from '../src/core/board-types'
import type { BoardStatus } from '../src/core/types'
import { WORKER_KINDS, type WorkerDefaults } from '../src/core/worker-defaults'
import { type IconName, icon } from './icons'

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Compact relative time: "now", "5m", "3h", "2d". */
export function relativeTime(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

const COLUMN_ICONS: Record<BoardStatus, IconName> = {
  todo: 'circle',
  'in-progress': 'circle-half',
  'in-review': 'circle-check',
  completed: 'circle-check-filled',
}

const STATE_ICONS: Record<AgentState, IconName> = {
  working: 'loader-circle',
  blocked: 'circle-alert',
  waiting: 'circle-alert',
  done: 'circle-check',
}

const STATE_LABELS: Record<AgentState, string> = {
  working: 'Working',
  blocked: 'Blocked',
  waiting: 'Waiting',
  done: 'Done',
}

/** Cards whose title, repo, branch or agent activity contains `query`, any case. */
export function filterCards(
  cards: readonly BoardCard[],
  query: string,
): BoardCard[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...cards]
  return cards.filter((c) =>
    [c.title, c.repo, c.branch ?? '', ...c.agents.map((a) => a.title ?? '')]
      .join('\n')
      .toLowerCase()
      .includes(q),
  )
}

function agentMark(agent: string | null): string {
  const kind = agent?.toLowerCase() ?? ''
  if (kind.includes('claude')) return icon('mark-claude', 'mark claude')
  if (kind.includes('codex')) return icon('mark-codex', 'mark codex')
  return icon('bot', 'mark')
}

/** Drops the spinner or status glyphs terminals put before an agent title. */
function cleanTitle(title: string | null): string | null {
  const t = title?.replace(/^[\s\u2022\u00b7*\u2600-\u27bf\u2800-\u28ff]+/, '')
  return t ? t.trim() : null
}

/** "Title - detail" or "Title | detail" (also en and em dash) into head and remainder. */
function splitActivity(title: string): [string, string | null] {
  const m = /\s[-|\u2013\u2014]\s/.exec(title)
  if (!m || m.index === 0) return [title, null]
  return [title.slice(0, m.index), title.slice(m.index + m[0].length)]
}

function renderAgentRow(agents: readonly CardAgent[], now: number): string {
  const a = agents[0]
  if (!a) return ''
  const title = cleanTitle(a.title)
  const [head, rest] = title
    ? splitActivity(title)
    : [STATE_LABELS[a.state], null]
  const detail = [rest, a.detail].filter(Boolean).join(' - ')
  const full = [title, a.detail].filter(Boolean).join(' - ')
  const tip = full ? ` title="${esc(full)}"` : ''
  const more =
    agents.length > 1 ? `<span class="more">+${agents.length - 1}</span>` : ''
  return `<div class="agent-row" data-agent="${a.state}">${icon(STATE_ICONS[a.state], 'state')}${agentMark(a.agent)}<span class="activity"${tip}><b class="act">${esc(head)}</b>${detail ? `<span class="detail"> - ${esc(detail)}</span>` : ''}</span>${a.model ? `<code class="model">${esc(a.model)}</code>` : ''}${a.outsideDefaults ? `<span class="outside-defaults">${esc('outside defaults')}</span>` : ''}${more}<span class="time">${esc(relativeTime(a.since, now))}</span></div>`
}

function cardDetails(c: BoardCard): string {
  const lines = [c.title]
  if (c.branch) lines.push(`Branch ${c.branch}`)
  if (c.mr) lines.push(`Linked ${c.mr}`)
  if (c.parentTitle) lines.push(`From ${c.parentTitle}`)
  if (c.childCount > 0) lines.push(plural(c.childCount, 'child', 'children'))
  return lines.join('\n')
}

function renderCard(c: BoardCard, now: number): string {
  const dot = c.isUnread ? '<i class="unread-dot"></i>' : ''
  const kind = icon(c.kind === 'mr' ? 'git-pull-request' : 'git-branch')
  const home = c.isMain ? icon('house', 'home') : ''
  const note = c.hasNote ? icon('file-text', 'note') : ''
  return `<article class="card" draggable="true" data-id="${esc(c.id)}" data-status="${c.status}" title="${esc(cardDetails(c))}">
<div class="line"><span class="kind">${dot}${kind}</span><span class="repo">${icon('folder')}<span class="repo-name">${esc(c.repo)}</span></span><span class="title${c.isUnread ? ' unread' : ''}">${esc(c.title)}</span>${home}<span class="trail">${note}<span class="status-ring">${icon(COLUMN_ICONS[c.status])}</span></span></div>
${renderAgentRow(c.agents, now)}</article>`
}

/** The pinned strip and the four columns, filtered by `query`. */
export function renderLanes(
  model: BoardModel,
  now: number,
  query = '',
): string {
  const pinned = filterCards(model.pinned, query)
  const strip =
    pinned.length > 0
      ? `<section class="pinned"><header class="pinned-head">${icon('pin')}<span class="col-label">Pinned</span><span class="count">${pinned.length}</span></header>
<div class="pinned-cards">${pinned.map((c) => renderCard(c, now)).join('\n')}</div></section>`
      : ''
  const cols = model.columns
    .map((col) => {
      const cards = filterCards(col.cards, query)
      return `<section class="column" data-status="${esc(col.status)}">
<header class="col-head">${icon(COLUMN_ICONS[col.status], 'col-icon')}<span class="col-label">${esc(col.label)}</span><span class="count">${cards.length}</span></header>
<div class="cards">${cards.map((c) => renderCard(c, now)).join('\n')}</div>
</section>`
    })
    .join('\n')
  return `${strip}<div class="columns">
${cols}
</div>`
}

/** The start form's choices: every agent with its models, and the current pick. */
export interface StartForm {
  agents: AgentModels[]
  agent: string
  model: string
}

const GLOBAL_HUB_BUTTON =
  '<button type="button" class="hub-btn" data-open-hub-global>Open global hub</button>'

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`
}

/** Agent and model selects (models of the chosen agent only) and the Start button. */
function renderChoiceSelects(start: StartForm): string {
  const agents = start.agents.some((a) => a.agent === start.agent)
    ? start.agents
    : [...start.agents, { agent: start.agent, models: [] }]
  const listed = agents.find((a) => a.agent === start.agent)?.models ?? []
  const models = listed.some((m) => m.id === start.model)
    ? listed
    : [{ id: start.model, label: start.model }, ...listed]
  return `<select name="agent" aria-label="Agent">${agents.map((a) => option(a.agent, a.agent, a.agent === start.agent)).join('')}</select><select name="model" aria-label="Model">${models.map((m) => option(m.id, m.label, m.id === start.model)).join('')}</select>`
}

function renderStartForm(start: StartForm): string {
  return `<form class="orch-form" data-orchestrator-form><span class="hub-note">Orchestrator</span>${renderChoiceSelects(start)}<button type="submit" class="hub-btn primary" data-start-orchestrator>Start orchestrator</button></form>`
}

export interface WorkerDefaultsForm {
  defaults: WorkerDefaults
  options: AgentModels[]
}

const KIND_LABELS = {
  implementation: 'Implementation',
  review: 'Review',
  design: 'Design and planning',
  prose: 'Prose',
}

function renderWorkerDefaults(workers: WorkerDefaultsForm): string {
  return `<section class="worker-defaults"><span class="hub-note">Worker defaults</span><div class="worker-default-rows">${WORKER_KINDS.map((kind) => `<form class="worker-default-form" data-worker-kind="${kind}" aria-label="${KIND_LABELS[kind]} Worker defaults"><span class="worker-kind">${KIND_LABELS[kind]}</span>${renderChoiceSelects({ agents: workers.options, ...workers.defaults[kind] })}<button type="submit" class="hub-btn" data-save-worker-defaults>Save</button></form>`).join('')}</div></section>`
}

/** A live Orchestrator: its name, state and model, and a button that jumps to it. */
function renderOrchestrator(o: OrchestratorView): string {
  const state = o.state
    ? `<span class="orch-state" data-agent="${o.state}">${icon(STATE_ICONS[o.state], 'state')}${STATE_LABELS[o.state]}</span>`
    : '<span class="orch-state">Running</span>'
  return `<span class="hub-note">Orchestrator</span><span class="orch-name" title="${esc(o.name)}">${agentMark(o.agent)}${esc(o.name)}</span>${state}<code class="model">${esc(o.model)}</code><button type="button" class="hub-btn primary" data-jump-orchestrator>Jump to orchestrator</button>`
}

/**
 * Global board: a chip per project that opens its hub. Project board: its
 * live Orchestrator, or the form that starts one (in the global hub).
 */
function renderHubs(
  model: BoardModel,
  filter: BoardFilter,
  start?: StartForm,
): string {
  if (filter.scope === 'project') {
    const body = model.orchestrator
      ? renderOrchestrator(model.orchestrator)
      : start
        ? renderStartForm(start)
        : '<span class="hub-note">Orchestrator lives in the global hub</span>'
    return `<div class="hubs orch">${body}<span class="spacer"></span>${GLOBAL_HUB_BUTTON}</div>
`
  }
  if (model.projects.length === 0) return ''
  const chips = model.projects
    .map(
      (p) =>
        `<span class="chip"><span class="chip-name">${esc(p)}</span><button type="button" class="hub-btn" data-open-hub="${esc(p)}" title="Open the ${esc(p)} hub">Open hub</button></span>`,
    )
    .join('')
  return `<div class="hubs"><span class="hub-note">Projects</span>${chips}</div>
`
}

export function renderBoard(
  model: BoardModel,
  filter: BoardFilter,
  now: number = Date.now(),
  query = '',
  start?: StartForm,
  workers?: WorkerDefaultsForm,
): string {
  const scope =
    filter.scope === 'project' ? esc(filter.project) : 'All projects'
  const mainCount = model.mainCheckoutCount ?? model.hiddenMainCount
  const mainsHidden = model.mainCheckoutsHidden ?? model.hiddenMainCount > 0
  const hidden =
    mainCount > 0
      ? `<button type="button" class="hidden-note main-toggle" data-toggle-main-checkouts aria-pressed="${!mainsHidden}" title="${mainsHidden ? 'Show' : 'Hide'} main checkouts">${plural(mainCount, 'main checkout', 'main checkouts')} ${mainsHidden ? 'hidden' : 'shown'}</button>`
      : ''
  return `<div class="board">
${renderHubs(model, filter, start)}${filter.scope === 'project' && workers ? renderWorkerDefaults(workers) : ''}<header class="bar"><span class="board-title">Board</span><span class="scope">${scope}</span><label class="search">${icon('search')}<input type="search" placeholder="Search worktrees" aria-label="Search worktrees" spellcheck="false" autocomplete="off" value="${esc(query)}"></label><span class="spacer"></span>${hidden}</header>
${model.notice ? `<p class="board-notice" role="status">${esc(model.notice)}</p>` : ''}
<div class="lanes">${renderLanes(model, now, query)}</div>
</div>`
}

export function renderError(message: string): string {
  return `<div class="error"><p>${esc(message)}</p><button type="button" data-action="retry">Retry</button></div>`
}
