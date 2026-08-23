/**
 * Renders the result-map boundary overlay to a PNG, so the geometry can be
 * *looked at* instead of argued about.
 *
 * Run: node coach/geo/preview.mjs CL --zoom 3,5,7,9
 *      node coach/geo/preview.mjs GB --regions "Scotland" --zoom 4,6,8
 *      node coach/geo/preview.mjs --help
 *
 * Vertex counts and simplification tolerances say nothing about whether an
 * archipelago still reads as islands. Only the picture does. Everything here
 * exists to make that picture honest:
 *
 *  - The geometry comes from the running server over `/api/scope-geo`, not off
 *    disk. The slice layout is rebuilt from time to time; the endpoint is the
 *    contract the browser actually uses, so this tool tests what ships.
 *  - The projection is Web Mercator at a named zoom with 256px tiles — the same
 *    plane Google draws on. A shape that looks wrong here looks wrong there.
 *  - The paint matches `paintScope` in coach/geocoach.user.js line for line:
 *    a #a99fce glow at the zoom's own weight/50%, a #2b1b58 fill at 14%, a #2b1b58 stroke at
 *    2px/95%. Get the weights wrong and good geometry reads as bad.
 *  - Edges are anti-aliased by supersampling. A jaggy rasteriser makes every
 *    coastline look low-poly, which would defeat the entire exercise.
 *
 * No dependencies, by constraint and by preference: the rasteriser and the PNG
 * encoder are below, and node's zlib does the compression. About 200 lines buys
 * independence from a native canvas build.
 *
 * PNGs go to a temp directory by default. They are generated artefacts and the
 * repo has no ignored scratch folder to put them in — keep them out of git.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = process.env.GEOCOACH_SERVER ?? 'http://127.0.0.1:5177'

/* The overlay's palette, copied from the userscript rather than imported: that
   file is a Tampermonkey script with no module boundary, and a divergence here
   would be visible in the very picture this tool exists to produce. */
const INK = [0x2b, 0x1b, 0x58]
const GLOW = [0xa9, 0x9f, 0xce]
const FILL_ALPHA = 0.14
const GLOW_ALPHA = 0.5
const INK_ALPHA = 0.95

/* Stroke weights ride the zoom in the overlay, and the whole reason they do is
   what this tool exists to show — a fixed 7px glow renders southern Chile as a
   smear that the shipped 3.5px one does not. Same ramp, same quantisation. */
function scopeWeights(z) {
  const t = Math.max(0, Math.min(1, ((typeof z === 'number' && isFinite(z) ? z : 4) - 2) / 10))
  const q = (a, b) => Math.round((a + (b - a) * t) * 4) / 4
  return { glow: q(2.5, 8), main: q(1, 2.4) }
}

/* Page furniture, not overlay: a near-white ground so the ink reads, and a
   graticule faint enough that it cannot be mistaken for a border. */
const BG = [0xf6, 0xf4, 0xfa]
const GRID = [0xdc, 0xd6, 0xe8]
const TEXT = [0x4a, 0x40, 0x68]

/* Which rung of the LOD ladder a client asks for at a given zoom. Deliberately
   duplicated from LODS in shape.mjs instead of imported: this tool talks to the
   server over HTTP precisely so it stays decoupled from the on-disk layer, and
   three lines of table is a cheaper coupling than an import. If the ladder in
   shape.mjs changes bands, change these numbers. A server that predates the
   ladder ignores the parameter, which is why nothing here depends on it. */
const LOD_BANDS = [
  [5, 0],
  [8, 1],
  [Infinity, 2],
]
const lodForZoom = (z) => LOD_BANDS.find(([maxZoom]) => z <= maxZoom)[1]

