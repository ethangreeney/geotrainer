import { describe, expect, it } from 'vitest'
import { fsrs, State } from 'ts-fsrs'
import {
  buildDeck,
  deckSummary,
  DEFAULT_DAILY_NEW,
  gradeRound,
  MASTERY_DAYS,
  newIntroducedToday,
  nextNewMetas,
  rankDeck,
  reviewsCompletedToday,
  logRepeatReview,
  repeatReviewsToday,
  ratingNameFor,
  unlockedTiers,
} from './scheduler.mjs'

const DAY = 86_400_000
const at = (iso) => new Date(iso)
const T0 = at('2026-03-01T00:00:00Z')
const plus = (date, days) => new Date(date.getTime() + days * DAY)

const CATALOG = [
  {
    mapId: 'lm-tier1',
    name: 'Foundations',
    tier: 1,
    metas: ['white-cap bollard', 'yellow rear plate', 'double concrete pole', 'yellow centre line', 'blue chevron sign'],
  },
  {
    mapId: 'lm-tier2',
    name: 'Regionals',
    tier: 2,
    metas: ['A-profile guardrail', 'red-band bollard', 'rusty snorkel', 'hexagonal pole', 'km marker sign'],
  },
  {
    mapId: 'lm-tier3',
    name: 'Deep cuts',
    tier: 3,
    metas: ['short mast antenna', 'hooped bollard', 'red painted kerb', 'wishbone pole', 'octagon sign'],
  },
]
const T1 = CATALOG[0].metas
const T2 = CATALOG[1].metas
const T3 = CATALOG[2].metas

/** A graduated review card with exact control over its interval and due date. */
function card({ due, stability = 10, scheduledDays = 10, state = State.Review, lastReview }) {
  const dueDate = at(due)
  return {
    due: dueDate.toISOString(),
    stability,
    difficulty: 5,
    elapsed_days: scheduledDays,
    scheduled_days: scheduledDays,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state,
    last_review: (lastReview ? at(lastReview) : plus(dueDate, -scheduledDays)).toISOString(),
    seen: 3,
    correct: 3,
    streak: 3,
    source: 'round',
  }
}

/** `count` metas from `names` scheduled `days` out — the tier-unlock lever. */
function mastered(names, count, { days = MASTERY_DAYS, due = '2026-06-01T00:00:00Z' } = {}) {
  const cards = {}
  for (const name of names.slice(0, count)) {
    cards[name] = card({ due, scheduledDays: days, stability: days * 1.2 })
  }
  return cards
}

/** Plays one round through the real grader, so tests exercise FSRS not fixtures. */
const drill = (cards, metaName, correct, now) => gradeRound(cards, { metaName, correct }, now)

describe('gradeRound', () => {
  it('creates a card on first sighting of a meta', () => {
    const cards = drill({}, T1[0], true, T0)
    expect(Object.keys(cards)).toEqual([T1[0]])
    expect(cards[T1[0]]).toMatchObject({ seen: 1, correct: 1, streak: 1, source: 'round', reps: 1 })
    expect(cards[T1[0]].last_review).toBe(T0.toISOString())
  })

  it('stamps firstSeen at the introduction and never rewrites it', () => {
    const born = drill({}, T1[0], true, T0)
    expect(born[T1[0]].firstSeen).toBe(T0.toISOString())

    const later = drill(born, T1[0], true, plus(T0, 9))
    expect(later[T1[0]].firstSeen).toBe(T0.toISOString()) // the introduction, not this review
    expect(later[T1[0]].seen).toBe(2)
  })

  it('leaves a card graded before firstSeen existed without one', () => {
    // Backdating would be a guess, and an old introduction read as today's
    // would eat an allowance the player never spent.
    const legacy = { [T1[0]]: card({ due: plus(T0, -1).toISOString() }) }
    const after = drill(legacy, T1[0], true, T0)[T1[0]]
    expect(after.firstSeen).toBeUndefined()
    expect(after.seen).toBe(4)
  })

  it('brings a sub-day step back due immediately', () => {
    // FSRS's minute-scale learning steps space cards within an Anki sitting.
    // Here a review is a whole round, minutes long by itself, so a card
    // waiting out a ten-minute step is only a card missing from the map. A
    // miss must be replayable in the very next game.
    const missed = drill({}, T1[0], false, T0)[T1[0]]
    expect(new Date(missed.due).getTime()).toBeLessThanOrEqual(T0.getTime())

    // A correct first sighting graduates straight to a days-scale interval —
    // only the miss was ever parked on a timer.
    const introduced = drill({}, T1[0], true, T0)[T1[0]]
    expect(new Date(introduced.due).getTime()).toBeGreaterThan(T0.getTime())
  })

  it('still lets a graduated card leave for days', () => {
    // The clamp only flattens today: an interval FSRS wrote in days survives.
    let cards = {}
    let at = T0
    for (let i = 0; i < 3; i++) {
      cards = drill(cards, T1[0], true, at)
      at = plus(at, 1)
    }
    expect(new Date(cards[T1[0]].due).getTime()).toBeGreaterThan(at.getTime())
  })

  it('serialises to plain JSON so state.json round-trips', () => {
    const cards = drill({}, T1[0], true, T0)
    expect(JSON.parse(JSON.stringify(cards))).toEqual(cards)
    expect(typeof cards[T1[0]].due).toBe('string')
    expect(new Date(cards[T1[0]].due).toISOString()).toBe(cards[T1[0]].due)
  })

  it('does not mutate the table it was given', () => {
    const before = drill({}, T1[0], true, T0)
    const snapshot = structuredClone(before)
    const after = drill(before, T1[0], true, plus(T0, 1))
    expect(before).toEqual(snapshot)
    expect(after).not.toBe(before)
    expect(after[T1[0]].seen).toBe(2)
  })

  it('passes rounds with no identified meta straight through', () => {
    const cards = drill({}, T1[0], true, T0)
    const after = gradeRound(cards, { metaName: null, correct: false }, T0)
    expect(after).toEqual(cards)
    expect(after).not.toBe(cards)
  })

  it('counts a streak of correct answers', () => {
    let cards = {}
    let now = T0
    for (let i = 0; i < 3; i++) {
      cards = drill(cards, T1[0], true, now)
      now = at(cards[T1[0]].due)
    }
    expect(cards[T1[0]]).toMatchObject({ seen: 3, correct: 3, streak: 3 })
  })

  it('resets the streak and collapses the interval on a wrong country', () => {
    let cards = {}
    let now = T0
    for (let i = 0; i < 4; i++) {
      cards = drill(cards, T1[0], true, now)
      now = at(cards[T1[0]].due)
    }
    const before = cards[T1[0]]
    expect(before.streak).toBe(4)
    expect(before.scheduled_days).toBeGreaterThan(0)

    const after = drill(cards, T1[0], false, now)[T1[0]]
    expect(after.streak).toBe(0)
    expect(after.correct).toBe(4) // a miss never un-earns past correct answers
    expect(after.seen).toBe(5)
    expect(after.lapses).toBe(before.lapses + 1)
    expect(after.scheduled_days).toBeLessThan(before.scheduled_days)
    // graded at the moment it fell due, a miss comes back within the hour,
    // where the same round answered correctly would have pushed weeks out
    const ifCorrect = drill(cards, T1[0], true, now)[T1[0]]
    expect(at(after.due).getTime()).toBeLessThan(at(ifCorrect.due).getTime())
    expect(at(after.due).getTime() - now.getTime()).toBeLessThan(DAY)
  })

  it('rates a first-sight correct easy, a repeat correct good, and a miss again', () => {
    expect(ratingNameFor(true, true)).toBe('easy')
    expect(ratingNameFor(true, false)).toBe('good')
    expect(ratingNameFor(false, true)).toBe('again')
    expect(ratingNameFor(false, false)).toBe('again')
  })

  it('gives a first sighting the easy head start over a hypothetical good', () => {
    const firstSight = drill({}, T1[0], true, T0)[T1[0]]
    const asRepeat = gradeRound({}, { metaName: T1[0], correct: true, rating: 'good' }, T0)[T1[0]]
    expect(at(firstSight.due).getTime()).toBeGreaterThan(at(asRepeat.due).getTime())
    expect(firstSight.stability).toBeGreaterThan(asRepeat.stability)
  })

  it('sends a first sight the player did not actually read back into learning', () => {
    // The card asks "did you use this clue?" the first time a meta lands and
    // the pin is right, because "correct" there says nothing about whether the
    // clue was read. Answering no has to mean what Again means anywhere else:
    // not a shorter interval, not a softer one — an unlearnt card, due now.
    const assumed = drill({}, T1[0], true, T0)[T1[0]] // left alone: prior knowledge
    const answered = gradeRound({}, { metaName: T1[0], rating: 'again', correct: false }, T0)[T1[0]]
    expect(at(assumed.due).getTime() - T0.getTime()).toBeGreaterThan(7 * DAY)
    expect(at(answered.due).getTime() - T0.getTime()).toBeLessThan(60 * 60 * 1000)
    expect(answered.state).toBe(1) // learning, not review
  })

  it('lets an explicit rating override the inferred one', () => {
    let base = drill({}, T1[0], true, T0)
    const now = at(base[T1[0]].due)
    const inferred = drill(base, T1[0], true, now)[T1[0]] // good
    const tapped = gradeRound(base, { metaName: T1[0], correct: true, rating: 'easy' }, now)[T1[0]]
    expect(tapped.scheduled_days).toBeGreaterThanOrEqual(inferred.scheduled_days)
    expect(tapped.stability).toBeGreaterThan(inferred.stability)
  })

  it('grades a wrong scope again regardless of anything else in the round', () => {
    const wrong = gradeRound({}, { metaName: T1[0], correct: false, score: 4900 }, T0)[T1[0]]
    const right = drill({}, T1[0], true, T0)[T1[0]]
    expect(wrong.stability).toBeLessThan(right.stability)
    expect(wrong.streak).toBe(0)
  })
})

