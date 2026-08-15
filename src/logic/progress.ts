import { TRACKS, trackOf } from '../data/tracks'
import type { Clue, StoredCard } from '../types'

/** ts-fsrs State.Review — the card has graduated out of the learning steps. */
const REVIEW = 2

/**
 * A clue counts as learned once its card has graduated to FSRS review state:
 * it has been recalled correctly enough times that it is now on a real
 * spacing schedule, not merely glimpsed once.
 */
export function isLearned(card: StoredCard | undefined): boolean {
  return !!card && card.state === REVIEW
}

/** A track is finished when nearly all of it is learned — the last few
 * stragglers are usually mid-relearn, and holding the next track hostage to
 * them just stalls the path. */
export const MASTERY = 0.85

export interface TrackProgress {
  id: string
  total: number
  learned: number
  seen: number
  mastered: boolean
}

export function trackProgress(
  clues: Clue[],
  cards: Record<string, StoredCard>,
): TrackProgress[] {
  const rows = TRACKS.map((t) => ({ id: t.id, total: 0, learned: 0, seen: 0, mastered: false }))
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const clue of clues) {
    const row = byId.get(trackOf(clue))
    if (!row) continue
    row.total += 1
    const card = cards[clue.id]
    if (card) row.seen += 1
    if (isLearned(card)) row.learned += 1
  }
  for (const row of rows) row.mastered = row.total > 0 && row.learned / row.total >= MASTERY
  return rows
}

/** The lowest unfinished track — where new material comes from. */
export function activeTrack(clues: Clue[], cards: Record<string, StoredCard>): string {
  const rows = trackProgress(clues, cards)
  return rows.find((r) => !r.mastered)?.id ?? rows[rows.length - 1].id
}
