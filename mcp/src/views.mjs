/**
 * Turning a cached round into pictures a model can look at.
 *
 * Two jobs. The four wide views — the round in photograph geometry, front being
 * the way the camera car faced — and the aimed close-up, which is the telephoto
 * to those. Both come off the same tile grid; only the field of view differs,
 * and below 45° that difference is enough to run the stitched sphere out of
 * pixels, so the close-up goes back to Google for the zoom-5 tiles covering
 * just that sector.
 *
 * Rendered JPEGs are written next to the tiles. A second look at the same round
 * is then free, which matters because the dossier tool is the one a coaching
 * session calls first and returns to.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Actionable } from './config.mjs'
import { Sphere, TILE, encodeJpeg, gridCols, renderView } from './imagery.mjs'
import { cacheRound, compass16, compassDeg, fetchTile, heading, readMeta } from './tiles.mjs'

const VIEWS = [['front', 0], ['right', 90], ['back', 180], ['left', 270]]
const ASPECT = 1008 / 1344 // the view's own shape, so the vertical field follows the horizontal
const MARGIN = 2 // degrees of slack, so tile rounding can never clip the frame
const WIDE = 45 // at or above this field of view the zoom-4 sphere already has the detail
const BUDGET = 64 // zoom-5 tiles: past this the view is nearly straight down, not worth the fetch

const mod = (n, m) => ((n % m) + m) % m
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * The round's imagery on disk, and what to say when there is none.
 *
 * A retired pano with no live coverage within 500 m is a real outcome, not a
 * bug — Google drops panoramas when it re-drives a road — so it returns a
 * sentence rather than throwing.
 */
export async function prepare(r) {
  const { dir, tiles } = await cacheRound(r)
  if (!tiles)
    return {
      dir,
      sphere: null,
      note:
        `no imagery for panoId ${r.panoId ?? '(none recorded)'}` +
        (r.panoId
          ? ': Google retired that pano and has no live coverage within 500 m either.'
          : ': the round was captured without one.'),
    }
  const cols = await gridCols(dir)
  const meta = await readMeta(dir)
  const note = meta.substituted
    ? `imagery: nearest live pano, ${meta.offsetM} m from the true spot — Google retired the pano ` +
      'this round was played on, so season and camera generation may differ.'
    : null
  return { dir, sphere: new Sphere(dir, cols), note }
}

/** The four wide views, rendered once and cached. */
export async function fourViews(r) {
  const { dir, sphere, note } = await prepare(r)
  if (!sphere) return { dir, views: [], note }
  const deg = await heading(dir, r.panoId)
  const views = []
  for (const [name, yaw] of VIEWS) {
    const file = join(dir, `view_${name}.jpg`)
    if (!existsSync(file))
      await writeFile(file, encodeJpeg(await renderView(sphere, { yaw, pitch: -5, fov: 100 }), 87))
    views.push({
      name,
      label: `view_${name}` + (deg == null ? '' : ` (faces ${compass16(deg + yaw)})`),
      jpeg: await readFile(file),
    })
  }
  const compass =
    deg == null
      ? null
      : `compass: front = ${compass16(deg)} (${Math.round(deg)}°) — north is ` +
        `${Math.round((360 - deg) % 360)}° of yaw`
  return { dir, views, note: [note, compass].filter(Boolean).join('\n') || null }
}

/* --------------------------------------------------------- the close-up */

/**
 * The block of zoom-5 tiles a view lands on.
 *
 * The frame reaches further round the sphere than fov/2: pitch swings its
 * bottom corners away from the lens axis, so a 30° view pitched 45° down spans
 * nearly 80° of yaw. Take the corner rays at their word instead of guessing.
 */
export function sectorFor(grid, yaw, pitch, fov) {
  const rad = Math.PI / 180
  const f = 0.5 / Math.tan((fov * rad) / 2) // focal length, in frame widths
  const dz = f * Math.cos(pitch * rad) - (ASPECT / 2) * Math.abs(Math.sin(pitch * rad))
  const halfH = dz > 0 ? Math.atan(0.5 / dz) / rad + MARGIN : 180 // dz<=0: the pole is in shot
  const halfV = Math.atan(ASPECT / 2 / f) / rad + MARGIN
  const cx = (yaw / 360 + 0.5) * grid.cols // tile units, unwrapped — the seam is fine here
  const dx = (halfH / 360) * grid.cols
  const left = Math.floor(cx - dx)
  const row = (lat) =>
    clamp(Math.floor((0.5 - clamp(lat, -90, 90) / 180) * grid.rows), 0, grid.rows - 1)
  const y0 = row(pitch + halfV)
  return {
    x0: mod(left, grid.cols),
    y0,
    cols: Math.min(grid.cols, Math.floor(cx + dx) - left + 1),
    rows: row(pitch - halfV) - y0 + 1,
    aim: [mod(Math.floor(cx), grid.cols), row(pitch)], // the tile the centre ray lands on
  }
}

