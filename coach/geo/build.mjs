/**
 * Turns the two Natural Earth 10m source files into the per-country slices the
 * server hands out. Run once: `node coach/geo/build.mjs` (sources fetched by
 * `node coach/geo/fetch.mjs`). The output is gitignored — it rebuilds in a few
 * seconds.
 *
 * Why slice at build time: the sources are 52 MB of JSON. Parsing them on every
 * request is slow and holding them resident is worse, but a round only ever
 * needs one country. Sliced, the server reads a file measured in kilobytes.
 *
 * Why the tolerance is adaptive: the map frames whatever it is given, so a
 * shape is always drawn at roughly the same size on screen no matter how big it
 * is on the ground. A fixed tolerance in degrees therefore spends its whole
 * budget in the wrong place — it leaves Canada carrying a hundred thousand
 * vertices no eye can resolve, while a small province is trimmed at the same
 * rate. Scaling the tolerance to the feature's own extent gives every outline
 * the same on-screen fidelity — well under a pixel of error at the zoom the
 * result map lands on — at a fraction of the payload. That, and the dissolve
 * that merges neighbours into one outline, live in shape.mjs; this file is the
 * driver that decides what to slice, group, merge and name.
 *
 * Writes:
 *   admin0/<CC>.json   { code, name, geometry }
 *   admin1/<CC>.json   [ { id, name, names, code, parts, geometry }, ... ]
 *   merged/<CC>.json   { "<signature>": { name, names, parts, geometry } }
 *   index.json         what exists, for the server's readiness check
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DETAIL, countVertices, dissolve, simplify } from './shape.mjs'
import { bare, countryCode, matchFeatures, norm, signature } from './resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'src')
const load = (f) => JSON.parse(readFileSync(join(SRC, f), 'utf8'))

/** Natural Earth writes "-99" (and "-1" in the subdivision file) where it
 * declines to assign a code; the _EH variant carries the de-facto one, which is
 * what a guess reverse-geocodes to. Insisting on two letters rather than two
 * characters is what keeps the placeholders out: a dozen subdivisions —
 * Somaliland, Northern Cyprus, the Kashmir glaciers — otherwise pile up under a
 * country called "-1", which nothing can ever ask for. */
const iso2 = (p) => {
  for (const v of [p.ISO_A2, p.ISO_A2_EH, p.iso_a2]) if (/^[A-Za-z]{2}$/.test(v ?? '')) return v.toUpperCase()
  return null
}

for (const dir of ['admin0', 'admin1', 'merged']) {
  rmSync(join(HERE, dir), { recursive: true, force: true })
  mkdirSync(join(HERE, dir), { recursive: true })
}

const index = { countries: {}, builtAt: new Date().toISOString(), detail: DETAIL }
let vIn = 0
let vOut = 0

/* ── admin0 ─────────────────────────────────────────────────────────────── */

/** Several ISO codes are claimed by more than one feature — France also owns
 * Clipperton, Brazil an "Indeterminate" river island — and the extras come
 * later in the file, so first-write-wins would hand back the wrong shape.
 * Rank by what the feature claims to be and only let a better claim win. */
const RANK = { 'Sovereign country': 3, Sovereignty: 3, Country: 3, Disputed: 1, Indeterminate: 1 }
const rankOf = (p) => RANK[p.TYPE] ?? 0
const best = new Map()
for (const f of load('ne_10m_admin_0_countries.geojson').features) {
  const code = iso2(f.properties)
  if (!code) continue
  if (rankOf(f.properties) > rankOf(best.get(code)?.properties ?? {})) best.set(code, f)
}

const writeCountry = (code, name, names, geometry) => {
  writeFileSync(join(HERE, 'admin0', code + '.json'), JSON.stringify({ code, name, geometry }))
  index.countries[code] = { name, names: [...new Set(names)], admin1: 0, merged: 0 }
}

for (const f of best.values()) {
  const p = f.properties
  const geometry = simplify(f.geometry)
  vIn += countVertices(f.geometry)
  vOut += countVertices(geometry)
  // Every spelling the country answers to, so a meta key written as
  // "Bosnia:" or "United States:" finds the same file.
  const names = new Set()
  for (const k of ['NAME_EN', 'NAME', 'NAME_LONG', 'NAME_SORT', 'NAME_CIAWF', 'ADMIN', 'SOVEREIGNT', 'NAME_ALT'])
    if (typeof p[k] === 'string') for (const part of p[k].split('|')) if (part.trim()) names.add(part.trim())
  writeCountry(iso2(p), p.NAME_EN || p.NAME, names, geometry)
}

