import type { BoardFilter } from '../src/core/board-filter'
import { parseBoardFile } from '../src/core/board-filter'
import type { BoardModel } from '../src/core/board-types'
import type { BoardStatus } from '../src/core/types'
import { isWorkerKind, type WorkerKind } from '../src/core/worker-defaults'
import {
  mergeWorkerDefaults,
  type WorkerDrafts,
  workerSaveChoice,
} from './form-state'
import {
  renderBoard,
  renderError,
  renderLanes,
  type StartForm,
  type WorkerDefaultsForm,
} from './render'

document.body.textContent = 'Loading board'
const style = document.createElement('link')
style.rel = 'stylesheet'
style.href = new URL('./board.css', import.meta.url).href
document.head.append(style)

const session = await orca.document?.session<string>()
let filter: BoardFilter = parseBoardFile(session?.value ?? '')
session?.onReplace((text) => {
  filter = parseBoardFile(text)
  // Each project has its own remembered choice.
  startForm = undefined
  workerDrafts = {}
  savedWorkers = undefined
  startEdited = false
  workerForm = undefined
  void refresh()
  void loadStartOptions()
  void loadWorkerDefaults()
})

let model: BoardModel | null = null
let query = ''
/** The start form choices for the current Project. */
let startForm: StartForm | undefined
let defaults: { agent: string; model: string } | null = null
let starting = false
let workerForm: WorkerDefaultsForm | undefined
let workerDrafts: WorkerDrafts = {}
let savedWorkers: WorkerDefaultsForm | undefined
let workersSeq = 0
let startSeq = 0
let startEdited = false
let savingDefaults = false

/** Bumped by every render, so a slower earlier fetch never paints over it. */
let paintSeq = 0
let inFlight = false
let again = false

function searchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('.search input')
}

function paintBoard(m: BoardModel): void {
  const input = searchInput()
  const focused = input !== null && document.activeElement === input
  const start = input?.selectionStart ?? null
  const end = input?.selectionEnd ?? null
  document.body.innerHTML = renderBoard(
    m,
    filter,
    Date.now(),
    query,
    startForm,
    workerForm,
  )
  if (starting) {
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      '[data-start-orchestrator]',
    )) {
      b.disabled = true
    }
  }
  if (savingDefaults) {
    for (const el of document.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement
    >('[data-worker-kind] button, [data-worker-kind] select'))
      el.disabled = true
  }
  if (!focused) return
  const next = searchInput()
  next?.focus()
  next?.setSelectionRange(start, end)
}

function paintError(message: string): void {
  paintSeq++
  model = null
  document.body.innerHTML = renderError(message)
}

/** Fetches and paints the board; overlapping calls collapse into one more fetch. */
async function refresh(): Promise<void> {
  if (inFlight) {
    again = true
    return
  }
  inFlight = true
  try {
    do {
      again = false
      const seq = ++paintSeq
      let paint: () => void
      try {
        const res = await orca.plugin.request('board.get', { filter })
        if ('error' in res) {
          const message = res.error
          paint = () => paintError(message)
        } else {
          const m = res.model
          paint = () => {
            model = m
            paintBoard(m)
          }
        }
      } catch {
        paint = () => paintError('Could not load the board.')
      }
      if (seq === paintSeq && !again) paint()
    } while (again)
  } finally {
    inFlight = false
  }
}

/** Loads the agents and models the start form offers, with the defaults picked. */
async function loadStartOptions(): Promise<void> {
  if (filter.scope !== 'project') return
  const seq = ++startSeq
  const project = filter.project
  try {
    const res = await orca.plugin.request('orchestrator.options', { project })
    if (filter.scope !== 'project' || filter.project !== project) return
    if (seq !== startSeq) return
    defaults = res.defaults
    startForm = {
      agents: res.agents,
      ...(startEdited && startForm
        ? { agent: startForm.agent, model: startForm.model }
        : res.defaults),
    }
    if (model) paintBoard(model)
  } catch {
    // The board still shows; the form appears once options load.
  }
}

