/**
 * The boundary layer's tests. Two halves, deliberately:
 *
 *  - The pure half exercises the name matcher and the geometry directly, and
 *    runs anywhere. It imports shape.mjs rather than re-deriving the maths, so
 *    the error bound it measures is the bound the build actually produced.
 *  - The built half reads the slices in admin0/l<n>/, admin1/l<n>/ and
 *    merged/l<n>/, one directory per rung of the LOD ladder. Those are
 *    gitignored — a fresh clone has no Natural Earth data — so it skips rather
 *    than fails when they are absent. `npm test` staying green on a clone is
 *    worth more than a red mark nobody can act on; `node coach/geo/audit.mjs`
 *    is the check that runs against a real build.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPack, locate } from './locate.mjs'
import {
  DROP_TOLS,
  LODS,
  area,
  bbox,
  clipGeometry,
  clipRing,
  countVertices,
  dissolve,
  extent,
  precisionFor,
  ring,
  ringsOf,
  segDistSq,
  signedArea,
  simplifyAt,
  simplifyRing,
} from './shape.mjs'
import {
  bare,
  countryCode,
  countryShape,
  geoLods,
  geoReady,
  loose,
  lodFor,
  matchFeatures,
  norm,
  regionShapes,
  signature,
} from './resolve.mjs'
import { decodeTopology, thinTopology } from './topo.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COACH = join(HERE, '..')
const built = geoReady()
const SRC = join(HERE, 'src', 'ne_10m_admin_0_countries.geojson')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const lodDir = (dir, lod = 0) => join(HERE, dir, 'l' + lod)
const codesIn = (dir, lod = 0) =>
  existsSync(lodDir(dir, lod))
    ? readdirSync(lodDir(dir, lod)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : []
const sliceOf = (dir, code, lod = 0) => read(join(lodDir(dir, lod), code + '.json'))

/** Furthest any point of `pts` strays from the polyline `line`. */
const maxDeviation = (pts, line) => {
  let worst = 0
  for (const p of pts) {
    let best = Infinity
    for (let i = 1; i < line.length; i++) best = Math.min(best, segDistSq(p, line[i - 1], line[i]))
    worst = Math.max(worst, best)
  }
  return Math.sqrt(worst)
}

const square = (x, y, w = 1) => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
  [x, y],
]

describe('norm', () => {
  it('ignores accents, case and punctuation', () => {
    expect(norm('Cataluña')).toBe(norm('CATALUNA'))
    expect(norm('Castellón')).toBe(norm('castellon'))
    expect(norm('Nusa-Tenggara  Timur')).toBe(norm('Nusa Tenggara Timur'))
    expect(norm("Provence-Alpes-Côte d'Azur")).toBe(norm('PROVENCE ALPES COTE D AZUR'))
  })

  it('drops the word for the kind of place, not the place', () => {
    expect(norm('East Nusa Tenggara Province')).toBe(norm('East Nusa Tenggara'))
    expect(norm('Provincia de Valencia')).toBe(norm('Valencia'))
    expect(norm('Comunidad Valenciana')).toBe(norm('Valenciana'))
  })

  it('keeps word order, so two different places stay different', () => {
    expect(norm('Nusa Tenggara Timur')).not.toBe(norm('Timur Nusa Tenggara'))
    expect(norm('North Sumatra')).not.toBe(norm('South Sumatra'))
  })

  it('strips the Korean noun only where a hyphen hangs it off the name', () => {
    expect(norm('Jeju-do')).toBe(norm('Jeju'))
    expect(norm('Seoul-teukbyeolsi')).toBe(norm('Seoul'))
    expect(norm('Dodoma')).toBe('dodoma')
  })

  it('survives a name made of nothing but nouns, and empty input', () => {
    expect(norm('Federal District')).toBeTruthy()
    expect(norm('')).toBe('')
    expect(norm(null)).toBe('null') // callers pass strings; this only has to not throw
    expect(norm('   ')).toBe('')
  })
})

describe('loose', () => {
  it('undoes a sort-order rotation and the ñ digraphs', () => {
    expect(loose('Balears, Illes')).toBe(loose('Illes Balears'))
    expect(loose('Kuala Lumpur, Wilayah Persekutuan')).toBe(loose('Wilayah Persekutuan Kuala Lumpur'))
    expect(loose('Catalunya')).toBe(loose('Cataluña'))
  })
})

