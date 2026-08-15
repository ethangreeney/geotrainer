import type { Category, Clue } from '../types'
import { LM_BEGINNER } from './lmBeginner'

/**
 * The Learnable Meta beginner list, adapted to the app's clue shape so the
 * scheduler, drill, and debrief all work on it unchanged. Each meta is one
 * card: its example image is the question, its note is the explanation.
 *
 * The category is derived from the tell's name. It only drives the label on
 * the question card and how the session interleaves — a wrong guess is never
 * judged by it — so a heuristic is enough.
 */
function categorize(tell: string): Category {
  const t = tell.toLowerCase()
  if (/bollard/.test(t)) return 'bollard'
  if (/car|cam\b|truck|follow/.test(t)) return 'camera'
  if (/plate/.test(t)) return 'licence-plate'
  if (/pole|stobie/.test(t)) return 'pole'
  if (/language|word for street|street name/.test(t)) return 'language'
  if (/line|road ?mark|hump/.test(t)) return 'road-line'
  if (/sign|chevron|stop|arrow/.test(t)) return 'sign'
  if (/guardrail|barrier|stone block/.test(t)) return 'guardrail'
  if (/vibes|landscape|pines/.test(t)) return 'landscape'
  if (/building|house|architecture/.test(t)) return 'architecture'
  return 'other'
}

/** Tells that only hold in one region of their country. */
const REGIONS: [RegExp, string][] = [
  [/alberta/i, 'Alberta'],
  [/newfoundland/i, 'Newfoundland'],
  [/ontario/i, 'Ontario'],
  [/quebec/i, 'Quebec'],
  [/\bSA stobie/i, 'South Australia'],
  [/\bWA yellow/i, 'Western Australia'],
  [/hokkaido/i, 'Hokkaido'],
  [/cali three/i, 'California'],
  [/paran/i, 'Paraná'],
]

const regionOf = (tell: string) => REGIONS.find(([re]) => re.test(tell))?.[1]

export const LM_CLUES: Clue[] = LM_BEGINNER.map((m) => ({
  id: m.id,
  country: m.country,
  category: categorize(m.tell),
  imageUrl: m.images[0] ?? null,
  description: m.note,
  confusedWith: [],
  notes: '',
  source: 'https://learnablemeta.com/maps/66c0d3feff4dbe492e06174e',
  tell: m.tell,
  region: regionOf(m.tell),
}))
