/**
 * The boundary layer's tests. Two halves, deliberately:
 *
 *  - The pure half exercises the name matcher and the geometry directly, and
 *    runs anywhere. It imports shape.mjs rather than re-deriving the maths, so
 *    the error bound it measures is the bound the build actually produced.
 *  - The built half reads the slices in admin0/, admin1/ and merged/. Those are
 *    gitignored — a fresh clone has no Natural Earth data — so it skips rather
 *    than fails when they are absent. `npm test` staying green on a clone is
 *    worth more than a red mark nobody can act on; `node coach/geo/audit.mjs`
 *    is the check that runs against a real build.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  area,
  bbox,
  dissolve,
  featureTol,
  precisionFor,
  ring,
  ringsOf,
  segDistSq,
  signedArea,
  simplify,
  simplifyRing,
} from './shape.mjs'
import {
  bare,
  countryCode,
  countryShape,
  geoReady,
  loose,
  matchFeatures,
  norm,
  regionShapes,
  signature,
} from './resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COACH = join(HERE, '..')
const built = geoReady()
const SRC = join(HERE, 'src', 'ne_10m_admin_0_countries.geojson')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const codesIn = (dir) =>
  existsSync(join(HERE, dir)) ? readdirSync(join(HERE, dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []

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

  it('replaces a ring too small to survive with its bounding box', () => {
    const islet = [[0, 0], [0.00001, 0], [0.00001, 0.00001], [0, 0.00001], [0, 0]]
    const r = ring(islet, 0.01)
    expect(r.length).toBe(5)
    expect(bbox(r)).toEqual(bbox(islet))
  })

  it('scales the tolerance to the feature, and the precision to the tolerance', () => {
    const big = { type: 'Polygon', coordinates: [square(0, 0, 40)] }
    const small = { type: 'Polygon', coordinates: [square(0, 0, 0.2)] }
    expect(featureTol(big)).toBeGreaterThan(featureTol(small))
    expect(precisionFor(featureTol(small))).toBeGreaterThanOrEqual(precisionFor(featureTol(big)))
  })

  it('measures area with the holes taken out', () => {
    const donut = { type: 'Polygon', coordinates: [square(0, 0, 10), square(4, 4, 2)] }
    expect(area(donut)).toBeCloseTo(96, 6)
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

  it('gives every country in the index the files the index claims', () => {
    expect(Object.keys(index.countries).length).toBeGreaterThan(200)
    expect(index.detail).toBeGreaterThan(0)
    for (const [code, c] of Object.entries(index.countries)) {
      expect(code).toMatch(/^[A-Z]{2}$/)
      expect(c.name).toBeTruthy()
      expect(existsSync(join(HERE, 'admin0', code + '.json'))).toBe(true)
      if (c.admin1) expect(read(join(HERE, 'admin1', code + '.json'))).toHaveLength(c.admin1)
      if (c.merged) expect(Object.keys(read(join(HERE, 'merged', code + '.json')))).toHaveLength(c.merged)
    }
  })

  it('gives every country with subdivisions an outline too', () => {
    // A country that has provinces but no outline draws nothing at all, and a
    // silent empty highlight is exactly the failure nobody reports. Natural
    // Earth omits a country file for several territories; build.mjs dissolves
    // their subdivisions instead, and this is what proves it did.
    for (const code of codesIn('admin1')) expect(countryShape(code), code).toBeTruthy()
  })

  it('holds together structurally in every file it wrote', { timeout: 60_000 }, () => {
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
    for (const code of codesIn('admin0')) check(read(join(HERE, 'admin0', code + '.json')).geometry, code)
    for (const code of codesIn('admin1'))
      for (const f of read(join(HERE, 'admin1', code + '.json'))) {
        if (!f.id || !f.parts?.length) faults.push(`${code}: ${f.name} has no identity`)
        check(f.geometry, f.id)
      }
    for (const code of codesIn('merged'))
      for (const [sig, f] of Object.entries(read(join(HERE, 'merged', code + '.json')))) {
        if (signature([f]) !== sig) faults.push(`${code}: ${sig} is filed under the wrong signature`)
        check(f.geometry, sig)
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
      const list = read(join(HERE, 'admin1', code + '.json'))
      for (const f of list) {
        const got = matchFeatures(list, [f.name]).matched[0]
        if (!got) wrong.push(`${code} ${f.name}: nothing`)
        else if (!got.names.some((n) => bare(n) === bare(f.name))) wrong.push(`${code} ${f.name} -> ${got.name}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('gives the Valencian Community all three of its provinces', () => {
    // It used to answer with Castellón alone: every province carries
    // "Comunidad Valenciana" among its own names, and the first one in the file
    // won. Near enough is the wrong answer here — one province of three, drawn
    // confidently, is worse than the honest whole-country fallback.
    const provinces = ['Castellón', 'Valencia', 'Alicante'].map((n) => regionShapes('ES', [n]).matched[0].id)
    const { matched } = regionShapes('ES', ['Comunidad Valenciana'])
    expect(matched).toHaveLength(1)
    expect([...matched[0].parts].sort()).toEqual([...provinces].sort())

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
    const parishes = read(join(HERE, 'admin1', 'BM.json')).filter((f) => !f.group)
    const bermuda = countryShape('BM')
    expect(bermuda.name).toBe('Bermuda')
    expect(index.countries.BM.synthesized).toBe(true)
    const sum = parishes.reduce((n, f) => n + area(f.geometry), 0)
    expect(area(bermuda.geometry)).toBeGreaterThan(sum * 0.95)
    expect(area(bermuda.geometry)).toBeLessThan(sum * 1.05)
  })

  it('says nothing rather than something wrong about a country it has no file for', () => {
    expect(countryShape('ZZ')).toBe(null)
    expect(countryShape('CX')).toBe(null)
    const { matched, missing } = regionShapes('ZZ', ['Anywhere'])
    expect(matched).toEqual([])
    expect(missing).toEqual(['Anywhere'])
  })
})

describe.skipIf(!existsSync(SRC))('against the Natural Earth source', () => {
  it('never moves a real coastline further than its own tolerance', () => {
    // The claim the whole module rests on, measured on the shapes it was
    // actually built from rather than on a curve chosen to be easy.
    const features = read(SRC).features.filter((f) => {
      const n = ringsOf(f.geometry).reduce((m, r) => m + r.length, 0)
      return n > 500 && n < 8000
    })
    expect(features.length).toBeGreaterThan(20)
    for (const f of features.slice(0, 25)) {
      const tol = featureTol(f.geometry)
      const slack = Math.SQRT2 * 10 ** -precisionFor(tol) // coordinates are rounded after simplifying
      for (const r of ringsOf(f.geometry)) {
        const s = simplifyRing(r, tol)
        if (s.length < 4) continue // too small to keep: becomes its own bounding box
        expect(maxDeviation(r, s), f.properties.NAME).toBeLessThanOrEqual(tol)
      }
      const out = simplify(f.geometry)
      const orig = ringsOf(f.geometry)
      const flat = ringsOf(out).flat()
      expect(maxDeviation(orig.flat().filter((_, i) => i % 7 === 0), flat)).toBeLessThan(tol * 3 + slack)
      expect(signedArea(ringsOf(out)[0])).not.toBe(0)
    }
  })
})