describe('geometry', () => {
  it('keeps every dropped vertex within the tolerance', () => {
    const pts = []
    for (let i = 0; i <= 2000; i++) pts.push([i / 100, Math.sin(i / 7) * 0.01 + Math.sin(i / 3) * 0.002])
    for (const tol of [0.02, 0.005, 0.001]) {
      const s = simplifyRing(pts, tol)
      expect(s.length).toBeLessThan(pts.length)
      expect(maxDeviation(pts, s)).toBeLessThanOrEqual(tol)
    }
  })

  it('refines a sliver rather than handing back its bounding box', () => {
    // The old build boxed anything that simplified below four points, which is
    // where the rectangular islands came from. A ring is now drawn finer than
    // the budget instead of squarer than the truth.
    const sliver = [[0, 0], [1, 0.001], [2, 0], [1, -0.001], [0, 0]]
    const r = ring(sliver, 0.5)
    expect(r.length).toBeGreaterThanOrEqual(4)
    const [x0, y0, x1, y1] = bbox(r)
    expect(x1 - x0).toBeCloseTo(2, 3)
    expect(y1 - y0).toBeLessThanOrEqual(0.002)
    // The apexes are what makes it a sliver rather than a rectangle: a bounding
    // box has its corners at the ends and nothing in between.
    expect(r.some(([x, y]) => Math.abs(x - 1) < 0.01 && y > 0.0005)).toBe(true)
    expect(r.some(([x, y]) => Math.abs(x - 1) < 0.01 && y < -0.0005)).toBe(true)
  })

  it('finer rungs cost more precision, because they are worth more decimals', () => {
    expect(precisionFor(LODS[2].tol)).toBeGreaterThan(precisionFor(LODS[0].tol))
  })

  it('measures area with the holes taken out', () => {
    const donut = { type: 'Polygon', coordinates: [square(0, 0, 10), square(4, 4, 2)] }
    expect(area(donut)).toBeCloseTo(96, 6)
  })
})

describe('the LOD ladder', () => {
  /** Half a screen pixel at zoom z, the error nothing at that zoom can show:
   * a 256 px tile spans 360° at z=0, so a pixel is 360/(256·2^z) degrees. */
  const halfPixel = (z) => 180 / (256 * 2 ** z)

  it('sizes each rung for the top of the band it serves', () => {
    expect(LODS.map((l) => l.id)).toEqual([0, 1, 2])
    expect(LODS.map((l) => l.maxZoom)).toEqual([5, 8, 24])
    // The last rung has no band above it, so it is sized for z≈11 — about as
    // close as the result map is ever pushed.
    for (const [lod, top] of [[LODS[0], 5], [LODS[1], 8], [LODS[2], 11]]) {
      expect(lod.tol, `LOD ${lod.id}`).toBeGreaterThan(halfPixel(top) * 0.7)
      expect(lod.tol, `LOD ${lod.id}`).toBeLessThanOrEqual(halfPixel(top) * 1.1)
    }
    // Coarse to fine, with no rung repeating the one before it.
    for (let i = 1; i < LODS.length; i++) expect(LODS[i].tol).toBeLessThan(LODS[i - 1].tol)
  })

  it('holds every rung to its own tolerance, not to the feature\'s size', () => {
    // The same coastline at three rungs. The old build gave a feature one
    // tolerance derived from its own extent, so a big country was drawn as
    // coarsely close up as far away; the bound now belongs to the zoom.
    const coast = []
    for (let i = 0; i <= 3000; i++) coast.push([i / 100, Math.sin(i / 11) * 0.05 + Math.sin(i / 3) * 0.004])
    let finer = 0
    for (const lod of LODS) {
      const s = simplifyRing(coast, lod.tol)
      expect(maxDeviation(coast, s), `LOD ${lod.id}`).toBeLessThanOrEqual(lod.tol)
      expect(s.length).toBeGreaterThan(finer)
      finer = s.length
    }
  })

  it('drops a ring too small to draw, and takes its holes with it', () => {
    const big = square(0, 0, 2)
    const hole = square(0.5, 0.5, 1)
    const islet = square(10, 10, 0.05)
    const isletHole = square(10.01, 10.01, 0.02)
    const geom = { type: 'MultiPolygon', coordinates: [[big, hole], [islet, isletHole]] }

    // 0.02 keeps everything but the islet: 0.07° across, under the 0.2°
    // threshold, and its hole leaves with it rather than punching open water.
    const fine = simplifyAt(geom, 0.02)
    expect(fine.coordinates).toHaveLength(1)
    expect(fine.coordinates[0]).toHaveLength(2)

    // At a coarser rung the hole itself falls under the threshold, and a
    // sub-pixel hole is noise the same way a sub-pixel island is.
    const coarse = simplifyAt(geom, 0.2)
    expect(coarse.coordinates).toHaveLength(1)
    expect(coarse.coordinates[0]).toHaveLength(1)
    expect(area(coarse)).toBeCloseTo(4, 1)
  })

  it('never empties a feature, however small every one of its islands is', () => {
    // An atoll nation is nothing but sub-pixel rings. Invisible is not an
    // available answer for the country the round was played in, so the largest
    // ring stays whatever the rule says.
    const atolls = { type: 'MultiPolygon', coordinates: [[square(0, 0, 0.02)], [square(1, 1, 0.05)], [square(2, 2, 0.01)]] }
    const out = simplifyAt(atolls, 0.02)
    expect(out.coordinates).toHaveLength(1)
    expect(ringsOf(out)).toHaveLength(1)
    // The largest, not the first: 0.05° at (1,1).
    expect(bbox(ringsOf(out)[0])[0]).toBeCloseTo(1, 3)
  })

  it('judges a ring by its bounding diagonal against the rung it is drawn at', () => {
    const at = (w, tol) => simplifyAt({ type: 'MultiPolygon', coordinates: [[square(0, 0, 5)], [square(20, 20, w)]] }, tol)
    const threshold = DROP_TOLS * 0.02
    // Just under and just over, measured on the diagonal the rule uses.
    expect(at((threshold / Math.SQRT2) * 0.9, 0.02).coordinates).toHaveLength(1)
    expect(at((threshold / Math.SQRT2) * 1.1, 0.02).coordinates).toHaveLength(2)
  })
})

