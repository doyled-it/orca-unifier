/**
 * Inline SVG icons for the board. Every icon draws with `currentColor`.
 *
 * Icons marked "Lucide" are path data from Lucide (https://lucide.dev),
 * ISC license, see LICENSE-lucide.txt. The status shapes `circle-half` and
 * `circle-check-filled` and the two agent marks are drawn for this plugin.
 */

const LUCIDE = {
  // Lucide: circle
  circle: '<circle cx="12" cy="12" r="10"/>',
  // Lucide: circle-check
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  // Lucide: circle-alert
  'circle-alert':
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  // Lucide: loader-circle
  'loader-circle': '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  // Lucide: git-branch
  'git-branch':
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  // Lucide: git-pull-request
  'git-pull-request':
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
  // Lucide: folder
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  // Lucide: house
  house:
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // Lucide: file-text
  'file-text':
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  // Lucide: bot
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  // Lucide: search
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  // Lucide: pin
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
} as const

const OWN = {
  /** Ring with its right half filled: work under way. */
  'circle-half':
    '<circle cx="12" cy="12" r="10"/><path d="M12 6a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/>',
  /** Solid disc with the check knocked out. */
  'circle-check-filled':
    '<circle cx="12" cy="12" r="10" fill="currentColor"/><path class="knockout" d="m8.5 12 2.5 2.5 4.5-5"/>',
  /** Claude: an eight-ray spark. */
  'mark-claude':
    '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke-width="2.6"/>',
  /** Codex: a ring around a three-blade swirl. */
  'mark-codex':
    '<circle cx="12" cy="12" r="9.5"/><path d="M12 12c0-3 1.5-5.5 4.5-6.5M12 12c2.6 1.5 4 4 3.4 7.1M12 12c-2.6 1.5-5.5 1.6-7.9-.5"/>',
} as const

export type IconName = keyof typeof LUCIDE | keyof typeof OWN

const BODIES: Record<IconName, string> = { ...LUCIDE, ...OWN }

/** An inline SVG for `name`, sized by CSS through `class="icon ..."`. */
export function icon(name: IconName, cls = ''): string {
  const c = cls ? `icon ${cls}` : 'icon'
  return `<svg class="${c}" data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BODIES[name]}</svg>`
}
