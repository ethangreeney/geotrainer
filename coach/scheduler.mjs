/**
 * Spaced-repetition scheduling for the GeoCoach meta ladder.
 *
 * Pure functions over plain-JSON state: no fs, no network, and no clock reads —
 * every entry point takes `now`, so the caller (the bridge, a test, a replay of
 * old rounds) owns time. State is the shape server.mjs already writes: a card is
 * that file's per-meta row (seen/correct/streak) with a serialised FSRS card
 * flattened onto it, dates as ISO strings exactly as src/logic/scheduling.ts does.
 */
import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs'

const scheduler = fsrs()

/**
 * A correct country this close to the pin means the meta was *read*, not
 * narrowed down from context — the difference between recall and deduction.
 */
export const PINPOINT_SCORE = 4500

/**
 * The interval that counts as "learned" for tier progression, measured in
 * scheduled_days rather than stability.
 *
 * Stability is a half-life estimate that already reads ~2.3 days after a single
 * Good, while the card is still sitting in a ten-minute learning step — using it
 * would unlock the next tier off answers the player has not actually slept on.
 * scheduled_days is the interval FSRS committed to, so it only clears a week
 * once the card has genuinely graduated, which is what the gate is claiming:
 * "you can leave this meta alone for a week and still know it".
 */
export const MASTERY_DAYS = 7
export const TIER_MASTERY_RATIO = 0.8

const DEFAULT_MIN_NEW = 5
const DEFAULT_MIN_SIZE = 18

function toStored(card) {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? new Date(card.last_review).toISOString() : undefined,
  }
}

/** Picks only the FSRS fields back out, leaving the coaching stats behind. */
function fromStored(stored) {
  return {
    due: new Date(stored.due),
    stability: stored.stability,
    difficulty: stored.difficulty,
    elapsed_days: stored.elapsed_days,
    scheduled_days: stored.scheduled_days,
    learning_steps: stored.learning_steps,
    reps: stored.reps,
    lapses: stored.lapses,
    state: stored.state,
    last_review: stored.last_review ? new Date(stored.last_review) : undefined,
  }
}

export function ratingFor(correctCountry, score, firstSight = false) {
  if (!correctCountry) return Rating.Again
  // First-sight correct is prior knowledge, not learning: rate it Easy so the
  // card starts at a week-plus interval (8d under current FSRS defaults, past
  // MASTERY_DAYS immediately). The ladder then paces on what the player
  // actually misses instead of walking known material through sleep cycles.
  return firstSight || (score ?? 0) >= PINPOINT_SCORE ? Rating.Easy : Rating.Good
}

/**
 * Folds one played round into the card table and returns a new table.
 * A round with no identified meta teaches the scheduler nothing, so it passes
 * through untouched rather than inventing a card to hang the result on.
 */
export function gradeRound(cards, round, now) {
  const next = { ...cards }
  const metaName = round?.metaName
  if (!metaName) return next

  const prev = cards[metaName]
  const { card: graded } = scheduler.next(
    prev ? fromStored(prev) : createEmptyCard(now),
    now,
    ratingFor(round.correctCountry, round.score, !prev),
  )

  next[metaName] = {
    ...toStored(graded),
    seen: (prev?.seen ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (round.correctCountry ? 1 : 0),
    // One miss resets the streak: knowing a meta means reading it cold, repeatedly.
    streak: round.correctCountry ? (prev?.streak ?? 0) + 1 : 0,
    source: round.source ?? prev?.source ?? 'round',
  }
  return next
}

function tierMastered(cards, rung) {
  const metas = rung?.metas ?? []
  if (!metas.length) return true // an empty rung has nothing to hold the ladder up
  const learned = metas.filter((name) => (cards[name]?.scheduled_days ?? 0) >= MASTERY_DAYS).length
  return learned / metas.length >= TIER_MASTERY_RATIO
}

/**
 * How many rungs the player has mastered, for the dashboard's progress display.
 * This no longer gates anything: like Anki, the deck introduces new material in
 * ladder order without locks — mastery is a scoreboard, not a wall.
 */
export function unlockedTiers(cards, catalog) {
  if (!catalog?.length) return 1
  let unlocked = 1
  while (unlocked < catalog.length && tierMastered(cards, catalog[unlocked - 1])) unlocked += 1
  return unlocked
}

/**
 * Flattens the unlocked rungs into one ordered list of drillable metas.
 * A meta listed on two maps is kept at its first (easiest) appearance, which is
 * what makes every downstream pass dedupe-free.
 */
function unlockedMetas(catalog, tiers) {
  const seen = new Set()
  const out = []
  for (let tier = 0; tier < tiers && tier < catalog.length; tier++) {
    const rung = catalog[tier]
    for (const name of rung?.metas ?? []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, mapId: rung.mapId, tier })
    }
  }
  return out
}

