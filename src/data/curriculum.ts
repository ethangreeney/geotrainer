import { CLUES } from './clues'
import { LM_CLUES } from './lm'
import { trackIndex } from './tracks'
import type { Clue } from '../types'

/**
 * One curriculum, two sources. Reviews draw on everything ever learned;
 * new material arrives in this order: the Learnable Meta beginner set first —
 * curated, photographed, and matched to what actually appears in games — then
 * the Plonk It library by learning-path track.
 */
export const ALL_CLUES: Clue[] = [...LM_CLUES, ...CLUES]

export const CURRICULUM: Clue[] = [
  ...LM_CLUES,
  ...[...CLUES].sort((a, b) => trackIndex(a) - trackIndex(b)),
]
