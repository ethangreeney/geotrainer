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

/**
 * The level-of-detail ladder, and where each rung's tolerance comes from.
 *
 * A web-mercator tile is 256 px wide and spans 360° at zoom 0, so one pixel is
 * 360/(256·2^z) degrees. Aim each rung at *half a pixel at the top of its own
 * zoom band* — the finest error that band can possibly show — and the numbers
 * fall out of the arithmetic rather than out of taste:
 *
 *   LOD 0, top of band z=5   180/(256·32)   = 0.0220°  → 0.02
 *   LOD 1, top of band z=8   180/(256·256)  = 0.0027°  → 0.0025
 *   LOD 2, no band above it  180/(256·2048) = 0.00034° → 0.0003
 *
 * LOD 2 is the last rung, so there is no "top of band" to size it by; it is
 * sized for z≈11, about as close as the result map is ever pushed, and from
 * there it just draws finer than the screen can show.
 *
 * `maxZoom` on the last rung is a number past any real map zoom rather than a
 * null, so a client can pick a rung with a plain `z <= maxZoom` scan.
 */
export const LODS = [
  { id: 0, tol: 0.02, maxZoom: 5 },
  { id: 1, tol: 0.0025, maxZoom: 8 },
  { id: 2, tol: 0.0003, maxZoom: 24 },
]

/**
 * An outer ring whose bounding box diagonal is under this many tolerances is
 * dropped for that LOD: at half a pixel per tolerance, ten of them is a ring
 * five pixels across, which the overlay then strokes with a seven-pixel glow.
 * A shape smaller than the line that draws it is a dot, and a hundred dots
 * along a coast — Patagonia, the Hebrides — read as one solid mass. Leaving it
 * out is the more honest drawing, and it returns properly outlined one rung
 * down, where it is finally big enough to have a shape.
 *
 * Ten rather than the three or four that "just below a pixel" would suggest,
 * because at three the rule does nothing measurable: Chile keeps 160 of its 163
 * outlines and the UK 53 of 57. At ten, Chile drops to 123 and the UK to 27,
 * while Shetland (1.03° across) and Orkney (0.71°) — the ones that have to
 * survive — clear the 0.2° LOD 0 threshold five times over.
 */
export const DROP_TOLS = 10

/** Floor on the tolerance the sliver rescue below may refine to. 1e-6° is a
 * tenth of a metre, which is also where precisionFor's six-decimal cap lands —
 * refining past it would only be undone by the rounding. */
export const REFINE_FLOOR = 1e-6

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

/** Whether a ring is too small to be worth drawing at `tol` — see DROP_TOLS. */
export const tooSmall = (r, tol) => extent(r) < DROP_TOLS * tol

/** A polygon ring needs 4 points to close, and a long thin sliver can simplify
 * below that — Douglas-Peucker keeps the endpoints and one apex, and a closed
 * ring's endpoints are the same point. This used to hand back the ring's
 * bounding box, which is where the boxy islands came from: a rectangle is not
 * an approximation of a coastline, it is a different shape drawn confidently.
 * Refine instead. The sliver is above the drop threshold, so it has earned its
 * pixels; giving it a quarter of the tolerance until it holds four points draws
 * it finer than the budget rather than wronger than the budget, and costs a
 * handful of vertices on the handful of rings that need it.
 *
 * Rounding happens here rather than in the caller so a rescued ring keeps the
 * decimals its own tolerance justifies — rounded to the LOD's coarser
 * precision, the sliver would collapse right back to a line. */
