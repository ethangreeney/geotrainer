/**
 * Packs the boundary slices into three binaries the round pipeline can carry:
 * one for countries, one for the subdivisions that meta scopes are written
 * against, and one for the scopes that span several subdivisions at once.
 * locate.mjs reads the first two; outline.mjs reads all three; the Worker
 * bundles them at deploy time.
 *
 *   node coach/geo/pack.mjs      (after build.mjs; ~1 min, writes coach/geo/pack/)
 *
 * Format, per file: a uint32 header length, that many bytes of JSON naming the
 * features in order, then one varint stream — per feature a ring count, per
 * ring a vertex count, then the vertices as zigzag deltas on an integer grid.
 * Delta coding is what makes it small: a simplified outline steps a few hundred
 * metres at a time, so almost every coordinate fits in one byte where a JSON
 * decimal takes eight.
 *
 * Which rung of the detail ladder each shape is packed at is decided per
 * shape — see RUNGS below. Nothing in the format records the choice, because
 * nothing downstream needs it: a feature is plain geometry either way.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SCOPE_REGIONS from '../scope-regions.json' with { type: 'json' }
import { countryCode, norm } from './resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACK_DIR = join(HERE, 'pack')
export const COUNTRY_PACK = join(PACK_DIR, 'admin0.bin')
export const REGION_PACK = join(PACK_DIR, 'admin1.bin')
export const MERGED_PACK = join(PACK_DIR, 'merged.bin')

/**
 * The two rungs a shape may be packed at, coarse first.
 *
 * The packs used to carry one rung apiece — countries at l1, subdivisions and
 * merges at l0 — and the serving path can only ever *thin* what the pack holds.
 * So a client zoomed in past z=8 and asking for LOD 2 got LOD 1 at best for a
 * country and LOD 0 for a region, and no amount of zooming made the outline
 * finer. Worse, simplifyAt drops any ring smaller than ten tolerances across,
 * which at l0 is 0.2° — twenty-two kilometres. Every offshore island a region
 * owns simply was not in the pack, which is what "small islands look
 * low-resolution" actually was: they were not low-resolution, they were gone.
 *
 * l2 everywhere is not affordable — the country pack alone would be 14MB and
 * Canada's provinces another 5MB — so the rung is chosen per shape against a
 * flat byte budget. That is the right axis: what makes l2 expensive is a long
 * coastline, and a long coastline is exactly what a big shape has. Malta, the
 * Faroes and Vanuatu are nowhere near the budget and take the fine rung; Canada
 * and Indonesia are far past it and stay where they were. Nothing gets worse
 * than it is today, and 90% of shapes get an order of magnitude better.
 *
 * The budget doubles as the serving-cost ceiling. buildScopeGeo re-simplifies
 * the whole outline on every request, so the largest shape in the pack is the
 * Worker's worst case; capping the packed bytes caps that too, and the shapes
 * that stay at l1 are precisely the ones already at l1 today.
 */
const RUNGS = ['l1', 'l2']
const FEATURE_BUDGET = 64 * 1024

/**
 * 1/20000° ≈ 5.5m.
 *
 * This used to be 1/2000° (~55m) with a comment claiming it was finer than
 * either rung's own simplification. That was true while the finest rung in any
 * pack was l1 (0.0025°, ~275m) and false the moment l2 (0.0003°, ~33m) went in:
 * a 55m grid rounds a 33m tolerance into noise, and the detail the finer slice
 * was read for would have been destroyed at pack time. Six times finer than the
 * tolerance it carries is the same margin 1/2000° gave l1, so the claim holds
 * again.
 *
 * The scale is written into each pack's header and read back by loadPack, so
 * the readers need no change and the hit-test grid, the offshore reach and the
 * printed decimals all follow it — outline.mjs derives its decimal places from
 * this number rather than assuming four.
 */
const SCALE = 20000

