/**
 * Looks up the boundary a round should highlight. Two entry points: a country
 * by ISO code, and a set of subdivisions by the names `scope-regions.json`
 * uses. Everything comes from the slices `build.mjs` wrote, cached after first
 * read — the deck touches a few dozen countries, so the cache stays small.
 *
 * Matching is by name, not code, because the names in scope-regions.json were
 * written from whatever the geocoder returned: sometimes English, sometimes
 * local, occasionally with the administrative noun attached, occasionally with
 * the noun rotated to the back for sorting ("Asturias, Principado de"). Natural
 * Earth carries the same subdivision under half a dozen spellings, so both
 * sides are normalised down to letters and compared. Anything that still fails
 * to match is reported rather than silently dropped — a scope entry that
 * resolves to nothing would draw the wrong shape, which is worse than drawing
 * none.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const cache = new Map()

const read = (p) => {
  if (!cache.has(p)) cache.set(p, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
  return cache.get(p)
}

export const geoReady = () => existsSync(join(HERE, 'index.json'))
const index = () => read(join(HERE, 'index.json'))

/** Words that name a kind of place rather than the place. Dropping them lets
 * "Nusa Tenggara Timur", "East Nusa Tenggara Province" and "NUSA-TENGGARA
 * TIMUR" land on the same key. */
const NOUNS = new Set(
  `state province provincia region regione comunidad comunitat prefecture governorate department departamento
   district county oblast voivodeship canton territory municipality autonomous special metropolitan city of the and de del di da do du des`
    .split(/\s+/)
    .filter(Boolean)
)

/** Korean romanisation hangs the administrative noun off the name with a
 * hyphen — Jeju-do, Seoul-teukbyeolsi, Busan-gwangyeoksi — and geocoders differ
 * on whether they keep it. Stripping it only after a hyphen means it cannot
 * touch a name that merely happens to end in those letters. */
const KOREAN_SUFFIX = /-(teukbyeoljachido|teukbyeoljachisi|teukbyeolsi|gwangyeoksi|gwangyeogsi|do|si|gun|gu)\b/g

const tokens = (s) => {
  const t = String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(KOREAN_SUFFIX, ' ')
    // Letters and digits of any script, not just Latin: Natural Earth carries
    // the local spelling for most of the world — Псковская область, 鹿児島県,
    // Ήπειρος — and a geocoder answering in the local script has to land
    // somewhere. Splitting on ASCII alone reduced every one of those to nothing.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const kept = t.filter((w) => !NOUNS.has(w))
  // A name made of nothing but nouns ("Federal District" in a country that has
  // only one) still has to be findable, so keep it whole rather than empty.
  return kept.length ? kept : t
}

/** Letters and digits only — no words dropped, nothing reordered. The strictest
 * of the three keys, and the first one tried: where two subdivisions share a
 * name once the nouns come off, the one that was actually called that should
 * answer. Laos has a Vientiane province and a "Vientiane [prefecture]", and
 * only this key tells them apart. */
export const bare = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** The main key: administrative nouns dropped, word order preserved. */
export function norm(s) {
  return tokens(s).join('')
}

/** The fallback key: word order discarded, and the ñ digraphs folded together —
 * Catalan writes it "ny" and Portuguese "nh" where Spanish writes "ñ", which
 * NFD already flattens to "n", so "Catalunya" and "Cataluña" differ by nothing
 * that means anything.
 *
 * Rotations are the other half: "Balears, Illes" for "Illes Balears", "Kuala
 * Lumpur, Wilayah Persekutuan" for the other way round — how a geocoder writes
 * a name it means to sort by. Sorting the words makes those identical without a
 * rule per language.
 *
 * Both belong in a fallback rather than in the primary key, because both also
 * collapse things that are genuinely distinct: sorted, "N.M." and "MN" are the
 * same word, and folded, "N.Y." and "N.H." are. An abbreviation that matches
 * exactly is answered on the first tier and never reaches this one. */
export function loose(s) {
  return tokens(String(s).replace(/ny|nh/gi, 'n'))
    .sort()
    .join('')
}

/** Geocoders emit dual-language names as "Catalunya [Cataluña]". Either half is
 * a name in its own right, so try the whole thing first and then each half. */
function variants(s) {
  const out = [s]
  const m = String(s).match(/^(.*?)\s*\[(.+)\]\s*$/)
  if (m) out.push(m[2], m[1])
  return out.filter((v) => v && v.trim())
}