/* ── admin1 ─────────────────────────────────────────────────────────────── */

/** Every spelling a subdivision answers to. scope-regions.json was written from
 * whatever the geocoder returned, which is sometimes the local name and
 * sometimes the English one, so match against all of them. */
const LOCALE = ['name_en', 'name_local', 'name_alt', 'woe_name', 'gn_name', 'gns_name']
const byCountry = new Map()
/** Raw geometry by feature id, kept until every dissolve is done: merging two
 * neighbours needs the borders as Natural Earth drew them, vertex for vertex. */
const raw = new Map()
/** What the admin1 features call their own country, for the ones admin0 lacks. */
const parentNames = new Map()

for (const f of load('ne_10m_admin_1_states_provinces.geojson').features) {
  const p = f.properties
  const code = iso2(p)
  if (!code) continue
  const names = new Set()
  for (const k of ['name', ...LOCALE]) {
    const v = p[k]
    if (typeof v === 'string') for (const part of v.split('|')) if (part.trim()) names.add(part.trim())
  }
  if (!names.size) continue
  const geometry = simplify(f.geometry)
  vIn += countVertices(f.geometry)
  vOut += countVertices(geometry)
  if (!byCountry.has(code)) byCountry.set(code, [])
  // adm1_code is unique across the whole file and present on every feature, so
  // it is the stable identity a precomputed merge can be keyed on.
  const id = p.adm1_code
  raw.set(id, f.geometry)
  byCountry.get(code).push({
    id,
    name: p.name || [...names][0],
    names: [...names],
    code: p.iso_3166_2 || p.adm1_code || null,
    parts: [id],
    geometry,
    groups: [p.region, p.geonunit].filter((g) => typeof g === 'string' && g.trim()),
  })
  if (!parentNames.has(code)) parentNames.set(code, new Set())
  for (const k of ['admin', 'geonunit']) if (typeof p[k] === 'string' && p[k].trim()) parentNames.get(code).add(p[k])
}

/**
 * Natural Earth splits some countries finer than the clue does: the UK is 232
 * council areas with Scotland only present as a `geonunit`, Spain is provinces
 * with Cataluña only present as a `region`. Those groupings become entries in
 * their own right so "Scotland" resolves like any other name.
 *
 * A group has to be dissolved, not just collected — drawing Scotland as 32
 * outlined councils puts borders through the middle of the shape.
 */
for (const [code, list] of byCountry) {
  const groups = new Map()
  const leaves = list.length
  for (const f of list)
    for (const g of f.groups) {
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(f)
    }
  for (const [name, members] of groups) {
    // A group covering every subdivision is the country, which admin0 already
    // draws. Keeping it would only let it shadow a subdivision of the same
    // name — Natural Earth files Mexico's geonunit as "Mexico", which is also
    // the State of México.
    if (members.length === leaves) continue
    // A group of one is the feature itself under another name — add the name,
    // don't add a duplicate shape.
    if (members.length < 2) {
      if (!members[0].names.some((n) => norm(n) === norm(name))) members[0].names.push(name)
      continue
    }
    // An alias every member carries is a name for the group, not for any one of
    // them: all three Valencian provinces answer to "Comunidad Valenciana",
    // which is the community, while the group itself is filed under the bare
    // "Valenciana". Promote those to the group and take them off the members,
    // or the province listed first wins a name that belongs to the whole.
    const shared = members[0].names.filter((n) => members.every((m) => m.names.some((x) => norm(x) === norm(n))))
    // Taken off the members literally, not by the noun-insensitive key: Hong
    // Kong has a Kowloon City district inside a Kowloon group, and stripping by
    // a key that drops "city" left the district with no name at all.
    const keys = new Set([name, ...shared].map(bare))
    for (const m of members) m.names = m.names.filter((n) => !keys.has(bare(n)))
    const parts = [...new Set(members.flatMap((m) => m.parts))]
    const geometry = simplify(dissolve(parts.map((p) => raw.get(p))))
    vOut += countVertices(geometry)
    list.push({ id: `${code}~${norm(name)}`, name, names: [name, ...shared], code: null, parts, geometry, group: true })
  }
  for (const f of list) delete f.groups
}

