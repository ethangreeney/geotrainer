/**
 * Turns the sources into the per-country slices the server hands out. Run once:
 * `node coach/geo/build.mjs` (sources fetched by `node coach/geo/fetch.mjs`).
 * The output is gitignored — it rebuilds in about half a minute.
 *
 * Two sources, and they do different jobs. Natural Earth is the naming layer:
 * every alternate spelling a subdivision answers to, and the outlines for
 * everywhere geoBoundaries has nothing. geoBoundaries is the geometry, drawn
 * from OpenStreetMap, and it is where the detail lives — Hokkaidō is 747 points
 * in Natural Earth and 123,899 in geoBoundaries, which is the difference
 * between an outline that cuts across a bay and one that goes round it. The two
 * are joined by ISO code where there is one, by name where there is not, and by
 * geometry — which shape's interior holds which — where the names disagree.
 * Where geoBoundaries turns out to be the coarser of the two, that country
 * keeps Natural Earth.
 *
 * Why slice at build time: the sources are hundreds of megabytes of JSON.
 * Parsing them on every request is slow and holding them resident is worse, but
 * a round only ever needs one country. Sliced, the server reads a file measured
 * in kilobytes.
 *
 * Why every shape is built three times: what an eye can resolve depends on the
 * zoom, not on the country. One tolerance per feature — the old scheme, sized
 * from the feature's own extent — let Chile's 37° mainland set the budget for
 * every rock in the Patagonian archipelago, so the islands came out a kilometre
 * coarse and the smallest came out as literal rectangles; and being fixed at
 * build time, the outline could never repay a user for zooming in. So each
 * feature is written once per rung of shape.mjs's LOD ladder, coarse to fine,
 * and the client swaps rungs as the map zooms. The tolerances, the ring-drop rule, and the dissolve that merges
 * neighbours into one outline all live in shape.mjs; this file is the driver
 * that decides what to slice, group, merge and name.
 *
 * Writes, for each LOD `l0`, `l1`, `l2`:
 *   admin0/<l>/<CC>.json   { code, name, geometry }
 *   admin1/<l>/<CC>.json   [ { id, name, names, code, parts, geometry }, ... ]
 *   merged/<l>/<CC>.json   { "<signature>": { name, names, parts, geometry } }
 *   index.json             what exists and the ladder it was built on
 *
 * One directory per LOD rather than one file holding all three, because the
 * server reads whole files: answering a LOD 0 request must never mean parsing
 * Canada's LOD 2 coastline.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LODS, countVertices, dissolve, hitTester, ringsOf, simplifyAt } from './shape.mjs'
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
  for (const lod of LODS) mkdirSync(join(HERE, dir, 'l' + lod.id), { recursive: true })
}

// The ladder goes in the index rather than being restated in the server and in
// the client: one definition, discovered by whoever needs it.
const index = { countries: {}, builtAt: new Date().toISOString(), lods: LODS }
let vIn = 0
const vOut = new Map(LODS.map((l) => [l.id, 0]))
const bytes = new Map(LODS.map((l) => [l.id, 0]))

/** Writes one slice at one LOD, tallying vertices as it goes so the run reports
 * what actually landed on disk. The three payload shapes — a country, a list of
 * subdivisions, a map of merges — are all just things with a geometry, which is
 * all the tally cares about. */
const slice = (dir, lod, code, payload) => {
  const each = payload.geometry ? [payload] : Array.isArray(payload) ? payload : Object.values(payload)
  for (const f of each) vOut.set(lod.id, vOut.get(lod.id) + countVertices(f.geometry))
  const json = JSON.stringify(payload)
  bytes.set(lod.id, bytes.get(lod.id) + Buffer.byteLength(json))
  writeFileSync(join(HERE, dir, 'l' + lod.id, code + '.json'), json)
}

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

/** One country outline at every rung. The geometry handed in is raw Natural
 * Earth — or a raw dissolve — and is thinned here and nowhere earlier. */
const writeCountry = (code, name, names, geometry) => {
  for (const lod of LODS) slice('admin0', lod, code, { code, name, geometry: simplifyAt(geometry, lod.tol) })
  index.countries[code] = { name, names: [...new Set(names)], admin1: 0, merged: 0 }
}

