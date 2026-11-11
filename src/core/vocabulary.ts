import type { BoardStatus } from './types'

export const STATUS_LABELS: Record<BoardStatus, string> = {
  todo: 'Todo',
  'in-progress': 'Working',
  'in-review': 'Review',
  completed: 'Done',
}
