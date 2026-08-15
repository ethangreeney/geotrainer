import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Rating, State } from 'ts-fsrs'
import { CLUES } from '../data/clues'
import { COUNTRIES, isKnownCountry } from '../data/countries'
import { MAP_COUNTRIES } from '../data/worldMap'
import { REGIONS, regionOf } from '../data/regions'
import { buildOptions, pickDistractors } from './distractors'
import { CATEGORIES } from '../data/categories'
import { buildCategoryQueue, buildPairQueue, buildQueue, buildSessionQueue, SESSION_LENGTH } from './queue'
import { TRACKS, trackClues, trackOf } from '../data/tracks'
import { activeTrack, isLearned, MASTERY, trackProgress } from './progress'
import { comparableClue, COMPARE_THRESHOLD, lookalikes, similarity } from './compare'
import { LM_CLUES } from '../data/lm'
import { CURRICULUM } from '../data/curriculum'
import { applyAnswer, BATCH_SIZE, blitzOptions, nextBatch, type BlitzCard } from './blitz'
import { FAST_ANSWER_MS, gradeFor, newCard, reviewCard } from './scheduling'
import {
  computeMatrix,
  emptyState,
  loadState,
  pairKey,
  recordAnswer,
  saveState,
  type StorageLike,
} from './store'
import type { Clue, StoredCard } from '../types'

const clue = (over: Partial<Clue> & Pick<Clue, 'id' | 'country' | 'category'>): Clue => ({
  imageUrl: null,
  description: 'stimulus',
  confusedWith: [],
  notes: 'notes',
  ...over,
})

function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

// ---------------------------------------------------------------- G1
describe('G1 distractor generator', () => {
  it('never returns the correct answer and always returns 3 unique distractors', () => {
    for (const c of CLUES) {
      for (let i = 0; i < 25; i++) {
        const picked = pickDistractors(c)
        expect(picked).toHaveLength(3)
        expect(new Set(picked).size).toBe(3)
        expect(picked).not.toContain(c.country)
      }
    }
  })

  it('prefers confusedWith countries when 3 or more exist', () => {
    const rich = CLUES.filter((c) => c.confusedWith.length >= 3)
    expect(rich.length).toBeGreaterThan(0)
    for (const c of rich) {
      for (let i = 0; i < 25; i++) {
        for (const code of pickDistractors(c)) {
          expect(c.confusedWith).toContain(code)
        }
      }
    }
  })

  it('builds 4 unique options containing the correct answer', () => {
    for (const c of CLUES) {
      const options = buildOptions(c)
      expect(options).toHaveLength(4)
      expect(new Set(options).size).toBe(4)
      expect(options).toContain(c.country)
    }
  })
})

// ---------------------------------------------------------------- G2
describe('G2 confusion matrix', () => {
  const target = clue({ id: 'x', country: 'PL', category: 'bollard' })

  it('increments exactly one pair on a wrong answer', () => {
    const next = recordAnswer(emptyState(), { clue: target, chosen: 'CZ', responseMs: 3000 })
    expect(next.matrix).toEqual({ [pairKey('PL', 'CZ')]: 1 })
    expect(Object.keys(next.matrix)).toHaveLength(1)
    expect(next.log).toHaveLength(1)
  })

  it('increments nothing on a correct answer', () => {
    const next = recordAnswer(emptyState(), { clue: target, chosen: 'PL', responseMs: 3000 })
    expect(next.matrix).toEqual({})
    expect(next.log).toHaveLength(1)
  })

  it('accumulates repeats and matches a recompute from the log', () => {
    let state = emptyState()
    state = recordAnswer(state, { clue: target, chosen: 'CZ', responseMs: 1000 })
    state = recordAnswer(state, { clue: target, chosen: 'CZ', responseMs: 1000 })
    state = recordAnswer(state, { clue: target, chosen: 'SK', responseMs: 1000 })
    state = recordAnswer(state, { clue: target, chosen: 'PL', responseMs: 1000 })
    expect(state.matrix).toEqual({ [pairKey('PL', 'CZ')]: 2, [pairKey('PL', 'SK')]: 1 })
    expect(computeMatrix(state.log)).toEqual(state.matrix)
  })
})