describe('TopoJSON', () => {
  // Two squares sharing their middle edge, written the way geoBoundaries writes
  // them: coordinates on a quantisation grid, each point a delta from the last,
  // and the shared edge stored once as an arc the right-hand square walks
  // backwards. Arc 0 is the shared border, 1 is the left square's outside, 2 is
  // the right's.
  const shared = {
    transform: { scale: [0.01, 0.01], translate: [10, 20] },
    arcs: [
      [
        [100, 0],
        [0, 20],
        [0, 20],
        [0, 20],
        [0, 20],
        [0, 20],
      ],
      [
        [100, 100],
        [-100, 0],
        [0, -100],
        [100, 0],
      ],
      [
        [100, 0],
        [100, 0],
        [0, 100],
        [-100, 0],
      ],
    ],
    objects: {
      units: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]], properties: { shapeName: 'Left' } },
          { type: 'Polygon', arcs: [[2, ~0]], properties: { shapeName: 'Right' } },
        ],
      },
    },
  }

  it('undoes the delta encoding and the quantisation grid', () => {
    const [left, right] = decodeTopology(shared)
    expect(left.properties.shapeName).toBe('Left')
    expect(left.geometry.coordinates[0][0]).toEqual([11, 20])
    // Closed rings: an arc list that returns to where it started.
    for (const f of [left, right]) {
      const r = f.geometry.coordinates[0]
      expect(r[0]).toEqual(r[r.length - 1])
    }
    expect(right.geometry.coordinates[0]).toContainEqual([11, 21])
  })

  it('gives both sides of a shared border the same coordinates, so a dissolve cancels it', () => {
    const [left, right] = decodeTopology(shared)
    const merged = dissolve([left.geometry, right.geometry])
    expect(ringsOf(merged)).toHaveLength(1)
    expect(area(merged)).toBeCloseTo(area(left.geometry) + area(right.geometry), 10)
  })

  it('still cancels it after thinning, because the border is thinned once', () => {
    // The reason the download is kept as a topology at all. Thin the two rings
    // separately and the shared edge comes back slightly different on each
    // side, leaving a hairline sliver where the dissolve failed to cancel.
    expect(decodeTopology(shared)[0].geometry.coordinates[0]).toHaveLength(9)
    const [left, right] = decodeTopology(thinTopology(shared, 0.02, simplifyRing))
    expect(left.geometry.coordinates[0]).toHaveLength(5)
    const merged = dissolve([left.geometry, right.geometry])
    expect(ringsOf(merged)).toHaveLength(1)
  })

  it('reads a topology that was never quantised, and one with nothing in it', () => {
    const flat = {
      arcs: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      objects: { a: { type: 'Polygon', arcs: [[0]], properties: { shapeName: 'Unit' } } },
    }
    expect(decodeTopology(flat)[0].geometry.coordinates[0]).toHaveLength(5)
    expect(decodeTopology({ arcs: [], objects: {} })).toEqual([])
    // A geometry type the boundary layer has no use for is skipped, not thrown.
    expect(decodeTopology({ arcs: [[[0, 0]]], objects: { p: { type: 'Point', coordinates: [0, 0] } } })).toEqual([])
  })

  it('carries a MultiPolygon\'s holes through as holes', () => {
    const withHole = {
      arcs: [square(0, 0, 10).map((p) => p), square(3, 3, 2).map((p) => p)],
      objects: {
        a: {
          type: 'MultiPolygon',
          arcs: [[[0], [1]]],
          properties: { shapeName: 'Ringed' },
        },
      },
    }
    const [f] = decodeTopology(withHole)
    expect(f.geometry.type).toBe('MultiPolygon')
    expect(f.geometry.coordinates[0]).toHaveLength(2)
    expect(area(f.geometry)).toBeCloseTo(100 - 4, 6)
  })
})

describe('dissolve', () => {
  const closed = (r) => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]

  it('merges neighbours into one ring with no border down the middle', () => {
    const merged = dissolve([
      { type: 'Polygon', coordinates: [square(0, 0)] },
      { type: 'Polygon', coordinates: [square(1, 0)] },
    ])
    expect(merged.coordinates.length).toBe(1)
    expect(merged.coordinates[0].length).toBe(1)
    expect(area(merged)).toBeCloseTo(2, 9)
    for (const r of ringsOf(merged)) expect(closed(r)).toBe(true)
  })

  it('leaves two shapes that do not touch as two shapes', () => {
    const merged = dissolve([
      { type: 'Polygon', coordinates: [square(0, 0)] },
      { type: 'Polygon', coordinates: [square(5, 5)] },
    ])
    expect(merged.coordinates.length).toBe(2)
    expect(area(merged)).toBeCloseTo(2, 9)
  })

  it('nests an enclave as a hole rather than a patch of its own', () => {
    const outer = [
      [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
    ]
    const holeRing = square(4, 4, 2)
    const host = { type: 'Polygon', coordinates: [outer, [...holeRing].reverse()] }
    const enclave = { type: 'Polygon', coordinates: [holeRing] }
    expect(area(dissolve([host]))).toBeCloseTo(96, 6)
    // the enclave filled in: one solid ring, hole gone
    const filled = dissolve([host, enclave])
    expect(area(filled)).toBeCloseTo(100, 6)
  })

  it('is unbothered by the same shape passed twice', () => {
    const s = { type: 'Polygon', coordinates: [square(0, 0)] }
    expect(area(dissolve([s, s]))).toBeCloseTo(1, 9)
  })
})

