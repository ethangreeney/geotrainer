/**
 * Street View tiles from Google's public tile CDN — no key, no auth, no quota
 * that a single player can reach. This is the whole reason the cache can be
 * built lazily: the imagery is not the server's to ship, it is re-fetchable
 * from the same CDN the game itself reads, one round at a time, on demand.
 *
 * Ported from coach/pano.mjs and coach/meta.mjs so the published package stands
 * alone; the protocol details (the positional-protobuf bodies, the retired-pano
 * fallback) are theirs and are commented there at length.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROUNDS } from './config.mjs'

const CDN = 'https://streetviewpixels-pa.googleapis.com/v1/tile'
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Macintosh)', Referer: 'https://www.google.com/' }

const WINDS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]
const mod = (n, m) => ((n % m) + m) % m

/** The 16-wind name for a bearing in degrees: 73 -> ENE. */
export const compass16 = (deg) => WINDS[Math.round(mod(deg, 360) / 22.5) % 16]

/** The bearing a 16-wind name stands for, or null if that is not one. */
export const compassDeg = (name) => {
  const i = WINDS.indexOf(String(name ?? '').toUpperCase())
  return i < 0 ? null : i * 22.5
}

export const roundDir = (id) => join(ROUNDS, String(id).replace(/[^\w.-]/g, '_'))

export const readMeta = (dir) =>
  readFile(join(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}))

/** Merge into meta.json — a merge, not a write: the heading and the pano
 *  substitution are learned at different moments and neither may drop the other. */
export async function writeMeta(dir, patch) {
  const next = { ...(await readMeta(dir)), ...patch }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(next))
  return next
}

/** One tile to disk. Returns its byte length, or 0 for a tile that isn't there. */
export async function fetchTile(file, panoId, x, y, zoom) {
  if (existsSync(file)) return (await readFile(file)).length
  const url =
    `${CDN}?cb_client=maps_sv.tactile&panoid=${encodeURIComponent(panoId)}` +
    `&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fover=2`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: BROWSER })
    if (!res.ok) return 0
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 2000) return 0 // Google's blank tile: this pano has no such zoom
    await writeFile(file, buf)
    return buf.length
  } catch {
    return 0 // a tile that never arrives is the same as one that doesn't exist
  }
}

async function grid(panoId, dir, zoom, cols, rows) {
  const want = []
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) want.push([x, y])
  const saved = []
  const CHUNK = 32 // be polite to the tile CDN
  for (let i = 0; i < want.length; i += CHUNK)
    await Promise.all(
      want.slice(i, i + CHUNK).map(async ([x, y]) => {
        const name = `pano_${y}_${x}.jpg`
        if (await fetchTile(join(dir, name), panoId, x, y, zoom)) saved.push(name)
      }),
    )
  return saved
}

/** Every tile of one panorama. zoom 4 (16x8) is the camera's full published
 *  detail; older coverage stops at zoom 3, so a near-empty zoom-4 grid is the
 *  signal to drop back rather than an error. */
export async function saveTiles(panoId, dir) {
  await mkdir(dir, { recursive: true })
  const four = await grid(panoId, dir, 4, 16, 8)
  if (four.length >= 8) return four.sort()
  return (await grid(panoId, dir, 3, 8, 4)).sort()
}

const metresBetween = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

/** The live panorama nearest a point, via Google's own SingleImageSearch RPC
 *  (the lookup the Maps viewer uses). Null when nothing is in range. */
export async function nearestPano(lat, lng, radius = 50) {
  const body = JSON.stringify([
    ['apiv3', null, null, null, 'US', null, null, null, null, null, [[0]]],
    [[null, null, lat, lng], radius],
    [
      [null, null, null, null, null, null, null, null, null, null, [null, null]],
      null, null, null, null, null, null, null, [2], null, [[[2, true, 2]]],
    ],
    [[2, 6]],
  ])
  try {
    const res = await fetch(
      'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch',
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json+protobuf', 'User-Agent': BROWSER['User-Agent'] },
      },
    )
    if (!res.ok) return null
    const found = (await res.json())?.[1]
    const pose = found?.[5]?.[0]?.[1]
    if (!found?.[1]?.[1] || !Number.isFinite(pose?.[0]?.[2])) return null
    return {
      panoId: found[1][1],
      lat: pose[0][2],
      lng: pose[0][3],
      heading: Number.isFinite(pose[2]?.[0]) ? pose[2][0] : null,
    }
  } catch {
    return null
  }
}

const PB_HEAD = '!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2sus!3m3!1m2!1e2!2s'
const PB_TAIL =
  '!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2' +
  '!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3' +
  '!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3'

/** Degrees clockwise from north that the pano centre faces, or null. A nicety —
 *  it turns "water on the left" into "water to the north-west" — so every
 *  failure is silent rather than costing the round its imagery. */
export async function panoHeading(panoId) {
  if (!panoId) return null
  try {
    const res = await fetch(
      'https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=us&pb=' +
        PB_HEAD + encodeURIComponent(panoId) + PB_TAIL,
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': BROWSER['User-Agent'] } },
    )
    if (!res.ok) return null
    const txt = await res.text() // opens with an anti-JSON-hijack line
    const deg = JSON.parse(txt.slice(txt.indexOf('\n') + 1))?.[1]?.[0]?.[5]?.[0]?.[1]?.[2]?.[0]
    return Number.isFinite(deg) ? mod(deg, 360) : null
  } catch {
    return null
  }
}

/**
 * One round's tiles, cached. Normally just the pano the round recorded — but
 * Google retires panoramas when it re-drives a road, and a retired id 404s at
 * every zoom while the game quietly shows whatever is live there now. When
 * nothing comes back, fall back to the nearest live pano to the true spot and
 * record the swap: the views are rendered off the substitute, so its heading is
 * the one that names them.
 */
export async function cacheRound(r) {
  const dir = roundDir(r.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'dossier.json'), JSON.stringify(r, null, 1))
  const have = (await readMeta(dir)).tiles
  if (have) return { dir, tiles: have }

  let tiles = r.panoId ? await saveTiles(r.panoId, dir) : []
  if (!tiles.length && r.panoId && Number.isFinite(r.answer?.lat))
    for (const radius of [50, 500]) {
      const near = await nearestPano(r.answer.lat, r.answer.lng, radius)
      if (!near || near.panoId === r.panoId) continue
      const got = await saveTiles(near.panoId, dir)
      if (!got.length) continue
      tiles = got
      await writeMeta(dir, {
        panoId: near.panoId,
        substituted: true,
        offsetM: Math.round(metresBetween(r.answer, near)),
        retired: r.panoId,
        ...(near.heading == null ? {} : { heading: near.heading }),
      })
      break
    }
  if (tiles.length) await writeMeta(dir, { tiles: tiles.length })
  return { dir, tiles: tiles.length }
}

/** The pano the tiles on disk actually came from, and which way it faces.
 *  Cached in meta.json so a second look at the same round costs no round trip. */
export async function heading(dir, fallbackPanoId) {
  const meta = await readMeta(dir)
  if (meta.heading != null) return meta.heading
  const deg = await panoHeading(meta.panoId ?? fallbackPanoId)
  if (deg != null) await writeMeta(dir, { heading: deg })
  return deg
}
