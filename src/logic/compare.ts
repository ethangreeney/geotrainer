import { CLUES } from '../data/clues'
import { COUNTRIES } from '../data/countries'
import type { Clue } from '../types'

/**
 * Picking the clue to show beside a wrong answer.
 *
 * The obvious rule — "any clue from the country they picked, same category" —
 * produces nonsense. Miss an Albanian chevron by clicking Germany and you get a
 * lecture on German sign backs: same category, nothing to do with the thing on
 * screen. A comparison is only worth the space when the two clues describe the
 * *same feature*, because that is the discrimination the learner actually got
 * wrong. So candidates are scored on how much distinctive vocabulary they share
 * with the clue that was asked, and a weak best match is shown as no match.
 */

const STOP = new Set(
  ('a an the and or but of in on at to for with from is are be been was were this that these those' +
    ' it its as by can you will not no very more most some any which their there they them he she' +
    ' his her one two often commonly usually generally typically found find seen see look looks' +
    ' like similar same other others than then when while into over under across around quite' +
    ' rather many much such all both each own so if up out about only just get got does do did also' +
    ' have has had').split(' '),
)

/** Crude suffix stripping so "signs"/"sign" and "bollards"/"bollard" score as one term. */
function stem(word: string): string {
  return word
    .replace(/ies$/, 'y')
    .replace(/(sses|shes|ches|xes)$/, (m) => m.slice(0, -2))
    .replace(/s$/, '')
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.add(stem(raw))
  }
  return out
}

const cache = new Map<Clue, Set<string>>()
function termsOf(clue: Clue): Set<string> {
  let terms = cache.get(clue)
  if (!terms) {
    terms = tokenize(`${clue.description} ${clue.notes ?? ''}`)
    cache.set(clue, terms)
  }
  return terms
}

// Document frequency over the whole clue set, so shared rare words ("chevron",
// "antenna", "insulator") count for far more than shared common ones ("black").
const DF = new Map<string, number>()
for (const clue of CLUES) {
  for (const term of termsOf(clue)) DF.set(term, (DF.get(term) ?? 0) + 1)
}
const weight = (term: string) => Math.log(CLUES.length / (1 + (DF.get(term) ?? 0))) ** 2

/** Cosine similarity of two clues over inverse-document-frequency weighted terms. */
export function similarity(a: Clue, b: Clue): number {
  const left = termsOf(a)
  const right = termsOf(b)
  let shared = 0
  let normLeft = 0
  let normRight = 0
  for (const term of left) {
    const w = weight(term)
    normLeft += w
    if (right.has(term)) shared += w
  }
  for (const term of right) normRight += weight(term)
  if (!normLeft || !normRight) return 0
  return shared / Math.sqrt(normLeft * normRight)
}

/**
 * Below this the best rival clue is about something else entirely and is more
 * confusing than the silence. Calibrated against the clue set: random country
 * pairs sit around 0.08, genuinely comparable ones (chevron vs chevron, antenna
 * vs antenna, plate colour vs plate colour) sit above 0.3.
 */
export const COMPARE_THRESHOLD = 0.3

/**
 * Categories where every clue describes the same national object: any two
 * bollard clues are inherently comparable, whatever words they use. The
 * diffuse categories (signs, architecture, landscape, general meta) mix many
 * unrelated features, so there the vocabulary test still decides.
 */
const SAME_OBJECT = new Set([
  'bollard',
  'licence-plate',
  'pole',
  'guardrail',
  'road-line',
  'camera',
  'language',
])

/**
 * A term rare enough to name a specific roadside feature — "chevron",
 * "insulator", "kerb" — rather than a colour or filler word. Two same-category
 * clues sharing one are about the same feature even when the cosine is diluted
 * by surrounding prose ("beware that there are some regional variants…").
 * Only the description is mined — notes love naming other countries ("also
 * used by Italy, Greece and Spain"), and place names say where a feature
 * lives, not what it is.
 */