// A window on the shape rather than the shape: the whole reason the finest
// rung can be served at all for a country the size of Canada.
describe('clipping to a window', () => {
  const BOX = [0, 0, 10, 10]
  const ringArea = (r) => Math.abs(signedArea(r))

  it('leaves a ring that is already inside completely alone', () => {
    const r = square(2, 2, 5)
    expect(clipRing(r, BOX)).toEqual(r)
  })

  it('cuts a ring that hangs over the edge down to the part on screen', () => {
    const clipped = clipRing(square(5, 5, 20), BOX)
    // The overhang is gone and the corner that was inside is still there.
    expect(clipped.every(([x, y]) => x >= 5 && x <= 10 && y >= 5 && y <= 10)).toBe(true)
    expect(ringArea(clipped)).toBeCloseTo(25, 6)
    expect(clipped[0]).toEqual(clipped[clipped.length - 1]) // still closed
  })

  it('answers nothing for a ring the window never touches', () => {
    expect(clipRing(square(50, 50, 5), BOX)).toBe(null)
  })

  it('keeps a window that spans the ring as the whole ring', () => {
    const clipped = clipRing(square(2, 2, 5), [-100, -100, 100, 100])
    expect(ringArea(clipped)).toBeCloseTo(25, 6)
  })

  it('drops the islands off screen and keeps the one on it', () => {
    const geom = {
      type: 'MultiPolygon',
      coordinates: [[square(1, 1, 3)], [square(80, 80, 3)]],
    }
    const out = clipGeometry(geom, BOX)
    expect(out.type).toBe('MultiPolygon')
    expect(out.coordinates).toHaveLength(1)
    expect(ringArea(out.coordinates[0][0])).toBeCloseTo(9, 6)
  })

  it('carries a hole through, and drops one the window cut away', () => {
    const geom = {
      type: 'Polygon',
      coordinates: [square(0, 0, 10), square(2, 2, 3), square(20, 20, 3)],
    }
    const out = clipGeometry(geom, [0, 0, 10, 10])
    expect(out.coordinates[0]).toHaveLength(2) // outer + the hole that is inside
    expect(ringArea(out.coordinates[0][1])).toBeCloseTo(9, 6)
  })

  it('answers nothing at all when the window misses everything', () => {
    expect(clipGeometry({ type: 'Polygon', coordinates: [square(50, 50, 3)] }, BOX)).toBe(null)
    expect(clipGeometry(null, BOX)).toBe(null)
    expect(clipGeometry({ type: 'Point', coordinates: [1, 1] }, BOX)).toBe(null)
  })

  it('cuts a real coastline to a fraction of itself without moving what is left', () => {
    // A jagged 400-point coast: the window keeps a tenth of it, and every
    // point it keeps is a point the original had, in the same place.
    const pts = []
    for (let i = 0; i <= 400; i++) pts.push([i / 40, 5 + Math.sin(i / 3) * 0.4])
    pts.push([10, -5], [0, -5], [0, 5])
    const clipped = clipRing(pts, [0, -10, 1, 10])
    expect(clipped.length).toBeLessThan(pts.length / 5)
    const inside = pts.filter(([x]) => x <= 1)
    for (const p of inside) expect(clipped.some(([x, y]) => x === p[0] && y === p[1])).toBe(true)
  })
})

describe('signature', () => {
  it('does not care what order or how often a subdivision was named', () => {
    const a = signature([{ id: 'x', parts: ['b', 'a'] }, { id: 'y', parts: ['c'] }])
    const b = signature([{ id: 'y', parts: ['c'] }, { id: 'x', parts: ['a', 'b', 'a'] }])
    expect(a).toBe(b)
  })
})

describe('matchFeatures', () => {
  const list = [
    { id: '1', name: 'Vientiane', names: ['Vientiane'], parts: ['1'] },
    { id: '2', name: 'Vientiane [prefecture]', names: ['Vientiane [prefecture]'], parts: ['2'] },
    { id: '3', name: 'Jervis Bay Territory', names: ['Jervis Bay Territory', 'Australian Capital Territory'], parts: ['3'] },
    { id: '4', name: 'Australian Capital Territory', names: ['Australian Capital Territory'], parts: ['4'] },
  ]

  it('answers with the place that was actually called that', () => {
    expect(matchFeatures(list, ['Vientiane']).matched[0].id).toBe('1')
    expect(matchFeatures(list, ['Vientiane [prefecture]']).matched[0].id).toBe('2')
  })

  it('prefers what a place calls itself over what a neighbour calls it', () => {
    expect(matchFeatures(list, ['Australian Capital Territory']).matched[0].id).toBe('4')
  })

  it('reports a name it cannot place instead of guessing at one', () => {
    const { matched, missing } = matchFeatures(list, ['Vientiane', 'Somewhere Else'])
    expect(matched).toHaveLength(1)
    expect(missing).toEqual(['Somewhere Else'])
  })

  it('does not fall over on an empty list or empty names', () => {
    expect(matchFeatures([], ['x']).matched).toEqual([])
    expect(matchFeatures(list, []).matched).toEqual([])
    expect(matchFeatures(null, null).matched).toEqual([])
  })
})

