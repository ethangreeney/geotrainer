/**
 * The geometry behind the boundary slices: simplification, area, and the
 * topological dissolve. Lives apart from build.mjs so the test suite can call
 * the same code the build ran rather than a copy of it — the error bound these
 * functions claim is the module's only real quality guarantee, and a test that
 * re-implemented it would prove nothing.
 *
 * Everything here works in raw degrees. That is wrong as geodesy and right as
 * cartography: the result map draws in Web Mercator, where a degree of longitude
 * is a constant number of pixels, so a tolerance in degrees is a tolerance in
 * pixels. Areas are likewise degrees², useful only for comparing one shape to
 * another at the same latitude, which is all they are ever used for.
 */

// Error budget: a shape drawn across ~600 px may deviate by DETAIL⁻¹ of its own
// width. 1/4000 is a fifth of a pixel — below what a display can show.
export const DETAIL = 4000
export const MIN_TOL = 0.0002 // floor, so small shapes stay honest rather than exact
export const MAX_TOL = 0.02

/** Squared perpendicular distance from p to the segment ab, in raw degrees.
 * Squared because Douglas-Peucker only ever compares distances. */
export function segDistSq(p, a, b) {
  let [x, y] = a
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) [x, y] = b
    else if (t > 0) { x += dx * t; y += dy * t }
  }
  dx = p[0] - x
  dy = p[1] - y
  return dx * dx + dy * dy
}

/** Douglas-Peucker, iterative so a 40k-vertex coastline can't blow the stack.
 * Every dropped vertex lies within `tol` of the kept polyline — that is the
 * guarantee the whole module rests on, and geo.test.mjs measures it directly. */
export function simplifyRing(pts, tol) {
  if (pts.length < 5) return pts
  const sq = tol * tol
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let far = -1
    let best = sq
    for (let i = lo + 1; i < hi; i++) {
      const d = segDistSq(pts[i], pts[lo], pts[hi])
      if (d > best) { best = d; far = i }
    }
    if (far > 0) {
      keep[far] = 1
      stack.push([lo, far], [far, hi])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** Bounding box of a ring, as [x0, y0, x1, y1]. */
export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/** Diagonal of a ring's bounding box, in degrees. */
export function extent(pts) {
  const [x0, y0, x1, y1] = bbox(pts)
  return Math.hypot(x1 - x0, y1 - y0)
}

export const clampTol = (t) => Math.min(MAX_TOL, Math.max(MIN_TOL, t))

/** A polygon ring needs 4 points to close. Below that the shape is finer than
 * the budget allows, so it becomes its own bounding box: present, correctly
 * placed, and honest about the detail it no longer carries. An islet that far
 * below the budget is a couple of pixels on screen either way. */
export function ring(r, tol) {
  const s = simplifyRing(r, tol)
  if (s.length >= 4) return s
  const [x0, y0, x1, y1] = bbox(r)
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
}

/** Whole-feature extent drives the budget: it is the feature, not the ring,
 * that the map frames. */
export function featureTol(geom) {
  const rings = ringsOf(geom)
  let max = 0
  for (const r of rings) max = Math.max(max, extent(r))
  return clampTol(max / DETAIL)
}

/** Decimals worth keeping at a given tolerance: a tenth of it, which holds
 * every bit that still means anything and roughly halves the file. Coordinates
 * arrive as full double precision — seventeen digits describing a shape now
 * accurate to a couple of kilometres. */
export const precisionFor = (tol) => Math.min(6, Math.max(3, Math.ceil(-Math.log10(tol / 10))))

function roundRing(r, dp) {
  const m = 10 ** dp
  return r.map(([x, y]) => [Math.round(x * m) / m, Math.round(y * m) / m])
}

export function simplify(geom) {
  if (!geom) return null
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return geom
  const tol = featureTol(geom)
  const dp = precisionFor(tol)
  const one = (r) => roundRing(ring(r, tol), dp)
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(one) }
  return { type: 'MultiPolygon', coordinates: geom.coordinates.map((poly) => poly.map(one)) }
}

export const countVertices = (g) =>
  !g ? 0 : g.type === 'Polygon'
    ? g.coordinates.reduce((n, r) => n + r.length, 0)
    : g.type === 'MultiPolygon'
      ? g.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0)
      : 0

/** Every ring of a polygonal geometry, outers and holes alike, order preserved. */
export function ringsOf(geom) {
  if (!geom) return []
  return geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : []
}

/** Shoelace. Sign carries winding, which the dissolve does not depend on but
 * which makes an accidentally reversed ring visible. */
export function signedArea(r) {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return a / 2
}

/** Area with holes subtracted, so a dissolve that wrongly nested an island as
 * a hole reads as lost area rather than as an exact match. */
export function area(geom) {
  if (!geom) return 0
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []
  let total = 0
  for (const poly of polys) {
    total += Math.abs(signedArea(poly[0]))
    for (let i = 1; i < poly.length; i++) total -= Math.abs(signedArea(poly[i]))
  }
  return total
}

export function inside(p, r) {
  let hit = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]
    const [xj, yj] = r[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

const pt = (c) => c[0] + ',' + c[1]

/**
 * Merges neighbouring features into one outline with no internal borders.
 *
 * The trick is that Natural Earth is topologically clean: two neighbours share
 * their border vertex-for-vertex, traversed in opposite directions. So an edge
 * that appears both as a>b and as b>a is interior and cancels; what survives is
 * the outline of the union, and it stitches head-to-tail back into rings.
 *
 * This only works on RAW geometry. Simplification thins each feature
 * independently, after which the shared border no longer matches on either side
 * and nothing cancels — which is exactly why every dissolve in this module
 * happens at build time, before anything is simplified. Passing the same
 * geometry twice is harmless: identical directed edges collapse in the map.
 */
export function dissolve(geoms) {
  const edges = new Map() // "from>to" -> [from, to]
  for (const g of geoms)
    for (const r of ringsOf(g))
      for (let i = 1; i < r.length; i++) edges.set(pt(r[i - 1]) + '>' + pt(r[i]), [r[i - 1], r[i]])
  const from = new Map()
  for (const [k, [, b]] of edges) {
    const [ka, kb] = k.split('>')
    if (edges.has(kb + '>' + ka)) continue
    if (!from.has(ka)) from.set(ka, [])
    from.get(ka).push(b)
  }
  const rings = []
  for (const [start, ends] of from) {
    while (ends.length) {
      const r = [start.split(',').map(Number)]
      let cur = ends.pop()
      let guard = 0
      while (pt(cur) !== start && guard++ < 200000) {
        r.push(cur)
        const nxt = from.get(pt(cur))
        if (!nxt?.length) break
        cur = nxt.pop()
      }
      r.push(r[0])
      if (r.length >= 4) rings.push(r)
    }
  }
  // Largest-first, so an enclave lands as a hole in the ring that contains it
  // rather than as a solid patch of its own.
  rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))
  const polys = []
  for (const r of rings) {
    const host = polys.find((poly) => inside(r[0], poly[0]))
    if (host) host.push(r)
    else polys.push([r])
  }
  return { type: 'MultiPolygon', coordinates: polys }
}
