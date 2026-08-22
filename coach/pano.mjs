/**
 * Street-view tiles for a panorama, straight from Google's public tile CDN
 * (no key, no auth). Shared by the local bridge, which saves tiles as rounds
 * arrive, and by coach/brief.mjs, which backfills them for rounds played on
 * another machine that only exist in the cloud. Both go through saveRoundTiles,
 * which covers the case of a pano Google has retired since the round was played.
 */
import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { panoHeading, writeRoundMeta } from './meta.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

export async function saveTiles(panoId, dir) {
  const fetchGrid = async (zoom, cols, rows) => {
    const saved = []
    const coords = []
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) coords.push([x, y])
    const CHUNK = 32 // be polite to the tile CDN
    for (let i = 0; i < coords.length; i += CHUNK) {
      await Promise.all(
        coords.slice(i, i + CHUNK).map(([x, y]) => {
          const url =
            `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile` +
            `&panoid=${encodeURIComponent(panoId)}&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fover=2`
          return fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)', Referer: 'https://www.google.com/' },
          })
            .then(async (res) => {
              if (!res.ok) return
              const buf = Buffer.from(await res.arrayBuffer())
              if (buf.length < 2000) return // blank tile
              const file = `pano_${y}_${x}.jpg`
              await writeFile(join(dir, file), buf)
              saved.push(file)
            })
            .catch(() => {})
        }),
      )
    }
    return saved
  }

  // zoom 4 = 16x8 tiles (8192x4096): the camera's full published detail for
  // modern coverage. Older panos stop at zoom 3 — wipe partial tiles and refetch.
  let saved = await fetchGrid(4, 16, 8)
  if (saved.length < 8) {
    await Promise.all(saved.map((f) => unlink(join(dir, f)).catch(() => {})))
    saved = await fetchGrid(3, 8, 4)
  }
  if (saved.length) {
    // pano.jpg (2048-wide overview) + pano_full.jpg (native resolution)
    await new Promise((resolve) => {
      execFile('python3', [join(ROOT, 'stitch.py'), dir], () => resolve())
    })
  }
  return saved.sort()
}

/* --------------------------------------------------- when a pano is retired */

/** Metres between two {lat,lng}. Only ever asked over a few hundred, so the
 *  spherical form is exact enough by a wide margin. */
const metresBetween = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

/**
 * The live panorama nearest a point — {panoId, lat, lng, heading}, or null if
 * nothing is within `radius` metres. Google's own SingleImageSearch RPC, the
 * lookup the maps viewer uses (no key, no auth).
 *
 * The body is positional protobuf-as-JSON: the viewer's own request with the
 * point and the radius spliced in; nothing else in it is ours to tune. In the
 * reply the pano id sits at [1][1][1] and its pose at [1][5][0][1] — [0][2] and
 * [0][3] the coordinates, [2][0] the heading (the same number photometa gives,
 * so it costs no second round trip). A point with no coverage answers 200 with
 * [0] = [5,"generic","Search returned no images."] and no [1] at all.
 */
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
        headers: {
          'Content-Type': 'application/json+protobuf',
          'User-Agent': 'Mozilla/5.0 (Macintosh)',
        },
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

/**
 * One round's tiles. Normally just saveTiles on the pano the round recorded —
 * but Google retires panoramas when it re-drives a road, and a retired id 404s
 * at every zoom while the game itself quietly shows whatever is live there now.
 * So when nothing comes back, fall back to the nearest live pano to the round's
 * TRUE spot and record the swap in meta.json, heading included: the views are
 * rendered off the substitute, so its heading is the one that names them.
 *
 * Returns the saved tile filenames, empty when neither pano had any. The RPC
 * only ever fires after a tile fetch has already come back empty.
 */
export async function saveRoundTiles(panoId, dir, at) {
  const saved = panoId ? await saveTiles(panoId, dir) : []
  // No recorded pano is not a retired one: nothing was asked for, so ask nothing.
  if (saved.length || !panoId || !Number.isFinite(at?.lat)) return saved
  for (const radius of [50, 500]) {
    const near = await nearestPano(at.lat, at.lng, radius)
    if (!near || near.panoId === panoId) continue
    const tiles = await saveTiles(near.panoId, dir)
    if (!tiles.length) continue
    const heading = near.heading ?? (await panoHeading(near.panoId))
    await writeRoundMeta(dir, {
      panoId: near.panoId,
      substituted: true,
      offsetM: Math.round(metresBetween(at, near)),
      retired: panoId,
      ...(heading == null ? {} : { heading }),
    })
    return tiles
  }
  return saved
}
