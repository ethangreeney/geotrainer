export type Category =
  | 'bollard'
  | 'licence-plate'
  | 'road-line'
  | 'pole'
  | 'sign'
  | 'guardrail'
  | 'language'
  | 'architecture'
  | 'landscape'
  | 'camera'
  | 'vehicle'
  | 'other'

export const CATEGORIES: Category[] = [
  'bollard',
  'licence-plate',
  'road-line',
  'pole',
  'sign',
  'guardrail',
  'language',
  'architecture',
  'landscape',
  'camera',
  'vehicle',
  'other',
]

export interface Clue {
  id: string
  country: string // ISO 3166-1 alpha-2
  category: Category
  imageUrl: string | null
  description: string
  confusedWith: string[]
  notes: string
  /** Plonk It guide page this clue was taken from. */
  source?: string
  /** Learnable Meta tell name, e.g. "Double concrete pole". Only on lm-* clues. */
  tell?: string
  /** Sub-national scope when the tell only works in one region, e.g. "Hokkaido". */
  region?: string
}

/** One meta from a Learnable Meta list: a named tell with example imagery. */
export interface LmMeta {
  id: string
  country: string
  tell: string
  note: string
  images: string[]
}

export interface Country {
  code: string
  name: string
  subregion: string
}

export interface AnswerRecord {
  clueId: string
  chosen: string
  correct: string
  timestamp: number
  responseMs: number
}

/** FSRS card with dates serialised for localStorage. */
export interface StoredCard {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review?: string
}

export interface AppState {
  version: 1
  cards: Record<string, StoredCard>
  log: AnswerRecord[]
  /** derived: key is `${correct}>${chosen}` */
  matrix: Record<string, number>
}
