/**
 * Street-view tiles for a panorama, straight from Google's public tile CDN
 * (no key, no auth). Shared by the local bridge, which saves tiles as rounds
 * arrive, and by coach/brief.mjs, which backfills them for rounds played on
 * another machine that only exist in the cloud.
 */
import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