describe('newIntroducedToday', () => {
  /** A card stamped as introduced at `when`, the way gradeRound stamps one. */
  const introducedAt = (when) => ({ ...card({ due: plus(when, 10).toISOString() }), firstSeen: when.toISOString() })

  it('counts nothing for an empty or unstamped table', () => {
    expect(newIntroducedToday({}, T0)).toBe(0)
    expect(newIntroducedToday(null, T0)).toBe(0)
    // every card in state.json predates the field: none of them is today's work
    expect(newIntroducedToday({ [T1[0]]: card({ due: T0.toISOString() }) }, T0)).toBe(0)
  })

  it('counts the metas introduced since the day began', () => {
    const cards = {
      [T1[0]]: introducedAt(at('2026-03-01T05:00:00Z')), // after 4am: today's
      [T1[1]]: introducedAt(at('2026-03-01T10:00:00Z')),
      [T1[2]]: introducedAt(at('2026-02-28T12:00:00Z')), // yesterday's
    }
    expect(newIntroducedToday(cards, at('2026-03-01T12:00:00Z'), 0)).toBe(2)
  })

  it('releases the allowance at the next 4am, not 24 hours later', () => {
    // Introduced at 9pm: still spent at 3:59am (one sitting), fresh at 4am.
    const cards = { [T1[0]]: introducedAt(at('2026-03-01T21:00:00Z')) }
    expect(newIntroducedToday(cards, at('2026-03-02T03:59:00Z'), 0)).toBe(1)
    expect(newIntroducedToday(cards, at('2026-03-02T04:01:00Z'), 0)).toBe(0)
  })

  it("draws the boundary on the player's clock, not the server's", () => {
    // Introduced 9pm NZ time (09:00 UTC). By 8am NZ the next morning the NZ
    // day has rolled over even though in UTC it is still the same date.
    const cards = { [T1[0]]: introducedAt(at('2026-03-01T09:00:00Z')) }
    expect(newIntroducedToday(cards, at('2026-03-01T10:00:00Z'), 720)).toBe(1) // 10pm NZ, same evening
    expect(newIntroducedToday(cards, at('2026-03-01T20:00:00Z'), 720)).toBe(0) // 8am NZ, fresh day
    expect(newIntroducedToday(cards, at('2026-03-01T20:00:00Z'), 0)).toBe(1) // in UTC, still the same day
  })
})

