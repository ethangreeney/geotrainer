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

export const RATING_BY_NAME = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

/**
 * The inferred FSRS button name, so the card UI can pre-select it.
 * `correct` is scope-aware: for region-scoped metas the server only passes
 * true when the guess landed inside the meta's own footprint, not merely the
 * right country. Right scope is a plain Good — Easy and Hard are judgement
 * calls only the player can make, via the card's rating buttons.
 */
export function ratingNameFor(correct, firstSight = false) {
  if (!correct) return 'again'
  // First-sight correct is prior knowledge, not learning: rate it Easy so the
  // card starts at a week-plus interval (8d under current FSRS defaults, past
  // MASTERY_DAYS immediately). The ladder then paces on what the player
  // actually misses instead of walking known material through sleep cycles.
  return firstSight ? 'easy' : 'good'
}

export function ratingFor(correct, firstSight = false) {
  return RATING_BY_NAME[ratingNameFor(correct, firstSight)]
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
  // An explicit rating (the player tapped a button on the card) overrides the
  // inferred one — the player knows better than the score whether they read the
  // meta or lucked into the country off other clues.
  const rating = RATING_BY_NAME[round.rating] ?? ratingFor(round.correct, !prev)
  const success = rating !== Rating.Again
  const { card: graded } = scheduler.next(prev ? fromStored(prev) : createEmptyCard(now), now, rating)

  next[metaName] = {
    ...toStored(graded),
    seen: (prev?.seen ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (success ? 1 : 0),
    // One miss resets the streak: knowing a meta means reading it cold, repeatedly.
    streak: success ? (prev?.streak ?? 0) + 1 : 0,
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
 * How many never-seen metas a single published deck is allowed to introduce.
 *
 * This is a cap, not a ranking, and the distinction is the whole design. FSRS
 * models forgetting for material already seen; it has no opinion at all about
 * the rate at which new material should arrive, and asking a retrievability
 * number to arbitrate that question is asking it something it cannot answer.
 * Anki, which does answer it, keeps the two entirely separate: a hard daily cap
 * on new cards (default 20) against a review limit (default 200), so new
 * material is about 9% of the day's load and never competes with review on a
 * shared priority scale.
 *
 * The reason a cap rather than a priority is that a new card is not one unit of
 * work — the rule of thumb is that each one generates roughly ten future
 * reviews. The introduction rate is the derivative of the review load, so
 * letting it run free is exactly how a deck buries its owner a fortnight later.
 * Cognitive-load and scaffolding research says the same thing from the other
 * direction: material is absorbed gradually, against what is already known.
 *
 * And this domain sharpens it. A published deck is one five-round GeoGuessr
 * game. A game of all-new metas is five near-certain misses with nothing known
 * to contrast against — but most of the learning here is discrimination ("this
 * is Estonia and NOT Latvia"), which only happens when known cards share the
 * game. One new meta per deck is 20% new: ahead of Anki's ~9% default and of
 * the player's own measured 8%, deliberately, because there is a real unseen
 * backlog to work through — but still a game that is mostly answerable.
 *
 * This is the knob. Raise it to introduce faster; `Infinity` removes the cap
 * entirely and restores the front-load-everything behaviour, where the unseen
 * backlog is cleared before review resumes.
 */
export const DEFAULT_NEW_PER_DECK = 1

/**
 * Where an unseen meta sits within the deck it was admitted to.
 *
 * Not a knob — DEFAULT_NEW_PER_DECK is the knob, and by the time this number is
 * used the cap has already decided how much new material exists. Zero is simply
 * the honest reading of a card with no memory behind it, and it keeps the
 * exposed `priority` monotonic across the returned list. Intra-deck order is
 * cosmetic anyway: GeoGuessr draws the rounds of a game from the published map
 * in its own order.
 */
const UNSEEN_PRIORITY = 0

/**
 * The offset that parks not-yet-due cards behind every card actually owed.
 * Retrievability is a probability, so due priorities occupy [0, 1]; adding one
 * puts filler in [1, 2], and no arithmetic accident can float a card the player
 * does not owe above one they do.
 */
const FUTURE_PRIORITY_OFFSET = 1

/**
 * How many entries rankDeck hands back when the caller does not say.
 *
 * A GeoGuessr game is five rounds, so this is five games' worth: enough that a
 * single sitting never runs off the end of the list, small enough that the tail
 * of the queue — the 90%-recall cards and the not-yet-due filler — never
 * reaches the published map at all. The Worker passes its own limit; this
 * default exists so a script or a test can call rankDeck without inventing one.
 */
const DEFAULT_LIMIT = 25

/**
 * Ranks the whole ladder into one priority queue and returns the head of it.
 *
 * This is the just-in-time answer to what buildDeck could not do. buildDeck's
 * careful retrievability ordering was thrown away the moment its metas were
 * flattened into a single GeoGuessr custom map, because GeoGuessr draws from a
 * map uniformly at random: a card at 55% recall and one at 92% had identical
 * odds of coming up. Rebuilding the map at game creation with only the top
 * entries is what makes an ordering mean anything, and rankDeck is that
 * ordering.
 *
 * Three groups, concatenated, so the separation is structural rather than a
 * numeric coincidence: unseen metas in ladder order (tier ascending, then
 * catalog order, deduped at a meta's first and easiest appearance) but no more
 * than `newLimit` of them, then due cards weakest-memory-first with the
 * longest-overdue breaking ties, then not-yet-due cards on the same key. The
 * third group is filler and behaves like it: it only appears when the caller
 * asks for more entries than there is real work, and it can never displace the
 * first two. `priority` is the key that produced the order, exposed so the
 * Worker or a debugging view can see why a meta landed where it did.
 *
 * The unseen surplus is dropped, not demoted. An unseen meta that loses to the
 * cap is simply not in this deck; parking it at the tail as filler would let
 * material the player has never met push out review work that is genuinely
 * owed, which is the thing the cap exists to prevent. `stats.newAvailable`
 * reports how many were waiting, so the backlog stays visible rather than
 * silently disappearing.
 *
 * The cap applies before `limit`, so the new slot survives a small deck: asking
 * for one entry against a real backlog yields the new meta, not a review.
 *
 * Unlike buildDeck there is no minimum size and no padding to reach one: if the
 * ladder yields three entries, three come back. Inventing filler to hit a
 * number was always a lie about what the player owes, and a just-in-time map
 * has no reason to tell it.
 */
export function rankDeck(cards, catalog, opts = {}, now) {
  const limit = Math.max(0, opts?.limit ?? DEFAULT_LIMIT)
  const newLimit = Math.max(0, opts?.newLimit ?? DEFAULT_NEW_PER_DECK)
  const table = cards ?? {}
  const entries = unlockedMetas(catalog ?? [], catalog?.length ?? 0)
  const moment = now.getTime()

  const unseen = []
  const due = []
  const future = []
  for (const entry of entries) {
    const card = table[entry.name]
    if (!card) {
      unseen.push({ ...entry, kind: 'new', priority: UNSEEN_PRIORITY })
      continue
    }
    const retrievability = scheduler.get_retrievability(fromStored(card), now, false)
    if (dueAt(card) <= moment) due.push({ ...entry, kind: 'due', priority: retrievability })
    else future.push({ ...entry, kind: 'future', priority: FUTURE_PRIORITY_OFFSET + retrievability })
  }

  // Equal recall is broken by due date: the card that has been waiting longest
  // is the one the schedule is furthest behind on.
  const byPriority = (a, b) => a.priority - b.priority || dueAt(table[a.name]) - dueAt(table[b.name])
  due.sort(byPriority)
  future.sort(byPriority)

  const metas = [...unseen.slice(0, newLimit), ...due, ...future]
    .slice(0, limit)
    .map(({ name, mapId, priority, kind }) => ({ name, mapId, priority, kind }))

  // The counts describe what is being returned, the same as buildDeck's stats —
  // except newAvailable, which is deliberately about what did not fit, since a
  // capped backlog the player cannot see is a backlog they cannot decide about.
  const counted = { new: 0, due: 0, future: 0 }
  for (const meta of metas) counted[meta.kind] += 1
  return {
    metas,
    stats: {
      ...counted,
      newAvailable: unseen.length,
      total: metas.length,
      unlockedTiers: unlockedTiers(table, catalog),
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