for (const f of best.values()) {
  const p = f.properties
  vIn += countVertices(f.geometry)
  // Every spelling the country answers to, so a meta key written as
  // "Bosnia:" or "United States:" finds the same file.
  const names = new Set()
  for (const k of ['NAME_EN', 'NAME', 'NAME_LONG', 'NAME_SORT', 'NAME_CIAWF', 'ADMIN', 'SOVEREIGNT', 'NAME_ALT'])
    if (typeof p[k] === 'string') for (const part of p[k].split('|')) if (part.trim()) names.add(part.trim())
  writeCountry(iso2(p), p.NAME_EN || p.NAME, names, f.geometry)
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
  vIn += countVertices(f.geometry)
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
    geometry: f.geometry,
    groups: [p.region, p.geonunit].filter((g) => typeof g === 'string' && g.trim()),
  })
  if (!parentNames.has(code)) parentNames.set(code, new Set())
  for (const k of ['admin', 'geonunit']) if (typeof p[k] === 'string' && p[k].trim()) parentNames.get(code).add(p[k])
}

/* ── geoBoundaries ──────────────────────────────────────────────────────── */

/**
 * Where geoBoundaries has a country, its subdivisions replace Natural Earth's
 * geometry outright — the whole of Hokkaidō was 747 points, one vertex every
 * six kilometres, which is why the outline used to cut straight across bays
 * that are plainly there on the map underneath. The same island out of
 * OpenStreetMap is a hundred and twenty thousand, thinned here to twelve.
 *
 * Only the geometry is replaced. Natural Earth stays the naming layer, because
 * the scopes were written from whatever the geocoder happened to return and
 * geoBoundaries carries exactly one name per unit. Its names are matched back
 * to Natural Earth's — by ISO 3166-2 code where both know one, by name
 * otherwise — and every alternate spelling comes across, so a scope that says
 * "Hokkaidō" or "Catalonia" still lands on the shape now drawn from the other
 * source.
 *
 * The country outline is rewritten too, as the dissolve of its own
 * subdivisions, so a countrywide highlight and a regional one never disagree
 * about where the coast is. That dissolve is only exact because the download
 * was thinned as TopoJSON arcs: a border shared by two provinces is one arc,
 * thinned once, and both sides still cancel it to the last digit.
 */
const GB = join(SRC, 'gb')

/** Natural Earth's spellings, reachable by any one of them. Keyed by every name
 * a subdivision answers to, and additionally by each grouping it belongs to —
 * so a geoBoundaries unit called "Cataluña", which Natural Earth only has as a
 * `region` over four provinces, still picks up "Catalonia" and "Catalunya". */
const neAliases = new Map()
const neByIso = new Map()
for (const [code, list] of byCountry) {
  const aliases = new Map()
  const add = (key, names) => {
    if (!key) return
    if (!aliases.has(key)) aliases.set(key, new Set())
    for (const n of names) aliases.get(key).add(n)
  }
  const groups = new Map()
  for (const f of list) {
    for (const n of f.names) add(norm(n), f.names)
    if (f.code) neByIso.set(f.code.toUpperCase(), f.names)
    for (const g of f.groups) {
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(f)
    }
  }
  for (const [name, members] of groups) {
    const shared = members[0].names.filter((n) => members.every((m) => m.names.some((x) => norm(x) === norm(n))))
    add(norm(name), [name, ...shared])
  }
  neAliases.set(code, aliases)
}

/**
 * Joins geoBoundaries units to Natural Earth's names by the ground they cover.
 *
 * The name join carries the alternate spellings, and it is what the curated
 * scopes match against — so a unit that fails to join answers to one spelling
 * only and any scope written with a different one silently draws nothing. Names
 * fail for dull reasons: geoBoundaries spells South Africa's Northern Cape
 * "Nothern Cape", and one transposed letter would have cost the province its
 * scope entirely.
 *
 * The two datasets disagree about spelling but not about where a province is,
 * so unjoined units are matched by geometry instead: sample the unit, ask which
 * Natural Earth subdivision holds the samples, and take that one's names.
 * Sampling rather than a centroid because a centroid falls outside anything
 * crescent-shaped; a clear majority rather than a first hit because border
 * vertices sit in both.
 */
