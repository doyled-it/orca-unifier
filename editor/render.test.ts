import { assert, test } from 'orca/testing'
import type { BoardCard, BoardModel, CardAgent } from '../src/core/board-types'
import type { BoardStatus } from '../src/core/types'
import { filterCards, renderBoard, renderError, renderLanes } from './render'

const LABELS: [BoardStatus, string][] = [
  ['todo', 'Todo'],
  ['in-progress', 'Working'],
  ['in-review', 'Review'],
  ['completed', 'Done'],
]

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'r1::/p/a',
    project: 'proj',
    repo: 'alpha',
    title: 'Fix login',
    branch: 'fix/login',
    status: 'todo',
    kind: 'branch',
    isUnread: false,
    isPinned: false,
    hasNote: false,
    agents: [],
    mr: null,
    parentTitle: null,
    childCount: 0,
    isMain: false,
    ...over,
  }
}

function agent(over: Partial<CardAgent> = {}): CardAgent {
  return {
    state: 'working',
    since: 1_000,
    title: null,
    detail: null,
    agent: null,
    model: null,
    ...over,
  }
}

function model(
  cards: BoardCard[] = [],
  hiddenMainCount = 0,
  pinned: BoardCard[] = [],
): BoardModel {
  return {
    columns: LABELS.map(([status, label]) => ({
      status,
      label,
      cards: cards.filter((c) => c.status === status),
    })),
    pinned,
    projects: ['proj'],
    hiddenMainCount,
  }
}

const GLOBAL = { scope: 'global' } as const

/** The HTML of the first card in the output. */
function firstCard(html: string): string {
  const start = html.indexOf('<article')
  return html.slice(start, html.indexOf('</article>', start))
}

test('column headers carry the label, the status icon and a count pill', () => {
  const html = renderBoard(
    model([card(), card({ id: 'b' }), card({ id: 'c', status: 'completed' })]),
    GLOBAL,
  )
  const icons = {
    todo: 'circle',
    'in-progress': 'circle-half',
    'in-review': 'circle-check',
    completed: 'circle-check-filled',
  }
  for (const [status, label] of LABELS) {
    const at = html.indexOf(`<section class="column" data-status="${status}"`)
    assert.ok(at >= 0, status)
    const head = html.slice(at, html.indexOf('</header>', at))
    assert.ok(head.includes(`>${label}<`), label)
    assert.ok(head.includes(`data-icon="${icons[status]}"`), `${status} icon`)
  }
  assert.ok(html.includes('<span class="count">2</span>'))
  assert.ok(html.includes('<span class="count">1</span>'))
  assert.ok(html.includes('<span class="count">0</span>'))
})

test('the header has the board title and a search box', () => {
  const html = renderBoard(model(), GLOBAL, 0, 'lo"gin')
  assert.ok(html.includes('>Board<'))
  assert.ok(html.includes('placeholder="Search worktrees"'))
  assert.ok(html.includes('value="lo&quot;gin"'))
  assert.ok(html.includes('data-icon="search"'))
})

test('kind icon follows the MR link', () => {
  const withMr = firstCard(
    renderBoard(model([card({ kind: 'mr', mr: '!12' })]), GLOBAL),
  )
  assert.ok(withMr.includes('data-icon="git-pull-request"'))
  assert.ok(!withMr.includes('data-icon="git-branch"'))
  const plain = firstCard(renderBoard(model([card()]), GLOBAL))
  assert.ok(plain.includes('data-icon="git-branch"'))
  assert.ok(!plain.includes('data-icon="git-pull-request"'))
})

test('repo badge has the folder icon and the repo name', () => {
  const html = firstCard(renderBoard(model([card({ repo: 'app' })]), GLOBAL))
  assert.ok(/class="repo"[^>]*>.*data-icon="folder".*app/s.test(html))
})