const HELP = `
preview.mjs — render the scope overlay exactly as the result map will draw it

  node coach/geo/preview.mjs <country> [options]

  <country>            ISO 3166-1 alpha-2 code (CL, GB, ZA...)
  --regions "A|B|C"    subdivision names, as spelled in coach/scope-regions.json
  --zoom 3,5,7,9       map zoom levels to render (default 3,5,7,9)
  --lod N              pin the level of detail; default is the rung a client
                       would pick for each zoom; "none" leaves it to the server
  --center LAT,LNG     centre the canvas here instead of on the bbox centre.
                       Past about zoom 6 a country no longer fits, and the bbox
                       centre is rarely the part you wanted to look at
  --out DIR            where the PNGs go (default \${TMPDIR}/geocoach-preview)
  --size WxH           canvas size in CSS px (default 900x600)
  --ss N               supersampling factor for anti-aliasing (default 3)
  --bare               no graticule, no caption — pure overlay on a flat ground
  --help

  The geometry is fetched from ${SERVER} (override with GEOCOACH_SERVER).
  Start the server with:
    nohup node coach/server.mjs > coach/server.log 2>&1 &
`

// ---------------------------------------------------------------- projection

const TILE = 256
/* Mercator diverges at the poles; every web map cuts it here, so the y range is
   exactly square with the x range and a tile is a tile at every zoom. */
const MAX_LAT = 85.05112878

const worldSize = (zoom) => TILE * 2 ** zoom

const projectX = (lng, world) => ((lng + 180) / 360) * world

const projectY = (lat, world) => {
  const s = Math.sin((Math.min(MAX_LAT, Math.max(-MAX_LAT, lat)) * Math.PI) / 180)
  return world * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))
}

/** The inverse, used only to find which parallels the canvas can see. */
const latOfY = (y, world) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI

// ------------------------------------------------------------------ geometry

/** Every linear ring in a FeatureCollection, as flat [lng,lat,...] arrays.
 *  Outer rings and holes come back undifferentiated on purpose: the fill rule
 *  below is even-odd, which decides what is a hole from the geometry itself
 *  rather than from ring order or winding — neither of which Natural Earth
 *  guarantees once a shape has been simplified and dissolved. */
function* rings(geojson) {
  const walk = function* (g) {
    if (!g) return
    if (g.type === 'Polygon') yield* g.coordinates
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) yield* poly
    else if (g.type === 'GeometryCollection') for (const sub of g.geometries) yield* walk(sub)
  }
  for (const f of geojson.features ?? []) yield* walk(f.geometry)
}

/** Bounding box, in a longitude frame that survives the antimeridian. Russia and
 *  Fiji straddle ±180, where a naive min/max claims the shape spans the whole
 *  planet and the preview zooms out to the entire world. Re-expressing western
 *  longitudes as >180 collapses that back to the real span; the frame carries a
 *  flag so projection can apply the same shift. */
function boundsOf(geojson) {
  let n = -Infinity
  let s = Infinity
  let rawW = Infinity
  let rawE = -Infinity
  let shiftW = Infinity
  let shiftE = -Infinity
  let points = 0
  let ringCount = 0
  for (const ring of rings(geojson)) {
    ringCount++
    for (const [lng, lat] of ring) {
      points++
      if (lat > n) n = lat
      if (lat < s) s = lat
      if (lng < rawW) rawW = lng
      if (lng > rawE) rawE = lng
      const shifted = lng < 0 ? lng + 360 : lng
      if (shifted < shiftW) shiftW = shifted
      if (shifted > shiftE) shiftE = shifted
    }
  }
  if (!points) return null
  // Only a shape that *appears* to span more than half the planet can be a
  // wrapped one; without that gate the two frames are the same width for an
  // ordinary country and floating-point noise decides which one wins.
  const wrap = rawE - rawW > 180 && shiftE - shiftW < rawE - rawW
  return {
    n,
    s,
    w: wrap ? shiftW : rawW,
    e: wrap ? shiftE : rawE,
    wrap,
    points,
    rings: ringCount,
  }
}

/** The server's own bbox when it sends one, ours otherwise. It is being added
 *  to the endpoint as this is written; trusting it when present keeps the
 *  preview framed the way the client will frame itself, and the local fallback
 *  means an older server still renders. */
