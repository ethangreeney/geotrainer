import type { AnswerRecord, AppState, Clue } from '../types'
import { reviewCard } from './scheduling'

export const STORAGE_KEY = 'geotrainer.state.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function emptyState(): AppState {
  return { version: 1, cards: {}, log: [], matrix: {} }
}

export function pairKey(correct: string, chosen: string): string {
  return `${correct}>${chosen}`
}

/** Rebuilds the confusion matrix from the answer log. */
export function computeMatrix(log: AnswerRecord[]): Record<string, number> {
  const matrix: Record<string, number> = {}
  for (const entry of log) {
    if (entry.chosen === entry.correct) continue
    const key = pairKey(entry.correct, entry.chosen)
    matrix[key] = (matrix[key] ?? 0) + 1
  }
  return matrix
}

/**
 * Applies one answer: appends to the log, updates the confusion matrix (wrong answers only)
 * and reschedules the clue's FSRS card. Pure — returns a new state.
 */
export function recordAnswer(
  state: AppState,
  answer: { clue: Clue; chosen: string; responseMs: number; now?: Date },
): AppState {
  const now = answer.now ?? new Date()
  const correct = answer.chosen === answer.clue.country

  const entry: AnswerRecord = {
    clueId: answer.clue.id,
    chosen: answer.chosen,
    correct: answer.clue.country,
    timestamp: now.getTime(),
    responseMs: answer.responseMs,
  }

  const matrix = { ...state.matrix }
  if (!correct) {
    const key = pairKey(answer.clue.country, answer.chosen)
    matrix[key] = (matrix[key] ?? 0) + 1
  }

  return {
    version: 1,
    cards: {
      ...state.cards,
      [answer.clue.id]: reviewCard(state.cards[answer.clue.id], correct, answer.responseMs, now),
    },
    log: [...state.log, entry],
    matrix,
  }
}

function defaultStorage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function saveState(state: AppState, storage: StorageLike | null = defaultStorage()): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function loadState(storage: StorageLike | null = defaultStorage()): AppState {
  const raw = storage?.getItem(STORAGE_KEY)
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as AppState
    if (parsed.version !== 1) return emptyState()
    return {
      version: 1,
      cards: parsed.cards ?? {},
      log: parsed.log ?? [],
      matrix: parsed.matrix ?? computeMatrix(parsed.log ?? []),
    }
  } catch {
    return emptyState()
  }
}

export interface ConfusionPair {
  correct: string
  chosen: string
  count: number
}

export function confusionPairs(state: AppState): ConfusionPair[] {
  return Object.entries(state.matrix)
    .map(([key, count]) => {
      const [correct, chosen] = key.split('>')
      return { correct, chosen, count }
    })
    .sort((a, b) => b.count - a.count)
}

export interface CategoryStat {
  category: string
  seen: number
  right: number
  accuracy: number
}

export function categoryAccuracy(state: AppState, clues: Clue[]): CategoryStat[] {
  const byId = new Map(clues.map((c) => [c.id, c]))
  const totals = new Map<string, { seen: number; right: number }>()

  for (const entry of state.log) {
    const clue = byId.get(entry.clueId)
    if (!clue) continue
    const stat = totals.get(clue.category) ?? { seen: 0, right: 0 }
    stat.seen += 1
    if (entry.chosen === entry.correct) stat.right += 1
    totals.set(clue.category, stat)
  }

  return [...totals.entries()]
    .map(([category, s]) => ({
      category,
      seen: s.seen,
      right: s.right,
      accuracy: s.seen === 0 ? 0 : s.right / s.seen,
    }))
    .sort((a, b) => a.accuracy - b.accuracy)
}