test('unread renders the dot and the bold title', () => {
  const unread = firstCard(
    renderBoard(model([card({ isUnread: true })]), GLOBAL),
  )
  assert.ok(unread.includes('class="unread-dot"'))
  assert.ok(unread.includes('class="title unread"'))
  const read = firstCard(renderBoard(model([card()]), GLOBAL))
  assert.ok(!read.includes('unread'))
})

test('main checkout renders the home icon', () => {
  assert.ok(
    firstCard(renderBoard(model([card({ isMain: true })]), GLOBAL)).includes(
      'data-icon="house"',
    ),
  )
  assert.ok(
    !firstCard(renderBoard(model([card()]), GLOBAL)).includes(
      'data-icon="house"',
    ),
  )
})

test('a note renders the file icon', () => {
  assert.ok(
    firstCard(renderBoard(model([card({ hasNote: true })]), GLOBAL)).includes(
      'data-icon="file-text"',
    ),
  )
  assert.ok(
    !firstCard(renderBoard(model([card()]), GLOBAL)).includes(
      'data-icon="file-text"',
    ),
  )
})

test('every card shows its status ring in the column color', () => {
  const html = firstCard(
    renderBoard(model([card({ status: 'in-review' })]), GLOBAL),
  )
  assert.ok(html.includes('class="status-ring"'))
  assert.ok(html.includes('data-icon="circle-check"'))
})

test('agent row shows activity title, detail, model and relative time', () => {
  const html = firstCard(
    renderBoard(
      model([
        card({
          agents: [
            agent({
              title: 'Fix login - reading files',
              model: 'claude-opus-4-8',
              agent: 'claude',
            }),
          ],
        }),
      ]),
      GLOBAL,
      61_000,
    ),
  )
  assert.ok(html.includes('class="agent-row"'))
  assert.ok(html.includes('data-agent="working"'))
  assert.ok(html.includes('<b class="act">Fix login</b>'))
  assert.ok(html.includes('<span class="detail"> - reading files</span>'))
  assert.ok(html.includes('<code class="model">claude-opus-4-8</code>'))
  assert.ok(html.includes('<span class="time">1m</span>'))
  assert.ok(html.includes('data-icon="loader-circle"'))
  assert.ok(html.includes('data-icon="mark-claude"'))
})

test('agent titles drop spinner glyphs and split on a bar', () => {
  const html = firstCard(
    renderBoard(
      model([
        card({
          agents: [agent({ title: '\u2810 Coordinate the work | 20-buffer' })],
        }),
      ]),
      GLOBAL,
    ),
  )
  assert.ok(html.includes('<b class="act">Coordinate the work</b>'))
  assert.ok(html.includes('<span class="detail"> - 20-buffer</span>'))
  assert.ok(!html.includes('\u2810'))
  const star = firstCard(
    renderBoard(
      model([card({ agents: [agent({ title: '\u2733 Plan' })] })]),
      GLOBAL,
    ),
  )
  assert.ok(star.includes('<b class="act">Plan</b>'))
})

test('tool detail follows the activity title, muted', () => {
  const one = firstCard(
    renderBoard(
      model([
        card({
          agents: [
            agent({
              title: 'Ask coordinator for task',
              detail: 'Bash: rg <x>',
            }),
          ],
        }),
      ]),
      GLOBAL,
    ),
  )
  assert.ok(one.includes('<b class="act">Ask coordinator for task</b>'))
  assert.ok(one.includes('<span class="detail"> - Bash: rg &lt;x&gt;</span>'))
  const both = firstCard(
    renderBoard(
      model([
        card({
          agents: [agent({ title: 'Fix - reading', detail: 'Edit: f.ts' })],
        }),
      ]),
      GLOBAL,
    ),
  )
  assert.ok(
    both.includes('<span class="detail"> - reading - Edit: f.ts</span>'),
  )
  const bare = firstCard(
    renderBoard(model([card({ agents: [agent({ detail: 'Read' })] })]), GLOBAL),
  )
  assert.ok(bare.includes('<b class="act">Working</b>'))
  assert.ok(bare.includes('<span class="detail"> - Read</span>'))
})

