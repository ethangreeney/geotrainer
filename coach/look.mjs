/**
 * An aimed close-up of one round's panorama — the telephoto to the four wide
 * views brief.mjs renders.
 *
 *   node coach/look.mjs <roundId> <yaw> [pitch] [fov]
 *
 * Yaw 0 is the way the camera car faced and grows clockwise; pitch up is
 * positive; defaults are pitch -5, fov 60. Under 45° of field the stitched
 * pano_full.jpg runs out of pixels, so the sector the view actually covers is
 * pulled at zoom 5 — twice the resolution the round was saved at — from
 * Google's public tile CDN and cached in the round's z5/. Google only keeps that
 * detail in a band around the horizon, so steep looks stay on the stitch.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const TILE = 512
const ASPECT = 1008 / 1344 // render.py's view, so the vertical field follows the horizontal
const MARGIN = 2 // degrees of slack, so tile rounding can never clip the frame
const WIDE = 45 // at or above this field of view pano_full.jpg already has the detail
const BUDGET = 64 // tiles: past this the view is nearly straight down, not worth the fetch
const USAGE = 'usage: node coach/look.mjs <roundId> <yaw> [pitch] [fov]'

const die = (msg) => {
  console.error(msg)
  process.exit(1)
}
const mod = (n, m) => ((n % m) + m) % m
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** The block of zoom-5 tiles the view lands on, as render.py's sector args.
 *
 * The frame reaches further round the sphere than fov/2: pitch swings its
 * bottom corners away from the lens axis, so a 30° view pitched 45° down spans
 * nearly 80° of yaw. Take the corner rays at their word instead of guessing. */
function sectorFor(grid, yaw, pitch, fov) {
  const rad = Math.PI / 180
  const f = 0.5 / Math.tan((fov * rad) / 2) // focal length, in frame widths
  const dz = f * Math.cos(pitch * rad) - (ASPECT / 2) * Math.abs(Math.sin(pitch * rad))
  const halfH = dz > 0 ? Math.atan(0.5 / dz) / rad + MARGIN : 180 // dz<=0: the pole is in shot
  const halfV = Math.atan(ASPECT / 2 / f) / rad + MARGIN
  const cx = (yaw / 360 + 0.5) * grid.cols // tile units, unwrapped — the seam is fine here
  const dx = (halfH / 360) * grid.cols
  const left = Math.floor(cx - dx)
  const row = (lat) => clamp(Math.floor((0.5 - clamp(lat, -90, 90) / 180) * grid.rows), 0, grid.rows - 1)
  const y0 = row(pitch + halfV)
  return {
    x0: mod(left, grid.cols),
    y0,
    cols: Math.min(grid.cols, Math.floor(cx + dx) - left + 1),
    rows: row(pitch - halfV) - y0 + 1,
    aim: [mod(Math.floor(cx), grid.cols), row(pitch)], // the tile the centre ray lands on
  }
}

/** A JPEG's width, read off its first SOF marker — no decoder needed. */
function jpegWidth(buf) {
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) return 0
    const m = buf[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return buf.readUInt16BE(i + 7)
    i += m === 0xff || m === 0x01 || (m >= 0xd0 && m <= 0xd8) ? 2 : 2 + buf.readUInt16BE(i + 2)
  }
  return 0
}

/** One zoom-5 tile into the cache, by its width: 512 where Google holds real
 * zoom-5 detail, 256 where it only has the stand-in the stitch already contains,
 * 0 where the tile never arrived. Tiles already on disk are left alone. */
async function tile(z5, panoId, [x, y]) {
  const file = join(z5, `z5_${y}_${x}.jpg`)
  if (existsSync(file)) return jpegWidth(await readFile(file))
  const url =
    `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile` +
    `&panoid=${encodeURIComponent(panoId)}&x=${x}&y=${y}&zoom=5&nbt=1&fover=2`
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)', Referer: 'https://www.google.com/' },
    })
    if (!res.ok) return 0
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 2000) return 0 // blank tile — this pano has no zoom 5
    await writeFile(file, buf)
    return jpegWidth(buf)
  } catch {
    return 0 // a tile that never arrives is the same as one that doesn't exist
  }
}