// ---------------------------------------------------------------- G3
describe('G3 FSRS grading', () => {
  it('maps wrong to Again, slow-correct to Good, fast-correct to Easy', () => {
    expect(gradeFor(false, 500)).toBe(Rating.Again)
    expect(gradeFor(false, 30000)).toBe(Rating.Again)
    expect(gradeFor(true, FAST_ANSWER_MS - 1)).toBe(Rating.Easy)
    expect(gradeFor(true, FAST_ANSWER_MS)).toBe(Rating.Good)
    expect(gradeFor(true, 30000)).toBe(Rating.Good)
  })

  it('moves the due date forward and records the review', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const fresh = newCard(now)
    expect(fresh.state).toBe(State.New)

    const reviewed = reviewCard(fresh, true, 8000, now)
    expect(new Date(reviewed.due).getTime()).toBeGreaterThan(now.getTime())
    expect(reviewed.reps).toBe(1)
    expect(reviewed.last_review).toBe(now.toISOString())
  })

  it('schedules a fast-correct answer further out than a wrong answer', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const base = newCard(now)
    const easy = reviewCard(base, true, 1000, now)
    const again = reviewCard(base, false, 1000, now)
    expect(new Date(easy.due).getTime()).toBeGreaterThan(new Date(again.due).getTime())
  })
})