/** ISO2 for a country written however the meta key or the geocoder spelled it. */
export function countryCode(name) {
  const want = norm(name)
  if (!want) return null
  const countries = Object.entries(index()?.countries ?? {})
  // Same order of preference as the subdivisions: a country's own name before
  // anything another country lists as an alternative for it.
  const alt = loose(name)
  for (const [code, c] of countries) if (norm(c.name) === want) return code
  for (const [code, c] of countries) if (c.names?.some((n) => norm(n) === want)) return code
  for (const [code, c] of countries) if (c.names?.some((n) => loose(n) === alt)) return code
  return null
}

export function countryShape(code) {
  return read(join(HERE, 'admin0', String(code).toUpperCase() + '.json'))
}

/**
 * Which claim on a name wins when several features answer to it. Natural Earth
 * lets a feature list its neighbour's name among its own aliases — the Jervis
 * Bay Territory carries "Australian Capital Territory", having once been
 * administered from there — and file order alone would hand the name to
 * whichever came first. What a feature calls itself outranks what another
 * feature calls it, and a dissolved group outranks the members that also list
 * the group's name.
 */
const rankOf = (f, primary) => (primary ? 2 : 0) + (f.group ? 1 : 0)
const put = (map, key, f, primary) => {
  if (!key) return
  const held = map.get(key)
  if (!held || rankOf(f, primary) > rankOf(held.f, held.primary)) map.set(key, { f, primary })
}

function lookupFor(list) {
  const literal = new Map()
  const exact = new Map()
  const rotated = new Map()
  for (const f of list) {
    for (const n of f.names ?? []) {
      const primary = n === f.name
      put(literal, bare(n), f, primary)
      put(exact, norm(n), f, primary)
      put(rotated, loose(n), f, primary)
    }
    // iso_3166_2 is "CA-ON"; accept the bare subdivision part too, since some
    // geocoders answer with the code where others answer with the name. A code
    // names one subdivision and nothing else, so it ranks with the name.
    if (f.code) for (const k of [norm(f.code), norm(String(f.code).split('-').pop())]) put(exact, k, f, true)
  }
  return { literal, exact, rotated }
}

/**
 * The name matcher, over a list already in hand. Exported because build.mjs
 * resolves every scope entry against the same rules to decide which dissolves
 * to precompute — two copies of this would drift apart the first time one is
 * fixed.
 */
export function matchFeatures(list, names) {
  const { literal, exact, rotated } = lookupFor(list ?? [])
  const matched = []
  const missing = []
  const seen = new Set()
  for (const name of names ?? []) {
    let f = null
    // Strictest key first. Each tier below it forgives something — a dropped
    // noun, then word order — and a name that survives no tier is reported
    // missing rather than handed to the nearest thing that looked like it.
    for (const v of variants(name)) {
      f = (literal.get(bare(v)) ?? exact.get(norm(v)) ?? rotated.get(loose(v)))?.f
      if (f) break
    }
    if (!f) missing.push(name)
    else if (!seen.has(f)) {
      seen.add(f)
      matched.push(f)
    }
  }
  return { matched, missing }
}

/** The identity of a set of features, as the leaf subdivisions it covers. Two
 * scope entries spelled differently — one naming the four Catalan provinces,
 * one naming Cataluña — describe the same ground and must find the same
 * precomputed shape. */
export const signature = (features) =>
  [...new Set(features.flatMap((f) => f.parts ?? [f.id]))].sort().join('|')

/**
 * Subdivisions of `code` matching `names`. Returns the features that matched
 * and the names that did not, so a caller can fall back to the country outline
 * rather than highlight a partial scope.
 *
 * Where two or more subdivisions match and build.mjs has a dissolved shape for
 * exactly that set, one feature comes back instead of several. Drawn separately
 * they show a stroke along every shared border — a line through the middle of
 * the highlight, which reads as a rendering fault rather than as information.
 * The merge cannot happen here: it needs raw geometry, and by now each feature
 * has been thinned on its own.
 */
export function regionShapes(code, names) {
  const cc = String(code).toUpperCase()
  const list = read(join(HERE, 'admin1', cc + '.json')) ?? []
  const { matched, missing } = matchFeatures(list, names)
  if (matched.length < 2) return { matched, missing }
  const merged = read(join(HERE, 'merged', cc + '.json'))?.[signature(matched)]
  return { matched: merged ? [merged] : matched, missing }
}