/**
 * Natural Earth's country file skips some of the small territories its own
 * subdivision file covers — Bermuda's parishes are there, Bermuda is not, and a
 * round played there would get no overlay at all. Where the pieces exist, the
 * whole is just their dissolve, and downstream cannot tell it from a real one.
 */
for (const [code, list] of byCountry) {
  if (index.countries[code]) continue
  const parts = [...new Set(list.filter((f) => !f.group).flatMap((f) => f.parts))]
  const geometry = simplify(dissolve(parts.map((p) => raw.get(p))))
  vOut += countVertices(geometry)
  const names = [...(parentNames.get(code) ?? [])]
  writeCountry(code, names[0] ?? code, names, geometry)
  index.countries[code].synthesized = true
}

for (const [code, list] of byCountry) {
  writeFileSync(join(HERE, 'admin1', code + '.json'), JSON.stringify(list))
  if (index.countries[code]) index.countries[code].admin1 = list.length
  else index.countries[code] = { name: code, names: [], admin1: list.length, merged: 0 }
}
// Written before the scope pass because that pass resolves country names
// through resolve.mjs, which reads this file; rewritten at the end with the
// merge counts.
writeFileSync(join(HERE, 'index.json'), JSON.stringify(index, null, 2))

/* ── precomputed merges ─────────────────────────────────────────────────── */

/**
 * A scope that names two adjacent subdivisions draws a stroke along the border
 * they share — a line through the middle of the highlight, which reads as a
 * rendering fault rather than as information. The cure is the same dissolve the
 * groups get, and it has to happen here: by the time the server answers, each
 * feature has been thinned on its own and the shared border no longer matches
 * on both sides.
 *
 * The set of combinations that can ever be asked for is not open-ended — it is
 * whatever scope-regions.json lists — so every multi-subdivision entry is
 * dissolved now and filed under the leaf subdivisions it covers. Keying on the
 * covered set rather than on the spelling means two entries that name the same
 * ground different ways share one shape. Sets with nothing adjacent in them
 * (an island group like Nusa Tenggara) dissolve to themselves, so there is
 * nothing to detect and no reason to special-case them.
 */
const scope = JSON.parse(readFileSync(join(HERE, '..', 'scope-regions.json'), 'utf8'))
const merged = new Map()
for (const [key, names] of Object.entries(scope)) {
  if (key.startsWith('_') || !Array.isArray(names)) continue
  const code = countryCode(key.split(':')[0].trim())
  if (!code) continue
  const { matched } = matchFeatures(byCountry.get(code) ?? [], names)
  if (matched.length < 2) continue
  const sig = signature(matched)
  if (!merged.has(code)) merged.set(code, {})
  if (merged.get(code)[sig]) continue
  const parts = [...new Set(matched.flatMap((f) => f.parts))]
  const geometry = simplify(dissolve(parts.map((p) => raw.get(p))))
  vOut += countVertices(geometry)
  // Label from the widest features only: where a scope names both a community
  // and one of its provinces, "Cataluña + Valenciana" is the honest caption and
  // "+ Valencia" would be noise.
  const outer = matched.filter((f) => !matched.some((o) => o !== f && f.parts.every((p) => o.parts.includes(p))))
  merged.get(code)[sig] = {
    id: sig,
    name: outer.map((f) => f.name).join(' + '),
    names: outer.map((f) => f.name),
    parts,
    geometry,
    dissolved: true,
  }
}
for (const [code, sets] of merged) {
  writeFileSync(join(HERE, 'merged', code + '.json'), JSON.stringify(sets))
  if (index.countries[code]) index.countries[code].merged = Object.keys(sets).length
}
writeFileSync(join(HERE, 'index.json'), JSON.stringify(index, null, 2))

const synthesized = Object.values(index.countries).filter((c) => c.synthesized).length
console.log(
  `admin0: ${Object.keys(index.countries).length} countries (${synthesized} dissolved from their own subdivisions) | ` +
    `admin1: ${byCountry.size} countries, ${[...byCountry.values()].reduce((n, l) => n + l.length, 0)} subdivisions | ` +
    `merged: ${[...merged.values()].reduce((n, s) => n + Object.keys(s).length, 0)} scope sets`
)
console.log(`vertices ${vIn.toLocaleString()} → ${vOut.toLocaleString()} (${((1 - vOut / vIn) * 100).toFixed(1)}% trimmed)`)