class Writer {
  constructor() {
    this.out = []
  }
  uint(n) {
    do {
      const b = n & 0x7f
      n = Math.floor(n / 128)
      this.out.push(n ? b | 0x80 : b)
    } while (n)
  }
  int(n) {
    this.uint(n < 0 ? -n * 2 - 1 : n * 2)
  }
}

const polygonsOf = (geometry) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates

/** One geometry's stretch of the varint stream, and how many polygons it is —
 * the header needs one place index per polygon, and a shape has a different
 * number of them at each rung. */
function encodeGeometry(geometry) {
  const w = new Writer()
  let polygons = 0
  for (const rings of polygonsOf(geometry)) {
    polygons++
    w.uint(rings.length)
    for (const ring of rings) {
      w.uint(ring.length)
      let px = 0
      let py = 0
      for (const [lng, lat] of ring) {
        const x = Math.round(lng * SCALE)
        const y = Math.round(lat * SCALE)
        w.int(x - px)
        w.int(y - py)
        px = x
        py = y
      }
    }
  }
  return { bytes: w.out, polygons }
}

/**
 * The finest rung this shape can afford, and the geometry to pack.
 *
 * The coarse rung is measured first and the fine one is fetched only when the
 * coarse one already fits: a finer simplification is never smaller, so a shape
 * over budget at l1 is over budget at l2 too, and Canada's 43MB of l2 JSON is
 * never parsed at all.
 */
function pick(coarse, finer) {
  if (encodeGeometry(coarse).bytes.length <= FEATURE_BUDGET) {
    const fine = finer()
    if (fine && encodeGeometry(fine).bytes.length <= FEATURE_BUDGET)
      return { lod: RUNGS[1], geometry: fine }
  }
  return { lod: RUNGS[0], geometry: coarse }
}

/** One entry per polygon, not per feature: a country's islands are separate
 * claims on the map, and keeping them apart lets the smallest-shape-wins rule
 * pick an island out of the sovereign that also covers it. */
function encode(entries, kind) {
  // The names live in a table and each polygon carries an index into it: a
  // country contributes hundreds of polygons and spelling "United States of
  // America" once beats spelling it four hundred times.
  const places = []
  const seen = new Map()
  const features = []
  // One buffer per feature rather than one array of bytes for the whole pack:
  // a pack's stream runs to millions of bytes and there is no spreading that
  // into a call without overflowing the stack.
  const chunks = []
  for (const { meta, geometry } of entries) {
    const key = meta.code + '\0' + meta.name
    if (!seen.has(key)) {
      seen.set(key, places.length)
      places.push(meta.names ? [meta.code, meta.name, meta.names] : [meta.code, meta.name])
    }
    const { bytes, polygons } = encodeGeometry(geometry)
    for (let i = 0; i < polygons; i++) features.push(seen.get(key))
    chunks.push(Buffer.from(bytes))
  }
  const head = Buffer.from(JSON.stringify({ scale: SCALE, kind, places, features }), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(head.length)
  return Buffer.concat([len, head, ...chunks])
}

const readSlice = (dir, lod, file) => {
  const path = join(HERE, dir, lod, file)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/** Every country geoBoundaries has a shape for, each at the finest rung it can
 * afford. */
export function countries() {
  const dir = join(HERE, 'admin0', RUNGS[0])
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      return {
        meta: { code: c.code, name: c.name },
        ...pick(c.geometry, () => readSlice('admin0', RUNGS[1], f)?.geometry),
      }
    })
}

/** Only the countries some meta is scoped to — the rest would be dead weight,
 * since a subdivision is never looked up except to test a scope. */
export function scopedCountries() {
  const codes = new Set()
  for (const key of Object.keys(SCOPE_REGIONS)) {
    if (key.startsWith('__')) continue
    const code = countryCode(key.split(':')[0].trim())
    if (code) codes.add(code)
  }
  return [...codes].sort()
}

/** Every spelling a scope might be written in, so the pack can carry the
 * subdivision under the name the card uses. */