function groundJoin(units, neFeatures, aliases) {
  const orphans = units.filter((u) => !nameDonors(u.name, aliases).length)
  const out = new Map()
  if (!orphans.length || !neFeatures.length) return out
  // Only Natural Earth units no name claimed, so a geometric near-miss can
  // never steal the names of a subdivision that already joined cleanly.
  const claimed = new Set(units.flatMap((u) => nameDonors(u.name, aliases)).map(norm))
  const free = neFeatures.filter((f) => !f.names.some((n) => claimed.has(norm(n))))
  if (!free.length) return out
  const neTests = free.map((f) => ringsOf(f.geometry).map(hitTester))
  for (const u of orphans) {
    const pts = interiorPoints(u.geometry)
    if (!pts.length) continue
    const hits = neTests.map((t) => pts.filter((p) => covers(t, p)).length)
    const rank = hits.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0])
    // A clear winner, not a bare majority. The two datasets draw the same coast
    // differently, so a coastal province loses a good share of its samples to
    // sea that Natural Earth puts outside every province — but it loses none of
    // them to the neighbour, and doubling the runner-up is the test that says so.
    if (rank[0][0] && rank[0][0] >= 2 * (rank[1]?.[0] ?? 0)) out.set(u, free[rank[0][1]].names)
  }
  return out
}

/** Every spelling a geoBoundaries name offers. It writes a bilingual
 * subdivision as one string with a slash — "Cataluña/Catalunya",
 * "País Vasco/Euskadi" — and neither half of that is a name anything else in
 * the world uses, so the whole thing joins to nothing and the region answers to
 * a spelling no scope would ever be written with. */
const spellings = (name) =>
  [...new Set([name ?? '', ...String(name ?? '').split('/')].map((s) => s.trim()).filter(Boolean))]

/** The Natural Earth names a geoBoundaries name earns, by any of its
 * spellings. */
const nameDonors = (name, aliases) => [
  ...new Set(spellings(name).flatMap((s) => [...(aliases.get(norm(s)) ?? [])])),
]

/** Inside by the even-odd rule over every ring at once, so a hole or an island
 * in a lake answers correctly without tracking which ring belongs to which
 * polygon. */
const covers = (tests, p) => {
  let n = 0
  for (const t of tests) if (t(p)) n++
  return n % 2 === 1
}

/** Points that are certainly inside a shape: a grid over its extent, keeping
 * what lands within. Vertices would be cheaper and are useless here — they sit
 * exactly on the border, which is the one place the two datasets disagree and
 * the one place a containment test can go either way. */
function interiorPoints(geom) {
  const rings = ringsOf(geom)
  if (!rings.length) return []
  const tests = rings.map(hitTester)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings)
    for (const c of r) {
      if (c[0] < x0) x0 = c[0]
      if (c[0] > x1) x1 = c[0]
      if (c[1] < y0) y0 = c[1]
      if (c[1] > y1) y1 = c[1]
    }
  const N = 32
  const pts = []
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p = [x0 + ((i + 0.5) / N) * (x1 - x0), y0 + ((j + 0.5) / N) * (y1 - y0)]
      if (covers(tests, p)) pts.push(p)
    }
  return pts
}