function frameFor(res, geojson) {
  const local = boundsOf(geojson)
  if (!local) return null
  const b = res.bbox
  const usable = b && [b.n, b.s, b.e, b.w].every((v) => typeof v === 'number' && Number.isFinite(v))
  // A served bbox is only adopted when it is in the same longitude frame we
  // measured in — a wrapped shape needs the shifted frame or the centre lands
  // on the far side of the world.
  if (usable && !local.wrap) return { ...local, n: b.n, s: b.s, e: b.e, w: b.w, served: true }
  return { ...local, served: false }
}

// ------------------------------------------------------------------ raster

/** An RGB canvas plus one shared coverage buffer. Coverage is kept separate from
 *  colour so a stroke can union with itself — a polyline drawn segment by
 *  segment straight into the pixels darkens every joint, and a 7px glow is
 *  nothing but joints. Taking the max coverage first and compositing once means
 *  round joins come free and seams cannot appear. */
function makeCanvas(w, h) {
  const px = new Uint8ClampedArray(w * h * 3)
  for (let i = 0; i < px.length; i += 3) {
    px[i] = BG[0]
    px[i + 1] = BG[1]
    px[i + 2] = BG[2]
  }
  return { w, h, px, cov: new Float32Array(w * h) }
}

function composite(canvas, color, alpha) {
  const { px, cov } = canvas
  for (let i = 0, p = 0; i < cov.length; i++, p += 3) {
    const a = cov[i] * alpha
    if (a <= 0) continue
    px[p] += (color[0] - px[p]) * a
    px[p + 1] += (color[1] - px[p + 1]) * a
    px[p + 2] += (color[2] - px[p + 2]) * a
  }
  cov.fill(0)
}

/** Even-odd scanline fill. Edges are bucketed by the first scanline they can
 *  cross and retired when they are past, so a country whose geometry mostly
 *  lies off-canvas — every zoom above about 6 — costs only what is on screen.
 *  Span ends carry their fractional pixel coverage; combined with supersampling
 *  that is more anti-aliasing than the eye can use. */
function fillRings(canvas, projected) {
  const { w, h, cov } = canvas
  const buckets = new Array(h)
  const edges = []
  for (const ring of projected) {
    for (let i = 0; i + 3 < ring.length; i += 2) {
      const y0 = ring[i + 1]
      const y1 = ring[i + 3]
      if (y0 === y1) continue // horizontal edges never cross a scanline centre
      const top = Math.max(0, Math.ceil(Math.min(y0, y1) - 0.5))
      const bottom = Math.min(h, Math.ceil(Math.max(y0, y1) - 0.5))
      if (bottom <= top) continue
      const id = edges.length
      edges.push({ x0: ring[i], y0, x1: ring[i + 2], y1, end: bottom })
      ;(buckets[top] ??= []).push(id)
    }
  }
  if (!edges.length) return

  let active = []
  const xs = []
  for (let row = 0; row < h; row++) {
    if (buckets[row]) active = active.concat(buckets[row])
    if (!active.length) continue
    const yc = row + 0.5
    xs.length = 0
    let live = 0
    for (const id of active) {
      const e = edges[id]
      if (e.end <= row) continue
      active[live++] = id
      if (e.y0 <= yc !== e.y1 <= yc) xs.push(e.x0 + ((yc - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0))
    }
    active.length = live
    if (xs.length < 2) continue
    xs.sort((a, b) => a - b)
    const off = row * w
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let a = xs[k]
      let b = xs[k + 1]
      if (b <= 0 || a >= w) continue
      if (a < 0) a = 0
      if (b > w) b = w
      const ia = Math.floor(a)
      const ib = Math.min(w - 1, Math.floor(b))
      if (ia === ib) {
        cov[off + ia] = Math.min(1, cov[off + ia] + (b - a))
        continue
      }
      cov[off + ia] = Math.min(1, cov[off + ia] + (ia + 1 - a))
      for (let i = ia + 1; i < ib; i++) cov[off + i] = 1
      cov[off + ib] = Math.min(1, cov[off + ib] + (b - ib))
    }
  }
}

