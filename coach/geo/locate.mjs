/**
 * Offline reverse geocoding: which country (and, where it matters, which
 * subdivision) a latitude/longitude falls in.
 *
 * This exists because the pipeline used to ask BigDataCloud. Their free
 * endpoint is browser-only — called from a server it answers 402 and bans the
 * caller's IP — so once round capture moved onto a Cloudflare Worker every
 * lookup silently failed and every round recorded itself as "??". A round with
 * no country cannot be graded, cannot be counted, and cannot be highlighted on
 * the result map, so the answer had to stop depending on a network call.
 *
 * The boundaries are already on disk: build.mjs writes the same geoBoundaries
 * shapes the result-map overlay draws. pack.mjs squeezes them into one binary
 * (see the format note there) and this module reads it back and does the
 * point-in-polygon itself. Nothing here touches the filesystem or the network,
 * so the Worker and the local bridge run identical code.
 *
 * Accuracy, measured against the 529 rounds captured while the old geocoder
 * still worked: 524 exact. The five misses are all territories that
 * geoBoundaries folds into their sovereign (American Samoa and the Northern
 * Marianas read as US, Christmas Island as AU) or that its snapshot omits
 * outright (Réunion). None is a wrong *neighbour* — the failure mode that
 * would matter — because the resolver never guesses across a land border.
 */

/** Zigzag varint reader over the packed stream. */
class Reader {
  constructor(bytes, at = 0) {
    this.b = bytes
    this.i = at
  }
  uint() {
    let n = 0
    let shift = 1
    for (;;) {
      const c = this.b[this.i++]
      n += (c & 0x7f) * shift
      if (!(c & 0x80)) return n
      shift *= 128
    }
  }
  int() {
    const n = this.uint()
    return n & 1 ? -(n + 1) / 2 : n / 2
  }
}

/**
 * Decodes a pack into features ready to query. Coordinates stay in the pack's
 * integer grid — the query point is quantised the same way — so the whole test
 * runs without ever converting a million vertices to floats.
 */
export function loadPack(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const headLen = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLen)))
  const r = new Reader(bytes, 4 + headLen)
  const places = head.places.map(([code, name]) => ({ code, name }))
  const features = head.features.map((placeIndex) => {
    const ringCount = r.uint()
    const rings = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let k = 0; k < ringCount; k++) {
      const n = r.uint()
      const xs = new Int32Array(n)
      const ys = new Int32Array(n)
      let px = 0
      let py = 0
      for (let i = 0; i < n; i++) {
        px += r.int()
        py += r.int()
        xs[i] = px
        ys[i] = py
        // Only the outer ring defines the extent; holes are inside it by
        // definition, and a bbox is only ever used to skip work.
        if (k === 0) {
          if (px < x0) x0 = px
          if (px > x1) x1 = px
          if (py < y0) y0 = py
          if (py > y1) y1 = py
        }
      }
      rings.push({ xs, ys })
    }
    return { ...places[placeIndex], rings, x0, y0, x1, y1, extent: (x1 - x0) * (y1 - y0) }
  })
  return { scale: head.scale, kind: head.kind, features }
}

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

/** Ring 0 is the outline, the rest are holes — a lake counts as outside. */
const covers = (f, x, y) => {
  if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) return false
  if (!inRing(f.rings[0], x, y)) return false
  for (let i = 1; i < f.rings.length; i++) if (inRing(f.rings[i], x, y)) return false
  return true
}

/** Squared distance from a point to a segment, in the pack's grid units. */
const toSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = ax + t * dx - px
  const ey = ay + t * dy - py
  return ex * ex + ey * ey
}

/** Nearest point on any of the feature's rings, with longitude pre-narrowed by
 * `kx` so the distance is a distance on the ground rather than in degrees. */
const toBoundary = (f, x, y, kx, limit) => {
  let best = limit
  for (const ring of f.rings) {
    const { xs, ys } = ring
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const d = toSegment(x * kx, y, xs[j] * kx, ys[j], xs[i] * kx, ys[i])
      if (d < best) best = d
    }
  }
  return best
}

/** How far off the coast a point may sit and still belong to the land it is
 * nearest, in degrees. Street View runs along piers, causeways and shorelines
 * that a simplified outline cuts the corner off, and panoramas sit on ferries;
 * 0.35° (~39km) recovers those without ever reaching another country's
 * territory across open water. */
const OFFSHORE = 0.35

/**
 * The feature containing `lat,lng`, or the nearest coastline within OFFSHORE.
 *
 * Containment is strict and is tried first, so a point genuinely inside a
 * country is never handed to a neighbour whose simplified outline happens to
 * pass nearby — the error that would mark a correct answer wrong. Where several
 * features contain the point (an enclave, or a territory drawn inside its
 * sovereign) the smallest wins, since the smaller shape is the more specific
 * claim.
 */
export function locate(pack, lat, lng) {
  if (!pack || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const x = Math.round(lng * pack.scale)
  const y = Math.round(lat * pack.scale)
  let best = null
  for (const f of pack.features) {
    if (!covers(f, x, y)) continue
    if (!best || f.extent < best.extent) best = f
  }
  if (best) return best

  // Nothing contains it: fall back to the nearest boundary. Longitude is
  // narrowed by latitude first so "nearest" means nearest on the ground rather
  // than nearest in degrees — at 60° north a degree of longitude is half a
  // degree of latitude, and without the correction Sweden would out-rank
  // Finland for a point sitting between them.
  const kx = Math.max(Math.cos((lat * Math.PI) / 180), 0.01)
  const reach = OFFSHORE * pack.scale
  let limit = (reach * kx) ** 2
  for (const f of pack.features) {
    if (x < f.x0 - reach || x > f.x1 + reach || y < f.y0 - reach || y > f.y1 + reach) continue
    const d = toBoundary(f, x, y, kx, limit)
    if (d < limit) {
      limit = d
      best = f
    }
  }
  return best
}