// ---------------------------------------------------------------- G4
describe('G4 session queue', () => {
  const pool: Clue[] = [
    clue({ id: 'b1', country: 'PL', category: 'bollard' }),
    clue({ id: 'b2', country: 'CZ', category: 'bollard' }),
    clue({ id: 'b3', country: 'SK', category: 'bollard' }),
    clue({ id: 'b4', country: 'DE', category: 'bollard' }),
    clue({ id: 'l1', country: 'PL', category: 'language' }),
    clue({ id: 'l2', country: 'CZ', category: 'language' }),
    clue({ id: 'l3', country: 'SK', category: 'language' }),
    clue({ id: 'p1', country: 'NL', category: 'pole' }),
    clue({ id: 'p2', country: 'BE', category: 'pole' }),
    clue({ id: 'p3', country: 'PT', category: 'pole' }),
  ]

  const noThreeInARow = (queue: Clue[]) => {
    for (let i = 2; i < queue.length; i++) {
      const same =
        queue[i].category === queue[i - 1].category && queue[i].category === queue[i - 2].category
      expect(same).toBe(false)
    }
  }

  it('interleaves categories over the real seed set', () => {
    noThreeInARow(buildQueue(CLUES, {}, new Date(), 10))
    noThreeInARow(buildQueue(CLUES, {}, new Date(), CLUES.length))
  })

  it('spreads a fresh session across several different skills', () => {
    const queue = buildQueue(CLUES, {}, new Date(), SESSION_LENGTH)
    expect(new Set(queue.map((c) => c.category)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(buildQueue(CLUES, {}, new Date(), 30).map((c) => c.category)).size).toBeGreaterThanOrEqual(10)
  })

  it('interleaves categories over a clumped pool', () => {
    noThreeInARow(buildQueue(pool, {}, new Date(), 10))
  })

  it('puts due reviews before new clues', () => {
    const now = new Date('2026-01-01T12:00:00Z')
    const past = new Date('2025-12-30T00:00:00Z').toISOString()
    const future = new Date('2026-02-01T00:00:00Z').toISOString()
    const card = (due: string): StoredCard => ({ ...newCard(now), due })

    const cards: Record<string, StoredCard> = {
      b1: card(past),
      l1: card(past),
      p1: card(future), // scheduled ahead: must not appear
    }

    const queue = buildQueue(pool, cards, now, 10)
    const dueIds = new Set(['b1', 'l1'])
    const firstNew = queue.findIndex((c) => !dueIds.has(c.id))

    expect(
      queue
        .slice(0, 2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['b1', 'l1'])
    expect(firstNew).toBe(2)
    expect(queue.map((c) => c.id)).not.toContain('p1')
  })

  it('restricts a focused skill drill to that one category and always fills it', () => {
    for (const category of CATEGORIES) {
      const queue = buildCategoryQueue(CLUES, category.id, {}, new Date())
      expect(queue.length, category.id).toBe(SESSION_LENGTH)
      for (const c of queue) expect(c.category).toBe(category.id)
      expect(new Set(queue.map((c) => c.id)).size).toBe(queue.length)
    }
  })

  it('still fills a focused drill when every card is scheduled ahead', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const future = new Date('2026-06-01T00:00:00Z').toISOString()
    const cards: Record<string, StoredCard> = {}
    for (const c of CLUES) cards[c.id] = { ...newCard(now), due: future }

    const queue = buildCategoryQueue(CLUES, 'bollard', cards, now)
    expect(queue).toHaveLength(SESSION_LENGTH)
    for (const c of queue) expect(c.category).toBe('bollard')
  })

  it('restricts a targeted pair drill to the two countries', () => {
    const queue = buildPairQueue(CLUES, 'PL', 'CZ')
    expect(queue.length).toBeGreaterThan(0)
    for (const c of queue) expect(['PL', 'CZ']).toContain(c.country)
  })
})

// ---------------------------------------------------------------- G5
describe('G5 localStorage round-trip', () => {
  it('reloads an identical state', () => {
    const storage = memoryStorage()
    const now = new Date('2026-01-01T00:00:00Z')
    let state = emptyState()
    state = recordAnswer(state, { clue: CLUES[0], chosen: 'CZ', responseMs: 4000, now })
    state = recordAnswer(state, {
      clue: CLUES[1],
      chosen: CLUES[1].country,
      responseMs: 2000,
      now,
    })

    saveState(state, storage)
    expect(loadState(storage)).toEqual(state)
  })

  it('returns empty state when storage is empty or corrupt', () => {
    const storage = memoryStorage()
    expect(loadState(storage)).toEqual(emptyState())
    storage.setItem('geotrainer.state.v1', '{not json')
    expect(loadState(storage)).toEqual(emptyState())
  })
})

// ---------------------------------------------------------------- G6
describe('G6 seed data', () => {
  it('has 40+ clues with unique ids', () => {
    expect(CLUES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CLUES.map((c) => c.id)).size).toBe(CLUES.length)
  })

  it('covers at least 3 categories', () => {
    expect(new Set(CLUES.map((c) => c.category)).size).toBeGreaterThanOrEqual(3)
  })

  it('names every category a clue uses, and offers no empty training mode', () => {
    const used = new Set<string>(CLUES.map((c) => c.category))
    const named = new Set(CATEGORIES.map((c) => c.id))
    for (const id of used) expect(named.has(id), id).toBe(true)
    for (const c of CATEGORIES) {
      expect(used.has(c.id), c.id).toBe(true)
      expect(CLUES.filter((x) => x.category === c.id).length).toBeGreaterThanOrEqual(SESSION_LENGTH)
      expect(c.blurb.length).toBeGreaterThan(20)
    }
  })

  it('frames every continent with countries it actually contains', () => {
    for (const r of REGIONS) {
      expect(r.frame.length, r.id).toBeGreaterThanOrEqual(5)
      for (const code of r.frame) expect(r.members, `${r.id} ${code}`).toContain(code)
    }
  })

  it('uses only known ISO codes and never lists itself as a confusion', () => {
    for (const c of CLUES) {
      expect(isKnownCountry(c.country), `${c.id} country ${c.country}`).toBe(true)
      expect(new Set(c.confusedWith).size).toBe(c.confusedWith.length)
      for (const code of c.confusedWith) {
        expect(isKnownCountry(code), `${c.id} confusedWith ${code}`).toBe(true)
        expect(code).not.toBe(c.country)
      }
    }
  })

  it('has a substantive description for every clue and a source it came from', () => {
    for (const c of CLUES) {
      expect(c.description.trim().length, c.id).toBeGreaterThan(20)
      expect(c.source, c.id).toMatch(/^https:\/\/www\.plonkit\.net\/[a-z0-9-]+$/)
    }
  })

  it('points every clue at a Plonk It image on the resizing CDN', () => {
    for (const c of CLUES) {
      expect(c.imageUrl, c.id).toMatch(/^https:\/\/www\.plonkit\.net\/images\/resize\/\d+\/80\/\S+$/)
    }
    // Hotlinked, so a duplicate URL would mean the same photo asked twice.
    expect(new Set(CLUES.map((c) => c.imageUrl)).size).toBe(CLUES.length)
  })

  it('spans the world rather than one continent', () => {
    const continents = new Set(CLUES.map((c) => regionOf(c.country)?.id))
    expect(continents.size).toBeGreaterThanOrEqual(6)
    expect(new Set(CLUES.map((c) => c.country)).size).toBeGreaterThanOrEqual(100)
  })

  it('can draw every country a drill can answer with', () => {
    const drawable = new Set(MAP_COUNTRIES.map((c) => c.id))
    for (const c of CLUES) expect(drawable.has(c.country), c.country).toBe(true)
    for (const country of COUNTRIES) {
      expect(drawable.has(country.code), country.code).toBe(true)
      expect(regionOf(country.code), country.code).toBeDefined()
    }
  })

  it('assigns every drawable country to exactly one continent', () => {
    const seen = new Set<string>()
    for (const r of REGIONS) {
      for (const m of r.members) {
        expect(seen.has(m), m).toBe(false)
        seen.add(m)
      }
    }
  })

  it('ships flag artwork for every country a drill can offer', () => {
    for (const country of COUNTRIES) {
      const file = resolve('public/flags', `${country.code.toLowerCase()}.svg`)
      expect(existsSync(file), country.code).toBe(true)
    }
  })
})