const FEATURE_DF_CAP = 90
const PLACE_WORDS = new Set(
  [
    ...COUNTRIES.flatMap((c) => c.name.toLowerCase().split(/[\s-]+/)),
    'europe', 'european', 'africa', 'african', 'asia', 'asian', 'america', 'american',
    'latin', 'oceania', 'scandinavia', 'balkan', 'baltic', 'nordic',
    'southern', 'northern', 'eastern', 'western', 'central',
    'country', 'region', 'regional', 'world', 'neighbouring', 'neighbour',
  ].map(stem),
)

const featureCache = new Map<Clue, Set<string>>()
function featureTermsOf(clue: Clue): Set<string> {
  let out = featureCache.get(clue)
  if (out) return out
  out = new Set<string>()
  for (const term of tokenize(clue.description)) {
    const df = DF.get(term) ?? 0
    if (df > 1 && df <= FEATURE_DF_CAP && !PLACE_WORDS.has(term)) out.add(term)
  }
  featureCache.set(clue, out)
  return out
}

function sharesFeature(a: Clue, b: Clue): boolean {
  const bTerms = featureTermsOf(b)
  for (const term of featureTermsOf(a)) if (bTerms.has(term)) return true
  return false
}

/** The clue that explains why the country they picked is not the answer, if one exists. */
export function comparableClue(chosen: string, target: Clue): Clue | null {
  let best: Clue | null = null
  let bestScore = -1
  let sameFeature = false
  for (const clue of CLUES) {
    if (clue.country !== chosen) continue
    let score = similarity(clue, target)
    if (clue.category === target.category) score *= 1.35
    if (target.confusedWith?.includes(chosen)) score *= 1.2
    // Same-feature candidates outrank every other one at any score: within a
    // single-object category any clue qualifies, elsewhere the two clues must
    // name the same rare feature word (chevron vs chevron, not chevron vs
    // sign backs).
    const inKind =
      clue.category === target.category &&
      (SAME_OBJECT.has(target.category) || sharesFeature(clue, target))
    if ((inKind && !sameFeature) || (inKind === sameFeature && score > bestScore)) {
      bestScore = score
      best = clue
      sameFeature = inKind
    }
  }
  if (sameFeature) return best
  return bestScore >= COMPARE_THRESHOLD ? best : null
}

/**
 * Demonyms the guides use when naming a rival country in prose — "Turkish
 * bollards are similar", "unlike the Polish design". Only irregular or
 * adjective forms are listed; plain country names are matched directly.
 */