/** Stroke as a union of round-capped capsules: coverage at a pixel is set from
 *  its distance to the segment, so caps and joins are round without any joint
 *  geometry, exactly like the map's own renderer. */
function strokeRings(canvas, projected, weight) {
  const { w, h, cov } = canvas
  const half = weight / 2
  const reach = half + 0.5
  for (const ring of projected) {
    for (let i = 0; i + 3 < ring.length; i += 2) {
      const x0 = ring[i]
      const y0 = ring[i + 1]
      const x1 = ring[i + 2]
      const y1 = ring[i + 3]
      const lo = Math.max(0, Math.floor(Math.min(x0, x1) - reach))
      const hi = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + reach))
      const top = Math.max(0, Math.floor(Math.min(y0, y1) - reach))
      const bot = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + reach))
      if (hi < lo || bot < top) continue
      const dx = x1 - x0
      const dy = y1 - y0
      const len2 = dx * dx + dy * dy
      for (let y = top; y <= bot; y++) {
        const off = y * w
        for (let x = lo; x <= hi; x++) {
          const px = x + 0.5 - x0
          const py = y + 0.5 - y0
          let t = len2 ? (px * dx + py * dy) / len2 : 0
          if (t < 0) t = 0
          else if (t > 1) t = 1
          const ex = px - t * dx
          const ey = py - t * dy
          const c = reach - Math.sqrt(ex * ex + ey * ey)
          if (c <= 0) continue
          const j = off + x
          const v = c > 1 ? 1 : c
          if (v > cov[j]) cov[j] = v
        }
      }
    }
  }
}

/** Box-filter down to the output size. The whole anti-aliasing strategy is
 *  "render bigger, average": simple, exactly right for coverage, and immune to
 *  the sharpening artefacts a fancier kernel would add to a thin stroke. */
function downsample(canvas, s) {
  const ow = canvas.w / s
  const oh = canvas.h / s
  const out = new Uint8ClampedArray(ow * oh * 3)
  const n = s * s
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < s; sy++) {
        let p = ((y * s + sy) * canvas.w + x * s) * 3
        for (let sx = 0; sx < s; sx++) {
          r += canvas.px[p++]
          g += canvas.px[p++]
          b += canvas.px[p++]
        }
      }
      const o = (y * ow + x) * 3
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
    }
  }
  return { w: ow, h: oh, px: out }
}

// -------------------------------------------------------------------- text

/* A 3x5 bitmap font, one glyph per line, rows separated by pipes. It exists so
   a folder of forty PNGs can be told apart without reading filenames — when you
   are comparing zoom 5 against zoom 7 the caption is the whole point. Uppercase
   and digits only; anything unmapped renders as a space. */
const FONT = {
  ' ': '...|...|...|...|...',
  '-': '...|...|###|...|...',
  '.': '...|...|...|...|.#.',
  ',': '...|...|...|.#.|#..',
  ':': '...|.#.|...|.#.|...',
  '/': '..#|..#|.#.|#..|#..',
  '+': '...|.#.|###|.#.|...',
  '(': '..#|.#.|.#.|.#.|..#',
  ')': '#..|.#.|.#.|.#.|#..',
  '|': '.#.|.#.|.#.|.#.|.#.',
  0: '###|#.#|#.#|#.#|###',
  1: '.#.|##.|.#.|.#.|###',
  2: '###|..#|###|#..|###',
  3: '###|..#|.##|..#|###',
  4: '#.#|#.#|###|..#|..#',
  5: '###|#..|###|..#|###',
  6: '###|#..|###|#.#|###',
  7: '###|..#|..#|..#|..#',
  8: '###|#.#|###|#.#|###',
  9: '###|#.#|###|..#|###',
  A: '.#.|#.#|###|#.#|#.#',
  B: '##.|#.#|##.|#.#|##.',
  C: '.##|#..|#..|#..|.##',
  D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###',
  F: '###|#..|##.|#..|#..',
  G: '.##|#..|#.#|#.#|.##',
  H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###',
  J: '..#|..#|..#|#.#|.#.',
  K: '#.#|#.#|##.|#.#|#.#',
  L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#',
  N: '#.#|###|###|###|#.#',
  O: '.#.|#.#|#.#|#.#|.#.',
  P: '##.|#.#|##.|#..|#..',
  Q: '.#.|#.#|#.#|##.|.##',
  R: '##.|#.#|##.|#.#|#.#',
  S: '.##|#..|.#.|..#|##.',
  T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###',
  V: '#.#|#.#|#.#|#.#|.#.',
  W: '#.#|#.#|###|###|#.#',
  X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.',
  Z: '###|..#|.#.|#..|###',
}