let gbCountries = 0
let gbUnits = 0
const gbDeclined = []
for (const file of existsSync(GB) ? readdirSync(GB).filter((f) => f.endsWith('.json')) : []) {
  const code = file.slice(0, -5).toUpperCase()
  const gb = JSON.parse(readFileSync(join(GB, file), 'utf8'))
  const units = (gb.features ?? []).filter((u) => u.geometry)
  if (!units.length) continue
  for (const u of units) vIn += countVertices(u.geometry)

  // geoBoundaries is not uniformly better. Most countries gain enormously —
  // Canada thirty-fold, Chile twenty-seven, Japan seventeen — but a handful
  // arrive from a generalised source and are plainly coarser than what we
  // already have: the United Kingdom is four nations in four thousand points
  // against Natural Earth's twenty thousand. Counting decides it, per country,
  // rather than a hand-kept list that would rot at the next release.
  const gbV = units.reduce((n, u) => n + countVertices(u.geometry), 0)
  const neV = (byCountry.get(code) ?? []).reduce((n, f) => n + countVertices(f.geometry), 0)
  if (gbV <= neV) {
    gbDeclined.push(code)
    continue
  }

  // Whatever this country is already called, from the country file if Natural
  // Earth has one and from its own subdivisions if not — geoBoundaries knows
  // one name per unit and the scopes were written against every spelling.
  const known = index.countries[code]
  const countryName = known?.name ?? [...(parentNames.get(code) ?? [])][0] ?? code
  const countryNames = known?.names ?? [...(parentNames.get(code) ?? [])]
  const wasSynthesized = !known

  // A territory with nothing to subdivide — Bermuda, American Samoa — arrives as
  // its outline alone. Take the better outline and leave its Natural Earth
  // parishes as they are; nothing scopes to a parish.
  if (gb.level === 'ADM0') {
    writeCountry(code, countryName, countryNames, units[0].geometry)
    if (wasSynthesized) index.countries[code].synthesized = true
    gbCountries++
    continue
  }

  const aliases = neAliases.get(code) ?? new Map()
  const byGround = groundJoin(units, byCountry.get(code) ?? [], aliases)
  const list = units.map((u, i) => {
    const names = new Set(spellings(u.name))
    const byName = nameDonors(u.name, aliases)
    const donors = (u.code && neByIso.get(u.code.toUpperCase())) ?? (byName.length ? byName : byGround.get(u))
    for (const n of donors ?? []) names.add(n)
    // `gb:` ids never collide with Natural Earth's adm1_code, so the two sources
    // can sit in `raw` together while the ADM0-only countries still resolve.
    const id = `gb:${code}:${i}`
    raw.set(id, u.geometry)
    return {
      id,
      name: u.name ?? [...names][0] ?? id,
      names: [...names],
      code: u.code ?? null,
      parts: [id],
      geometry: u.geometry,
      groups: [],
    }
  })
  byCountry.set(code, list)
  // The country is its own subdivisions, dissolved — not Natural Earth's
  // outline, which would disagree with them along every coast.
  writeCountry(code, countryName, countryNames, dissolve(list.map((f) => f.geometry)))
  if (wasSynthesized || known?.synthesized) index.countries[code].synthesized = true
  gbCountries++
  gbUnits += list.length
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
    const geometry = dissolve(parts.map((p) => raw.get(p)))
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
  const geometry = dissolve(parts.map((p) => raw.get(p)))
  const names = [...(parentNames.get(code) ?? [])]
  writeCountry(code, names[0] ?? code, names, geometry)
  index.countries[code].synthesized = true
}

for (const [code, list] of byCountry) {
  for (const lod of LODS)
    slice('admin1', lod, code, list.map((f) => ({ ...f, geometry: simplifyAt(f.geometry, lod.tol) })))
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
  const geometry = dissolve(parts.map((p) => raw.get(p)))
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
  for (const lod of LODS)
    slice(
      'merged',
      lod,
      code,
      Object.fromEntries(
        Object.entries(sets).map(([sig, f]) => [sig, { ...f, geometry: simplifyAt(f.geometry, lod.tol) }])
      )
    )
  if (index.countries[code]) index.countries[code].merged = Object.keys(sets).length
}
writeFileSync(join(HERE, 'index.json'), JSON.stringify(index, null, 2))

const synthesized = Object.values(index.countries).filter((c) => c.synthesized).length
console.log(
  `admin0: ${Object.keys(index.countries).length} countries (${synthesized} dissolved from their own subdivisions) | ` +
    `admin1: ${byCountry.size} countries, ${[...byCountry.values()].reduce((n, l) => n + l.length, 0)} subdivisions | ` +
    `merged: ${[...merged.values()].reduce((n, s) => n + Object.keys(s).length, 0)} scope sets | ` +
    `geoBoundaries: ${gbCountries} countries, ${gbUnits} subdivisions` +
    (gbDeclined.length ? ` (Natural Earth kept for ${gbDeclined.join(', ')} — finer there)` : '')
)
for (const lod of LODS) {
  const n = vOut.get(lod.id)
  console.log(
    `  LOD ${lod.id} (tol ${lod.tol}°, z≤${lod.maxZoom}): ` +
      `${n.toLocaleString()} vertices (raw sources hold ${vIn.toLocaleString()}), ` +
      `${(bytes.get(lod.id) / 2 ** 20).toFixed(1)} MB on disk`
  )
}

// The slices are what the overlay draws; the packs are what the round pipeline
// reverse-geocodes against. Building them here means the two can never drift —
// a rebuild that left a stale pack behind would grade rounds against the old
// boundaries without saying so.
await import('./pack.mjs').then((m) => m.writePacks())