describe('reviewsCompletedToday', () => {
  /** A card answered at `when`, met long enough ago to be a review. */
  const answeredAt = (when, firstSeen = plus(when, -30)) => ({
    ...card({ due: plus(when, 6).toISOString(), lastReview: when.toISOString() }),
    firstSeen: firstSeen.toISOString(),
  })

  it('counts nothing for an empty table or a card never answered', () => {
    expect(reviewsCompletedToday({}, T0)).toBe(0)
    expect(reviewsCompletedToday(null, T0)).toBe(0)
    expect(reviewsCompletedToday({ [T1[0]]: { seen: 1, firstSeen: T0.toISOString() } }, T0)).toBe(0)
  })

  it('counts the cards graded since the same day boundary the allowance uses', () => {
    const cards = {
      [T1[0]]: answeredAt(at('2026-03-01T11:00:00Z')),
      [T1[1]]: answeredAt(at('2026-03-01T05:00:00Z')),
      [T1[2]]: answeredAt(at('2026-02-28T12:00:00Z')), // yesterday's clears
    }
    expect(reviewsCompletedToday(cards, at('2026-03-01T12:00:00Z'), 0)).toBe(2)
    expect(reviewsCompletedToday(cards, at('2026-03-02T12:00:00Z'), 0)).toBe(0)
  })

  it('leaves today\'s introductions to the allowance rather than counting them twice', () => {
    // A meta met an hour ago has both stamps inside the window. It is one
    // round of work, and it is new-card work — counting it on both halves
    // would fill two bars off a single round.
    const cards = {
      [T1[0]]: answeredAt(plus(T0, -0.05), plus(T0, -0.05)),
      [T1[1]]: answeredAt(plus(T0, -0.05)),
    }
    expect(reviewsCompletedToday(cards, T0)).toBe(1)
    expect(newIntroducedToday(cards, T0)).toBe(1)
  })

  it('counts a card, not an answer', () => {
    // last_review holds one instant, so a meta drilled three times today is
    // one card of the day's work. That is what keeps done-plus-still-owed a
    // total that stays put while it fills.
    let cards = gradeRound({}, { metaName: T1[0] }, T0)
    cards = gradeRound(cards, { metaName: T1[0], correct: true }, plus(T0, 0.01))
    cards = gradeRound(cards, { metaName: T1[0], correct: true }, plus(T0, 0.02))
    expect(reviewsCompletedToday(cards, plus(T0, 0.03))).toBe(1)
    // A day later the last answer has aged out of the window.
    expect(reviewsCompletedToday(cards, plus(T0, 1.5))).toBe(0)
  })

  it('exempts the introduction itself, and only the introduction', () => {
    // A card whose one and only grade is its introduction is the allowance's
    // work, not a review —
    const introducedOnly = gradeRound({}, { metaName: T1[0] }, T0)
    expect(reviewsCompletedToday(introducedOnly, plus(T0, 0.01))).toBe(0)
    // — but answering it again later the same day is a review. This is the
    // shrinking-bar bug: the old rule dropped these answers entirely, so the
    // due count fell while "done" stood still and the bar's total shrank as
    // the player cleared their own new cards.
    const reviewedAgain = gradeRound(introducedOnly, { metaName: T1[0], correct: true }, plus(T0, 0.2))
    expect(reviewsCompletedToday(reviewedAgain, plus(T0, 0.25))).toBe(1)
    expect(newIntroducedToday(reviewedAgain, plus(T0, 0.25))).toBe(1)
  })

  it('hands repeat answers to the log, so done counts answers overall', () => {
    // The live shrinking bar, second act: 100 cards reviewed by lunch, and the
    // afternoon spent re-clearing their learning steps moved nothing, because
    // a card already counted cannot be counted again. The log is where those
    // answers go, and done = distinct cards + logged repeats moves by exactly
    // one per answer.
    let cards = gradeRound({}, { metaName: T1[0], correct: true }, plus(T0, -3))
    let log = []
    const done = (when) => reviewsCompletedToday(cards, when) + repeatReviewsToday(log, when)

    // First answer of the day: not a repeat — the distinct-card count takes it.
    log = logRepeatReview(log, cards[T1[0]], plus(T0, 0.01))
    cards = gradeRound(cards, { metaName: T1[0], correct: true }, plus(T0, 0.01))
    expect(log).toEqual([])
    expect(done(plus(T0, 0.02))).toBe(1)

    // Second and third answers: repeats, one log entry each.
    for (const dt of [0.1, 0.2]) {
      log = logRepeatReview(log, cards[T1[0]], plus(T0, dt))
      cards = gradeRound(cards, { metaName: T1[0], correct: true }, plus(T0, dt))
    }
    expect(done(plus(T0, 0.25))).toBe(3)

    // A day later the whole session has aged out, log included.
    expect(done(plus(T0, 1.5))).toBe(0)
    expect(logRepeatReview(log, cards[T1[0]], plus(T0, 3)).length).toBe(0)
  })

  it('never logs an introduction or its first re-answer as a repeat', () => {
    // The introduction is the allowance's; the first re-answer is the
    // distinct-card count's (the shrinking-bar fix). Only from the third
    // answer on is there work no other counter can see.
    let cards = {}
    let log = []
    for (const dt of [0, 0.1, 0.2]) {
      log = logRepeatReview(log, cards[T1[0]], plus(T0, dt))
      cards = gradeRound(cards, { metaName: T1[0], correct: true }, plus(T0, dt))
    }
    expect(log.length).toBe(1)
    const done = reviewsCompletedToday(cards, plus(T0, 0.25)) + repeatReviewsToday(log, plus(T0, 0.25))
    expect(done).toBe(2) // three answers, one of them the introduction
    expect(newIntroducedToday(cards, plus(T0, 0.25))).toBe(1)
  })

  it('sees the grade gradeRound actually wrote', () => {
    // The stamp is FSRS's own, so this is only ever measuring real work: a
    // meta drilled yesterday and left alone today does not count.
    const yesterday = gradeRound({}, { metaName: T1[0], correct: true }, plus(T0, -1.2))
    expect(reviewsCompletedToday(yesterday, T0)).toBe(0)
    const again = gradeRound(yesterday, { metaName: T1[0], correct: true }, plus(T0, -0.1))
    expect(reviewsCompletedToday(again, T0)).toBe(1)
  })
})

describe('unlockedTiers', () => {
  it('always opens the first tier', () => {
    expect(unlockedTiers({}, CATALOG)).toBe(1)
    expect(unlockedTiers({}, [])).toBe(1)
  })

  it('unlocks the next tier at exactly 80% scheduled a week out', () => {
    expect(unlockedTiers(mastered(T1, 4), CATALOG)).toBe(2)
  })

  it('stays locked one meta below the 80% line', () => {
    expect(unlockedTiers(mastered(T1, 3), CATALOG)).toBe(1)
  })

  it('counts an interval of exactly seven days but not six', () => {
    expect(unlockedTiers(mastered(T1, 4, { days: MASTERY_DAYS }), CATALOG)).toBe(2)
    expect(unlockedTiers(mastered(T1, 4, { days: MASTERY_DAYS - 1 }), CATALOG)).toBe(1)
  })

  it('ignores stability when the card is still in a learning step', () => {
    // One Good leaves stability above 2 with a ten-minute step: the player has
    // not slept on it, so it must not count toward opening the next tier.
    // (Explicit Good: the inferred first-sight rating is Easy, which graduates.)
    let cards = {}
    for (const name of T1)
      cards = gradeRound(cards, { metaName: name, correct: true, rating: 'good' }, T0)
    for (const name of T1) {
      expect(cards[name].stability).toBeGreaterThan(2)
      expect(cards[name].scheduled_days).toBe(0)
    }
    expect(unlockedTiers(cards, CATALOG)).toBe(1)
  })

  it('climbs two rungs when both are mastered', () => {
    const cards = { ...mastered(T1, 5), ...mastered(T2, 4) }
    expect(unlockedTiers(cards, CATALOG)).toBe(3)
  })

  it('stops at the first unmastered rung even if a harder one looks done', () => {
    const cards = { ...mastered(T1, 5), ...mastered(T2, 2), ...mastered(T3, 5) }
    expect(unlockedTiers(cards, CATALOG)).toBe(2)
  })

  it('never exceeds the catalog length', () => {
    const cards = { ...mastered(T1, 5), ...mastered(T2, 5), ...mastered(T3, 5) }
    expect(unlockedTiers(cards, CATALOG)).toBe(CATALOG.length)
  })
})

