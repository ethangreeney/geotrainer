/**
 * The twelve skills a Plonk It clue can belong to, in the order they are worth
 * learning: the tells that decide a round first, then the slower context ones.
 * A focused session drills one of these; the mixed session interleaves them.
 */
export interface Category {
  id: string
  name: string
  blurb: string
}

export const CATEGORIES: Category[] = [
  {
    id: 'bollard',
    name: 'Bollards',
    blurb: 'Shape, stripe and reflector — the fastest single-object country tell there is.',
  },
  {
    id: 'language',
    name: 'Language & script',
    blurb: 'Alphabets, diacritics and the words that only ever appear in one country.',
  },
  {
    id: 'sign',
    name: 'Road signs',
    blurb: 'Shapes, borders, fonts, backing plates and the shields on the highway.',
  },
  {
    id: 'pole',
    name: 'Utility poles',
    blurb: 'Material, cross-arms, insulators and how the wires are strung.',
  },
  {
    id: 'road-line',
    name: 'Road markings',
    blurb: 'Line colour, dash rhythm, edge lines and centre-line pairings.',
  },
  {
    id: 'vehicle',
    name: 'Vehicles & driving side',
    blurb: 'Which side traffic keeps, plus the cars, cones and plates on the road.',
  },
  {
    id: 'licence-plate',
    name: 'Licence plates',
    blurb: 'Colour blocks and proportions — the parts still readable through the game blur.',
  },
  {
    id: 'camera',
    name: 'Camera & car',
    blurb: 'Generation, rig height, blur and colour cast of the Google coverage itself.',
  },
  {
    id: 'guardrail',
    name: 'Guardrails',
    blurb: 'Barrier profile, post spacing and the shape of the reflectors on top.',
  },
  {
    id: 'architecture',
    name: 'Architecture',
    blurb: 'Housing style, roofing, render and the materials people build with.',
  },
  {
    id: 'landscape',
    name: 'Landscape',
    blurb: 'Terrain, vegetation, soil colour and the light of the region.',
  },
  {
    id: 'other',
    name: 'General meta',
    blurb: 'Everything else the guides call out: kerbs, chevrons, post boxes, oddities.',
  },
]

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))

export function categoryName(id: string): string {
  return BY_ID.get(id)?.name ?? id.replace('-', ' ')
}
