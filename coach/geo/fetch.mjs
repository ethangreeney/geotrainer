/**
 * Downloads the sources the boundary slices are built from: the two Natural
 * Earth files, and then geoBoundaries' OpenStreetMap-derived subdivisions for
 * every country the deck can actually put on screen.
 *
 *   node coach/geo/fetch.mjs [--force]
 *   node coach/geo/build.mjs
 *
 * Natural Earth is 52 MB and geoBoundaries is roughly 600 MB in flight and 300
 * MB thinned on disk, so both are gitignored like the slices; this script is
 * what makes a fresh clone reproducible. It takes about ten minutes on a good
 * connection, almost all of it geoBoundaries. Natural Earth is public domain,
 * geoBoundaries gbOpen is ODbL 1.0, and both are served straight off the
 * projects' own hosts, so there is no key, no account and no rate limit to
 * respect — the only reason to think about the network here is that this much
 * data over a bad connection is worth resuming rather than restarting, hence
 * the retries and the skip-if-present.
 *
 * Pinned to a tag rather than master: an unannounced upstream reshuffle should
 * not quietly change which shape a round highlights. Moving to a newer release
 * is a one-line edit and a rebuild.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'src')
const RELEASE = 'v5.1.2'
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${RELEASE}/geojson`
const FILES = ['ne_10m_admin_0_countries.geojson', 'ne_10m_admin_1_states_provinces.geojson']
const force = process.argv.includes('--force')

const mb = (bytes) => (bytes / 1e6).toFixed(1) + ' MB'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sizeOf = async (path) => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function download(name) {
  const path = join(SRC, name)
  const have = await sizeOf(path)
  if (have && !force) {
    console.log(`${name}: have it (${mb(have)}) — pass --force to replace`)
    return
  }
  // Written aside and moved into place, so an interrupted download can never
  // leave a truncated file that parses as far as it goes and then throws in
  // the middle of a build.
  const tmp = path + '.part'
  for (const backoff of [0, 2000, 10000]) {
    if (backoff) await sleep(backoff)
    try {
      const res = await fetch(`${BASE}/${name}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      await rename(tmp, path)
      console.log(`${name}: ${mb(await sizeOf(path))}`)
      return
    } catch (err) {
      await unlink(tmp).catch(() => {})
      console.warn(`${name}: ${err.message}`)
    }
  }
  throw new Error(`could not fetch ${name} from ${BASE}`)
}

await mkdir(SRC, { recursive: true })
for (const name of FILES) await download(name)

/* ── geoBoundaries ──────────────────────────────────────────────────────── */

/**
 * Natural Earth is a small-scale dataset and it shows the moment anyone zooms
 * in: the whole of Hokkaidō is 747 points, one vertex every six kilometres, so
 * the outline cuts straight across bays that are plainly there on the map
 * underneath. No amount of care in the simplifier helps, because the finest
 * rung of the ladder was already serving the source unthinned — the detail was
 * never there to lose.
 *
 * geoBoundaries carries the same subdivisions drawn from OpenStreetMap:
 * Hokkaidō is 123,899 points, and thinned to the ladder's finest tolerance it
 * lands at 12,194 — sixteen times Natural Earth's whole budget, at a quarter of
 * a megabyte. Zoomed out the two are indistinguishable (166 points against
 * 161), which is the point: this changes nothing about the coarse view and
 * everything about the close one.
 *
 * Natural Earth stays. It is the naming layer — every alternate spelling a
 * subdivision answers to, and the country outlines for everywhere the deck has
 * never been — and it is the fallback for any country geoBoundaries has no
 * subdivisions for. What is replaced is geometry, country by country, only
 * where something better exists.
 *
 * Only the countries the catalogs can actually serve are downloaded. That is
 * around ninety of them and roughly 600 MB of TopoJSON; all 240 would be
 * several gigabytes to hold shapes for rounds that cannot come up. A country
 * outside the list simply draws from Natural Earth as it always did.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { LODS, simplifyRing } from './shape.mjs'
import { decodeTopology, thinTopology } from './topo.mjs'

const GB = join(SRC, 'gb')
const GB_API = 'https://www.geoboundaries.org/api/current/gbOpen'
// The finest rung's tolerance, applied once here so the cache on disk is the
// most detail the overlay can ever draw and no more. Everything coarser is
// derived from it at build time.
const GB_TOL = LODS[LODS.length - 1].tol

/** Which countries the deck can put on screen: every country the location
 * catalogs cover, plus every country a curated scope names. Read from the raw
 * files rather than from built output, since this runs before the build. */