async function loadWorkerDefaults(): Promise<void> {
  if (filter.scope !== 'project') return
  const seq = ++workersSeq
  const project = filter.project
  try {
    const res = await orca.plugin.request('workerDefaults.get', { project })
    if (filter.scope !== 'project' || filter.project !== project) return
    if (seq !== workersSeq) return
    savedWorkers = res
    workerForm = mergeWorkerDefaults(res, workerDrafts)
    if (model) paintBoard(model)
  } catch {
    /* Keep the board available if choices could not be loaded. */
  }
}

async function saveWorkerDefaults(kind: WorkerKind): Promise<void> {
  if (filter.scope !== 'project' || !workerForm || savingDefaults) return
  const project = filter.project
  const choice = workerSaveChoice(kind, workerDrafts)
  if (!choice) return
  savingDefaults = true
  if (model) paintBoard(model)
  try {
    const res = await orca.plugin.request('workerDefaults.set', {
      project,
      kind,
      ...choice,
    })
    if (filter.scope !== 'project' || filter.project !== project) return
    if ('error' in res) paintError(res.error)
    else {
      delete workerDrafts[kind]
      await Promise.all([loadWorkerDefaults(), loadStartOptions()])
      await refresh()
    }
  } catch {
    if (filter.scope === 'project' && filter.project === project)
      paintError('Worker defaults could not be saved.')
  } finally {
    savingDefaults = false
    if (model) paintBoard(model)
  }
}

/** The default model for the default agent, else the agent's first listed model. */
function modelFor(agent: string): string {
  if (!startForm) return ''
  if (defaults && agent === defaults.agent) return defaults.model
  const models = startForm.agents.find((a) => a.agent === agent)?.models ?? []
  return models[0]?.id ?? ''
}

async function startOrchestrator(): Promise<void> {
  if (filter.scope !== 'project' || !startForm || starting) return
  starting = true
  if (model) paintBoard(model)
  try {
    const res = await orca.plugin.request('orchestrator.start', {
      project: filter.project,
      agent: startForm.agent,
      model: startForm.model,
    })
    starting = false
    if ('error' in res) paintError(res.error)
    else await refresh()
  } catch {
    starting = false
    paintError('That did not work.')
  }
}

async function jumpToOrchestrator(): Promise<void> {
  if (filter.scope !== 'project') return
  try {
    const res = await orca.plugin.request('orchestrator.jump', {
      project: filter.project,
    })
    if ('error' in res) paintError(res.error)
  } catch {
    paintError('That did not work.')
  }
}

async function setStatus(worktreeId: string, status: BoardStatus) {
  try {
    const res = await orca.plugin.request('board.setStatus', {
      worktreeId,
      status,
    })
    if ('error' in res) paintError(res.error)
    else await refresh()
  } catch {
    paintError('That did not work.')
  }
}

async function openWorktree(worktreeId: string) {
  try {
    const res = await orca.plugin.request('board.openWorktree', { worktreeId })
    if ('error' in res) paintError(res.error)
  } catch {
    paintError('That did not work.')
  }
}

async function openHub(target: BoardFilter) {
  try {
    const res = await orca.plugin.request('hub.open', target)
    if ('error' in res) paintError(res.error)
  } catch {
    paintError('That did not work.')
  }
}

function elementOf(t: EventTarget | null): Element | null {
  return t instanceof Element ? t : null
}

document.addEventListener('click', (e) => {
  const t = elementOf(e.target)
  if (!t) return
  if (t.closest('[data-action="retry"]')) {
    void refresh()
    return
  }
  if (t.closest('[data-toggle-main-checkouts]') && model) {
    void (async () => {
      try {
        const res = await orca.plugin.request('board.setMainCheckouts', {
          filter,
          hidden: !(model?.mainCheckoutsHidden ?? true),
        })
        if ('error' in res) paintError(res.error)
        else await refresh()
      } catch {
        paintError('The main checkout visibility could not be saved.')
      }
    })()
    return
  }
  const hub = t.closest<HTMLElement>('[data-open-hub]')
  if (hub?.dataset.openHub) {
    void openHub({ scope: 'project', project: hub.dataset.openHub })
    return
  }
  if (t.closest('[data-open-hub-global]')) {
    void openHub({ scope: 'global' })
    return
  }
  if (t.closest('[data-jump-orchestrator]')) {
    void jumpToOrchestrator()
    return
  }
  const card = t.closest<HTMLElement>('.card')
  if (card?.dataset.id) void openWorktree(card.dataset.id)
})