/**
 * One aimed view. `aim` is degrees of yaw (0 = the way the car faced, growing
 * clockwise) or a 16-wind compass name, which aims by the world instead of by
 * the car and so needs the pano's heading.
 */
export async function look(r, aim, pitch = -5, fov = 60) {
  const { dir, sphere, note } = await prepare(r)
  if (!sphere) throw new Actionable(note)

  const wind = compassDeg(aim)
  let north = (await readMeta(dir)).heading ?? null
  if (wind != null && north == null) {
    north = await heading(dir, r.panoId)
    if (north == null)
      throw new Actionable(
        `Google will not say which way this pano faces, so "${aim}" cannot be turned into a yaw. ` +
          'Aim in degrees instead (0 = the way the camera car faced, growing clockwise).',
      )
  }
  const yaw = wind == null ? Number(aim) : mod(wind - north, 360)
  if (!Number.isFinite(yaw))
    throw new Actionable(`"${aim}" is neither a number of degrees nor a compass point like NNE.`)

  // Zoom 5 is twice zoom 4 in each direction and an equirect is always 2:1, so
  // a C-column zoom-4 grid has a 2C x C zoom-5 grid above it.
  const grid = { cols: sphere.cols * 2, rows: sphere.cols }
  const panoId = (await readMeta(dir)).panoId ?? r.panoId
  let use = sphere
  let source = `zoom 4 (${sphere.width}x${sphere.height}) — ${fov}° of field asks nothing sharper`

  if (fov < WIDE && sphere.cols >= 8 && panoId) {
    const s = sectorFor(grid, yaw, pitch, fov)
    const z5 = join(dir, 'z5')
    if (s.cols * s.rows > BUDGET) {
      source = `zoom 4 — this aim spans ${s.cols}x${s.rows} zoom-5 tiles, too many to fetch`
    } else {
      await mkdir(z5, { recursive: true })
      // One tile at the centre of the frame says whether the rest are worth
      // asking for: Google only holds zoom-5 detail in a band around the
      // horizon, and answers a steep-down aim with a stand-in no sharper than
      // the stitch. A short file is that stand-in.
      const aimed = await fetchTile(join(z5, `z5_${s.aim[1]}_${s.aim[0]}.jpg`), panoId, ...s.aim, 5)
      if (!aimed) {
        source = 'zoom 4 — this pano has no zoom-5 imagery'
      } else {
        const want = []
        for (let rr = 0; rr < s.rows; rr++)
          for (let c = 0; c < s.cols; c++) want.push([mod(s.x0 + c, grid.cols), s.y0 + rr])
        let have = 0
        const CHUNK = 16 // be polite to the tile CDN
        for (let i = 0; i < want.length; i += CHUNK)
          have += (
            await Promise.all(
              want
                .slice(i, i + CHUNK)
                .map(([x, y]) => fetchTile(join(z5, `z5_${y}_${x}.jpg`), panoId, x, y, 5)),
            )
          ).filter(Boolean).length
        if (have === want.length) {
          use = new Sphere(z5, grid.cols, (row, col) => `z5_${row}_${col}.jpg`)
          source = `zoom 5 (${grid.cols * TILE}x${grid.rows * TILE}) — ${s.cols}x${s.rows} tiles`
        } else {
          source = `zoom 4 — zoom 5 came back ${want.length - have} of ${want.length} tiles short`
        }
      }
    }
  } else if (fov < WIDE) {
    source = 'zoom 4 — no tile grid here to hang a zoom 5 on'
  }

  const file = join(dir, `look_${Math.round(yaw)}_${Math.round(pitch)}_${Math.round(fov)}.jpg`)
  const jpeg = existsSync(file)
    ? await readFile(file)
    : encodeJpeg(await renderView(use, { yaw, pitch, fov }), 90)
  if (!existsSync(file)) await writeFile(file, jpeg)

  return {
    jpeg,
    text: [
      `round ${r.id} — yaw ${Math.round(yaw)}°, pitch ${pitch}°, ${fov}° field`,
      north == null ? null : `that is ${compass16(north + yaw)} on the compass`,
      source,
      note,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