async function neededCountries() {
  const names = new Set()
  for (const file of await readdir(join(HERE, '..', 'catalog')).catch(() => [])) {
    if (!file.endsWith('.json')) continue
    const cat = JSON.parse(await readFile(join(HERE, '..', 'catalog', file), 'utf8'))
    for (const loc of cat.locations ?? []) if (loc.country) names.add(loc.country.trim())
  }
  const scope = JSON.parse(await readFile(join(HERE, '..', 'scope-regions.json'), 'utf8'))
  for (const key of Object.keys(scope)) if (!key.startsWith('_')) names.add(key.split(':')[0].trim())

  // Natural Earth's own country file is the name-to-code table, the same one
  // the build uses; reading it here keeps a fresh clone from needing a build
  // before it can fetch.
  const ne = JSON.parse(await readFile(join(SRC, FILES[0]), 'utf8'))
  const codes = new Map()
  const two = (p) => [p.ISO_A2, p.ISO_A2_EH, p.iso_a2].find((v) => /^[A-Za-z]{2}$/.test(v ?? ''))
  const three = (p) => [p.ISO_A3, p.ISO_A3_EH, p.ADM0_A3, p.adm0_a3].find((v) => /^[A-Za-z]{3}$/.test(v ?? ''))
  const key = (s) => s.toLowerCase().replace(/[^a-z]/g, '')
  for (const f of ne.features) {
    const p = f.properties
    const cc = two(p)
    const c3 = three(p)
    if (!cc || !c3) continue
    for (const k of ['NAME_EN', 'NAME', 'NAME_LONG', 'NAME_SORT', 'NAME_CIAWF', 'ADMIN', 'SOVEREIGNT'])
      if (typeof p[k] === 'string' && !codes.has(key(p[k])))
        codes.set(key(p[k]), { cc: cc.toUpperCase(), iso3: c3.toUpperCase() })
  }
  const out = new Map()
  const unknown = []
  for (const name of names) {
    const hit = codes.get(key(name))
    if (hit) out.set(hit.cc, hit.iso3)
    else unknown.push(name)
  }
  if (unknown.length) console.warn(`gb: no ISO code for ${unknown.sort().join(', ')} — those stay on Natural Earth`)
  return out
}

/** Where geoBoundaries keeps this country's finest boundaries. Subdivisions
 * when it has them; the country outline alone for the small territories that
 * have no subdivisions to have, which is all they need. */
async function gbSource(iso3) {
  for (const level of ['ADM1', 'ADM0']) {
    const res = await fetch(`${GB_API}/${iso3}/${level}/`).catch(() => null)
    if (!res?.ok) continue
    const meta = await res.json()
    const url = meta.tjDownloadURL ?? meta.gjDownloadURL?.replace(/\.geojson$/, '.topojson')
    if (url) return { level, url }
  }
  return null
}

/** One country, downloaded and thinned to the cache the build reads. The raw
 * download is never written: it is parsed, thinned in memory and dropped, so a
 * 648 MB Canada costs its own download and nothing on disk. */
async function gbCountry(cc, iso3) {
  const path = join(GB, cc + '.json')
  if ((await sizeOf(path)) && !force) return { cc, skipped: true }
  const src = await gbSource(iso3)
  if (!src) return { cc, missing: true }
  for (const backoff of [0, 3000, 15000]) {
    if (backoff) await sleep(backoff)
    try {
      const res = await fetch(src.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const topo = JSON.parse(await res.text())
      const features = decodeTopology(thinTopology(topo, GB_TOL, simplifyRing)).map((f) => ({
        name: f.properties.shapeName ?? null,
        code: /^[A-Za-z]{2}-\w+$/.test(f.properties.shapeISO ?? '') ? f.properties.shapeISO : null,
        geometry: f.geometry,
      }))
      if (!features.length) throw new Error('no features')
      const json = JSON.stringify({ iso3, level: src.level, features })
      await writeFile(path + '.part', json)
      await rename(path + '.part', path)
      return { cc, level: src.level, units: features.length, bytes: json.length }
    } catch (err) {
      await unlink(path + '.part').catch(() => {})
      console.warn(`gb ${cc}: ${err.message}`)
    }
  }
  return { cc, failed: true }
}

await mkdir(GB, { recursive: true })
const wanted = [...(await neededCountries())].sort()
console.log(`gb: ${wanted.length} countries to check`)
let done = 0
let written = 0
let held = 0
const missing = []
const queue = wanted.slice()
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const [cc, iso3] = queue.shift()
      const r = await gbCountry(cc, iso3)
      done++
      if (r.skipped) held++
      else if (r.missing || r.failed) missing.push(cc)
      else {
        written++
        console.log(`gb ${cc} ${r.level}: ${r.units} units, ${mb(r.bytes)} thinned  [${done}/${wanted.length}]`)
      }
    }
  }),
)
console.log(
  `gb: ${written} written, ${held} already had` +
    (missing.length ? `, ${missing.length} on Natural Earth only (${missing.sort().join(', ')})` : ''),
)
console.log('now run: node coach/geo/build.mjs')
