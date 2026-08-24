/**
 * Packs the boundary slices into two binaries the round pipeline can carry:
 * one for countries, one for the subdivisions that meta scopes are written
 * against. locate.mjs reads them; the Worker bundles them at deploy time.
 *
 *   node coach/geo/pack.mjs      (after build.mjs; ~2s, writes coach/geo/pack/)
 *
 * Format, per file: a uint32 header length, that many bytes of JSON naming the
 * features in order, then one varint stream — per feature a ring count, per
 * ring a vertex count, then the vertices as zigzag deltas on an integer grid.
 * Delta coding is what makes it small: a simplified outline steps a few hundred
 * metres at a time, so almost every coordinate fits in one byte where a JSON
 * decimal takes eight.
 *
 * The country pack uses the middle rung of the ladder (~275m). The coarsest
 * rung loses whole islands and hands border towns to the wrong side — measured
 * against captured rounds it put a Finnish round in Sweden and a Lao one in
 * Thailand, which is exactly the failure this system cannot afford. The
 * subdivision pack uses the coarsest rung on purpose: it only decides whether a
 * guess landed inside a meta's scope, and those scopes are whole states.
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

const COUNTRY_LOD = 'l1'
const REGION_LOD = 'l0'
// 1/2000° ≈ 55m — finer than either rung's own simplification, so quantising
// costs nothing, and coarse enough that most deltas stay inside one byte.
const SCALE = 2000

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

/** One entry per polygon, not per feature: a country's islands are separate
 * claims on the map, and keeping them apart lets the smallest-shape-wins rule
 * pick an island out of the sovereign that also covers it. */
function encode(entries, kind) {
  const w = new Writer()
  // The names live in a table and each polygon carries an index into it: a
  // country contributes hundreds of polygons and spelling "United States of
  // America" once beats spelling it four hundred times.
  const places = []
  const seen = new Map()
  const features = []
  for (const { meta, geometry } of entries) {
    const key = meta.code + '\u0000' + meta.name
    if (!seen.has(key)) {
      seen.set(key, places.length)
      places.push(meta.names ? [meta.code, meta.name, meta.names] : [meta.code, meta.name])
    }
    for (const rings of polygonsOf(geometry)) {
      features.push(seen.get(key))
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
  }
  const head = Buffer.from(JSON.stringify({ scale: SCALE, kind, places, features }), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(head.length)
  return Buffer.concat([len, head, Buffer.from(w.out)])
}

const readSlice = (dir, lod, file) => {
  const path = join(HERE, dir, lod, file)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function countries() {
  const dir = join(HERE, 'admin0', COUNTRY_LOD)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      return { meta: { code: c.code, name: c.name }, geometry: c.geometry }
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

/** Subdivisions travel with all their spellings, because the one a scope is
 * written against is not always the one geoBoundaries uses: it spells South
 * Africa's Northern Cape "Nothern Cape", and a scope saying "Northern Cape"
 * graded every correct guess in the province out of scope for as long as the
 * pack carried that one name alone. The scope's own spelling leads, so a
 * dossier names the province the way the card does. */
function regions() {
  const out = []
  for (const code of scopedCountries()) {
    for (const f of readSlice('admin1', REGION_LOD, code + '.json') ?? []) {
      const names = f.names?.length ? f.names : [f.name]
      const name = names.find((n) => scopeSpellings.has(norm(n))) ?? f.name
      out.push({ meta: { code, name, names }, geometry: f.geometry })
    }
  }
  return out
}

/** Both packs, written next to the slices they came from. Called by build.mjs
 * so a rebuild can never leave a stale pack behind, and runnable on its own
 * when only the packing changed. */
export function writePacks() {
  mkdirSync(PACK_DIR, { recursive: true })
  for (const [label, path, entries, kind] of [
    ['countries', COUNTRY_PACK, countries(), 'admin0'],
    ['subdivisions', REGION_PACK, regions(), 'admin1'],
  ]) {
    const buf = encode(entries, kind)
    writeFileSync(path, buf)
    // The country pack is bundled into the Worker, whose whole script has to
    // stay under 3MB gzipped alongside the meta catalogs. Worth watching.
    console.log(`${label}: ${entries.length} features, ${(buf.length / 1e6).toFixed(2)} MB`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) writePacks()
