/**
 * Rasterises the repo's own country boundaries into the dot mask the landing
 * page's globe is drawn from.
 *
 *   node site/scripts/globe-dots.mjs      (~5s, writes site/globe-dots.json)
 *
 * Run once, by hand, and commit the result: the site build must never depend on
 * coach/geo/, which is 650MB of gitignored source and slices that only exist on
 * a machine that has run the fetch.
 *
 * The shapes come from coach/geo/pack/admin0.bin — the same binary the Worker
 * reverse-geocodes rounds against, so the coastlines on the page are literally
 * the coastlines the grader uses. locate.mjs decodes it; the containment test
 * is repeated here rather than borrowed, because `locate` deliberately falls
 * back to the nearest coast within 39km when nothing contains the point, and on
 * a globe that reads as a halo of dots floating in the sea around every island.
 * A missing dot is invisible; a dot in the ocean is a mistake you can see.
 *
 * Sampling is a near-even spherical grid: a fixed latitude step, and a
 * longitude step widened by 1/cos(lat) so the dots do not crowd at the poles.
 * Odd rows are offset half a step, which packs them hexagonally and stops the
 * mask reading as a lattice. Output is quantised to a tenth of a degree — 11km,
 * far finer than the 155km spacing — and written as one flat array of integer
 * lat,lng pairs, which gzips to a quarter of its size and needs three lines to
 * read back.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPack } from '../../coach/geo/locate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACK = join(HERE, '..', '..', 'coach', 'geo', 'pack', 'admin0.bin')
const OUT = join(HERE, '..', 'globe-dots.json')

const RAD = Math.PI / 180
/** 1.4° ≈ 155km at the equator: dense enough that Italy still has a shape,
 *  sparse enough that the whole mask stays under 8k points. */
const STEP = 1.4
const NORTH = 84 // nothing above this but the last of Ellesmere Island
const SOUTH = -89 // Antarctica is most of a hemisphere and should look like it

if (!existsSync(PACK)) {
  console.error(`no country pack at ${PACK} — run: node coach/geo/build.mjs`)
  process.exit(2)
}

const pack = loadPack(readFileSync(PACK))

const inRing = (ring, x, y) => {
  const { xs, ys } = ring
  let inside = false
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const yi = ys[i]
    const yj = ys[j]
    if (yi > y !== yj > y && x < ((xs[j] - xs[i]) * (y - yi)) / (yj - yi) + xs[i]) inside = !inside
  }
  return inside
}

/** Ring 0 is the outline, the rest are holes — a lake is not land. */
const covers = (f, x, y) => {
  if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) return false
  if (!inRing(f.rings[0], x, y)) return false
  for (let i = 1; i < f.rings.length; i++) if (inRing(f.rings[i], x, y)) return false
  return true
}

/* One pass over 9k polygons per sample point would be 200M bounding-box tests.
   Bucketing the polygons by the latitude bands they span turns almost all of
   those into a lookup, and the whole grid finishes in a couple of seconds. */
const BAND = 2 // degrees per bucket
const bands = new Map()
const bandKey = (lat) => Math.floor(lat / BAND)
for (const f of pack.features) {
  const lo = bandKey(f.y0 / pack.scale)
  const hi = bandKey(f.y1 / pack.scale)
  for (let k = lo; k <= hi; k++) {
    const list = bands.get(k)
    if (list) list.push(f)
    else bands.set(k, [f])
  }
}

const land = (lat, lng) => {
  const here = bands.get(bandKey(lat))
  if (!here) return false
  const x = Math.round(lng * pack.scale)
  const y = Math.round(lat * pack.scale)
  for (const f of here) if (covers(f, x, y)) return true
  return false
}

const rows = Math.floor((NORTH - SOUTH) / STEP)
const out = []
let sampled = 0
for (let r = 0; r <= rows; r++) {
  const lat = SOUTH + r * STEP
  const cos = Math.max(Math.cos(lat * RAD), 0.02)
  const n = Math.max(3, Math.round((360 * cos) / STEP))
  const span = 360 / n
  const shift = r % 2 ? span / 2 : 0
  for (let c = 0; c < n; c++) {
    const lng = -180 + c * span + shift
    sampled++
    if (land(lat, lng)) out.push(Math.round(lat * 10), Math.round(lng * 10))
  }
}

/* ------------------------------------------------------------------ checks */
const dots = out.length / 2
const problems = []
if (out.some((v) => !Number.isFinite(v))) problems.push('a coordinate came out NaN')
if (dots < 3500 || dots > 9000) problems.push(`${dots} dots — wanted 4k–8k; the step or the pack has changed`)
if (out.length % 2) problems.push('odd number of values — the pairs are misaligned')

const near = (lat, lng, within) => {
  for (let i = 0; i < out.length; i += 2) {
    if (Math.abs(out[i] / 10 - lat) <= within && Math.abs(out[i + 1] / 10 - lng) <= within) return true
  }
  return false
}
/* Coastlines a person can name, one on each side of both equators, plus a
   patch of open ocean big enough that no simplification could reach it. */
for (const [name, lat, lng] of [
  ['Melbourne', -37, 145],
  ['Paris', 48.9, 2.4],
  ['Kansas', 38.5, -98],
  ['Nairobi', -1.3, 36.8],
  ['central Siberia', 62, 95],
])
  if (!near(lat, lng, 1.6)) problems.push(`no land dot near ${name} (${lat}, ${lng})`)
if (near(0, -30, 1.6)) problems.push('a land dot in the middle of the Atlantic (0, -30)')

const north = out.filter((_, i) => i % 2 === 0 && out[i] > 0).length
const south = dots - north
const east = out.filter((_, i) => i % 2 === 1 && out[i] > 0).length
if (!north || !south || !east || east === dots) problems.push('a whole hemisphere came back empty')

writeFileSync(OUT, JSON.stringify(out) + '\n')
const bytes = readFileSync(OUT).length
console.log(`${sampled} points sampled, ${dots} on land (${((100 * dots) / sampled).toFixed(1)}%)`)
console.log(`hemispheres: ${north} north / ${south} south, ${east} east / ${dots - east} west`)
console.log(`wrote ${OUT} — ${(bytes / 1024).toFixed(1)} KB`)
if (problems.length) {
  console.error('\n' + problems.join('\n'))
  process.exit(1)
}