const scopeSpellings = new Set(
  Object.values(SCOPE_REGIONS)
    .filter(Array.isArray)
    .flat()
    .map(norm),
)

/**
 * The one country's slice at the fine rung, read at most once however many of
 * its shapes ask for it, and indexed by whatever identifies a shape across
 * rungs. build.mjs writes every rung from the same list in the same order, so
 * the key is only ever a guard against that changing.
 */
function fineIndex(load, keyOf) {
  let index
  return (key) => {
    if (index === undefined) {
      index = new Map()
      for (const f of load() ?? []) index.set(keyOf(f), f)
    }
    return index.get(key)
  }
}

/** Subdivisions travel with all their spellings, because the one a scope is
 * written against is not always the one geoBoundaries uses: it spells South
 * Africa's Northern Cape "Nothern Cape", and a scope saying "Northern Cape"
 * graded every correct guess in the province out of scope for as long as the
 * pack carried that one name alone. The scope's own spelling leads, so a
 * dossier names the province the way the card does. */
export function regions() {
  const out = []
  for (const code of scopedCountries()) {
    const fine = fineIndex(
      () => readSlice('admin1', RUNGS[1], code + '.json'),
      (f) => f.id ?? f.name,
    )
    for (const f of readSlice('admin1', RUNGS[0], code + '.json') ?? []) {
      const names = f.names?.length ? f.names : [f.name]
      const name = names.find((n) => scopeSpellings.has(norm(n))) ?? f.name
      out.push({
        meta: { code, name, names },
        ...pick(f.geometry, () => fine(f.id ?? f.name)?.geometry),
      })
    }
  }
  return out
}

/**
 * The scopes that cover several subdivisions at once, already dissolved by
 * build.mjs into a single outline with the internal borders taken out. Drawn
 * from their parts instead, a scope like Paraná + Santa Catarina + Rio Grande
 * do Sul shows a stroke along every shared border — a line through the middle
 * of the highlight, which reads as a rendering fault rather than as
 * information.
 *
 * A merge is looked up by the set of subdivisions it covers, so the names it
 * covers travel in the place table's alias slot — normalised through `norm`,
 * because that lookup has to survive the accents, the administrative nouns and
 * the case that separate "Paraná" on a card from "Parana" in geoBoundaries.
 * The display name (with the accents, joined by +) stays in the name slot,
 * which is what the overlay's label is built from.
 */
export function merges() {
  const dir = join(HERE, 'merged', RUNGS[0])
  const out = []
  for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!file.endsWith('.json')) continue
    const code = file.slice(0, -5)
    let fine
    const sets = readSlice('merged', RUNGS[0], file) ?? {}
    for (const [sig, m] of Object.entries(sets)) {
      out.push({
        meta: { code, name: m.name, names: m.names.map(norm) },
        ...pick(m.geometry, () => (fine ??= readSlice('merged', RUNGS[1], file) ?? {})[sig]?.geometry),
      })
    }
  }
  return out
}

/** All three packs, written next to the slices they came from. Called by build.mjs
 * so a rebuild can never leave a stale pack behind, and runnable on its own
 * when only the packing changed. */
export function writePacks() {
  mkdirSync(PACK_DIR, { recursive: true })
  for (const [label, path, entries, kind] of [
    ['countries', COUNTRY_PACK, countries(), 'admin0'],
    ['subdivisions', REGION_PACK, regions(), 'admin1'],
    ['dissolved scopes', MERGED_PACK, merges(), 'merged'],
  ]) {
    const buf = encode(entries, kind)
    writeFileSync(path, buf)
    const rungs = RUNGS.map((r) => `${entries.filter((e) => e.lod === r).length} ${r}`).join(', ')
    // The three packs are bundled into the Worker, whose whole script has to
    // stay well under Cloudflare's ceiling alongside the meta catalogs. Worth
    // watching, and the rung split is what moves it.
    console.log(`${label}: ${entries.length} features (${rungs}), ${(buf.length / 1e6).toFixed(2)} MB`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) writePacks()