test('agent row without a model or title still renders the state', () => {
  const html = firstCard(
    renderBoard(
      model([card({ agents: [agent({ state: 'done' })] })]),
      GLOBAL,
      1_000,
    ),
  )
  assert.ok(html.includes('data-agent="done"'))
  assert.ok(!html.includes('<code'))
  assert.ok(html.includes('data-icon="bot"'))
  assert.ok(html.includes('data-icon="circle-check"'))
  assert.ok(html.includes('<span class="time">now</span>'))
})

test('agent marks by agent kind', () => {
  const kinds: [string, string][] = [
    ['codex', 'mark-codex'],
    ['claude', 'mark-claude'],
    ['other', 'bot'],
  ]
  for (const [kind, icon] of kinds) {
    const html = firstCard(
      renderBoard(model([card({ agents: [agent({ agent: kind })] })]), GLOBAL),
    )
    assert.ok(html.includes(`data-icon="${icon}"`), kind)
  }
})

test('blocked and waiting agents show the alert icon', () => {
  for (const state of ['blocked', 'waiting'] as const) {
    const html = firstCard(
      renderBoard(model([card({ agents: [agent({ state })] })]), GLOBAL),
    )
    assert.ok(html.includes('data-icon="circle-alert"'), state)
  }
})

test('two agents render the most urgent one plus a counter', () => {
  const html = firstCard(
    renderBoard(
      model([
        card({
          agents: [
            agent({ state: 'blocked', title: 'Needs you' }),
            agent({ state: 'working', title: 'Background' }),
          ],
        }),
      ]),
      GLOBAL,
    ),
  )
  assert.ok(html.includes('Needs you'))
  assert.ok(!html.includes('Background'))
  assert.ok(html.includes('<span class="more">+1</span>'))
})

test('no agent row when the worktree has no agents', () => {
  const html = firstCard(renderBoard(model([card()]), GLOBAL))
  assert.ok(!html.includes('agent-row'))
})

test('filterCards matches title, repo, branch and agent title, ignoring case', () => {
  const base = { title: 'untitled', repo: 'x', branch: null }
  const cards = [
    card({ ...base, id: 't', title: 'Fix LOGIN' }),
    card({ ...base, id: 'r', repo: 'App' }),
    card({ ...base, id: 'b', branch: 'feat/Search-box' }),
    card({ ...base, id: 'a', agents: [agent({ title: 'Reading Files' })] }),
    card({ ...base, id: 'n' }),
  ]
  const ids = (q: string) => filterCards(cards, q).map((c) => c.id)
  assert.deepEqual(ids('login'), ['t'])
  assert.deepEqual(ids('APP'), ['r'])
  assert.deepEqual(ids('search-box'), ['b'])
  assert.deepEqual(ids('reading'), ['a'])
  assert.deepEqual(ids('  '), ['t', 'r', 'b', 'a', 'n'])
  assert.deepEqual(ids('zzz'), [])
})

test('renderLanes applies the search query to columns and counts', () => {
  const html = renderLanes(
    model([
      card({ id: 'one', title: 'Alpha' }),
      card({ id: 'two', title: 'Beta' }),
    ]),
    0,
    'beta',
  )
  assert.ok(html.includes('data-id="two"'))
  assert.ok(!html.includes('data-id="one"'))
  assert.ok(html.includes('<span class="count">1</span>'))
})

test('every text value is escaped', () => {
  const html = renderBoard(
    model([
      card({
        id: 'x::"1"',
        title: '<img src=x onerror=alert(1)>',
        repo: 'a&b',
        branch: '<b>',
        mr: '<i>',
        parentTitle: '<u>',
        agents: [agent({ title: `say "hi" and 'bye'`, model: '<m>' })],
      }),
    ]),
    GLOBAL,
  )
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(html.includes('a&amp;b'))
  assert.ok(html.includes('say &quot;hi&quot; and &#39;bye&#39;'))
  assert.ok(html.includes('&lt;m&gt;'))
  assert.ok(html.includes('data-id="x::&quot;1&quot;"'))
  assert.ok(!/<(b|i|u|m)>/.test(html))
})