document.addEventListener('submit', (e) => {
  const worker = elementOf(e.target)?.closest<HTMLElement>('[data-worker-kind]')
  if (worker && isWorkerKind(worker.dataset.workerKind)) {
    e.preventDefault()
    void saveWorkerDefaults(worker.dataset.workerKind)
    return
  }
  const form = elementOf(e.target)?.closest('[data-orchestrator-form]')
  if (!form) return
  e.preventDefault()
  void startOrchestrator()
})

document.addEventListener('change', (e) => {
  const t = elementOf(e.target)
  if (!(t instanceof HTMLSelectElement)) return
  const kind = t.closest<HTMLElement>('[data-worker-kind]')?.dataset.workerKind
  if (workerForm && isWorkerKind(kind)) {
    const current = workerForm.defaults[kind]
    const choice =
      t.name === 'agent'
        ? {
            agent: t.value,
            model:
              workerForm.options.find((a) => a.agent === t.value)?.models[0]
                ?.id ?? '',
          }
        : { ...current, model: t.value }
    const saved = savedWorkers?.defaults[kind]
    if (saved && saved.agent === choice.agent && saved.model === choice.model)
      delete workerDrafts[kind]
    else workerDrafts[kind] = choice
    workerForm = mergeWorkerDefaults(savedWorkers ?? workerForm, workerDrafts)
    if (model) paintBoard(model)
    return
  }
  if (!startForm) return
  if (!t.closest('[data-orchestrator-form]')) return
  startEdited = true
  if (t.name === 'agent') {
    startForm = { ...startForm, agent: t.value, model: modelFor(t.value) }
    if (model) paintBoard(model)
  } else if (t.name === 'model') {
    startForm = { ...startForm, model: t.value }
  }
})

document.addEventListener('input', (e) => {
  const t = elementOf(e.target)
  if (!(t instanceof HTMLInputElement) || !t.closest('.search')) return
  query = t.value
  const lanes = document.querySelector('.lanes')
  if (model && lanes) lanes.innerHTML = renderLanes(model, Date.now(), query)
})

document.addEventListener('keydown', (e) => {
  const t = elementOf(e.target)
  if (e.key !== 'Escape' || !(t instanceof HTMLInputElement)) return
  if (!t.closest('.search') || t.value === '') return
  t.value = ''
  t.dispatchEvent(new Event('input', { bubbles: true }))
})

let drag: { id: string; from: string } | null = null

function clearDrop(): void {
  for (const el of document.querySelectorAll('.column.drop')) {
    el.classList.remove('drop')
  }
}

function dropColumn(e: DragEvent): HTMLElement | null {
  const col = elementOf(e.target)?.closest<HTMLElement>('.column')
  if (!col || !drag || col.dataset.status === drag.from) return null
  return col
}

document.addEventListener('dragstart', (e) => {
  const card = elementOf(e.target)?.closest<HTMLElement>('.card')
  const id = card?.dataset.id
  if (!card || !id) return
  drag = { id, from: card.dataset.status ?? '' }
  card.classList.add('dragging')
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
})

document.addEventListener('dragover', (e) => {
  const col = dropColumn(e)
  if (!col) return
  e.preventDefault()
  if (!col.classList.contains('drop')) {
    clearDrop()
    col.classList.add('drop')
  }
})

document.addEventListener('dragleave', (e) => {
  const col = elementOf(e.target)?.closest('.column')
  const into = elementOf(e.relatedTarget)
  if (col && !(into && col.contains(into))) col.classList.remove('drop')
})

document.addEventListener('dragend', () => {
  drag = null
  clearDrop()
  for (const el of document.querySelectorAll('.dragging')) {
    el.classList.remove('dragging')
  }
})

document.addEventListener('drop', (e) => {
  const col = dropColumn(e)
  const id = drag?.id
  drag = null
  clearDrop()
  if (!col || !id) return
  e.preventDefault()
  void setStatus(id, col.dataset.status as BoardStatus)
})

orca.plugin.on('board.changed', () => {
  void loadWorkerDefaults()
  void loadStartOptions()
  void refresh()
})

await refresh()
await loadStartOptions()

await loadWorkerDefaults()