const dueAt = (card) => new Date(card.due).getTime()

/**
 * Assembles the next session: everything owed, then as much new material as the
 * deck has room for, with near-future review only as last-resort filler.
 *
 * Due cards lead in retrievability order so the weakest memory is answered while
 * attention is freshest. New metas fill the rest of the deck up to minSize —
 * spare capacity goes to unseen material rather than re-serving cards the player
 * already holds, so a light review day means more of the ladder, not Colombia on
 * loop. minNew keeps new material flowing even when reviews alone fill the deck.
 * New metas drain the lowest tier before spilling upward — the ladder orders
 * introductions, it never locks them (standard Anki semantics: due reviews
 * plus a budget of new cards; no mastery gates). Padding — already-held
 * cards, soonest-due first — appears
 * only once the unseen supply runs dry, and if even that can't fill minSize the
 * deck is simply short, since inventing a card would corrupt the schedule to
 * pad a number.
 *
 * `metas` is ordered due → new → padding and `stats` gives the size of each
 * run, so a caller can tell them apart. That matters: padded metas are not owed
 * yet, and feeding their rounds back through gradeRound is over-review — FSRS
 * reads a repeat at near-zero elapsed time as a card that needs propping up, so
 * difficulty climbs and intervals stall. Grade the due and new rounds; treat
 * padding as free practice.
 */
export function buildDeck(cards, catalog, opts = {}, now) {
  const minNew = opts?.minNew ?? DEFAULT_MIN_NEW
  const minSize = opts?.minSize ?? DEFAULT_MIN_SIZE
  const entries = unlockedMetas(catalog ?? [], catalog?.length ?? 0)

  const due = entries
    .filter((e) => cards[e.name] && dueAt(cards[e.name]) <= now.getTime())
    .map((e) => ({
      ...e,
      retrievability: scheduler.get_retrievability(fromStored(cards[e.name]), now, false),
    }))
    .sort((a, b) => a.retrievability - b.retrievability || dueAt(cards[a.name]) - dueAt(cards[b.name]))

  // entries ascend by tier, so a plain slice drains the lowest tier with
  // anything left to teach before touching the next unlocked one.
  const introduced = entries
    .filter((e) => !cards[e.name])
    .slice(0, Math.max(minNew, minSize - due.length))

  const chosen = new Set([...due, ...introduced].map((e) => e.name))
  const padding = entries
    .filter((e) => cards[e.name] && !chosen.has(e.name))
    .sort((a, b) => dueAt(cards[a.name]) - dueAt(cards[b.name]))
    .slice(0, Math.max(0, minSize - chosen.size))

  const metas = [...due, ...introduced, ...padding].map(({ name, mapId }) => ({ name, mapId }))
  return {
    metas,
    introduced: introduced.map((e) => e.name),
    stats: {
      due: due.length,
      introduced: introduced.length,
      padding: padding.length,
      total: metas.length,
      unlockedTiers: unlockedTiers(cards, catalog),
    },
  }
}

/**
 * Counts for the status widget, scoped to the unlocked ladder so the numbers
 * match the deck the player will actually be handed. nextDue looks strictly
 * forward — anything already owed is counted in `due`, so the useful remaining
 * question is when the next card wakes up.
 */
/** Current recall probability of a stored card, for dashboards. */
export function retrievabilityOf(stored, now) {
  return scheduler.get_retrievability(fromStored(stored), now, false)
}

export function deckSummary(cards, catalog, now) {
  const entries = unlockedMetas(catalog ?? [], catalog?.length ?? 0)
  let due = 0
  let learning = 0
  let unseen = 0
  let nextDue = null

  for (const { name } of entries) {
    const card = cards[name]
    if (!card) {
      unseen += 1
      continue
    }
    if (card.state === State.Learning || card.state === State.Relearning) learning += 1
    const at = dueAt(card)
    if (at <= now.getTime()) due += 1
    else if (nextDue === null || at < nextDue) nextDue = at
  }

  return {
    due,
    learning,
    unseen,
    unlockedTiers: unlockedTiers(cards, catalog),
    nextDue: nextDue === null ? null : new Date(nextDue).toISOString(),
  }
}
