import type { Clue } from '../types'
import { COUNTRIES, subregionOf } from '../data/countries'

export type Rng = () => number

function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Picks `count` distractor country codes for a clue.
 * Priority: the clue's `confusedWith` list, then same-subregion countries, then any
 * other European country. Never returns the correct answer, never repeats.
 */
export function pickDistractors(clue: Clue, count = 3, rng: Rng = Math.random): string[] {
  const chosen: string[] = []
  const taken = new Set<string>([clue.country])

  const add = (codes: string[]) => {
    for (const code of codes) {
      if (chosen.length >= count) return
      if (taken.has(code)) continue
      taken.add(code)
      chosen.push(code)
    }
  }

  add(shuffle(clue.confusedWith, rng))

  if (chosen.length < count) {
    const region = subregionOf(clue.country)
    const neighbours = COUNTRIES.filter((c) => c.subregion === region).map((c) => c.code)
    add(shuffle(neighbours, rng))
  }

  if (chosen.length < count) {
    add(shuffle(COUNTRIES.map((c) => c.code), rng))
  }

  return chosen
}

/** The four shuffled answer options for a clue: the correct country plus three distractors. */
export function buildOptions(clue: Clue, rng: Rng = Math.random): string[] {
  return shuffle([clue.country, ...pickDistractors(clue, 3, rng)], rng)
}

/** Two shuffled options for a targeted A-vs-B drill. */
export function buildPairOptions(a: string, b: string, rng: Rng = Math.random): string[] {
  return shuffle([a, b], rng)
}
