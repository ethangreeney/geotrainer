/**
 * The overlay's geometry layer, the half that has to run in the Worker.
 *
 * Two things are being pinned here. The first is the behaviour the local
 * server had, case by case, because the whole point of moving this into a
 * shared module is that the overlay keeps drawing exactly what it drew when
 * the laptop was awake — a scope spanning three states as one shape, a scope
 * nothing answers to as the plain country, a country with no boundary as
 * nothing at all.
 *
 * The second is purity. outline.mjs is bundled into a Cloudflare Worker, where
 * a `node:fs` import is not a slow path but a deploy that fails, so the source
 * itself is checked. And its name keys are a copy of resolve.mjs's, so the two
 * are held side by side over every name in the built packs: drift between them
 * would not throw, it would quietly draw three shapes where one was meant.
 *
 * Like the rest of the boundary suite, the built half skips rather than fails
 * when the packs are absent — they are gitignored, and a fresh clone has none.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPack } from './locate.mjs'
import { merges } from './pack.mjs'
import { loadMergedPack, norm, scopeOutline } from './outline.mjs'
import { norm as normOnDisk } from './resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACK = join(HERE, 'pack')
const at = (name) => join(PACK, name)
const built = existsSync(at('admin0.bin')) && existsSync(at('admin1.bin')) && existsSync(at('merged.bin'))
const packs = built
  ? {
      country: loadPack(readFileSync(at('admin0.bin'))),
      region: loadPack(readFileSync(at('admin1.bin'))),
      merged: loadMergedPack(readFileSync(at('merged.bin'))),
    }
  : null

const outline = (country, regions) => scopeOutline(packs, { country, regions })
const counted = (r) => r.geojson.features.length

describe('scopeOutline', () => {
  /**
   * The round that prompted all of this: "Paraná pines", a meta scoped to the
   * three southern states. Drawn from its parts it shows a stroke along every
   * shared border — a line through the middle of the highlight, which reads as
   * a rendering fault. One feature is the whole answer.
   */
  it.runIf(built)('draws a three-state scope as one shape, not three', () => {
    const r = outline('BR', ['Paraná', 'Santa Catarina', 'Rio Grande do Sul'])
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('region')
    expect(r.label).toBe('Parana + Santa Catarina + Rio Grande do Sul, Brazil')
    expect(counted(r)).toBe(1)
  })

  it.runIf(built)('finds the same shape however the scope spells it', () => {
    const accented = outline('BR', ['Paraná', 'Santa Catarina', 'Rio Grande do Sul'])
    // The cards are written from whatever the geocoder returned, so the same
    // three states arrive with the accent, without it, and in any case.
    for (const spelling of [
      ['Parana', 'Santa Catarina', 'Rio Grande do Sul'],
      ['PARANÁ', 'santa catarina', 'Rio Grande Do Sul'],
      ['Estado do Parana', 'Santa Catharina', 'Rio Grande do Sul'],
    ]) {
      const r = outline('BR', spelling)
      expect(counted(r), spelling.join(' + ')).toBe(1)
      expect(r.label, spelling.join(' + ')).toBe(accented.label)
    }
  })

  /**
   * Several cards name one subdivision twice, in two languages, because that
   * is how the geocoder answered on two different rounds. Three names, two
   * subdivisions, and the merge that covers them has two parts — so the count
   * the merge is matched on has to be the subdivisions matched, not the names
   * asked for.
   */
  it.runIf(built)('counts a subdivision named twice as one', () => {
    const r = outline('BR', ['Goiás', 'Distrito Federal', 'Federal District'])
    expect(r.kind).toBe('region')
    expect(counted(r)).toBe(1)
    expect(r.names).toEqual(['Goias + Distrito Federal'])
  })

  it.runIf(built)('gives the country its own outline when nothing is scoped', () => {
    for (const regions of [undefined, [], ['']]) {
      const r = outline('BR', regions)
      expect(r.ok).toBe(true)
      expect(r.kind).toBe('country')
      expect(r.label).toBe('Brazil')
      expect(counted(r)).toBe(1)
    }
  })

  /**
   * A scope that resolves to nothing falls all the way back to the country.
   * Drawing the part of it that did match would put a border on the map that
   * the meta does not have, and a wrong border teaches something wrong; a
   * whole country is merely vague.
   */
  it.runIf(built)('falls back to the whole country when no name matches', () => {
    const r = outline('BR', ['Atlantis', 'Westeros'])
    expect(r.kind).toBe('country')
    expect(r.label).toBe('Brazil')
    expect(counted(r)).toBe(1)
  })

  it.runIf(built)('has no shape at all for a country with no boundary on file', () => {
    // ZZ is what a failed geocode asks for, and CC is a real country code the
    // sources between them draw nothing for — Natural Earth files the Cocos
    // Islands under an uncoded administration and geoBoundaries has no CCK.
    // Both are "no overlay", not "try again".
    for (const code of ['ZZ', '', 'CC']) {
      const r = outline(code, ['anything'])
      expect(r.ok, code).toBe(false)
      expect(r.kind, code).toBe('none')
      expect(r.error, code).toMatch(/no boundary on file/)
    }
  })

  it.runIf(built)('draws each subdivision separately where no merge was built', () => {
    // Two states no card scopes together, so build.mjs never dissolved them.
    // Internal borders will show, which is the honest answer: the alternative
    // is dissolving on the fly, and the geometry to do it with is gone by now.
    const r = outline('BR', ['Mato Grosso', 'Roraima'])
    expect(r.kind).toBe('region')
    expect(counted(r)).toBe(2)
    expect(r.label).toBe('Mato Grosso, Roraima, Brazil')
  })

  it.runIf(built)('names only the first three, then counts the rest', () => {
    // Five states, no merge for that set: the label is a label, not a list.
    const r = outline('BR', ['Mato Grosso', 'Roraima', 'Amazonas', 'Amapa', 'Para'])
    expect(counted(r)).toBe(5)
    expect(r.label).toBe('Mato Grosso, Roraima, Amazonas +2 more, Brazil')
  })

  it.runIf(built)('answers with coordinates, in degrees, closed and in range', () => {
    const places = 10 ** Math.ceil(Math.log10(packs.merged.scale))
    const r = outline('BR', ['Paraná', 'Santa Catarina', 'Rio Grande do Sul'])
    const g = r.geojson.features[0].geometry
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    for (const rings of polygons)
      for (const ring of rings) {
        expect(ring.length).toBeGreaterThan(3)
        expect(ring[0]).toEqual(ring[ring.length - 1])
        for (const [lng, lat] of ring) {
          expect(Math.abs(lng)).toBeLessThanOrEqual(180)
          expect(Math.abs(lat)).toBeLessThanOrEqual(90)
          // Coordinates carry exactly the decimals the pack's own grid can
          // express and no more, whatever that grid is set to; claiming more
          // would be invention.
          expect(Math.round(lng * places) / places).toBe(lng)
          expect(Math.round(lat * places) / places).toBe(lat)
        }
      }
    // Southern Brazil, and nowhere near anywhere else.
    const pts = polygons.flat().flat()
    expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThan(-34)
    expect(Math.max(...pts.map((p) => p[1]))).toBeLessThan(-22)
  })
})

