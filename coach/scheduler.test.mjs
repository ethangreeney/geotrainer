import { describe, expect, it } from 'vitest'
import { fsrs, State } from 'ts-fsrs'
import {
  buildDeck,
  deckSummary,
  gradeRound,
  MASTERY_DAYS,
  PINPOINT_SCORE,
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
const drill = (cards, metaName, correctCountry, score, now) =>
  gradeRound(cards, { metaName, correctCountry, score }, now)

describe('gradeRound', () => {
  it('creates a card on first sighting of a meta', () => {
    const cards = drill({}, T1[0], true, 3000, T0)
    expect(Object.keys(cards)).toEqual([T1[0]])
    expect(cards[T1[0]]).toMatchObject({ seen: 1, correct: 1, streak: 1, source: 'round', reps: 1 })
    expect(cards[T1[0]].last_review).toBe(T0.toISOString())
  })

  it('serialises to plain JSON so state.json round-trips', () => {
    const cards = drill({}, T1[0], true, 3000, T0)
    expect(JSON.parse(JSON.stringify(cards))).toEqual(cards)
    expect(typeof cards[T1[0]].due).toBe('string')
    expect(new Date(cards[T1[0]].due).toISOString()).toBe(cards[T1[0]].due)
  })

  it('does not mutate the table it was given', () => {
    const before = drill({}, T1[0], true, 3000, T0)
    const snapshot = structuredClone(before)
    const after = drill(before, T1[0], true, 3000, plus(T0, 1))
    expect(before).toEqual(snapshot)
    expect(after).not.toBe(before)
    expect(after[T1[0]].seen).toBe(2)
  })

  it('passes rounds with no identified meta straight through', () => {
    const cards = drill({}, T1[0], true, 3000, T0)
    const after = gradeRound(cards, { metaName: null, correctCountry: false, score: 0 }, T0)
    expect(after).toEqual(cards)
    expect(after).not.toBe(cards)
  })

  it('counts a streak of correct answers', () => {
    let cards = {}
    let now = T0
    for (let i = 0; i < 3; i++) {
      cards = drill(cards, T1[0], true, 3000, now)
      now = at(cards[T1[0]].due)
    }
    expect(cards[T1[0]]).toMatchObject({ seen: 3, correct: 3, streak: 3 })
  })

  it('resets the streak and collapses the interval on a wrong country', () => {
    let cards = {}
    let now = T0
    for (let i = 0; i < 4; i++) {
      cards = drill(cards, T1[0], true, 3000, now)
      now = at(cards[T1[0]].due)
    }
    const before = cards[T1[0]]
    expect(before.streak).toBe(4)
    expect(before.scheduled_days).toBeGreaterThan(0)

    const after = drill(cards, T1[0], false, 200, now)[T1[0]]
    expect(after.streak).toBe(0)
    expect(after.correct).toBe(4) // a miss never un-earns past correct answers
    expect(after.seen).toBe(5)
    expect(after.lapses).toBe(before.lapses + 1)
    expect(after.scheduled_days).toBeLessThan(before.scheduled_days)
    // graded at the moment it fell due, a miss comes back within the hour,
    // where the same round answered correctly would have pushed weeks out
    const ifCorrect = drill(cards, T1[0], true, 3000, now)[T1[0]]
    expect(at(after.due).getTime()).toBeLessThan(at(ifCorrect.due).getTime())
    expect(at(after.due).getTime() - now.getTime()).toBeLessThan(DAY)
  })

  it('grows the interval faster for a near-pinpoint answer than a plain correct one', () => {
    const good = drill({}, T1[0], true, PINPOINT_SCORE - 1, T0)[T1[0]]
    const easy = drill({}, T1[0], true, PINPOINT_SCORE + 500, T0)[T1[0]]
    expect(at(easy.due).getTime()).toBeGreaterThan(at(good.due).getTime())
    expect(easy.stability).toBeGreaterThan(good.stability)
  })

  it('keeps the easy-beats-good gap on a mature card', () => {
    let base = {}
    let now = T0
    for (let i = 0; i < 3; i++) {
      base = drill(base, T1[0], true, 3000, now)
      now = at(base[T1[0]].due)
    }
    const good = drill(base, T1[0], true, PINPOINT_SCORE - 1, now)[T1[0]]
    const easy = drill(base, T1[0], true, PINPOINT_SCORE, now)[T1[0]]
    expect(easy.scheduled_days).toBeGreaterThan(good.scheduled_days)
  })

  it('treats exactly the pinpoint score as easy and a missing score as good', () => {
    const boundary = drill({}, T1[0], true, PINPOINT_SCORE, T0)[T1[0]]
    const under = drill({}, T1[0], true, PINPOINT_SCORE - 1, T0)[T1[0]]
    const missing = gradeRound({}, { metaName: T1[0], correctCountry: true }, T0)[T1[0]]
    expect(at(boundary.due).getTime()).toBeGreaterThan(at(under.due).getTime())
    expect(missing.stability).toBe(under.stability)
  })

  it('grades a wrong country again even at a high score', () => {
    const wrong = drill({}, T1[0], false, 4900, T0)[T1[0]]
    const right = drill({}, T1[0], true, 4900, T0)[T1[0]]
    expect(wrong.stability).toBeLessThan(right.stability)
    expect(wrong.streak).toBe(0)
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
    let cards = {}
    for (const name of T1) cards = drill(cards, name, true, 3000, T0)
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
  it('fills the deck with tier-one material when nothing is due', () => {
    const deck = buildDeck({}, CATALOG, {}, T0)
    expect(deck.metas).toEqual(T1.slice(0, 5).map((name) => ({ name, mapId: 'lm-tier1' })))
    expect(deck.introduced).toEqual(T1.slice(0, 5))
    expect(deck.stats).toMatchObject({ due: 0, introduced: 5, padding: 0, unlockedTiers: 1 })
  })

  it('leaves the deck short rather than inventing cards to reach minSize', () => {
    const cards = {}
    const deck = buildDeck(cards, CATALOG, { minSize: 18 }, T0)
    expect(deck.metas.length).toBe(5)
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

  it('puts due cards first, then new metas, then padding', () => {
    const cards = {
      [T1[0]]: card({ due: plus(T0, -5).toISOString() }), // due
      [T1[1]]: card({ due: plus(T0, 3).toISOString() }), // padding
      [T1[2]]: card({ due: plus(T0, 9).toISOString() }), // padding
    }
    // room for 3 beyond the due card, but tier 1 only has two unseen left —
    // new material takes priority and padding covers just the shortfall
    const deck = buildDeck(cards, CATALOG, { minNew: 1, minSize: 4 }, T0)
    expect(deck.metas.map((m) => m.name)).toEqual([T1[0], T1[3], T1[4], T1[1]])
    expect(deck.introduced).toEqual([T1[3], T1[4]])
    expect(deck.stats).toMatchObject({ due: 1, introduced: 2, padding: 1, total: 4 })
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

  it('introduces from tier 2 once tier 1 is exhausted, never from a locked tier', () => {
    const cards = { ...mastered(T1, 5), ...mastered(T2, 3) }
    const deck = buildDeck(cards, CATALOG, { minNew: 5, minSize: 0 }, T0)
    expect(deck.introduced).toEqual([T2[3], T2[4]]) // tier 2 has only two left
    expect(deck.stats.unlockedTiers).toBe(2)
    for (const meta of deck.metas) expect(T3).not.toContain(meta.name)
  })

  it('never offers a meta from a locked tier', () => {
    const deck = buildDeck({}, CATALOG, { minNew: 99, minSize: 99 }, T0)
    const names = deck.metas.map((m) => m.name)
    expect(names).toEqual(T1)
    for (const name of [...T2, ...T3]) expect(names).not.toContain(name)
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

describe('deckSummary', () => {
  it('reports an untouched ladder', () => {
    expect(deckSummary({}, CATALOG, T0)).toEqual({
      due: 0,
      learning: 0,
      unseen: 5,
      unlockedTiers: 1,
      nextDue: null,
    })
  })

  it('counts due, learning and unseen across the unlocked ladder', () => {
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
      unseen: 4, // tier 2 is open, and four of its metas are untouched
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

  it('ignores cards belonging to locked tiers', () => {
    const cards = { [T3[0]]: card({ due: plus(T0, -1).toISOString() }) }
    expect(deckSummary(cards, CATALOG, T0)).toMatchObject({ due: 0, unseen: 5, unlockedTiers: 1 })
  })

  it('tracks the same ladder the deck is built from', () => {
    const cards = { ...mastered(T1, 5, { due: plus(T0, -1).toISOString() }) }
    const summary = deckSummary(cards, CATALOG, T0)
    const deck = buildDeck(cards, CATALOG, { minNew: 0, minSize: 0 }, T0)
    expect(summary.due).toBe(deck.stats.due)
    expect(summary.unlockedTiers).toBe(deck.stats.unlockedTiers)
  })
})