/** Drawn after downsampling, so the caption stays crisp while the map stays
 *  smooth. Accented names are folded to ASCII rather than dropped — "Cataluña"
 *  reading as CATALUNA is better than as CATALU A. */
function drawText(img, x0, y0, text, scale, color) {
  const chars = String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
  let x = x0
  for (const ch of chars) {
    const glyph = FONT[ch] ?? FONT[' ']
    const rows = glyph.split('|')
    for (let ry = 0; ry < rows.length; ry++) {
      for (let rx = 0; rx < rows[ry].length; rx++) {
        if (rows[ry][rx] !== '#') continue
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + rx * scale + sx
            const py = y0 + ry * scale + sy
            if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue
            const p = (py * img.w + px) * 3
            img.px[p] = color[0]
            img.px[p + 1] = color[1]
            img.px[p + 2] = color[2]
          }
        }
      }
    }
    x += 4 * scale
  }
  return x
}

// -------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Truecolour PNG, no alpha — the ground is opaque, and three channels compress
 *  and transfer better than four. Rows use the standard adaptive filter with
 *  libpng's minimum-sum-of-absolute-differences heuristic: on a map that is
 *  mostly flat ground it is the difference between a 40KB file and a 400KB one,
 *  which matters when a human (or a model) has to open twenty of them. */
function encodePng(img) {
  const { w, h, px } = img
  const bpp = 3
  const stride = w * bpp
  const raw = Buffer.alloc(h * (stride + 1))
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride))
  const zero = Buffer.alloc(stride)
  let prev = zero
  for (let y = 0; y < h; y++) {
    const cur = Buffer.from(px.buffer, px.byteOffset + y * stride, stride)
    let best = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      const out = cand[f]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0
        const b = prev[i]
        const c = i >= bpp ? prev[i - bpp] : 0
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
        out[i] = (cur[i] - pred) & 0xff
        score += out[i] < 128 ? out[i] : 256 - out[i]
      }
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }
    raw[y * (stride + 1)] = best
    cand[best].copy(raw, y * (stride + 1) + 1)
    prev = cur
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// -------------------------------------------------------------------- render

/* Graticule spacing: pick the coarsest step that still puts roughly half a
   dozen lines across the canvas, so the grid reads as scale rather than as
   texture at every zoom from the whole hemisphere to a single valley. */
const GRID_STEPS = [45, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01]
const gridStep = (spanDegrees) => GRID_STEPS.find((s) => spanDegrees / s >= 5) ?? GRID_STEPS.at(-1)