export function ring(r, tol) {
  let t = tol
  let s = simplifyRing(r, t)
  while (s.length < 4 && t > REFINE_FLOOR) {
    t /= 4
    s = simplifyRing(r, t)
  }
  // Degenerate even at full precision (a ring of repeated points): keep it as
  // drawn. Nothing here can invent a shape that was never there.
  if (s.length < 4) s = r
  return roundRing(s, precisionFor(t))
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

/**
 * One geometry, thinned for one rung of the ladder.
 *
 * The tolerance is a function of zoom, not of the feature. The old build sized
 * it from the feature's largest ring, which meant Chile's 37°-tall mainland set
 * the budget for every rock in the Patagonian archipelago: the coast came out
 * smooth and the islands came out as boxes, at every zoom, forever. Zoom is the
 * thing that decides what an eye can resolve, so zoom is the thing that decides
 * the tolerance — and a feature is now built three times, once per band.
 *
 * Rings below the drop threshold leave, and a hole leaves with the outer ring
 * that contained it: dropping the outer and keeping the hole would punch a void
 * in open water. Holes are judged on their own size too, since a sub-pixel hole
 * is noise the same way a sub-pixel island is. What never happens is a feature
 * emptying itself — an island nation is *all* small rings, and invisible is not
 * an acceptable answer for the country the round was played in — so if the rule
 * would take everything, the largest ring stays.
 */
export function simplifyAt(geom, tol) {
  if (!geom) return null
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return geom
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  const kept = []
  for (const poly of polys) {
    if (!poly.length || tooSmall(poly[0], tol)) continue
    // A ring of three points is two points and a repeat: no area, nothing to
    // draw. OpenStreetMap has a scattering of them and they arrive intact,
    // because `ring` refuses to invent detail and hands a degenerate ring back
    // as it found it. Dropping is the honest answer — an outer ring with no
    // area takes its polygon with it.
    const outer = ring(poly[0], tol)
    if (outer.length < 4) continue
    const holes = poly.slice(1).filter((h) => !tooSmall(h, tol))
    kept.push([outer, ...holes.map((h) => ring(h, tol)).filter((h) => h.length >= 4)])
  }
  if (!kept.length) {
    let widest = null
    for (const poly of polys) if (poly.length && (!widest || extent(poly[0]) > extent(widest))) widest = poly[0]
    const r = widest && ring(widest, tol)
    if (r && r.length >= 4) kept.push([r])
  }
  if (geom.type === 'Polygon' && kept.length === 1) return { type: 'Polygon', coordinates: kept[0] }
  return { type: 'MultiPolygon', coordinates: kept }
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

/**
 * The same crossing test as `inside`, prepared for a ring that will be asked
 * many times.
 *
 * Nesting a hundred thousand Arctic islets means asking, for each one, whether
 * it sits inside the Canadian mainland — and the mainland is one ring of well
 * over a million points, so the honest answer costs a million comparisons and
 * the honest build never finishes. Only the edges at the islet's own latitude
 * can possibly be crossed, so the ring is bucketed into horizontal bands once
 * and each query walks one band: a few dozen edges instead of a million.
 *
 * Small rings skip all of this — building the index would cost more than the
 * scans it saves.
 */
export function hitTester(ring) {
  if (ring.length < 512) return (p) => inside(p, ring)
  let lo = Infinity
  let hi = -Infinity
  for (const c of ring) {
    if (c[1] < lo) lo = c[1]
    if (c[1] > hi) hi = c[1]
  }
  const n = Math.max(1, Math.min(8192, ring.length >> 4))
  const h = (hi - lo) / n || 1
  const bands = Array.from({ length: n }, () => [])
  const band = (y) => Math.min(n - 1, Math.max(0, Math.floor((y - lo) / h)))
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = band(Math.min(ring[i][1], ring[j][1]))
    const b = band(Math.max(ring[i][1], ring[j][1]))
    for (let k = a; k <= b; k++) bands[k].push(i, j)
  }
  return (p) => {
    const b = bands[band(p[1])]
    let hit = false
    for (let t = 0; t < b.length; t += 2) {
      const [xi, yi] = ring[b[t]]
      const [xj, yj] = ring[b[t + 1]]
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
}

/** How far apart two torn ends may be and still be the same corner. Sixty
 * metres is the largest real mismatch in the source; a kilometre leaves room
 * for coarser data without being able to bridge a strait. */
const STITCH_MAX_DEG = 0.01

/**
 * Repairs an outline that cancellation tore.
 *
 * Cancelling a shared border is an exact-match test, and two neighbours only
 * match exactly where they were digitised from the same line. OpenStreetMap's
 * Canada is nearly all like that — but at nine places along Hudson Bay and
 * Ungava, Quebec and Nunavut trace the same coast from surveys that disagree in
 * the fourth decimal, sixty metres apart. Nine edges therefore fail to cancel
 * as pairs and instead leave nine gaps, which turns the mainland outline from
 * one closed ring into ten open chains. The walk below then runs off the end of
 * a chain and closes it with a straight line — the chord across northern Quebec
 * that drew a triangle over Ungava Bay.
 *
 * A gap announces itself: the vertex a chain stops at has an edge arriving and
 * none leaving, and the vertex the next chain starts at has one leaving and
 * none arriving. So pair them up — nearest first, and only across a distance
 * too small to be a real coastline feature — and the chains close back into the
 * ring they were. Anything left unpaired is a genuine hole in the source, and
 * saying so at build time beats drawing a chord and hoping nobody looks.
 */
function stitchGaps(from, balance, point) {
  const tails = [] // an edge arrives and none leaves — a chain stops here
  const heads = [] // an edge leaves and none arrives — a chain starts here
  for (const [id, d] of balance) {
    for (let i = 0; i < -d; i++) tails.push(id)
    for (let i = 0; i < d; i++) heads.push(id)
  }
  if (!tails.length) return 0
  const pairs = []
  for (const t of tails)
    for (const h of heads) {
      if (t === h) continue
      const dx = point[t][0] - point[h][0]
      const dy = point[t][1] - point[h][1]
      const d = Math.hypot(dx, dy)
      if (d <= STITCH_MAX_DEG) pairs.push({ t, h, d })
    }
  pairs.sort((a, b) => a.d - b.d)
  const usedT = new Set()
  const usedH = new Set()
  let stitched = 0
  for (const p of pairs) {
    if (usedT.has(p.t) || usedH.has(p.h)) continue
    usedT.add(p.t)
    usedH.add(p.h)
    let list = from.get(p.t)
    if (!list) from.set(p.t, (list = []))
    list.push(p.h)
    stitched++
  }
  const left = tails.length - stitched
  if (left)
    console.warn(
      `[geo] dissolve: ${left} of ${tails.length} torn ends had no partner within ${STITCH_MAX_DEG}° — the outline will close them with a straight line`,
    )
  return stitched
}

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
  /**
   * Vertices as small integers rather than as "x,y" strings.
   *
   * Cancelling edges means recognising the same corner arriving from two
   * neighbours, and the obvious way to do that is to spell the coordinates out
   * and compare the text. At Natural Earth's scale that was free. At
   * OpenStreetMap's it is the whole cost of the build: Canada is two and a half
   * million vertices, and formatting every one of them twice — once for each
   * edge it belongs to — dominates everything else the dissolve does.
   *
   * The cheap path exploits how the geometry got here. Decoded from a
   * topology, a border shared by two provinces is one arc, and both provinces
   * reference the very same coordinate arrays; a reversed arc is a reversed
   * list of the same arrays. So identity alone identifies most corners, and the
   * text is only ever built for a coordinate this dissolve has not seen as an
   * object before — which is every vertex exactly once, and which is also what
   * keeps the answer right for Natural Earth's geometry, where two neighbours
   * genuinely hold separate arrays holding equal numbers.
   */
  const byRef = new Map()
  const byText = new Map()
  const point = []
  const idOf = (c) => {
    let id = byRef.get(c)
    if (id !== undefined) return id
    const text = c[0] + ',' + c[1]
    id = byText.get(text)
    if (id === undefined) {
      id = point.length
      point.push(c)
      byText.set(text, id)
    }
    byRef.set(c, id)
    return id
  }

  // a -> set of b, for every directed edge a→b. Nested maps rather than one map
  // of joined keys, for the same reason as above: no key to build.
  const out = new Map()
  let edgeCount = 0
  for (const g of geoms)
    for (const r of ringsOf(g)) {
      let a = idOf(r[0])
      for (let i = 1; i < r.length; i++) {
        const b = idOf(r[i])
        let ends = out.get(a)
        if (!ends) out.set(a, (ends = new Set()))
        if (!ends.has(b)) {
          ends.add(b)
          edgeCount++
        }
        a = b
      }
    }

  // An edge that appears both ways round is interior — the border two
  // neighbours share — and drops out. What survives is the outline of the
  // union, still head-to-tail.
  const from = new Map()
  // How many edges leave a vertex minus how many arrive. On a closed outline
  // every vertex balances; the ones that do not are where the outline is torn.
  const balance = new Map()
  for (const [a, ends] of out)
    for (const b of ends) {
      if (out.get(b)?.has(a)) continue
      let list = from.get(a)
      if (!list) from.set(a, (list = []))
      list.push(b)
      balance.set(a, (balance.get(a) ?? 0) + 1)
      balance.set(b, (balance.get(b) ?? 0) - 1)
    }
  stitchGaps(from, balance, point)

  const rings = []
  // A walk can visit each surviving edge at most once, so the edge count is the
  // only honest ceiling. It has to be computed rather than picked: Canada's
  // mainland is one ring of well over a million points at the finest rung, and
  // a fixed guard sized for Natural Earth's coastlines would quietly truncate
  // it into an outline that ends in the middle of the Arctic.
  const limit = edgeCount + 1
  for (const [start, ends] of from) {
    while (ends.length) {
      const r = [point[start]]
      let cur = ends.pop()
      let guard = 0
      while (cur !== start && guard++ < limit) {
        r.push(point[cur])
        const nxt = from.get(cur)
        if (!nxt?.length) break
        cur = nxt.pop()
      }
      r.push(r[0])
      if (r.length >= 4) rings.push(r)
    }
  }
  const sized = rings.map((r) => ({ r, a: Math.abs(signedArea(r)), box: bbox(r) }))
  sized.sort((x, y) => y.a - x.a)

  /**
   * Which ring, if any, encloses each of the others.
   *
   * Asking that of every ring already placed is quadratic, and Canada's coast
   * at the finest rung dissolves into a hundred thousand rings — the Arctic
   * archipelago is mostly islets — which is ten billion comparisons and a build
   * that never ends. So the rings placed so far are indexed by the whole-degree
   * cells their bounding boxes cover, and a new ring only ever asks the one
   * cell its first point falls in. Anything spanning more cells than it is
   * worth indexing — a mainland, a country-sized outline — goes in a short list
   * that is always consulted, which is both correct and tiny.
   */
  const CELLS_INDEXED = 4096
  const grid = new Map()
  const wide = []
  const polys = []
  const boxes = []
  const tests = []
  for (const { r, box } of sized) {
    let host = -1
    const cell = Math.floor(box[0]) + ':' + Math.floor(box[1])
    // Ascending index is descending area, so the first container found is the
    // tightest-fitting one that was placed — an enclave inside an enclave lands
    // in the right host.
    const candidates = [...wide, ...(grid.get(cell) ?? [])].sort((a, b) => a - b)
    for (const i of candidates) {
      const h = boxes[i]
      if (box[0] < h[0] || box[1] < h[1] || box[2] > h[2] || box[3] > h[3]) continue
      if ((tests[i] ??= hitTester(polys[i][0]))(r[0])) {
        host = i
        break
      }
    }
    if (host >= 0) {
      polys[host].push(r)
      continue
    }
    const i = polys.length
    polys.push([r])
    boxes.push(box)
    tests.push(null)
    const x0 = Math.floor(box[0])
    const x1 = Math.floor(box[2])
    const y0 = Math.floor(box[1])
    const y1 = Math.floor(box[3])
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > CELLS_INDEXED) {
      wide.push(i)
      continue
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = x + ':' + y
        if (!grid.has(k)) grid.set(k, [])
        grid.get(k).push(i)
      }
  }
  return { type: 'MultiPolygon', coordinates: polys }
}

/**
 * The part of a shape that falls inside a rectangle.
 *
 * The detail ladder can only ever be a compromise while the whole outline has
 * to travel: Hokkaidō at the finest rung is a quarter of a megabyte and fine to
 * send, but Chile is two and Canada is forty, so the server has to answer a
 * zoomed-in map with a coarse shape and the coastline goes back to cutting
 * across bays. Clipping breaks the link between how much detail a shape has and
 * how much of it has to be sent: what leaves the server is bounded by the size
 * of the window, not by the size of the country, and every country can be drawn
 * at full precision.
 *
 * Sutherland–Hodgman, one half-plane at a time. It is exact for a convex
 * clipping shape, and a rectangle is convex; where it degenerates — a concave
 * ring re-entering the box, which comes back joined along the edge rather than
 * as two rings — the join lies on the boundary of the window, which the caller
 * keeps well off screen.
 */
export function clipGeometry(geom, box) {
  if (!geom) return null
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null
  if (!polys) return null
  const kept = []
  for (const poly of polys) {
    const outer = clipRing(poly[0], box)
    if (!outer) continue
    kept.push([outer, ...poly.slice(1).map((h) => clipRing(h, box)).filter(Boolean)])
  }
  return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null
}

/** One ring against one rectangle `[w, s, e, n]`, or null if nothing survives. */
export function clipRing(pts, [x0, y0, x1, y1]) {
  // The closing repeat is an artefact of how a ring is written down; the
  // algorithm wants the cycle, and re-closing at the end is what puts it back.
  let out = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
    ? pts.slice(0, -1)
    : pts.slice()
  const sides = [
    [(p) => p[0] >= x0, (a, b) => atX(a, b, x0)],
    [(p) => p[0] <= x1, (a, b) => atX(a, b, x1)],
    [(p) => p[1] >= y0, (a, b) => atY(a, b, y0)],
    [(p) => p[1] <= y1, (a, b) => atY(a, b, y1)],
  ]
  for (const [keep, cross] of sides) {
    const next = []
    for (let i = 0; i < out.length; i++) {
      const cur = out[i]
      const prev = out[(i + out.length - 1) % out.length]
      const kc = keep(cur)
      if (kc !== keep(prev)) next.push(cross(prev, cur))
      if (kc) next.push(cur)
    }
    out = next
    if (out.length < 3) return null
  }
  return [...out, out[0]]
}

const atX = (a, b, x) => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]
const atY = (a, b, y) => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y]