describe('buildDeck: empty state', () => {
  it('fills the deck with new material in ladder order when nothing is due', () => {
    const deck = buildDeck({}, CATALOG, {}, T0)
    expect(deck.introduced).toEqual([...T1, ...T2, ...T3]) // 15 metas, still under minSize 18
    expect(deck.metas.slice(0, 5)).toEqual(T1.map((name) => ({ name, mapId: 'lm-tier1' })))
    expect(deck.stats).toMatchObject({ due: 0, introduced: 15, padding: 0, unlockedTiers: 1 })
  })

  it('leaves the deck short rather than inventing cards to reach minSize', () => {
    const cards = {}
    const deck = buildDeck(cards, CATALOG, { minSize: 18 }, T0)
    expect(deck.metas.length).toBe(15) // the whole catalog, and that is all there is
    expect(deck.metas.length).toBeLessThan(18)
    expect(cards).toEqual({}) // buildDeck never writes state
    const names = new Set(CATALOG.flatMap((t) => t.metas))
    for (const meta of deck.metas) expect(names.has(meta.name)).toBe(true)
  })

  it('honours minNew as the floor when minSize gives no extra room', () => {
    const deck = buildDeck({}, CATALOG, { minNew: 2, minSize: 0 }, T0)
    expect(deck.introduced).toEqual(T1.slice(0, 2))
    expect(deck.metas.length).toBe(2)
  })

  it('introduces nothing when new material is switched off', () => {
    const deck = buildDeck({}, CATALOG, { minNew: 0, minSize: 0 }, T0)
    expect(deck.metas).toEqual([])
    expect(deck.introduced).toEqual([])
  })
})

describe('buildDeck: composition', () => {
  it('orders due cards by retrievability, weakest memory first', () => {
    const cards = {
      [T1[0]]: card({ due: '2026-02-27T00:00:00Z', stability: 40, scheduledDays: 40 }),
      [T1[1]]: card({ due: '2026-02-01T00:00:00Z', stability: 10, scheduledDays: 10 }),
      [T1[2]]: card({ due: '2026-02-28T00:00:00Z', stability: 3, scheduledDays: 3 }),
    }
    const deck = buildDeck(cards, CATALOG, { minNew: 0, minSize: 0 }, T0)
    const names = deck.metas.map((m) => m.name)
    const recall = (name) => fsrs().get_retrievability(cards[name], T0, false)

    expect(names).toEqual([...names].sort((a, b) => recall(a) - recall(b)))
    expect(recall(names[0])).toBeLessThan(recall(names[2]))
    // Not stability order: the forgetting curve weighs time elapsed against
    // stability, so a month-overdue 10-day memory is thinner than a fresh 3-day one.
    expect(names).toEqual([T1[1], T1[2], T1[0]])
  })

  it('ranks a long-overdue card ahead of a barely-due one of equal strength', () => {
    const cards = {
      [T1[0]]: card({ due: T0.toISOString(), stability: 10, scheduledDays: 10 }), // due this instant
      [T1[1]]: card({ due: plus(T0, -20).toISOString(), stability: 10, scheduledDays: 10 }),
    }
    const deck = buildDeck(cards, CATALOG, { minNew: 0, minSize: 0 }, T0)
    expect(deck.metas.map((m) => m.name)).toEqual([T1[1], T1[0]])
  })

  it('puts due cards first, then new metas spilling up the ladder before padding', () => {
    const cards = {
      [T1[0]]: card({ due: plus(T0, -5).toISOString() }), // due
      [T1[1]]: card({ due: plus(T0, 3).toISOString() }), // held, not owed
      [T1[2]]: card({ due: plus(T0, 9).toISOString() }), // held, not owed
    }
    // room for 3 beyond the due card: tier 1's two unseen metas, then the
    // ladder spills into tier 2 rather than re-serving held cards as padding
    const deck = buildDeck(cards, CATALOG, { minNew: 1, minSize: 4 }, T0)
    expect(deck.metas.map((m) => m.name)).toEqual([T1[0], T1[3], T1[4], T2[0]])
    expect(deck.introduced).toEqual([T1[3], T1[4], T2[0]])
    expect(deck.stats).toMatchObject({ due: 1, introduced: 3, padding: 0, total: 4 })
  })

  it('fills spare capacity with new material, spilling into the next unlocked tier', () => {
    const cards = {
      ...mastered(T1, 4, { due: plus(T0, 30).toISOString() }), // 80% of tier 1 → tier 2 open
      [T1[0]]: card({ due: plus(T0, -1).toISOString() }), // due
    }
    const deck = buildDeck(cards, CATALOG, { minNew: 1, minSize: 5 }, T0)
    expect(deck.stats.unlockedTiers).toBe(2)
    expect(deck.introduced).toEqual([T1[4], T2[0], T2[1], T2[2]])
    expect(deck.stats).toMatchObject({ due: 1, introduced: 4, padding: 0, total: 5 })
  })

  it('gathers due cards from every unlocked tier', () => {
    const cards = {
      ...mastered(T1, 5, { due: plus(T0, 30).toISOString() }),
      [T2[0]]: card({ due: plus(T0, -2).toISOString(), stability: 8 }),
      [T1[0]]: card({ due: plus(T0, -1).toISOString(), stability: 30, scheduledDays: 30 }),
    }
    const deck = buildDeck(cards, CATALOG, { minNew: 0, minSize: 0 }, T0)
    expect(deck.stats.unlockedTiers).toBe(2)
    expect(deck.metas).toEqual([
      { name: T2[0], mapId: 'lm-tier2' },
      { name: T1[0], mapId: 'lm-tier1' },
    ])
  })

  it('drains tier 2 then keeps introducing from tier 3 — the ladder orders, it never locks', () => {
    const cards = { ...mastered(T1, 5), ...mastered(T2, 3) }
    const deck = buildDeck(cards, CATALOG, { minNew: 5, minSize: 0 }, T0)
    expect(deck.introduced).toEqual([T2[3], T2[4], T3[0], T3[1], T3[2]])
    expect(deck.stats.unlockedTiers).toBe(2)
  })

  it('offers the whole catalog in ladder order when asked for more than it holds', () => {
    const deck = buildDeck({}, CATALOG, { minNew: 99, minSize: 99 }, T0)
    expect(deck.metas.map((m) => m.name)).toEqual([...T1, ...T2, ...T3])
  })

  it('lists a meta once when it appears on two maps', () => {
    const shared = 'white-cap bollard'
    const catalog = [
      CATALOG[0],
      { ...CATALOG[1], metas: [shared, ...T2] }, // tier 2 repeats a tier 1 meta
    ]
    const cards = { ...mastered(T1, 5, { due: plus(T0, -3).toISOString() }) }
    const deck = buildDeck(cards, catalog, { minNew: 5, minSize: 20 }, T0)
    const names = deck.metas.map((m) => m.name)
    expect(names.filter((n) => n === shared)).toHaveLength(1)
    expect(new Set(names).size).toBe(names.length)
    // kept at its easiest appearance
    expect(deck.metas.find((m) => m.name === shared).mapId).toBe('lm-tier1')
  })
})

