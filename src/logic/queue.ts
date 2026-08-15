import { trackIndex, trackOf } from '../data/tracks'
import { activeTrack } from './progress'
import type { Clue, StoredCard } from '../types'

export const SESSION_LENGTH = 10

/**
 * Flattens tiers of clues into one queue, keeping earlier tiers strictly ahead of later ones
 * while spreading categories. Each step scores every available category by how much of it
 * is left times how long since it was last asked, then takes the earliest clue from the
 * winner. Size alone just ping-pongs between the two biggest categories; recency alone
 * empties the small ones early and leaves the tail clumped. The product does both: a
 * session touches several different skills, and no category ever repeats back to back.
 */
function interleave(tiers: Clue[][], length: number): Clue[] {
  const pools = tiers.map((t) => t.slice())
  const out: Clue[] = []
  const lastUsedAt = new Map<string, number>()
  let lastCategory: string | null = null

  while (out.length < length) {
    const pool = pools.find((p) => p.length > 0)
    if (!pool) break

    const remaining = new Map<string, number>()
    for (const c of pool) remaining.set(c.category, (remaining.get(c.category) ?? 0) + 1)

    let index = -1
    let best = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const category = pool[i].category
      if (category === lastCategory) continue
      const gap = out.length - (lastUsedAt.get(category) ?? -1)
      const score = remaining.get(category)! * gap
      if (score > best) {
        best = score
        index = i
      }
    }
    if (index === -1) index = 0

    const [picked] = pool.splice(index, 1)
    lastUsedAt.set(picked.category, out.length)
    out.push(picked)
    lastCategory = picked.category
  }

  return out
}

export function isDue(card: StoredCard, now: Date): boolean {
  return new Date(card.due).getTime() <= now.getTime()
}

/** FSRS-due reviews first, then unseen clues, interleaved across categories. */
export function buildQueue(
  clues: Clue[],
  cards: Record<string, StoredCard>,
  now: Date = new Date(),
  length: number = SESSION_LENGTH,
): Clue[] {
  const due: Clue[] = []
  const fresh: Clue[] = []

  for (const clue of clues) {
    const card = cards[clue.id]
    if (!card) fresh.push(clue)
    else if (isDue(card, now)) due.push(clue)
  }

  due.sort(
    (a, b) => new Date(cards[a.id].due).getTime() - new Date(cards[b.id].due).getTime(),
  )

  return interleave([due, fresh], length)
}

/**
 * The mixed daily session, gated by the learning path: reviews come from
 * everywhere you have ever been — a scheduled card is a promise — but new
 * material is introduced only from the lowest unfinished track, so the first
 * weeks are spent on the curated essentials instead of trivia about
 * territories you will never see.
 */
export function buildSessionQueue(
  clues: Clue[],
  cards: Record<string, StoredCard>,
  now: Date = new Date(),
  length: number = SESSION_LENGTH,
): Clue[] {
  const active = activeTrack(clues, cards)
  const due: Clue[] = []
  const fresh: Clue[] = []

  for (const clue of clues) {
    const card = cards[clue.id]
    if (!card) {
      if (trackOf(clue) === active) fresh.push(clue)
    } else if (isDue(card, now)) due.push(clue)
  }

  due.sort(
    (a, b) => new Date(cards[a.id].due).getTime() - new Date(cards[b.id].due).getTime(),
  )

  const queue = interleave([due, fresh], length)
  if (queue.length >= length) return queue

  // Path exhausted at this track and nothing due: open the next tracks rather
  // than serve a short session.
  const taken = new Set(queue.map((c) => c.id))
  const beyond = clues
    .filter((c) => !cards[c.id] && !taken.has(c.id))
    .sort((a, b) => trackIndex(a) - trackIndex(b))
  return [...queue, ...interleave([beyond], length - queue.length)]
}

/**
 * Queue for a focused single-skill session. Scheduling still applies inside the
 * skill — due reviews first, then unseen — and unseen clues arrive in learning-
 * path order, so a first language drill teaches the thirty major languages, not
 * a random walk through 85 countries. Once both run out the session tops up
 * with whatever is scheduled soonest, so a focused drill is never empty.
 */
export function buildCategoryQueue(
  clues: Clue[],
  category: string,
  cards: Record<string, StoredCard>,
  now: Date = new Date(),
  length: number = SESSION_LENGTH,
): Clue[] {
  const pool = clues
    .filter((c) => c.category === category)
    .sort((a, b) => trackIndex(a) - trackIndex(b))
  const queue = buildQueue(pool, cards, now, length)
  if (queue.length >= Math.min(length, pool.length)) return queue

  const taken = new Set(queue.map((c) => c.id))
  const soonest = pool
    .filter((c) => !taken.has(c.id))
    .sort((a, b) => new Date(cards[a.id].due).getTime() - new Date(cards[b.id].due).getTime())

  return [...queue, ...soonest.slice(0, length - queue.length)]
}

/** Queue for a targeted A-vs-B drill: only clues belonging to those two countries. */
export function buildPairQueue(
  clues: Clue[],
  a: string,
  b: string,
  length: number = SESSION_LENGTH,
): Clue[] {
  const pool = clues.filter((c) => c.country === a || c.country === b)
  return interleave([pool], Math.min(length, pool.length))
}

/** Number of cards falling due in the next 24 hours. */
export function dueTomorrow(cards: Record<string, StoredCard>, now: Date = new Date()): number {
  const cutoff = now.getTime() + 24 * 60 * 60 * 1000
  return Object.values(cards).filter((c) => {
    const due = new Date(c.due).getTime()
    return due > now.getTime() && due <= cutoff
  }).length
}