const DEMONYMS: Record<string, string[]> = {
  // "american" is deliberately absent: the guides use it for the continents
  // ("the only American country…") far more often than for the USA.
  US: ['the us', 'the usa', 'united states'], GB: ['british', 'the uk'],
  FR: ['french'], DE: ['german'], ES: ['spanish'],
  PT: ['portuguese'], IT: ['italian'], NL: ['dutch'], BE: ['belgian'], CH: ['swiss'],
  AT: ['austrian'], DK: ['danish'], SE: ['swedish'], NO: ['norwegian'], FI: ['finnish'],
  IS: ['icelandic'], IE: ['irish'], PL: ['polish'], CZ: ['czech'], SK: ['slovak'],
  HU: ['hungarian'], RO: ['romanian'], BG: ['bulgarian'], GR: ['greek'], TR: ['turkish'],
  RU: ['russian'], UA: ['ukrainian'], EE: ['estonian'], LV: ['latvian'], LT: ['lithuanian'],
  HR: ['croatian'], RS: ['serbian'], SI: ['slovenian'], AL: ['albanian'], ME: ['montenegrin'],
  MK: ['macedonian'], BA: ['bosnian'], JP: ['japanese'], KR: ['korean'], TW: ['taiwanese'],
  TH: ['thai'], VN: ['vietnamese'], KH: ['cambodian'], LA: ['lao', 'laotian'],
  MY: ['malaysian'], SG: ['singaporean'], ID: ['indonesian'], PH: ['filipino', 'philippine'],
  IN: ['indian'], BD: ['bangladeshi'], LK: ['sri lankan'], MN: ['mongolian'], KZ: ['kazakh'],
  KG: ['kyrgyz'], IL: ['israeli'], JO: ['jordanian'], AE: ['emirati'], QA: ['qatari'],
  OM: ['omani'], AU: ['australian'], NZ: [], MX: ['mexican'], BR: ['brazilian'],
  AR: ['argentine', 'argentinian'], CL: ['chilean'], PE: ['peruvian'], CO: ['colombian'],
  EC: ['ecuadorian'], BO: ['bolivian'], UY: ['uruguayan'], PY: ['paraguayan'], CA: ['canadian'],
  ZA: ['south african'], KE: ['kenyan'], NG: ['nigerian'], GH: ['ghanaian'], SN: ['senegalese'],
  TN: ['tunisian'], EG: ['egyptian'], UG: ['ugandan'], MT: ['maltese'], CY: ['cypriot'],
  AD: ['andorran'], LU: ['luxembourgish'],
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Countries the clue's own text names — the author's hand-picked confusion set. */
function mentionedCountries(clue: Clue): string[] {
  const text = `${clue.description} ${clue.notes ?? ''}`.toLowerCase()
  const out: string[] = []
  for (const c of COUNTRIES) {
    if (c.code === clue.country) continue
    const forms = [c.name.toLowerCase(), ...(DEMONYMS[c.code] ?? [])]
    if (forms.some((f) => new RegExp(`\\b${escapeRe(f)}\\b`).test(text))) out.push(c.code)
  }
  return out
}

/** Colour words: a lookalike must agree on palette, not just on the feature. */
const COLOURS = new Set([
  'white', 'red', 'yellow', 'black', 'blue', 'green', 'orange', 'grey', 'gray', 'burgundy',
])

/**
 * Countries whose guides describe the same feature with the same colours —
 * the set the learner actually has to discriminate between. An Argentine
 * red-and-white chevron is also how Turkey, Bulgaria or the Philippines mark
 * their curves; pretending the tell is unique teaches a false rule.
 */
/** Colours named by the clue's own description. Notes are excluded on purpose:
 * they usually describe the palette of the country to contrast with ("NOTE:
 * Argentina uses white with red arrows"). */
function paletteOf(clue: Clue): Set<string> {
  return new Set([...tokenize(clue.description)].filter((t) => COLOURS.has(t)))
}

export function lookalikes(
  target: Clue,
  limit: number = 7,
): { country: string; clue: Clue | null }[] {
  const targetFeatures = featureTermsOf(target)
  const targetColours = paletteOf(target)
  const bestPerCountry = new Map<string, { clue: Clue; score: number; exact: boolean }>()

  for (const clue of CLUES) {
    if (clue.country === target.country || clue.category !== target.category) continue
    const features = featureTermsOf(clue)
    if (![...targetFeatures].some((t) => features.has(t))) continue
    let exact = true
    if (targetColours.size > 0) {
      // The palette IS the tell: a lookalike must use every colour the missed
      // clue names, or "white" alone would match half the world.
      const colours = paletteOf(clue)
      if (![...targetColours].every((c) => colours.has(c))) continue
      exact = colours.size === targetColours.size
    }
    const score = similarity(clue, target)
    const held = bestPerCountry.get(clue.country)
    if (!held || score > held.score) bestPerCountry.set(clue.country, { clue, score, exact })
  }

  // Hand-curated confusions outrank any heuristic: the clue's own confusedWith
  // list first, then every country the note names in prose ("Turkish bollards
  // are similar…"), then palette-matched rivals to fill.
  const ordered: string[] = []
  const push = (code: string) => {
    if (code !== target.country && !ordered.includes(code)) ordered.push(code)
  }
  for (const code of target.confusedWith ?? []) push(code)
  for (const code of mentionedCountries(target)) push(code)
  for (const [country] of [...bestPerCountry.entries()].sort((a, b) =>
    a[1].exact !== b[1].exact ? (a[1].exact ? -1 : 1) : b[1].score - a[1].score,
  ))
    push(country)

  return ordered
    .slice(0, limit)
    .map((country) => ({ country, clue: bestPerCountry.get(country)?.clue ?? null }))
}