test('cards are draggable and carry their status', () => {
  const html = firstCard(
    renderBoard(model([card({ status: 'in-review' })]), GLOBAL),
  )
  assert.ok(html.includes('draggable="true"'))
  assert.ok(html.includes('data-status="in-review"'))
})

test('pinned strip renders only when it has cards', () => {
  const none = renderBoard(model([card()]), GLOBAL)
  assert.ok(!none.includes('class="pinned"'))
  const html = renderBoard(
    model([], 0, [card({ id: 'p', title: 'Pinned one', isPinned: true })]),
    GLOBAL,
  )
  assert.ok(html.includes('class="pinned"'))
  assert.ok(html.includes('data-icon="pin"'))
  assert.ok(html.includes('Pinned one'))
  const hiddenBySearch = renderLanes(
    model([], 0, [card({ id: 'p', title: 'Pinned one', isPinned: true })]),
    0,
    'zzz',
  )
  assert.ok(!hiddenBySearch.includes('class="pinned"'))
})

test('hidden main checkouts are counted with the right plural', () => {
  assert.ok(
    renderBoard(model([], 1), GLOBAL).includes('1 main checkout hidden'),
  )
  assert.ok(
    renderBoard(model([], 3), GLOBAL).includes('3 main checkouts hidden'),
  )
  assert.ok(!renderBoard(model([], 0), GLOBAL).includes('checkout'))
})

test('card details list MR, parent and children with the right plural', () => {
  const one = firstCard(
    renderBoard(
      model([card({ mr: '!12', parentTitle: 'Parent job', childCount: 1 })]),
      GLOBAL,
    ),
  )
  assert.ok(one.includes('!12'))
  assert.ok(one.includes('Parent job'))
  assert.ok(one.includes('1 child'))
  assert.ok(!one.includes('1 children'))
  const two = firstCard(renderBoard(model([card({ childCount: 2 })]), GLOBAL))
  assert.ok(two.includes('2 children'))
})

test('renderError shows the message and a Retry button', () => {
  const html = renderError('Could not <read> boards')
  assert.ok(html.includes('Could not &lt;read&gt; boards'))
  assert.ok(html.includes('Retry'))
  assert.ok(html.includes('<button'))
})

test('partial board notice is escaped and leaves available cards visible', () => {
  const notice =
    'Some worktrees could not be listed; the board may be incomplete.'
  const partial = { ...model([card()]), notice }
  for (const filter of [
    GLOBAL,
    { scope: 'project', project: 'proj' },
  ] as const) {
    const html = renderBoard(partial, filter)
    assert.ok(html.includes(notice))
    assert.ok(html.includes('Fix login'))
    assert.ok(!html.includes('data-action="retry"'))
  }
  const escaped = renderBoard(
    { ...partial, notice: '<img src="x"> & missing' },
    GLOBAL,
  )
  assert.ok(escaped.includes('&lt;img src=&quot;x&quot;&gt; &amp; missing'))
  assert.ok(!escaped.includes('<img'))
  assert.ok(!renderBoard(model(), GLOBAL).includes(notice))
})

test('rendered text never uses banned words or emoji', () => {
  const html = renderBoard(
    model(
      [
        card({
          agents: [agent({ title: 'Working on it' }), agent()],
          mr: '!1',
          kind: 'mr',
          parentTitle: 'p',
          childCount: 1,
          isUnread: true,
          hasNote: true,
          isMain: true,
        }),
      ],
      2,
      [card({ id: 'pin', isPinned: true })],
    ),
    { scope: 'project', project: 'proj' },
    5_000,
  )
  const text = `${html.replace(/<[^>]*>/g, ' ')} ${renderError('x')}`
  assert.ok(!/\b(Run|Dispatch|Task|gate|pane)\b/i.test(text))
  assert.ok(!/\p{Extended_Pictographic}/u.test(html))
  assert.ok(!html.includes('\u2014'))
})