function renderOne({ geojson, frame, zoom, width, height, ss, bare, center, caption }) {
  const world = worldSize(zoom)
  const shift = frame.wrap ? 360 : 0
  // Centre on the projected midpoint of the box, not on the mid-latitude:
  // Mercator stretches with latitude, so the two differ by tens of pixels for
  // anything tall, and fitBounds centres the box the map actually draws.
  const cx = center
    ? projectX(center.lng < 0 ? center.lng + shift : center.lng, world)
    : (projectX(frame.w, world) + projectX(frame.e, world)) / 2
  const cy = center ? projectY(center.lat, world) : (projectY(frame.n, world) + projectY(frame.s, world)) / 2
  const originX = cx - width / 2
  const originY = cy - height / 2

  // Everything downstream works in supersampled device pixels, so the map-to-
  // canvas transform absorbs the factor once here and nothing else has to know.
  const toX = (lng) => (projectX(lng < 0 ? lng + shift : lng, world) - originX) * ss
  const toY = (lat) => (projectY(lat, world) - originY) * ss

  const projected = []
  for (const ring of rings(geojson)) {
    const flat = new Float64Array(ring.length * 2)
    for (let i = 0; i < ring.length; i++) {
      flat[i * 2] = toX(ring[i][0])
      flat[i * 2 + 1] = toY(ring[i][1])
    }
    projected.push(flat)
  }

  const canvas = makeCanvas(width * ss, height * ss)

  if (!bare) {
    const step = gridStep((width * 360) / world)
    const lines = []
    // Grid longitudes live in the canvas's own display frame, which for a
    // wrapped shape runs past 180 — so they are projected straight rather than
    // through toX, whose antimeridian shift would send them round the world.
    const west = (originX / world) * 360 - 180
    const east = ((originX + width) / world) * 360 - 180
    for (let lng = Math.ceil(west / step) * step; lng <= east; lng += step) {
      const x = (((lng + 180) / 360) * world - originX) * ss
      lines.push(Float64Array.from([x, 0, x, canvas.h]))
    }
    const north = latOfY(originY, world)
    const south = latOfY(originY + height, world)
    for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
      const y = toY(lat)
      lines.push(Float64Array.from([0, y, canvas.w, y]))
    }
    strokeRings(canvas, lines, ss)
    composite(canvas, GRID, 1)
  }

  // Draw order mirrors the two Data layers: the glow sits at zIndex 1 under
  // everything, then the translucent fill, then the crisp ink on top.
  const weights = scopeWeights(zoom)
  strokeRings(canvas, projected, weights.glow * ss)
  composite(canvas, GLOW, GLOW_ALPHA)
  fillRings(canvas, projected)
  composite(canvas, INK, FILL_ALPHA)
  strokeRings(canvas, projected, weights.main * ss)
  composite(canvas, INK, INK_ALPHA)

  const img = downsample(canvas, ss)
  if (!bare) {
    drawText(img, 10, 10, caption[0], 2, TEXT)
    drawText(img, 10, 24, caption[1], 2, TEXT)
  }
  // Framing on the bbox centre puts the camera in open ocean for anything with
  // a far-flung dependency — Chile's centre is halfway to Easter Island — and a
  // blank PNG looks identical to a broken renderer. Count what actually landed
  // on the canvas so the caller can be told which of the two it is looking at.
  let onCanvas = 0
  for (const ring of projected) {
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] >= 0 && ring[i] <= canvas.w && ring[i + 1] >= 0 && ring[i + 1] <= canvas.h) onCanvas++
    }
  }
  img.onCanvas = onCanvas
  return img
}