describe('buildDeck: padding', () => {
  const everything = () => {
    const cards = {}
    for (const [i, name] of [...T1, ...T2, ...T3].entries()) {
      cards[name] = card({ due: plus(T0, i + 1).toISOString(), scheduledDays: 30, stability: 30 })
    }
    cards[T1[0]] = card({ due: plus(T0, -1).toISOString(), scheduledDays: 30, stability: 30 })
    cards[T2[0]] = card({ due: plus(T0, -2).toISOString(), scheduledDays: 30, stability: 30 })
    return cards
  }

  it('pads to minSize with the cards closest to falling due', () => {
    const deck = buildDeck(everything(), CATALOG, { minNew: 5, minSize: 6 }, T0)
    expect(deck.introduced).toEqual([]) // nothing unseen left
    expect(deck.metas.length).toBe(6)
    expect(deck.stats).toMatchObject({ due: 2, padding: 4 })
    // padding is soonest-due-first: T1[1] (+2d), T1[2] (+3d), T1[3] (+4d), T1[4] (+5d)
    expect(deck.metas.slice(2).map((m) => m.name)).toEqual([T1[1], T1[2], T1[3], T1[4]])
  })

  it('does not pad a deck that already meets minSize', () => {
    const deck = buildDeck(everything(), CATALOG, { minNew: 5, minSize: 2 }, T0)
    expect(deck.metas.length).toBe(2)
    expect(deck.stats.padding).toBe(0)
  })

  it('stops short when the catalog runs out of cards to pad with', () => {
    const small = [CATALOG[0]]
    const cards = {
      [T1[0]]: card({ due: plus(T0, -1).toISOString() }),
      [T1[1]]: card({ due: plus(T0, 2).toISOString() }),
      [T1[2]]: card({ due: plus(T0, 4).toISOString() }),
    }
    const deck = buildDeck(cards, small, { minNew: 5, minSize: 18 }, T0)
    expect(deck.metas.length).toBe(5) // 1 due + 2 new + 2 padding, and that is all there is
    expect(deck.metas.length).toBeLessThan(18)
    expect(deck.stats).toMatchObject({ due: 1, introduced: 2, padding: 2 })
  })

  it('counts new metas toward minSize before padding', () => {
    const cards = { [T1[0]]: card({ due: plus(T0, 5).toISOString() }) }
    const deck = buildDeck(cards, CATALOG, { minNew: 4, minSize: 4 }, T0)
    expect(deck.stats).toMatchObject({ due: 0, introduced: 4, padding: 0, total: 4 })
  })

  it('applies the documented defaults of 5 new and 18 minimum', () => {
    const cards = everything()
    const withDefaults = buildDeck(cards, CATALOG, {}, T0)
    expect(withDefaults).toEqual(buildDeck(cards, CATALOG, { minNew: 5, minSize: 18 }, T0))
    expect(withDefaults.metas.length).toBe(15) // every card there is, still under 18
  })
})