describe('learning path', () => {
  it('assigns every clue to exactly one of the three tracks', () => {
    const ids = new Set(TRACKS.map((t) => t.id))
    let total = 0
    for (const id of ids) total += trackClues(CLUES, id).length
    expect(total).toBe(CLUES.length)
    for (const c of CLUES) expect(ids.has(trackOf(c))).toBe(true)
  })

  it('keeps the starter track small, curated and high-signal', () => {
    const starter = trackClues(CLUES, 'starter')
    expect(starter.length).toBeGreaterThanOrEqual(80)
    expect(starter.length).toBeLessThanOrEqual(160)
    // One flagship clue per country and skill, never a dump of a whole guide.
    const pairs = new Set(starter.map((c) => `${c.country}|${c.category}`))
    expect(pairs.size).toBe(starter.length)
    // The majors are all on the ramp.
    const langs = new Set(starter.filter((c) => c.category === 'language').map((c) => c.country))
    for (const major of ['JP', 'TH', 'KR', 'RU', 'DE', 'FR', 'ES', 'PT', 'FI', 'SE']) {
      if (CLUES.some((c) => c.country === major && c.category === 'language'))
        expect(langs.has(major), major).toBe(true)
    }
  })

  it('introduces new material only from the active track', () => {
    const queue = buildSessionQueue(CLUES, {}, new Date(), SESSION_LENGTH)
    expect(queue.length).toBe(SESSION_LENGTH)
    for (const c of queue) expect(trackOf(c)).toBe('starter')
  })

  it('keeps reviews from earlier tracks alive after advancing', () => {
    // Master the starter track, leave one card due: the due review must appear
    // even though new material now comes from the core track.
    const cards: Record<string, StoredCard> = {}
    const starter = trackClues(CLUES, 'starter')
    const past = new Date('2026-01-01T00:00:00Z')
    for (const c of starter) {
      cards[c.id] = {
        due: '2099-01-01T00:00:00.000Z', stability: 30, difficulty: 5,
        elapsed_days: 0, scheduled_days: 30, learning_steps: 0,
        reps: 3, lapses: 0, state: State.Review,
      }
    }
    cards[starter[0].id] = { ...cards[starter[0].id], due: past.toISOString() }
    expect(activeTrack(CLUES, cards)).toBe('core')
    const queue = buildSessionQueue(CLUES, cards, new Date(), SESSION_LENGTH)
    expect(queue[0].id).toBe(starter[0].id)
    for (const c of queue.slice(1)) expect(trackOf(c)).toBe('core')
  })

  it('starts a fresh language drill with the major languages', () => {
    const queue = buildCategoryQueue(CLUES, 'language', {}, new Date(), SESSION_LENGTH)
    expect(queue.length).toBe(SESSION_LENGTH)
    for (const c of queue) expect(trackOf(c)).toBe('starter')
  })

  it('reports mastery from graduated cards only', () => {
    const rows = trackProgress(CLUES, {})
    for (const row of rows) {
      expect(row.learned).toBe(0)
      expect(row.mastered).toBe(false)
    }
    expect(MASTERY).toBeGreaterThan(0.5)
    expect(isLearned(undefined)).toBe(false)
  })
})