// ---------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = {
    country: null,
    regions: '',
    zooms: [3, 5, 7, 9],
    lod: 'auto',
    out: join(tmpdir(), 'geocoach-preview'),
    width: 900,
    height: 600,
    ss: 3,
    bare: false,
    center: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i] ?? ''
    if (a === '--regions') opts.regions = next()
    else if (a === '--zoom') opts.zooms = next().split(',').map(Number).filter(Number.isFinite)
    else if (a === '--lod') opts.lod = next()
    else if (a === '--out') opts.out = next()
    else if (a === '--center' || a === '--centre') {
      const [lat, lng] = next().split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.error('--center wants LAT,LNG')
        process.exit(2)
      }
      opts.center = { lat, lng }
    }
    else if (a === '--size') {
      const [w, h] = next().split(/[x×]/).map(Number)
      if (Number.isFinite(w) && Number.isFinite(h)) {
        opts.width = w
        opts.height = h
      }
    } else if (a === '--ss') opts.ss = Math.max(1, Math.min(4, Number(next()) || 3))
    else if (a === '--bare') opts.bare = true
    else if (!a.startsWith('-') && !opts.country) opts.country = a.toUpperCase()
    else {
      console.error(`unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return opts
}

async function fetchScope(country, regions, lod) {
  const url = new URL('/api/scope-geo', SERVER)
  url.searchParams.set('country', country)
  if (regions) url.searchParams.set('regions', regions)
  if (lod !== null) url.searchParams.set('lod', String(lod))
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    console.error(
      `cannot reach the coach server at ${SERVER} (${err.message})\n` +
        'start it with:  nohup node coach/server.mjs > coach/server.log 2>&1 &'
    )
    process.exit(1)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    console.error(`scope-geo ${res.status}: ${body?.error ?? 'no geometry'}`)
    process.exit(1)
  }
  return body
}

/* The canvas is fixed, so a shape either fits or is cropped — and a crop is
   worth saying out loud, because a picture of Canada's Yukon is easy to mistake
   for a picture of Canada. */
const fitNote = (frame, zoom, width, height) => {
  const world = worldSize(zoom)
  const w = Math.abs(projectX(frame.e, world) - projectX(frame.w, world))
  const h = Math.abs(projectY(frame.s, world) - projectY(frame.n, world))
  return {
    w: Math.round(w),
    h: Math.round(h),
    fits: w <= width && h <= height,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  const opts = parseArgs(argv)
  if (!/^[A-Z]{2}$/.test(opts.country ?? '')) {
    console.error('first argument must be an ISO 3166-1 alpha-2 country code (see --help)')
    process.exit(2)
  }
  if (!opts.zooms.length) {
    console.error('--zoom needs at least one level')
    process.exit(2)
  }
  mkdirSync(opts.out, { recursive: true })

  // One fetch per distinct LOD, not per zoom: three zooms in the same band are
  // three renders of exactly the same coordinates.
  const cache = new Map()
  const slug = opts.regions
    ? opts.regions
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .toLowerCase()
    : ''

  for (const zoom of opts.zooms) {
    const lod = opts.lod === 'auto' ? lodForZoom(zoom) : opts.lod === 'none' ? null : Number(opts.lod)
    const key = String(lod)
    if (!cache.has(key)) cache.set(key, await fetchScope(opts.country, opts.regions, lod))
    const res = cache.get(key)
    const frame = frameFor(res, res.geojson)
    if (!frame) {
      console.error(`${opts.country}: the server returned no coordinates to draw`)
      process.exit(1)
    }
    // The rung the server says it served beats the one we asked for: a server
    // that predates the ladder reports nothing and silently serves its only
    // detail level, and the caption should not claim otherwise.
    const servedLod = res.lod ?? (lod === null ? '?' : `${lod}?`)
    const fit = fitNote(frame, zoom, opts.width, opts.height)
    const where = opts.center
      ? `AT ${opts.center.lat.toFixed(2)},${opts.center.lng.toFixed(2)}`
      : `${fit.w}X${fit.h}PX ${fit.fits ? 'FITS' : 'CROPPED'}`
    const caption = [
      `${res.label ?? opts.country}`,
      `Z${zoom} LOD ${servedLod} ${frame.points} PTS ${frame.rings} RINGS ${where}`,
    ]
    const img = renderOne({ geojson: res.geojson, frame, zoom, ...opts, caption })
    const at = opts.center ? `-at${opts.center.lat.toFixed(2)}_${opts.center.lng.toFixed(2)}` : ''
    const name =
      `${opts.country}${slug ? `-${slug}` : ''}${at}-z${zoom}-lod${servedLod}${opts.bare ? '-bare' : ''}`.replace(/\?/g, 'x') + '.png'
    const file = join(opts.out, name)
    writeFileSync(file, encodePng(img))
    console.log(
      `${file}  ${img.w}x${img.h}  z${zoom} lod=${servedLod}  ` +
        `${frame.points} pts / ${frame.rings} rings  shape ${fit.w}x${fit.h}px ${fit.fits ? '(fits)' : '(cropped)'}` +
        `${opts.center ? `  centred on ${opts.center.lat},${opts.center.lng}` : ''}` +
        `${frame.served ? '' : '  [bbox computed locally]'}`
    )
    if (!img.onCanvas)
      console.warn(
        `  ^ nothing landed on this canvas — the bbox centre is empty at z${zoom}. Use --center LAT,LNG to aim it.`
      )
  }
}

main()