/** Fill the z5/ cache for a sector. */
async function fetchSector(panoId, z5, grid, s) {
  const want = []
  for (let r = 0; r < s.rows; r++)
    for (let c = 0; c < s.cols; c++) want.push([mod(s.x0 + c, grid.cols), s.y0 + r])
  const cached = want.filter((t) => existsSync(join(z5, `z5_${t[1]}_${t[0]}.jpg`))).length
  const CHUNK = 16 // be polite to the tile CDN
  let have = 0
  for (let i = 0; i < want.length; i += CHUNK) {
    const widths = await Promise.all(want.slice(i, i + CHUNK).map((t) => tile(z5, panoId, t)))
    have += widths.filter(Boolean).length
  }
  return { have, want: want.length, cached }
}

/* ------------------------------------------------------------------- main */

const [id, yawArg, pitchArg, fovArg] = process.argv.slice(2)
const [yaw, pitch, fov] = [Number(yawArg), Number(pitchArg ?? -5), Number(fovArg ?? 60)]
if (!id || yawArg === undefined || ![yaw, pitch, fov].every(Number.isFinite) || fov <= 0) die(USAGE)

const dir = join(ROOT, 'rounds', id)
if (!existsSync(join(dir, 'dossier.json')) || !existsSync(join(dir, 'pano_full.jpg')))
  die(`no panorama in coach/rounds/${id}/ — run: node coach/brief.mjs ${id}`)

// Zoom 5 is twice zoom 4 in each direction and an equirect is always 2:1, so a
// C-column zoom-4 grid has a 2C x C zoom-5 grid above it: 32x16 over the usual
// 16-column pano, 26x13 over the third-party 13-column kind.
const files = await readdir(dir)
const c4 = files.reduce((n, f) => Math.max(n, Number(f.match(/^pano_\d+_(\d+)\.jpg$/)?.[1] ?? -1) + 1), 0)
const grid = { cols: c4 * 2, rows: c4 }
const { panoId } = JSON.parse(await readFile(join(dir, 'dossier.json'), 'utf8'))

let sector = null
const sphere = c4 ? ` (${c4 * TILE}x${(c4 * TILE) / 2})` : ''
let source = `pano_full.jpg${sphere} — ${fov}° of field asks nothing sharper`
if (fov < WIDE) {
  source = 'pano_full.jpg — no zoom-4 grid here to hang a zoom 5 on'
  const z5 = join(dir, 'z5')
  const s = c4 >= 8 && panoId ? sectorFor(grid, yaw, pitch, fov) : null
  const affordable = s && s.cols * s.rows <= BUDGET
  if (affordable) await mkdir(z5, { recursive: true })
  // One tile at the centre of the frame says whether the rest are worth asking
  // for: steep-down aims fall outside the band Google keeps zoom 5 for.
  const aimed = affordable ? await tile(z5, panoId, s.aim) : 0
  if (s && !affordable) {
    source = `pano_full.jpg — this aim spans ${s.cols}x${s.rows} zoom-5 tiles, too many to fetch`
  } else if (aimed && aimed < TILE) {
    source = 'pano_full.jpg — zoom 5 is no sharper than the stitch this far below the horizon'
  } else if (s) {
    const got = await fetchSector(panoId, z5, grid, s)
    if (got.have === got.want) {
      sector = s
      const px = `${grid.cols * TILE}x${grid.rows * TILE}`
      source = `zoom 5 (${px}) — ${s.cols}x${s.rows} tiles, ${got.want - got.cached} fetched, ${got.cached} cached`
    } else {
      source = `pano_full.jpg — zoom 5 came back ${got.want - got.have} of ${got.want} tiles short`
    }
  }
}

const out = join(dir, `look_${Math.round(yaw)}_${Math.round(fov)}.jpg`)
const args = ['look', dir, yaw, pitch, fov, out]
if (sector) args.push(sector.x0, sector.y0, sector.cols, sector.rows, grid.cols, grid.rows)
await new Promise((done, fail) => {
  const script = join(ROOT, 'render.py')
  execFile('python3', [script, ...args.map(String)], (err, _out, stderr) =>
    err ? fail(new Error(stderr.trim() || err.message)) : done(),
  )
}).catch((e) => die(e.message))

console.log(out)
console.log(source)
