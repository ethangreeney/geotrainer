import { CLUES } from './clues'
import type { Clue } from '../types'

/**
 * The learning path. Plonk It's own advice to beginners is to start with the
 * clues you meet in most rounds — driving side, the big scripts, bollards,
 * the camera — in the countries that actually come up, and only then widen
 * out. A flat pile of 1674 clues ignores that, so the clue set is split into
 * three ordered tracks. New material is introduced strictly from the lowest
 * unfinished track; reviews from earlier tracks never go away.
 */
export interface Track {
  id: string
  name: string
  blurb: string
}

export const TRACKS: Track[] = [
  {
    id: 'starter',
    name: 'Essentials',
    blurb:
      'One flagship tell per skill for the thirty countries you meet in almost every game — the majors of language, bollards, signs and the car itself.',
  },
  {
    id: 'core',
    name: 'Working meta',
    blurb:
      'The two or three best tells in every skill across the hundred countries with real coverage. This is the track that wins ordinary rounds.',
  },
  {
    id: 'deep',
    name: 'Deep cuts',
    blurb:
      'Everything else in the guides — rare territories, trekker islands and the obscure details that separate good from unbeatable.',
  },
]

/** The ~30 countries that dominate GeoGuessr world maps. */
const TIER_1 = new Set([
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'GB', 'IE', 'FR', 'ES', 'PT', 'DE', 'NL',
  'IT', 'PL', 'SE', 'NO', 'FI', 'RU', 'TR', 'AU', 'NZ', 'JP', 'KR', 'TH', 'ID',
  'IN', 'ZA', 'KE', 'MY',
])

/** The rest of the countries with meaningful official coverage. */
const TIER_2 = new Set([
  'AT', 'CH', 'BE', 'LU', 'DK', 'IS', 'EE', 'LV', 'LT', 'CZ', 'SK', 'HU', 'RO',
  'BG', 'GR', 'HR', 'RS', 'SI', 'AL', 'ME', 'MK', 'BA', 'UA', 'MD', 'CY', 'MT',
  'AD', 'PE', 'CO', 'EC', 'BO', 'UY', 'PY', 'GT', 'PA', 'DO', 'PH', 'VN', 'KH',
  'LA', 'LK', 'BD', 'MN', 'KZ', 'KG', 'IL', 'JO', 'AE', 'QA', 'OM', 'TW', 'HK',
  'SG', 'NG', 'GH', 'SN', 'BW', 'UG', 'TN', 'EG', 'LS', 'SZ', 'RW', 'MG',
])

/** The skills whose flagship clue makes the essentials cut. */
const STARTER_CATEGORIES = new Set(['bollard', 'language', 'sign', 'camera', 'vehicle'])

/**
 * Assign every clue to exactly one track. Within a country and category the
 * guides list their step-one country-recognition tells first, so "the first
 * clue" genuinely is the flagship one.
 */
function assign(): Map<string, string> {
  const trackOf = new Map<string, string>()
  const starterSeen = new Set<string>()
  const corePerPair = new Map<string, number>()

  for (const clue of CLUES) {
    const pair = `${clue.country}|${clue.category}`

    if (
      TIER_1.has(clue.country) &&
      STARTER_CATEGORIES.has(clue.category) &&
      !starterSeen.has(pair)
    ) {
      starterSeen.add(pair)
      trackOf.set(clue.id, 'starter')
      continue
    }

    if (TIER_1.has(clue.country) || TIER_2.has(clue.country)) {
      const used = (corePerPair.get(pair) ?? 0) + 1
      corePerPair.set(pair, used)
      if (used <= 2) {
        trackOf.set(clue.id, 'core')
        continue
      }
    }

    trackOf.set(clue.id, 'deep')
  }
  return trackOf
}

const TRACK_OF = assign()
const ORDER = new Map(TRACKS.map((t, i) => [t.id, i]))

export function trackOf(clue: Clue): string {
  return TRACK_OF.get(clue.id) ?? 'deep'
}

export function trackIndex(clue: Clue): number {
  return ORDER.get(trackOf(clue)) ?? TRACKS.length - 1
}

export function trackClues(clues: Clue[], id: string): Clue[] {
  return clues.filter((c) => trackOf(c) === id)
}