describe('debrief comparison', () => {
  it('finds the rival clue about the same feature when one exists', () => {
    const target = CLUES.find(
      (c) => c.country === 'AL' && c.description.includes('backs of road signs'),
    )!
    const rival = comparableClue('DE', target)
    expect(rival).not.toBeNull()
    expect(rival!.country).toBe('DE')
    expect(rival!.description.toLowerCase()).toContain('sign backs')
  })

  it('returns nothing rather than an unrelated clue', () => {
    const target = CLUES.find(
      (c) => c.country === 'AL' && c.description.includes('chevrons are white on black'),
    )!
    // Germany's guide says nothing about chevrons; a "comparison" would mislead.
    expect(comparableClue('DE', target)).toBeNull()
  })

  it('scores same-feature pairs far above unrelated ones', () => {
    const chevronAL = CLUES.find((c) => c.description.includes('chevrons are white on black'))!
    const chevronME = CLUES.find((c) => c.country === 'ME' && c.description.includes('chevrons'))!
    expect(similarity(chevronAL, chevronME)).toBeGreaterThan(COMPARE_THRESHOLD)
  })

  it('always compares within single-object skills like bollards', () => {
    // Any two national bollards are the same feature even when the words differ.
    const target = CLUES.find((c) => c.country === 'AL' && c.category === 'bollard')!
    const rival = comparableClue('FR', target)
    expect(rival).not.toBeNull()
    expect(rival!.country).toBe('FR')
    expect(rival!.category).toBe('bollard')
  })

  it('matches diffuse-category clues that name the same feature', () => {
    // Argentine chevron vs Turkey: Turkey's guide has three chevron clues, so
    // "nothing to compare" would be flatly wrong even though the prose differs.
    const target = CLUES.find(
      (c) => c.country === 'AR' && c.description.includes('white-and-red chevrons'),
    )!
    const rival = comparableClue('TR', target)
    expect(rival).not.toBeNull()
    expect(rival!.description.toLowerCase()).toContain('chevron')
  })

  it('lists the countries that share a tell, palette included', () => {
    const target = CLUES.find(
      (c) => c.country === 'AR' && c.description.includes('white-and-red chevrons'),
    )!
    const twins = lookalikes(target)
    expect(twins.length).toBeGreaterThan(0)
    const countries = twins.map((t) => t.country)
    // Red-and-white chevron countries qualify; Finland's black-and-yellow do not.
    expect(countries).not.toContain('FI')
    expect(countries.some((c) => ['TR', 'BG', 'PH', 'RO', 'ZA', 'DK'].includes(c))).toBe(true)
    for (const t of twins) if (t.clue) expect(t.clue.category).toBe(target.category)
  })

  it('puts countries the note itself names ahead of any heuristic', () => {
    // The LM Australia bollard note says "Turkish bollards are similar" —
    // Turkey must lead the confusable list, whatever the colour maths says.
    const target = LM_CLUES.find((c) => c.country === 'AU' && c.tell === 'Bollard')!
    const countries = lookalikes(target).map((t) => t.country)
    expect(countries[0]).toBe('TR')
  })
})