describe('rankDeck', () => {
  const LADDER = [...T1, ...T2, ...T3]

  /**
   * Every meta already carried, none of them owed: due dates walk out from
   * T0+1, so ascending catalog order is also ascending retrievability.
   */
  function fullTable(overrides = {}) {
    const cards = {}
    for (const [i, name] of LADDER.entries()) {
      cards[name] = card({ due: plus(T0, i + 1).toISOString(), scheduledDays: 30, stability: 30 })
    }
    return { ...cards, ...overrides }
  }

  /** A catalog of `count` unseen metas, for testing the cap against a real backlog. */
  const wideCatalog = (count) => [
    {
      mapId: 'lm-wide',
      name: 'Wide',
      tier: 1,
      metas: Array.from({ length: count }, (_, i) => `meta ${i}`),
    },
  ]

  const names = (deck) => deck.metas.map((m) => m.name)
  const kinds = (deck) => deck.metas.map((m) => m.kind)

  /** A card stamped as introduced at `when`, the way gradeRound stamps one. */
  const introducedAt = (name, when) => ({
    [name]: { ...card({ due: plus(when, 10).toISOString() }), firstSeen: when.toISOString() },
  })

  it('leads with the review work and fills the rest with new metas', () => {
    const cards = {
      [T1[1]]: card({ due: plus(T0, -30).toISOString(), stability: 2, scheduledDays: 2 }),
      [T2[0]]: card({ due: plus(T0, -10).toISOString(), stability: 5, scheduledDays: 5 }),
    }
    const unseen = LADDER.filter((n) => !cards[n])
    const deck = rankDeck(cards, CATALOG, { limit: 99 }, T0)

    // what is owed, weakest first, and then the day's allowance of new material
    expect(names(deck)).toEqual([T1[1], T2[0], ...unseen.slice(0, DEFAULT_DAILY_NEW)])
    expect(kinds(deck)).toEqual(['due', 'due', ...unseen.slice(0, DEFAULT_DAILY_NEW).map(() => 'new')])
    // the three unseen metas past the allowance are not filler at the tail — they are absent
    expect(deck.stats).toEqual({
      new: 10,
      due: 2,
      future: 0,
      newAvailable: 13,
      newAllowance: 10,
      doneForToday: false,
      total: 12,
      unlockedTiers: 1,
    })
  })

  it('admits a day of new metas by default, however deep the backlog', () => {
    expect(DEFAULT_DAILY_NEW).toBe(10)
    const deck = rankDeck({}, wideCatalog(100), { limit: 99 }, T0)
    expect(deck.metas).toHaveLength(10)
    expect(deck.metas[0]).toMatchObject({ name: 'meta 0', kind: 'new', priority: 0 })
    expect(names(deck)).toEqual(wideCatalog(10)[0].metas) // ladder order, the first ten
    expect(deck.stats).toMatchObject({ new: 10, newAvailable: 100, newAllowance: 10, total: 10 })
  })

  it('spends the allowance across the day rather than per deck', () => {
    const catalog = wideCatalog(100)
    const spent = (count) =>
      Object.assign({}, ...Array.from({ length: count }, (_, i) => introducedAt(`meta ${i}`, plus(T0, -0.1))))

    expect(rankDeck(spent(4), catalog, { limit: 99 }, T0).stats).toMatchObject({ newAllowance: 6, new: 6 })
    expect(rankDeck(spent(10), catalog, { limit: 99 }, T0).stats).toMatchObject({ newAllowance: 0, new: 0 })
    // never negative, however hard the player pushed
    expect(rankDeck(spent(14), catalog, { limit: 99 }, T0).stats).toMatchObject({ newAllowance: 0, new: 0 })
    // and the whole allowance is back once yesterday's introductions age out
    expect(rankDeck(spent(10), catalog, { limit: 99 }, plus(T0, 1)).stats).toMatchObject({
      newAllowance: 10,
      new: 10,
    })
  })

  it("takes the host's configured allowance over the default", () => {
    const catalog = wideCatalog(100)
    expect(rankDeck({}, catalog, { limit: 99, dailyNew: 3 }, T0).stats).toMatchObject({
      new: 3,
      newAllowance: 3,
    })
    expect(rankDeck(introducedAt('meta 0', T0), catalog, { limit: 99, dailyNew: 3 }, T0).stats).toMatchObject({
      new: 2,
      newAllowance: 2,
    })
  })

  it('counts the metas a played round actually introduced', () => {
    // End to end: gradeRound stamps the introduction, rankDeck reads the stamp.
    let cards = {}
    let now = T0
    for (const name of T1) {
      cards = gradeRound(cards, { metaName: name, correct: true }, now)
      now = new Date(now.getTime() + 60_000) // a round apiece
    }
    expect(newIntroducedToday(cards, now)).toBe(5)
    expect(rankDeck(cards, CATALOG, { limit: 99 }, now).stats).toMatchObject({
      newAllowance: 5,
      new: 5,
      newAvailable: 10,
    })
  })

  it('gives a full deck of due work no room for new material', () => {
    // The backlog throttle, and the point of due-first: a fortnight away leaves
    // more reviews owed than a ten-location map can hold, so nothing new is
    // introduced until the debt is paid down.
    const cards = {}
    for (const [i, name] of LADDER.entries())
      cards[name] = card({ due: plus(T0, -i - 1).toISOString(), stability: 5, scheduledDays: 5 })
    delete cards[T3[3]]
    delete cards[T3[4]]

    const deck = rankDeck(cards, CATALOG, { limit: 10 }, T0)
    expect(kinds(deck)).toEqual(Array(10).fill('due'))
    expect(deck.stats).toMatchObject({ new: 0, due: 10, newAvailable: 2, newAllowance: 10, doneForToday: false })
  })

  it('returns pure review at newLimit 0, while still reporting the backlog', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: plus(T0, -1).toISOString(), stability: 6, scheduledDays: 6 }),
    })
    delete cards[T3[4]]
    const deck = rankDeck(cards, CATALOG, { limit: 99, newLimit: 0 }, T0)

    expect(kinds(deck)).not.toContain('new')
    expect(names(deck)[0]).toBe(T1[0])
    expect(deck.stats).toMatchObject({ new: 0, due: 1, newAvailable: 1 })
  })

  it('front-loads the whole unseen backlog at newLimit Infinity', () => {
    const cards = {
      [T1[1]]: card({ due: plus(T0, -30).toISOString(), stability: 2, scheduledDays: 2 }),
      [T2[0]]: card({ due: plus(T0, -10).toISOString(), stability: 5, scheduledDays: 5 }),
    }
    const unseen = LADDER.filter((n) => !cards[n])
    const deck = rankDeck(cards, CATALOG, { limit: 99, newLimit: Infinity }, T0)

    expect(names(deck)).toEqual([T1[1], T2[0], ...unseen])
    expect(kinds(deck)).toEqual(['due', 'due', ...unseen.map(() => 'new')])
    expect(deck.stats).toMatchObject({ new: 13, due: 2, newAvailable: 13, total: 15 })
  })

  it('lets an explicit newLimit override the day, in both directions', () => {
    const catalog = wideCatalog(40)
    const spent = Object.assign(
      {},
      ...Array.from({ length: 10 }, (_, i) => introducedAt(`meta ${i}`, plus(T0, -0.1))),
    )
    // the day is spent, but the override is the caller's business
    expect(rankDeck(spent, catalog, { limit: 99, newLimit: 4 }, T0).stats).toMatchObject({
      new: 4,
      newAllowance: 0,
    })
    // and it steers this deck without rewriting what the day still owes
    expect(rankDeck({}, catalog, { limit: 99, newLimit: 0 }, T0).stats).toMatchObject({
      new: 0,
      newAllowance: 10,
    })
  })

  it('reports the true backlog in newAvailable however small the deck', () => {
    const deck = rankDeck({}, wideCatalog(40), { limit: 3, newLimit: 2 }, T0)
    expect(deck.metas).toHaveLength(2) // the cap binds before the limit does
    expect(deck.stats).toMatchObject({ new: 2, newAvailable: 40, total: 2 })
  })

  it('spends a one-entry deck on the review it owes, not the new meta', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: plus(T0, -9).toISOString(), stability: 4, scheduledDays: 4 }),
      [T2[1]]: card({ due: plus(T0, -4).toISOString(), stability: 9, scheduledDays: 9 }),
    })
    delete cards[T3[4]]
    const deck = rankDeck(cards, CATALOG, { limit: 1 }, T0)
    expect(deck.metas).toHaveLength(1)
    expect(deck.metas[0]).toMatchObject({ name: T1[0], kind: 'due' })
    // the unseen meta had the allowance for it and still lost to the debt
    expect(deck.stats).toMatchObject({ new: 0, due: 1, newAvailable: 1, newAllowance: 10, total: 1 })
  })

  it('orders due cards by retrievability, weakest memory first', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: '2026-02-27T00:00:00Z', stability: 40, scheduledDays: 40 }),
      [T1[1]]: card({ due: '2026-02-01T00:00:00Z', stability: 10, scheduledDays: 10 }),
      [T1[2]]: card({ due: '2026-02-28T00:00:00Z', stability: 3, scheduledDays: 3 }),
    })
    const deck = rankDeck(cards, CATALOG, { limit: 3 }, T0)
    const recall = (name) => fsrs().get_retrievability(cards[name], T0, false)

    expect(kinds(deck)).toEqual(['due', 'due', 'due'])
    expect(names(deck)).toEqual([T1[1], T1[2], T1[0]])
    expect(deck.metas.map((m) => m.priority)).toEqual(names(deck).map(recall))
  })

  it('breaks equal recall toward the card that has waited longest', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: T0.toISOString(), stability: 10, scheduledDays: 10 }),
      [T1[1]]: card({ due: plus(T0, -20).toISOString(), stability: 10, scheduledDays: 10 }),
    })
    const deck = rankDeck(cards, CATALOG, { limit: 2 }, T0)
    expect(names(deck)).toEqual([T1[1], T1[0]])
  })

  it('holds not-yet-due cards behind every due one, and only when asked for extra', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: plus(T0, -1).toISOString(), scheduledDays: 30, stability: 30 }),
    })
    const owed = rankDeck(cards, CATALOG, { limit: 1 }, T0)
    expect(names(owed)).toEqual([T1[0]])
    expect(owed.stats).toMatchObject({ new: 0, due: 1, future: 0, newAvailable: 0, total: 1 })

    const padded = rankDeck(cards, CATALOG, { limit: 4 }, T0)
    expect(kinds(padded)).toEqual(['due', 'future', 'future', 'future'])
    expect(names(padded)).toEqual([T1[0], T1[1], T1[2], T1[3]])
    expect(padded.stats).toMatchObject({ due: 1, future: 3, total: 4 })
  })

  it('returns future cards rather than nothing when the whole ladder is ahead', () => {
    const deck = rankDeck(fullTable(), CATALOG, { limit: 3 }, T0)
    expect(deck.metas).toHaveLength(3)
    expect(kinds(deck)).toEqual(['future', 'future', 'future'])
    expect(names(deck)).toEqual([T1[0], T1[1], T1[2]])
    expect(deck.stats).toMatchObject({ new: 0, due: 0, future: 3, newAvailable: 0, total: 3 })
  })

  it('calls the day done only once nothing is owed and no new meta may follow', () => {
    const done = (cards, opts = {}) => rankDeck(cards, CATALOG, { limit: 99, ...opts }, T0).stats.doneForToday

    // work outstanding in either form keeps the session open
    expect(done(fullTable({ [T1[0]]: card({ due: plus(T0, -1).toISOString() }) }))).toBe(false)
    expect(done({})).toBe(false) // nothing due, but fifteen metas waiting to be met

    // nothing due and the ladder exhausted: there is no more work to be had
    expect(done(fullTable())).toBe(true)
    // nothing due and today's allowance already spent on other metas
    const spent = Object.assign(
      {},
      ...LADDER.slice(0, 10).map((name) => introducedAt(name, plus(T0, -0.1))),
    )
    expect(done(spent)).toBe(true)
    // ...which is a fact about today, not about the ladder: tomorrow it reopens
    expect(rankDeck(spent, CATALOG, { limit: 99 }, plus(T0, 1)).stats.doneForToday).toBe(false)
  })

  it('sorts by priority inside each group, and by group across the deck', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: plus(T0, -9).toISOString(), stability: 4, scheduledDays: 4 }),
      [T2[0]]: card({ due: plus(T0, -2).toISOString(), stability: 20, scheduledDays: 20 }),
    })
    delete cards[T3[0]] // one unseen meta, which the group order parks behind the reviews
    const deck = rankDeck(cards, CATALOG, { limit: 99 }, T0)

    expect(kinds(deck)).toEqual(['due', 'due', 'new', ...Array(12).fill('future')])
    for (const kind of ['due', 'new', 'future']) {
      const within = deck.metas.filter((m) => m.kind === kind).map((m) => m.priority)
      expect(within).toEqual([...within].sort((a, b) => a - b))
    }
    // a new meta reports 0 and still sits behind reviews that report more: the
    // group is the policy, the number only orders within it
    expect(deck.metas[2].priority).toBe(0)
    expect(deck.metas[1].priority).toBeGreaterThan(0)
  })

  it('truncates at limit without reordering', () => {
    const cards = fullTable({
      [T1[0]]: card({ due: plus(T0, -1).toISOString(), stability: 6, scheduledDays: 6 }),
      [T2[1]]: card({ due: plus(T0, -4).toISOString(), stability: 9, scheduledDays: 9 }),
    })
    delete cards[T3[4]]
    const whole = rankDeck(cards, CATALOG, { limit: 99 }, T0)
    for (const size of [0, 1, 4, 9]) {
      const cut = rankDeck(cards, CATALOG, { limit: size }, T0)
      expect(cut.metas).toEqual(whole.metas.slice(0, size))
      expect(cut.stats.total).toBe(size)
      expect(cut.stats.newAvailable).toBe(whole.stats.newAvailable)
    }
  })

  it('returns pure new material from an empty card table, a day of it', () => {
    const deck = rankDeck({}, CATALOG, { limit: 99 }, T0)
    expect(deck.metas[0]).toEqual({ name: T1[0], mapId: 'lm-tier1', priority: 0, kind: 'new' })
    expect(names(deck)).toEqual([...T1, ...T2]) // ten, the lowest rungs first
    expect(deck.stats).toEqual({
      new: 10,
      due: 0,
      future: 0,
      newAvailable: 15,
      newAllowance: 10,
      doneForToday: false,
      total: 10,
      unlockedTiers: 1,
    })
  })

  it('never pads to a minimum: three entries available means three returned', () => {
    const small = [{ mapId: 'lm-tiny', name: 'Tiny', tier: 1, metas: T1.slice(0, 3) }]
    const deck = rankDeck({}, small, { limit: 25, newLimit: Infinity }, T0)
    expect(deck.metas).toHaveLength(3)
    expect(deck.stats.total).toBe(3)
  })

  it('lists a meta once when it appears on two maps, at its easiest', () => {
    const shared = T1[0]
    const catalog = [CATALOG[0], { ...CATALOG[1], metas: [shared, ...T2] }]
    const cards = { ...mastered(T1, 5, { due: plus(T0, -3).toISOString() }) }
    const deck = rankDeck(cards, catalog, { limit: 99, newLimit: Infinity }, T0)

    expect(names(deck).filter((n) => n === shared)).toHaveLength(1)
    expect(new Set(names(deck)).size).toBe(deck.metas.length)
    expect(deck.metas.find((m) => m.name === shared).mapId).toBe('lm-tier1')
  })

  it('defaults to five games worth of locations', () => {
    const cards = {}
    for (const [i, name] of wideCatalog(40)[0].metas.entries()) {
      cards[name] = card({ due: plus(T0, i + 1).toISOString(), scheduledDays: 30, stability: 30 })
    }
    const deck = rankDeck(cards, wideCatalog(40), {}, T0)
    expect(deck.metas).toHaveLength(25)
    expect(deck).toEqual(rankDeck(cards, wideCatalog(40), { limit: 25 }, T0))
  })

  it('reads state without writing it', () => {
    const cards = fullTable({ [T1[0]]: card({ due: plus(T0, -1).toISOString() }) })
    const snapshot = structuredClone(cards)
    rankDeck(cards, CATALOG, { limit: 99 }, T0)
    expect(cards).toEqual(snapshot)
  })

  it('survives an empty catalog', () => {
    expect(rankDeck({}, [], {}, T0)).toEqual({
      metas: [],
      stats: {
        new: 0,
        due: 0,
        future: 0,
        newAvailable: 0,
        newAllowance: 10,
        doneForToday: true,
        total: 0,
        unlockedTiers: 1,
      },
    })
  })
})