describe('loadMergedPack', () => {
  // What pack.mjs packs, not what any one rung holds: each shape is packed at
  // the finest rung it fits the budget at, so there is no single directory on
  // disk the pack can be held against any more.
  const source = built ? merges() : []

  /** Every dissolved shape build.mjs wrote, back out of the pack with the same
   * polygons, the same rings and the same vertices — within the grid it was
   * quantised onto, which is the only precision the pack ever claimed. */
  it.runIf(source.length > 0)('round-trips every shape pack.mjs wrote', () => {
    const grid = 0.5 / packs.merged.scale
    let checked = 0
    for (const { meta, geometry } of source) {
      const got = (packs.merged.byCountry.get(meta.code) ?? []).find((m) => m.name === meta.name)
      expect(got, `${meta.code} ${meta.name}`).toBeTruthy()
      // The names it covers are the lookup key, and they are stored already
      // normalised — one per part, in the order build.mjs dissolved them.
      expect(got.keys).toEqual(meta.names)
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
      expect(got.polygons.length, `${meta.code} ${meta.name}`).toBe(polygons.length)
      polygons.forEach((rings, p) => {
        expect(got.polygons[p].rings.length).toBe(rings.length)
        rings.forEach((ring, k) => {
          const { xs, ys } = got.polygons[p].rings[k]
          expect(xs.length).toBe(ring.length)
          for (let i = 0; i < ring.length; i++) {
            expect(Math.abs(xs[i] / packs.merged.scale - ring[i][0])).toBeLessThanOrEqual(grid)
            expect(Math.abs(ys[i] / packs.merged.scale - ring[i][1])).toBeLessThanOrEqual(grid)
          }
        })
      })
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it.runIf(built)('keeps every merge findable by the country it belongs to', () => {
    expect(packs.merged.merges.length).toBeGreaterThan(0)
    for (const merge of packs.merged.merges) {
      expect(packs.merged.byCountry.get(merge.code)).toContain(merge)
      // A merge with fewer than two parts is a subdivision, and would shadow
      // the subdivision's own shape.
      expect(merge.keys.length, merge.name).toBeGreaterThan(1)
      expect(merge.polygons.length, merge.name).toBeGreaterThan(0)
    }
  })
})

/**
 * outline.mjs is bundled into the Worker, so anything that reaches for the
 * filesystem is not a slow path — it is a deploy that fails. Cheap to check
 * from here, and it fails at the moment the import is added rather than at the
 * moment someone deploys.
 */
describe('running in the Worker', () => {
  const source = readFileSync(join(HERE, 'outline.mjs'), 'utf8')

  it('imports nothing a Worker does not have', () => {
    expect(source).not.toMatch(/from\s*'node:/)
    expect(source).not.toMatch(/require\(/)
    // No bundled JSON either: the packs arrive as bytes from the caller.
    expect(source).not.toMatch(/with\s*\{\s*type:\s*'json'\s*\}/)
    // Only locate.mjs, which is pure for the same reason.
    expect([...source.matchAll(/from\s*'([^']+)'/g)].map((m) => m[1])).toEqual(['./locate.mjs'])
  })

  /** The name keys are copied from resolve.mjs rather than imported, because
   * that module reads the slices off disk. Copies drift; this is the check
   * that they have not, run over every name the packs actually carry — the
   * merged pack's keys are written by resolve.mjs's norm at pack time and read
   * by outline.mjs's at query time, so a disagreement is a scope that stops
   * finding its dissolved shape. */
  it.runIf(built)('keys names exactly as the on-disk resolver does', () => {
    const names = new Set(['', 'Paraná', 'Federal District', 'Jeju-do', 'Balears, Illes', 'Catalunya [Cataluña]'])
    for (const f of [...packs.region.features, ...packs.country.features]) for (const n of f.names) names.add(n)
    for (const merge of packs.merged.merges) names.add(merge.name)
    const drifted = [...names].filter((n) => norm(n) !== normOnDisk(n))
    expect(drifted, 'names the two normalisers disagree about').toEqual([])
  })
})
