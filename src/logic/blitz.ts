import { lookalikes } from './compare'
import { isDue } from './queue'
import type { Clue, StoredCard } from '../types'

/**
 * Blitz: the acquisition loop. Learning 187 image–country pairs on a map that
 * takes two clicks and an animation per answer would take weeks; first contact
 * with a tell needs a loop measured in seconds. So new material arrives in
 * small batches: study the batch, then a forced-choice drill where every miss
 * comes straight back until it has been beaten twice in a row. Only the first
 * attempt is graded — the scheduler must see honest recall, not the cramming
 * that follows it. The map drill stays as the review stage, where the harder
 * spatial retrieval belongs.
 */
export const BATCH_SIZE = 6
export const RETIRE_STREAK = 2
/** A missed card returns after this many other questions. */
const RETRY_GAP = 2

export interface BlitzCard {
  clue: Clue
  /** Consecutive correct answers since the last miss. */
  streak: number
  /** First-attempt outcome — what actually gets graded. */
  firstChosen: string | null
  firstMs: number
}

/** The next tells to acquire: unseen in curriculum order, topped up with due reviews. */
export function nextBatch(
  clues: Clue[],
  cards: Record<string, StoredCard>,
  now: Date = new Date(),
  size: number = BATCH_SIZE,
): Clue[] {
  const unseen = clues.filter((c) => !cards[c.id])
  if (unseen.length >= size) return unseen.slice(0, size)
  const due = clues
    .filter((c) => cards[c.id] && isDue(cards[c.id], now))
    .sort((a, b) => new Date(cards[a.id].due).getTime() - new Date(cards[b.id].due).getTime())
  return [...unseen, ...due].slice(0, size)
}

/**
 * Four options for a forced choice: the answer plus its documented confusions,
 * padded from the rest of the batch's world. Distractors drawn from the real
 * confusable set make even the multiple-choice pass discrimination practice.
 */
export function blitzOptions(clue: Clue, pool: Clue[], rand: () => number = Math.random): string[] {
  const options = [clue.country]
  for (const twin of lookalikes(clue, 3)) {
    if (!options.includes(twin.country)) options.push(twin.country)
  }
  const rest = [...new Set(pool.map((c) => c.country))].filter((c) => !options.includes(c))
  while (options.length < 4 && rest.length > 0) {
    options.push(rest.splice(Math.floor(rand() * rest.length), 1)[0])
  }
  // Fisher–Yates so the answer's position carries no signal.
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[options[i], options[j]] = [options[j], options[i]]
  }
  return options
}

export interface BlitzStep {
  queue: BlitzCard[]
  /** Set when this answer retired the card — time to grade its first attempt. */
  retired: BlitzCard | null
}

/**
 * Advance the drill queue by one answer to its head card. A card retires on a
 * clean first try, or after RETIRE_STREAK straight corrects following a miss.
 * A miss resets the streak and reinserts the card a couple of questions out.
 */
export function applyAnswer(
  queue: BlitzCard[],
  chosen: string,
  responseMs: number,
): BlitzStep {
  const [head, ...rest] = queue
  const correct = chosen === head.clue.country
  const first = head.firstChosen === null
  const card: BlitzCard = {
    ...head,
    streak: correct ? head.streak + 1 : 0,
    firstChosen: first ? chosen : head.firstChosen,
    firstMs: first ? responseMs : head.firstMs,
  }

  if (correct && (first || card.streak >= RETIRE_STREAK)) {
    return { queue: rest, retired: card }
  }
  const at = correct ? rest.length : Math.min(RETRY_GAP, rest.length)
  return { queue: [...rest.slice(0, at), card, ...rest.slice(at)], retired: null }
}