describe('learnable meta quiz', () => {
  const MAP_IDS = new Set(MAP_COUNTRIES.map((c) => c.id))
  const seedCards = (clues: Clue[], due: Date): Record<string, StoredCard> =>
    Object.fromEntries(
      clues.map((c) => [c.id, { ...newCard(due), due: due.toISOString() }]),
    )

  it('adapts all 187 beginner metas into schedulable clues', () => {
    expect(LM_CLUES.length).toBe(187)
    for (const clue of LM_CLUES) {
      expect(clue.id.startsWith('lm-')).toBe(true)
      expect(clue.imageUrl).toBeTruthy()
      expect(clue.description.length).toBeGreaterThan(10)
      expect(clue.tell!.length).toBeGreaterThan(2)
      expect(MAP_IDS.has(clue.country)).toBe(true)
    }
  })

  it('never collides with Plonk It clue ids', () => {
    const plonk = new Set(CLUES.map((c) => c.id))
    for (const clue of LM_CLUES) expect(plonk.has(clue.id)).toBe(false)
  })

  it('builds a full quiz session with due metas ahead of unseen ones', () => {
    const queue = buildQueue(LM_CLUES, {}, new Date(), SESSION_LENGTH)
    expect(queue.length).toBe(SESSION_LENGTH)
    const cards = seedCards(LM_CLUES.slice(0, 3), new Date('2020-01-01'))
    const withDue = buildQueue(LM_CLUES, cards, new Date(), SESSION_LENGTH)
    expect(withDue.slice(0, 3).every((c) => cards[c.id])).toBe(true)
  })
})

describe('blitz acquisition', () => {
  const rig = (n: number) => CURRICULUM.slice(0, n)

  it('serves unseen tells in curriculum order, topping up with due reviews', () => {
    expect(nextBatch(CURRICULUM, {}).map((c) => c.id)).toEqual(
      CURRICULUM.slice(0, BATCH_SIZE).map((c) => c.id),
    )
    const cards = Object.fromEntries(
      CURRICULUM.slice(0, CURRICULUM.length - 2).map((c) => [
        c.id,
        { ...newCard(new Date('2020-01-01')), due: '2020-01-02T00:00:00.000Z' },
      ]),
    )
    const batch = nextBatch(CURRICULUM, cards, new Date())
    expect(batch.length).toBe(BATCH_SIZE)
    expect(batch.slice(0, 2).every((c) => !cards[c.id])).toBe(true)
    expect(batch.slice(2).every((c) => !!cards[c.id])).toBe(true)
  })

  it('options always contain the answer and three unique rivals', () => {
    let seed = 42
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (const clue of rig(30)) {
      const options = blitzOptions(clue, CURRICULUM, rand)
      expect(options).toHaveLength(4)
      expect(new Set(options).size).toBe(4)
      expect(options).toContain(clue.country)
    }
  })

  it('retires a clean first try immediately and grades exactly once', () => {
    const queue = rig(2).map((clue) => ({ clue, streak: 0, firstChosen: null, firstMs: 0 }))
    const step = applyAnswer(queue, queue[0].clue.country, 1500)
    expect(step.retired?.clue.id).toBe(queue[0].clue.id)
    expect(step.retired?.firstChosen).toBe(queue[0].clue.country)
    expect(step.queue).toHaveLength(1)
  })

  it('a miss re-queues nearby and demands two straight corrects', () => {
    const clues = rig(4)
    let queue: BlitzCard[] = clues.map((clue) => ({
      clue,
      streak: 0,
      firstChosen: null,
      firstMs: 0,
    }))
    const missed = clues[0]

    let step = applyAnswer(queue, 'XX', 900)
    expect(step.retired).toBeNull()
    // Reinserted two questions out, first attempt preserved for grading.
    expect(step.queue[2].clue.id).toBe(missed.id)
    expect(step.queue[2].firstChosen).toBe('XX')

    // First correct after the miss: not retired yet, goes to the back.
    queue = [step.queue[2], ...step.queue.slice(3)]
    step = applyAnswer(queue, missed.country, 900)
    expect(step.retired).toBeNull()

    // Second straight correct: retired, still graded on the original miss.
    queue = [step.queue[step.queue.length - 1]]
    step = applyAnswer(queue, missed.country, 900)
    expect(step.retired?.firstChosen).toBe('XX')
    expect(step.queue).toHaveLength(0)
  })
})