describe('deckSummary', () => {
  it('reports an untouched ladder', () => {
    expect(deckSummary({}, CATALOG, T0)).toEqual({
      due: 0,
      learning: 0,
      unseen: 15, // the whole ladder: introductions are ordered, never locked
      unlockedTiers: 1,
      nextDue: null,
    })
  })

  it('counts due, learning and unseen across the whole ladder', () => {
    const cards = {
      ...mastered(T1, 4, { due: plus(T0, 12).toISOString() }),
      [T1[0]]: card({ due: plus(T0, -1).toISOString() }),
      [T1[4]]: card({ due: plus(T0, 4).toISOString(), state: State.Relearning, scheduledDays: 0 }),
      [T2[0]]: card({ due: plus(T0, 2).toISOString(), state: State.Learning, scheduledDays: 0 }),
    }
    const summary = deckSummary(cards, CATALOG, T0)
    expect(summary).toEqual({
      due: 1,
      learning: 2,
      unseen: 9, // four of tier 2 plus all of tier 3 are untouched
      unlockedTiers: 2,
      nextDue: plus(T0, 2).toISOString(),
    })
  })

  it('looks strictly forward for nextDue', () => {
    const cards = {
      [T1[0]]: card({ due: plus(T0, -3).toISOString() }),
      [T1[1]]: card({ due: plus(T0, -9).toISOString() }),
    }
    expect(deckSummary(cards, CATALOG, T0)).toMatchObject({ due: 2, nextDue: null })
  })

  it('counts a due card on a high tier even while the scoreboard reads tier 1', () => {
    const cards = { [T3[0]]: card({ due: plus(T0, -1).toISOString() }) }
    expect(deckSummary(cards, CATALOG, T0)).toMatchObject({ due: 1, unseen: 14, unlockedTiers: 1 })
  })

  it('tracks the same ladder the deck is built from', () => {
    const cards = { ...mastered(T1, 5, { due: plus(T0, -1).toISOString() }) }
    const summary = deckSummary(cards, CATALOG, T0)
    const deck = buildDeck(cards, CATALOG, { minNew: 0, minSize: 0 }, T0)
    expect(summary.due).toBe(deck.stats.due)
    expect(summary.unlockedTiers).toBe(deck.stats.unlockedTiers)
  })
})