test('the global board lists each project with an Open hub button', () => {
  const m = { ...model(), projects: ['alpha', 'be"ta'] }
  const html = renderBoard(m, GLOBAL)
  assert.ok(html.includes('data-open-hub="alpha"'))
  assert.ok(html.includes('data-open-hub="be&quot;ta"'))
  assert.ok(html.includes('Open hub'))
})

test('the project board points to the global hub for the Orchestrator', () => {
  const html = renderBoard(model(), { scope: 'project', project: 'proj' })
  assert.ok(html.includes('Orchestrator lives in the global hub'))
  assert.ok(html.includes('data-open-hub-global'))
  assert.ok(!html.includes('data-open-hub="'))
})

const PROJECT = { scope: 'project', project: 'proj' } as const
const START = {
  agents: [
    {
      agent: 'claude',
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      ],
    },
    { agent: 'codex', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] },
  ],
  agent: 'claude',
  model: 'claude-opus-5-5',
}

test('a project board without an Orchestrator shows the start form with defaults selected', () => {
  const html = renderBoard(model(), PROJECT, 0, '', START)
  assert.ok(html.includes('data-start-orchestrator'))
  assert.match(html, /<select[^>]*name="agent"/)
  assert.match(html, /<select[^>]*name="model"/)
  assert.match(html, /<option value="claude" selected>/)
  assert.match(
    html,
    /<option value="claude-opus-5-5" selected>Claude Opus 5\.5<\/option>/,
  )
  // The model select lists only the selected agent's models.
  assert.ok(html.includes('claude-haiku-5-5'))
  assert.ok(!html.includes('value="gpt-6.1-sol"'))
  assert.ok(html.includes('<option value="codex">'))
  assert.ok(html.includes('Start orchestrator'))
  assert.ok(!html.includes('data-jump-orchestrator'))
})

test('the start form keeps a chosen model the catalog does not list', () => {
  const html = renderBoard(model(), PROJECT, 0, '', {
    ...START,
    agent: 'codex',
    model: 'gpt-7',
  })
  assert.match(html, /<option value="codex" selected>/)
  assert.match(html, /<option value="gpt-7" selected>/)
  assert.ok(html.includes('value="gpt-6.1-sol"'))
  assert.ok(!html.includes('claude-haiku-5-5'))
})

test('a live Orchestrator replaces the form with its name, state and a jump button', () => {
  const m = {
    ...model(),
    orchestrator: {
      terminalId: 'term_1',
      name: 'Plan <the> work',
      agent: 'claude',
      model: 'claude-opus-5-5',
      state: 'waiting' as const,
    },
  }
  const html = renderBoard(m, PROJECT, 0, '', START)
  assert.ok(!html.includes('data-start-orchestrator'))
  assert.ok(!html.includes('<select'))
  assert.ok(html.includes('Plan &lt;the&gt; work'))
  assert.ok(html.includes('Waiting'))
  assert.ok(html.includes('claude-opus-5-5'))
  assert.ok(html.includes('data-jump-orchestrator'))
  assert.ok(html.includes('Jump to orchestrator'))
})

test('a live Orchestrator with an unknown state still renders', () => {
  const m = {
    ...model(),
    orchestrator: {
      terminalId: 'term_1',
      name: 'Claude Code',
      agent: 'claude',
      model: 'claude-opus-5-5',
      state: null,
    },
  }
  const html = renderBoard(m, PROJECT, 0, '', START)
  assert.ok(html.includes('Running'))
  assert.ok(html.includes('data-jump-orchestrator'))
})

test('the global board never shows the start form', () => {
  const html = renderBoard(model(), GLOBAL, 0, '', START)
  assert.ok(!html.includes('data-start-orchestrator'))
  assert.ok(!html.includes('<select'))
})