describe.skipIf(!built)('the built slices', () => {
  const scope = read(join(COACH, 'scope-regions.json'))
  // Read lazily: a skipped describe still runs its own body, and on a clone
  // with no build there is no index to read.
  const index = built ? read(join(HERE, 'index.json')) : { countries: {} }

  it('gives every country in the index the files the index claims, at every rung', () => {
    expect(Object.keys(index.countries).length).toBeGreaterThan(200)
    // The ladder is published in the index so the server and the client can
    // discover it instead of restating shape.mjs's constants.
    expect(index.lods).toEqual(LODS)
    expect(geoLods()).toEqual(LODS)
    for (const [code, c] of Object.entries(index.countries)) {
      expect(code).toMatch(/^[A-Z]{2}$/)
      expect(c.name).toBeTruthy()
      for (const lod of index.lods) {
        expect(existsSync(join(lodDir('admin0', lod.id), code + '.json')), `${code} LOD ${lod.id}`).toBe(true)
        if (c.admin1) expect(sliceOf('admin1', code, lod.id)).toHaveLength(c.admin1)
        if (c.merged) expect(Object.keys(sliceOf('merged', code, lod.id))).toHaveLength(c.merged)
      }
    }
  })

  it('gives every country with subdivisions an outline too', () => {
    // A country that has provinces but no outline draws nothing at all, and a
    // silent empty highlight is exactly the failure nobody reports. Natural
    // Earth omits a country file for several territories; build.mjs dissolves
    // their subdivisions instead, and this is what proves it did.
    for (const code of codesIn('admin1')) expect(countryShape(code), code).toBeTruthy()
  })

  it('gets finer as the ladder climbs, without ever losing the mainland', () => {
    // Nine countries chosen for the shapes that break naive simplification:
    // an archipelago strung down a mainland (CL), islands off a big island
    // (GB, JP), a fjord coast (NO), pure archipelago (PH, ID, GR), the biggest
    // vertex counts on file (CA, RU).
    for (const code of ['CL', 'GB', 'JP', 'NO', 'PH', 'ID', 'CA', 'GR', 'RU']) {
      const geoms = index.lods.map((lod) => countryShape(code, lod.id).geometry)
      for (let i = 1; i < geoms.length; i++) {
        expect(countVertices(geoms[i]), `${code} LOD ${i}`).toBeGreaterThan(countVertices(geoms[i - 1]))
        expect(geoms[i].coordinates.length, `${code} LOD ${i}`).toBeGreaterThanOrEqual(geoms[i - 1].coordinates.length)
      }
      // Whatever the drop rule takes, it never takes the shape the country is:
      // the widest ring is the same one at every rung.
      const widest = geoms.map((g) => Math.max(...ringsOf(g).map(extent)))
      for (const w of widest) expect(w / widest[2], code).toBeGreaterThan(0.98)
      // And the coarse rung is a real saving, not a rounding difference.
      expect(countVertices(geoms[0]) * 2, code).toBeLessThan(countVertices(geoms[2]))
    }
  })

  it('resolves a region at the rung it was asked for, and clamps the rest', () => {
    // Same feature, same identity, more detail — the LOD picks the geometry
    // and nothing else. Anything off the end of the ladder clamps rather than
    // returning nothing: an unknown rung is still a request to draw.
    const shapes = index.lods.map((lod) => regionShapes('GB', ['Scotland'], lod.id).matched[0])
    expect(new Set(shapes.map((f) => f.id)).size).toBe(1)
    for (let i = 1; i < shapes.length; i++)
      expect(countVertices(shapes[i].geometry)).toBeGreaterThan(countVertices(shapes[i - 1].geometry))
    expect(lodFor(99).id).toBe(index.lods.length - 1)
    expect(lodFor(-4).id).toBe(0)
    expect(lodFor('nonsense').id).toBe(0)
    expect(countryShape('CL', 99)).toEqual(countryShape('CL', index.lods.length - 1))
    // The default is the coarse rung: the cheapest thing to send, and what a
    // client that has not said otherwise is drawing.
    expect(countryShape('CL')).toEqual(countryShape('CL', 0))
    expect(regionShapes('BR', ['Bahia']).matched[0].geometry).toEqual(
      regionShapes('BR', ['Bahia'], 0).matched[0].geometry
    )
  })

  it('holds together structurally in every file it wrote', { timeout: 120_000 }, () => {
    // Millions of coordinates, so the checks are plain conditions and only the
    // failures reach expect(): an assertion per vertex costs minutes.
    const faults = []
    const check = (geom, where) => {
      if (geom?.type !== 'Polygon' && geom?.type !== 'MultiPolygon') return faults.push(`${where}: ${geom?.type}`)
      const rings = ringsOf(geom)
      if (!rings.length) faults.push(`${where}: no rings`)
      for (const r of rings) {
        if (r.length < 4) faults.push(`${where}: ring of ${r.length}`)
        if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) faults.push(`${where}: ring not closed`)
        for (const [x, y] of r)
          if (!(Math.abs(x) <= 180.001) || !(Math.abs(y) <= 90.001)) faults.push(`${where}: point ${x},${y}`)
      }
    }
    for (const lod of index.lods) {
      for (const code of codesIn('admin0', lod.id)) check(sliceOf('admin0', code, lod.id).geometry, `${code} l${lod.id}`)
      for (const code of codesIn('admin1', lod.id))
        for (const f of sliceOf('admin1', code, lod.id)) {
          if (!f.id || !f.parts?.length) faults.push(`${code}: ${f.name} has no identity`)
          check(f.geometry, `${f.id} l${lod.id}`)
        }
      for (const code of codesIn('merged', lod.id))
        for (const [sig, f] of Object.entries(sliceOf('merged', code, lod.id))) {
          if (signature([f]) !== sig) faults.push(`${code}: ${sig} is filed under the wrong signature`)
          check(f.geometry, `${sig} l${lod.id}`)
        }
    }
    expect(faults.slice(0, 20)).toEqual([])
  })

  it('names the sovereign state behind an ISO code two features claim', () => {
    // France also owns Clipperton, Kazakhstan a Russian-administered sliver,
    // Brazil an "Indeterminate" river island, Australia the Coral Sea Islands.
    for (const [name, code] of [['France', 'FR'], ['Kazakhstan', 'KZ'], ['Brazil', 'BR'], ['Australia', 'AU']]) {
      expect(countryCode(name)).toBe(code)
      expect(index.countries[code].name).toBe(name)
      expect(countryShape(code).name).toBe(name)
    }
  })

  it('finds a country however the meta key or the geocoder spelled it', () => {
    for (const [name, code] of [
      ['United States', 'US'],
      ['South Korea', 'KR'],
      ['Czechia', 'CZ'],
      ['Turkey', 'TR'],
      ['Cote dIvoire', 'CI'],
    ])
      expect(countryCode(name), name).toBe(code)
    expect(countryCode('Atlantis')).toBe(null)
  })

  it('places a subdivision in ten countries and four alphabets', () => {
    const one = (cc, name) => {
      const { matched } = regionShapes(cc, [name])
      expect(matched.length, `${cc} ${name}`).toBe(1)
      return matched[0]
    }
    one('GB', 'Scotland')
    one('BR', 'Minas Gerais')
    one('JP', 'Hokkaido')
    one('KR', 'Jeju-do')
    one('RU', 'Приморский край')
    one('UA', 'Odessa')
    one('IN', 'Kerala')
    one('MY', 'Melaka')
    one('CA', 'ON') // the iso_3166_2 half, as some geocoders answer
    one('ID', 'Nusa Tenggara Timur')
    one('ES', 'Illes Balears')
  })

  it('draws a shape for every scope in scope-regions.json', () => {
    // The whole-file audit, as a test: a scope that resolves to nothing falls
    // back to the country outline in the browser, which looks like a working
    // overlay and is not one.
    const failures = []
    for (const [key, names] of Object.entries(scope)) {
      if (key.startsWith('_') || !Array.isArray(names)) continue
      const code = countryCode(key.split(':')[0].trim())
      if (!code) failures.push(`${key}: no country`)
      else if (!regionShapes(code, names).matched.length) failures.push(`${key}: no region matched`)
    }
    expect(failures).toEqual([])
  })

  it('never answers with a subdivision that is not called what was asked', { timeout: 60_000 }, () => {
    // Every one of the ~4,900 subdivisions, asked for by its own name. What
    // comes back has to answer to that name too — a near miss that quietly
    // returns the neighbour is worse than no shape at all, because the
    // whole-country fallback at least looks like what it is.
    const wrong = []
    for (const code of codesIn('admin1')) {
      const list = sliceOf('admin1', code)
      for (const f of list) {
        const got = matchFeatures(list, [f.name]).matched[0]
        if (!got) wrong.push(`${code} ${f.name}: nothing`)
        else if (!got.names.some((n) => bare(n) === bare(f.name))) wrong.push(`${code} ${f.name} -> ${got.name}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('gives the Valencian Community all three of its provinces', () => {
    // It used to answer with Castellón alone: every province carried
    // "Comunidad Valenciana" among its own names, and the first one in the file
    // won. Near enough is the wrong answer here — one province of three, drawn
    // confidently, is worse than the honest whole-country fallback. The finer
    // source files Spain as its nineteen communities rather than its provinces,
    // so the three province names now have to land on the community that holds
    // them, and land on the same one.
    const provinces = ['Castellón', 'Valencia', 'Alicante'].map((n) => regionShapes('ES', [n]).matched)
    for (const m of provinces) expect(m).toHaveLength(1)
    const { matched } = regionShapes('ES', ['Comunidad Valenciana'])
    expect(matched).toHaveLength(1)
    expect(new Set(provinces.map((m) => m[0].id))).toEqual(new Set([matched[0].id]))

    // The English exonym is in no Natural Earth field, so it matches nothing —
    // and nothing is what it must return. Resolving it to whichever province
    // looked closest is the bug above, wearing a different name.
    const english = regionShapes('ES', ['Valencian Community'])
    expect(english.matched).toEqual([])
    expect(english.missing).toEqual(['Valencian Community'])
  })

  it('hands back one shape where a scope covers several neighbours', () => {
    // Drawn as two features they show a stroke along the border they share,
    // which reads as a rendering fault rather than as information.
    const parts = ['Bahia', 'Pernambuco'].map((n) => regionShapes('BR', [n]).matched[0])
    const { matched } = regionShapes('BR', ['Bahia', 'Pernambuco'])
    expect(matched).toHaveLength(1)
    expect(matched[0].parts).toHaveLength(2)
    expect(matched[0].name).toContain('Bahia')
    const sum = parts.reduce((n, f) => n + area(f.geometry), 0)
    expect(area(matched[0].geometry)).toBeGreaterThan(sum * 0.98)
    expect(area(matched[0].geometry)).toBeLessThan(sum * 1.02)
  })

  it('keeps a scope whose members do not touch as separate islands', () => {
    const parts = ['Nusa Tenggara Timur', 'Nusa Tenggara Barat'].map((n) => regionShapes('ID', [n]).matched[0])
    const { matched } = regionShapes('ID', ['Nusa Tenggara Timur', 'Nusa Tenggara Barat'])
    expect(matched).toHaveLength(1)
    expect(matched[0].geometry.coordinates.length).toBeGreaterThan(1)
    const sum = parts.reduce((n, f) => n + area(f.geometry), 0)
    expect(area(matched[0].geometry)).toBeGreaterThan(sum * 0.98)
    expect(area(matched[0].geometry)).toBeLessThan(sum * 1.02)
  })

  it('answers two spellings of the same ground with the same shape', () => {
    const a = regionShapes('ES', ['Cataluña', 'Comunidad Valenciana', 'Islas Baleares'])
    const b = regionShapes('ES', ['Catalunya', 'Valenciana', 'Balears, Illes'])
    expect(a.matched).toHaveLength(1)
    expect(b.matched).toHaveLength(1)
    expect(b.matched[0].geometry).toEqual(a.matched[0].geometry)
  })

  it('builds a territory Natural Earth files only as parishes', () => {
    // Natural Earth has no country outline for Bermuda at all — only its nine
    // parishes — so the country has to be made rather than read. Measured at
    // the finest rung: Bermuda is 0.28° corner to corner, so at the coarse
    // rungs it is deliberately drawn below its own size.
    const fine = LODS[LODS.length - 1].id
    const parishes = sliceOf('admin1', 'BM', fine).filter((f) => !f.group)
    const bermuda = countryShape('BM', fine)
    expect(bermuda.name).toBe('Bermuda')
    expect(index.countries.BM.synthesized).toBe(true)
    // Same ground as the parishes — the two sources trace the same reefs
    // differently, so this is a sanity band, not an identity.
    const [x0, y0, x1, y1] = bbox(parishes.flatMap((f) => ringsOf(f.geometry).flat()))
    const [a0, b0, a1, b1] = bbox(ringsOf(bermuda.geometry).flat())
    for (const [got, want] of [
      [a0, x0],
      [b0, y0],
      [a1, x1],
      [b1, y1],
    ])
      expect(Math.abs(got - want)).toBeLessThan(0.02)
    // And drawn from the finer source, which is the whole reason it is taken
    // over the parishes it replaces.
    expect(countVertices(bermuda.geometry)).toBeGreaterThan(
      parishes.reduce((n, f) => n + countVertices(f.geometry), 0)
    )
  })

  it('says nothing rather than something wrong about a country it has no file for', () => {
    // ZZ is what a failed geocode asks for. CC is a real code the sources
    // between them draw nothing for: Natural Earth files the Cocos Islands
    // under the same uncoded "Indian Ocean Territories" admin as Christmas
    // Island, and only the one the deck has actually played is rescued.
    expect(countryShape('ZZ')).toBe(null)
    expect(countryShape('CC')).toBe(null)
    const { matched, missing } = regionShapes('ZZ', ['Anywhere'])
    expect(matched).toEqual([])
    expect(missing).toEqual(['Anywhere'])
  })
})

describe.skipIf(!existsSync(SRC))('against the Natural Earth source', () => {
  const sample = () => {
    const features = read(SRC).features.filter((f) => {
      const n = ringsOf(f.geometry).reduce((m, r) => m + r.length, 0)
      return n > 500 && n < 8000
    })
    expect(features.length).toBeGreaterThan(20)
    return features.slice(0, 25)
  }

  it('never moves a real coastline further than the rung it was drawn for', { timeout: 60_000 }, () => {
    // The claim the whole module rests on, measured at every rung and on the
    // shapes it was actually built from rather than on a curve chosen to be
    // easy. A ring the rung dropped is not measured — it was not drawn.
    for (const f of sample())
      for (const lod of LODS) {
        const slack = Math.SQRT2 * 10 ** -precisionFor(lod.tol) // coordinates are rounded after simplifying
        for (const r of ringsOf(f.geometry)) {
          if (extent(r) < DROP_TOLS * lod.tol) continue
          expect(maxDeviation(r, ring(r, lod.tol)), `${f.properties.NAME} LOD ${lod.id}`).toBeLessThanOrEqual(
            lod.tol + slack
          )
        }
        const out = simplifyAt(f.geometry, lod.tol)
        expect(signedArea(ringsOf(out)[0])).not.toBe(0)
      }
  })

  it('draws the finest rung as the source drew it', { timeout: 60_000 }, () => {
    // LOD 2 is what a zoomed-in map gets, and it has to be the coastline rather
    // than an impression of it: every vertex within a third of a metre of the
    // source outline, and the area it encloses within a tenth of a percent.
    const fine = LODS[LODS.length - 1]
    for (const f of sample()) {
      const out = simplifyAt(f.geometry, fine.tol)
      const kept = ringsOf(f.geometry).filter((r) => extent(r) >= DROP_TOLS * fine.tol)
      expect(maxDeviation(kept.flat(), ringsOf(out).flat()), f.properties.NAME).toBeLessThan(fine.tol * 2)
      const raw = { type: f.geometry.type, coordinates: f.geometry.coordinates }
      if (area(raw) > 1) expect(area(out) / area(raw), f.properties.NAME).toBeCloseTo(1, 3)
    }
  })
})

/**
 * The offline reverse geocoder. Skips without a built pack, like the rest of
 * the built half.
 *
 * The cases worth pinning are the ones that used to go wrong, not the easy
 * middles: a point on the far side of a land border from a much larger
 * neighbour (the failure that marks a correct answer wrong), a small territory
 * drawn inside the sovereign that also covers it, and a shoreline point that a
 * simplified outline leaves in the water.
 */
describe('offline reverse geocoding', () => {
  const packPath = join(HERE, 'pack', 'admin0.bin')
  const regionPath = join(HERE, 'pack', 'admin1.bin')
  const built = existsSync(packPath)
  const pack = built ? loadPack(readFileSync(packPath)) : null
  const regions = built && existsSync(regionPath) ? loadPack(readFileSync(regionPath)) : null
  const at = (lat, lng) => locate(pack, lat, lng)?.code ?? '??'

  it.runIf(built)('places ordinary points in their country', () => {
    expect(at(-0.1807, -78.4678)).toBe('EC') // Quito
    expect(at(-33.9755, 25.6059)).toBe('ZA') // Gqeberha
    expect(at(-25.2708, 152.2147)).toBe('AU') // Maryborough, Queensland
    expect(at(35.6762, 139.6503)).toBe('JP') // Tokyo
    expect(at(64.1466, -21.9426)).toBe('IS') // Reykjavik
  })

  it.runIf(built)('does not hand a border town to the larger neighbour', () => {
    expect(at(68.4453, 22.4772)).toBe('FI') // Kilpisjarvi arm, Sweden a ridge away
    expect(at(16.5795, 104.7475)).toBe('LA') // Mekong bank, Thailand across the water
    expect(at(42.3314, -83.0458)).toBe('US') // Detroit, and Windsor 1km across
    expect(at(42.3149, -83.0364)).toBe('CA') // the river, on the other side
    expect(at(43.7309, 7.4209)).toBe('MC') // Monaco, wholly inside France
  })

  it.runIf(built)('prefers the smaller claim where shapes nest', () => {
    expect(at(18.3474, -64.7103)).toBe('VI') // US Virgin Islands, not the BVI
    expect(at(22.3193, 114.1694)).toBe('HK') // Hong Kong, not mainland China
  })

  it.runIf(built)('pulls shoreline points back onto the land they belong to', () => {
    // Toronto's waterfront and a Gulf-of-St-Lawrence shore both fall outside a
    // simplified outline; both are unambiguously Canada.
    expect(at(43.6407, -79.3875)).toBe('CA')
    expect(at(50.0236, -66.8667)).toBe('CA')
  })

  it.runIf(built)('leaves open ocean unresolved rather than guessing', () => {
    expect(at(0, -140)).toBe('??') // middle of the Pacific
  })

  it.runIf(built && !!regions)('names the subdivision for scoped countries', () => {
    expect(locate(regions, -33.8688, 151.2093)?.name).toBe('New South Wales')
    expect(locate(regions, 37.7749, -122.4194)?.name).toBe('California')
    // Nothing is carried for countries no meta is scoped to.
    expect(locate(regions, 48.8566, 2.3522)).toBe(null)
  })

  /**
   * A scope is a list of subdivision names, and grading is a string match
   * against what the pack calls the ground the guess landed on. The two
   * datasets disagree about spelling — geoBoundaries writes South Africa's
   * Northern Cape as "Nothern Cape" — so a pack carrying one name per shape
   * graded every correct guess inside those provinces out of scope, silently,
   * and only for the handful of metas whose scope happened to be spelled the
   * other way. The pack now carries every spelling; this is the check that it
   * still covers every scope we have written.
   */
  it.runIf(built && !!regions)('answers to every spelling a scope is written in', () => {
    const known = new Set(regions.features.flatMap((f) => f.names).map(normRegion))
    const scopes = JSON.parse(readFileSync(join(HERE, '..', 'scope-regions.json'), 'utf8'))
    const ungradeable = Object.entries(scopes)
      .filter(([, named]) => Array.isArray(named) && !named.some((n) => known.has(normRegion(n))))
      .map(([meta]) => meta)
    expect(ungradeable, 'metas whose scope no shape answers to').toEqual([])
  })

  it.runIf(built && !!regions)('knows the province under the name its scope uses', () => {
    expect(locate(regions, -28.45, 21.25)?.names).toContain('Northern Cape')
    expect(locate(regions, 43.36, -5.84)?.names).toContain('Asturias')
  })
})

/** The grader's own normaliser, copied rather than imported: it lives in the
 * Worker, which cannot be loaded here. Drift between the two shows up as this
 * suite passing while a round grades wrong, so keep them identical. */
const normRegion = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\b(prefecture|province|region|state|district|county|governorate|oblast)\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