describe('rankDeck with duel weights', () => {
  // Country-prefixed names, the way every catalog meta is actually named —
  // the prefix is what the weights key on.
  const WCAT = [
    {
      mapId: 'lm-weighted',
      name: 'Weighted',
      tier: 1,
      metas: ['Mexico: one', 'Mexico: two', 'Mexico: three', 'Brazil: one', 'Brazil: two', 'Russia: one'],
    },
  ]
  const newNames = (deck) => deck.metas.filter((m) => m.kind === 'new').map((m) => m.name)
  /** A card born inside the rolling day ending at T0, holding a slot against
   * its country's interleave cap. */
  const dealtToday = () => ({
    ...card({ due: plus(T0, 10).toISOString() }),
    firstSeen: at('2026-02-28T20:00:00Z').toISOString(),
  })

  it('keeps the ladder order when no weights are given', () => {
    const deck = rankDeck({}, WCAT, { limit: 99 }, T0)
    expect(newNames(deck)).toEqual([
      'Mexico: one',
      'Mexico: two',
      'Mexico: three',
      'Brazil: one',
      'Brazil: two',
      'Russia: one',
    ])
  })

  it('leads with the countries that cost the most, ladder order inside each', () => {
    const deck = rankDeck({}, WCAT, { limit: 99, newWeights: { Brazil: 9000, Russia: 400 } }, T0)
    expect(newNames(deck)).toEqual([
      'Brazil: one',
      'Brazil: two',
      'Russia: one',
      'Mexico: one',
      'Mexico: two',
      'Mexico: three',
    ])
  })

  it('defers a third clue from one country behind everyone still under the cap', () => {
    const deck = rankDeck({}, WCAT, { limit: 99, newWeights: { Mexico: 9000 } }, T0)
    // Mexico leads on weight, but its third clue waits for the other
    // countries — the all-Mexico run this ordering exists to end.
    expect(newNames(deck)).toEqual([
      'Mexico: one',
      'Mexico: two',
      'Brazil: one',
      'Brazil: two',
      'Russia: one',
      'Mexico: three',
    ])
  })

  it("counts clues already introduced today against the country's cap", () => {
    const cards = { 'Mexico: dealt-a': dealtToday(), 'Mexico: dealt-b': dealtToday() }
    const deck = rankDeck(cards, WCAT, { limit: 99, newWeights: { Mexico: 9000 } }, T0)
    // Two Mexican clues this morning means every unseen Mexican clue defers,
    // however heavy the weight.
    expect(newNames(deck)).toEqual([
      'Brazil: one',
      'Brazil: two',
      'Russia: one',
      'Mexico: one',
      'Mexico: two',
      'Mexico: three',
    ])
  })

  it('spends the allowance anyway when only capped countries remain', () => {
    const only = [{ mapId: 'lm-mx', name: 'MX', tier: 1, metas: ['Mexico: one', 'Mexico: two', 'Mexico: three', 'Mexico: four'] }]
    const deck = rankDeck({}, only, { limit: 99, newWeights: { Mexico: 1 } }, T0)
    expect(newNames(deck)).toEqual(['Mexico: one', 'Mexico: two', 'Mexico: three', 'Mexico: four'])
  })

  it('previews exactly what the deck would deal, given the same weights', () => {
    const opts = { newWeights: { Brazil: 9000, Russia: 400 } }
    const deck = rankDeck({}, WCAT, { limit: 99, ...opts }, T0)
    expect(nextNewMetas({}, WCAT, 4, opts, T0)).toEqual(newNames(deck).slice(0, 4))
  })
})