test('agent rows render outside defaults only for a flagged tracked Worker', () => {
  const outside = firstCard(
    renderBoard(
      model([
        card({ agents: [agent({ model: '<actual>', outsideDefaults: true })] }),
      ]),
      GLOBAL,
    ),
  )
  assert.ok(outside.includes('class="outside-defaults"'))
  assert.ok(outside.includes('>outside defaults</span>'))
  assert.ok(outside.includes('&lt;actual&gt;'))
  for (const over of [{}, { outsideDefaults: false }]) {
    const html = renderBoard(model([card({ agents: [agent(over)] })]), GLOBAL)
    assert.ok(!html.includes('outside defaults'))
  }
})

const WORKERS = {
  defaults: {
    implementation: { agent: 'codex', model: 'gpt-6.1-sol' },
    review: { agent: 'codex', model: 'gpt-6.1-sol' },
    design: { agent: 'claude', model: 'claude-opus-5-5' },
    prose: { agent: 'other"', model: '<prose>' },
  },
  options: [
    ...START.agents,
    { agent: 'other"', models: [{ id: '<prose>', label: '<Words & more>' }] },
  ],
}

test('project header edits every Worker kind with filtered selected and escaped options', () => {
  const html = renderBoard(model(), PROJECT, 0, '', START, WORKERS)
  assert.ok(html.includes('Worker defaults'))
  for (const kind of ['implementation', 'review', 'design', 'prose']) {
    assert.ok(html.includes(`data-worker-kind="${kind}"`))
  }
  const review =
    html.match(
      /<form[^>]*data-worker-kind="review"[^>]*>(.*?)<\/form>/s,
    )?.[1] ?? ''
  assert.match(review, /<option value="codex" selected>/)
  assert.match(review, /<option value="gpt-6.1-sol" selected>/)
  assert.ok(!review.includes('value="claude-haiku-5-5"'))
  assert.ok(html.includes('value="other&quot;" selected'))
  assert.ok(
    html.includes('value="&lt;prose&gt;" selected>&lt;Words &amp; more&gt;'),
  )
  assert.ok(!html.includes('<Words'))
  assert.ok(
    !renderBoard(model(), GLOBAL, 0, '', START, WORKERS).includes(
      'Worker defaults',
    ),
  )
  const live = {
    ...model(),
    orchestrator: {
      terminalId: 't',
      name: 'Coordinator',
      agent: 'claude',
      model: 'x',
      state: null,
    },
  }
  assert.ok(
    renderBoard(live, PROJECT, 0, '', START, WORKERS).includes(
      'Worker defaults',
    ),
  )
})

test('refreshing Worker defaults replaces untouched rows and options, preserving drafts', async () => {
  const state = await import('./form-state')
  const fresh = {
    defaults: {
      implementation: { agent: 'codex', model: 'new' },
      review: { agent: 'codex', model: 'new' },
      design: { agent: 'claude', model: 'new' },
      prose: { agent: 'claude', model: 'new' },
    },
    options: [{ agent: 'codex', models: [{ id: 'new', label: 'New' }] }],
  }
  const drafts = { review: { agent: 'codex', model: 'unsaved' } }
  assert.deepEqual(state.mergeWorkerDefaults(fresh, drafts), {
    ...fresh,
    defaults: { ...fresh.defaults, review: drafts.review },
  })
  assert.equal(state.workerSaveChoice('implementation', drafts), null)
  assert.deepEqual(state.workerSaveChoice('review', drafts), drafts.review)
})

test('E1: hidden main checkouts are a toggle that remains available when shown', () => {
  const hidden = renderBoard(model([], 2), GLOBAL)
  assert.match(hidden, /<button[^>]*data-toggle-main-checkouts/)
  assert.match(hidden, /aria-pressed="false"/)
  const shown = renderBoard(
    { ...model([], 0), mainCheckoutCount: 2, mainCheckoutsHidden: false },
    GLOBAL,
  )
  assert.match(shown, /data-toggle-main-checkouts/)
  assert.ok(shown.includes('2 main checkouts shown'))
  assert.match(shown, /aria-pressed="true"/)
})
