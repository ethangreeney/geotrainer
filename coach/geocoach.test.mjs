import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The userscript is browser source with no build step and no exports, so it
 * cannot be imported — but it is also the one part of the system that never
 * runs on this machine, which makes a copy-paste test worthless. So both files
 * are read and executed as shipped: the loader whole, under stub globals, and
 * the body's scope-overlay section sliced out and given its dependencies as
 * function parameters. Anything that drifts out of that section, or renames its
 * markers, fails the slice test below rather than quietly testing nothing.
 */
const read = (name) => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8')
const loaderSrc = read('geocoach.loader.js')
const bodySrc = read('geocoach.user.js')

const SECTION_START = '  // -------------------------------------------------------- scope overlay'
const SECTION_END = '  function removeCard() {'
const startAt = bodySrc.indexOf(SECTION_START)
const endAt = bodySrc.indexOf(SECTION_END)
const sliceOk = startAt >= 0 && endAt > startAt
const section = sliceOk ? bodySrc.slice(startAt, endAt) : ''

/** The section's own top-level names, handed back for the tests to drive. */
const EXPORTS = `;return { fetchScopeGeo, scopeKey, ensureMapCapture, pickResultMap, scopeBounds,
  widenIfOffscreen, paintScope, drawScopeOverlay, removeScopeOverlay, layers: () => scopeLayers }`

/** The loader, run against a stub window. Its body fetch never calls back. */
function runLoader(W) {
  const console = { log() {}, warn() {}, error() {} }
  new Function('unsafeWindow', 'GM_xmlhttpRequest', 'console', loaderSrc)(W, () => {}, console)
  return W
}

const ONTARIO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Ontario' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-95, 41], [-74, 41], [-74, 57], [-95, 57], [-95, 41]]],
      },
    },
  ],
}
const PAYLOAD = { ok: true, kind: 'region', country: 'CA', label: 'Ontario, Canada', names: ['Ontario'], geojson: ONTARIO }
const SCOPE = { country: 'CA', regions: ['Ontario'] }

/**
 * One page's worth of stubs: a Maps API with the two classes the overlay
 * touches, one result-map-sized map, and a GM_xmlhttpRequest whose reply is
 * whatever the test says it is. `reply` returns a response object, or the
 * string 'error'/'timeout' to take those callbacks instead.
 */
function makeEnv({ payload = PAYLOAD, reply, pathname = '/results/xyz', viewport = null } = {}) {
  if (!sliceOk) throw new Error('scope-overlay section not found in geocoach.user.js')
  const dataLayers = []
  const fitCalls = []
  const requests = []
  const tlogLines = []
  class Data {
    constructor(o) {
      this.map = o.map
      this.styles = []
      this.geo = []
      dataLayers.push(this)
    }
    setStyle(s) {
      this.styles.push(s)
    }
    addGeoJson(g) {
      this.geo.push(g)
    }
    setMap(m) {
      this.map = m
    }
  }
  class LatLngBounds {
    constructor() {
      this.pts = []
    }
    extend(p) {
      this.pts.push(p)
      return this
    }
  }
  const div = { isConnected: true, getBoundingClientRect: () => ({ width: 900, height: 600 }) }
  const map = {
    getDiv: () => div,
    fitBounds: (...args) => fitCalls.push(args),
    getBounds: () => viewport,
  }
  const W = { google: { maps: { Data, LatLngBounds, Map: class {} } }, __geocoachMaps: [map] }
  const answer = reply || (() => ({ status: 200, responseText: JSON.stringify(payload) }))
  const GM_xmlhttpRequest = (req) => {
    requests.push(req)
    setTimeout(() => {
      const r = answer(req)
      if (r === 'error') req.onerror?.()
      else if (r === 'timeout') req.ontimeout?.()
      else req.onload?.(r)
    }, 0)
  }
  const api = new Function(
    'W',
    'LOCAL',
    'tlog',
    'GM_xmlhttpRequest',
    'document',
    'location',
    'requestAnimationFrame',
    'fetch',
    section + EXPORTS,
  )(
    W,
    'http://127.0.0.1:5177',
    (line) => tlogLines.push(line),
    GM_xmlhttpRequest,
    { getElementById: () => null },
    { pathname },
    (fn) => setTimeout(fn, 16),
    () => Promise.reject(new Error('mixed content')),
  )
  return { api, W, map, div, dataLayers, fitCalls, requests, tlogLines }
}

const urlsOf = (env) => env.requests.map((r) => r.url)
const styleOf = (layer) => layer.styles[layer.styles.length - 1]
/** Lets the GM reply land, the map be found, and the fade run to completion. */
const settle = () => vi.advanceTimersByTimeAsync(500)

// Fake timers throughout: the overlay waits on a network reply, polls for a
// map that may not be mounted yet, and fades over 320ms. Real waits would make
// the suite slow and flaky for no extra coverage.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('test setup', () => {
  it('finds the scope-overlay section in the shipped body', () => {
    expect(startAt, 'section start marker missing from geocoach.user.js').toBeGreaterThanOrEqual(0)
    expect(endAt, 'section end marker (removeCard) missing or above the start').toBeGreaterThan(startAt)
    expect(section).toContain('function drawScopeOverlay')
  })
})

describe('loader map capture', () => {
  it('wraps a Map constructor that already exists', () => {
    const W = {}
    class RealMap {
      constructor(div) {
        this.div = div
      }
    }
    W.google = { maps: { Map: RealMap } }
    runLoader(W)
    const m = new W.google.maps.Map({ id: 'a' })
    expect(W.__geocoachMaps).toEqual([m])
    expect(m.div).toEqual({ id: 'a' })
  })

  it('keeps instanceof and subclassing intact', () => {
    const W = {}
    class RealMap {
      constructor(div) {
        this.div = div
      }
    }
    W.google = { maps: { Map: RealMap } }
    runLoader(W)
    const m = new W.google.maps.Map({ id: 'a' })
    expect(m).toBeInstanceOf(RealMap)
    expect(m).toBeInstanceOf(W.google.maps.Map)
    class Sub extends W.google.maps.Map {
      hello() {
        return 'hi'
      }
    }
    const s = new Sub({ id: 'b' })
    expect(s).toBeInstanceOf(Sub)
    expect(s.hello()).toBe('hi')
    expect(W.__geocoachMaps).toEqual([m, s])
  })

  it('captures a namespace that arrives after the loader ran', () => {
    const W = {}
    runLoader(W)
    expect(W.google).toBeUndefined()
    // Exactly how the Maps bootstrap does it.
    const g = W.google || (W.google = {})
    expect(W.google).toBe(g)
    class RealMap {}
    W.google.maps = {}
    W.google.maps.Map = RealMap
    const m = new W.google.maps.Map()
    expect(m).toBeInstanceOf(RealMap)
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('captures when google exists but google.maps lands later', () => {
    const W = { google: {} }
    runLoader(W)
    class RealMap {}
    W.google.maps = { Map: RealMap }
    const m = new W.google.maps.Map()
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('caps the buffer so a long session cannot grow it forever', () => {
    const W = { google: { maps: { Map: class {} } } }
    runLoader(W)
    const built = []
    for (let i = 0; i < 30; i++) built.push(new W.google.maps.Map())
    expect(W.__geocoachMaps).toHaveLength(20)
    expect(W.__geocoachMaps[19]).toBe(built[29]) // the newest survives, the oldest go
  })
})

describe('loader importLibrary capture', () => {
  it('captures a page that only ever destructures Map out of importLibrary', async () => {
    const W = {}
    runLoader(W)
    class RealMap {}
    W.google = {}
    W.google.maps = { importLibrary: () => Promise.resolve({ Map: RealMap }) }
    const { Map } = await W.google.maps.importLibrary('maps')
    const m = new Map()
    expect(m).toBeInstanceOf(RealMap)
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('buffers one instance when both paths hand out the same constructor', async () => {
    const W = {}
    runLoader(W)
    class RealMap {}
    W.google = {}
    W.google.maps = { Map: RealMap, importLibrary: () => Promise.resolve({ Map: RealMap }) }
    const lib = await W.google.maps.importLibrary('maps')
    // One constructor reached twice must yield one proxy, or every map built
    // through it would be buffered once per wrapping layer.
    expect(lib.Map).toBe(W.google.maps.Map)
    const m = new lib.Map()
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('hooks importLibrary attached a tick after the namespace lands', async () => {
    const W = {}
    runLoader(W)
    class RealMap {}
    W.google = {}
    W.google.maps = {} // no importLibrary on it yet
    W.google.maps.importLibrary = () => Promise.resolve({ Map: RealMap })
    await vi.advanceTimersByTimeAsync(0) // the loader's one late re-check
    const { Map } = await W.google.maps.importLibrary('maps')
    const m = new Map()
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('hooks importLibrary attached late even when google.maps predates the loader', async () => {
    // The mirror of the test above: here the namespace is already in place at
    // document-start and only importLibrary arrives afterwards, so the late
    // re-check has to belong to hookMaps rather than to the google.maps setter.
    const W = { google: { maps: {} } }
    runLoader(W)
    class RealMap {}
    W.google.maps.importLibrary = () => Promise.resolve({ Map: RealMap })
    await vi.advanceTimersByTimeAsync(0)
    const { Map } = await W.google.maps.importLibrary('maps')
    const m = new Map()
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('passes a rejection straight through', async () => {
    const W = {}
    runLoader(W)
    W.google = {}
    W.google.maps = { importLibrary: () => Promise.reject(new Error('library unavailable')) }
    await expect(W.google.maps.importLibrary('maps')).rejects.toThrow('library unavailable')
    expect(W.__geocoachMaps).toEqual([])
  })

  it('passes a non-promise return value straight through', () => {
    const W = {}
    runLoader(W)
    W.google = {}
    W.google.maps = { importLibrary: () => 'not a promise' }
    expect(W.google.maps.importLibrary('maps')).toBe('not a promise')
  })

  it('leaves a library object without a Map alone', async () => {
    const W = {}
    runLoader(W)
    const lib = { Marker: class {} }
    W.google = {}
    W.google.maps = { importLibrary: () => Promise.resolve(lib) }
    await expect(W.google.maps.importLibrary('marker')).resolves.toBe(lib)
    expect(W.__geocoachMaps).toEqual([])
  })
})

describe('ensureMapCapture', () => {
  it('wraps the constructor for a body with no loader behind it', () => {
    const env = makeEnv()
    class RealMap {}
    env.W.google.maps.Map = RealMap
    env.W.__geocoachMaps = []
    env.api.ensureMapCapture()
    const m = new env.W.google.maps.Map()
    expect(m).toBeInstanceOf(RealMap)
    expect(env.W.__geocoachMaps).toEqual([m])
  })

  it('wraps importLibrary too', async () => {
    const env = makeEnv()
    class RealMap {}
    env.W.google.maps.importLibrary = () => Promise.resolve({ Map: RealMap })
    env.W.__geocoachMaps = []
    env.api.ensureMapCapture()
    const { Map } = await env.W.google.maps.importLibrary('maps')
    const m = new Map()
    expect(env.W.__geocoachMaps).toEqual([m])
  })

  it('stays idempotent on its own', () => {
    const env = makeEnv()
    class RealMap {}
    env.W.google.maps.Map = RealMap
    env.W.google.maps.importLibrary = () => Promise.resolve({})
    env.W.__geocoachMaps = []
    env.api.ensureMapCapture()
    const wrappedCtor = env.W.google.maps.Map
    const wrappedLoader = env.W.google.maps.importLibrary
    env.api.ensureMapCapture()
    expect(env.W.google.maps.Map).toBe(wrappedCtor)
    expect(env.W.google.maps.importLibrary).toBe(wrappedLoader)
    const m = new env.W.google.maps.Map()
    expect(env.W.__geocoachMaps).toEqual([m])
  })

  it('re-arms a hot-reloaded body without double-buffering the loader wrap', () => {
    // The loader hooks at document-start; a body reloaded mid-session then
    // runs ensureMapCapture over a namespace that is already wrapped. Both
    // share one registry, so this must be a no-op rather than a second layer.
    const W = {}
    runLoader(W)
    class RealMap {}
    W.google = {}
    W.google.maps = { Map: RealMap }
    const afterLoader = W.google.maps.Map
    const env = makeEnv()
    // Loader and body share one window (both hold unsafeWindow), which is what
    // lets the body recognise a constructor the loader already wrapped.
    Object.assign(env.W, W)
    env.api.ensureMapCapture()
    expect(W.google.maps.Map).toBe(afterLoader)
    const m = new W.google.maps.Map()
    expect(W.__geocoachMaps).toEqual([m])
  })

  it('does nothing when there is no Maps API at all', () => {
    const env = makeEnv()
    delete env.W.google
    expect(() => env.api.ensureMapCapture()).not.toThrow()
  })
})

describe('scope-geo request', () => {
  it('pipe-joins regions and percent-encodes them', () => {
    const env = makeEnv()
    env.api.fetchScopeGeo({ country: 'CA', regions: ['Ontario', 'Quebec'] }).catch(() => {})
    env.api.fetchScopeGeo({ country: 'ES', regions: ['Cataluña'] }).catch(() => {})
    env.api.fetchScopeGeo({ country: 'ID', regions: ['Nusa Tenggara Timur'] }).catch(() => {})
    expect(urlsOf(env)).toEqual([
      'http://127.0.0.1:5177/api/scope-geo?country=CA&regions=Ontario%7CQuebec',
      'http://127.0.0.1:5177/api/scope-geo?country=ES&regions=Catalu%C3%B1a',
      'http://127.0.0.1:5177/api/scope-geo?country=ID&regions=Nusa%20Tenggara%20Timur',
    ])
  })

  it('omits the regions parameter for a countrywide meta', () => {
    const env = makeEnv()
    env.api.fetchScopeGeo({ country: 'SE', regions: null }).catch(() => {})
    env.api.fetchScopeGeo({ country: 'SE', regions: [] }).catch(() => {})
    expect(urlsOf(env)).toEqual([
      'http://127.0.0.1:5177/api/scope-geo?country=SE',
      'http://127.0.0.1:5177/api/scope-geo?country=SE',
    ])
  })

  it('goes over GM_xmlhttpRequest, because the LAN server is http and the page https', () => {
    const env = makeEnv()
    env.api.fetchScopeGeo(SCOPE).catch(() => {})
    expect(env.requests).toHaveLength(1)
    expect(env.requests[0]).toMatchObject({ method: 'GET' })
    expect(env.requests[0].timeout).toBeGreaterThan(0)
  })
})

describe('drawing the scope', () => {
  it('draws the shape on its own layers, on the visible map', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(2)
    for (const layer of env.dataLayers) {
      expect(layer.map).toBe(env.map)
      expect(layer.geo).toEqual([ONTARIO])
    }
    expect(env.map.data).toBeUndefined() // GeoGuessr's own layer is never touched
    expect(env.api.layers()).toHaveLength(2)
  })

  it('styles the layers before the features land, so there is no default-blue frame', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await vi.advanceTimersByTimeAsync(1)
    for (const layer of env.dataLayers) {
      expect(layer.styles.length).toBeGreaterThanOrEqual(1)
      expect(layer.styles[0].strokeOpacity).toBe(0)
      expect(layer.geo).toHaveLength(1)
    }
  })

  it('fades up to the card palette over several frames', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    const [glow, main] = env.dataLayers
    expect(main.styles.length).toBeGreaterThan(3)
    expect(styleOf(main)).toMatchObject({
      strokeColor: '#2b1b58',
      fillColor: '#2b1b58',
      strokeOpacity: 0.95,
      strokeWeight: 2,
    })
    expect(styleOf(main).fillOpacity).toBeCloseTo(0.14, 10)
    // Light enough that the guess and answer pins stay readable through it.
    expect(styleOf(main).fillOpacity).toBeLessThan(0.2)
    expect(styleOf(glow)).toMatchObject({ strokeColor: '#a99fce', fillOpacity: 0 })
    expect(styleOf(glow).strokeWeight).toBeGreaterThan(styleOf(main).strokeWeight)
    expect(styleOf(glow).zIndex).toBeLessThan(styleOf(main).zIndex)
  })

  it('never swallows a click meant for the map', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    for (const layer of env.dataLayers) for (const s of layer.styles) expect(s.clickable).toBe(false)
  })

  it('waits for a result map that mounts a beat after the card', async () => {
    const env = makeEnv()
    const map = env.W.__geocoachMaps[0]
    env.W.__geocoachMaps = []
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await vi.advanceTimersByTimeAsync(100)
    expect(env.dataLayers).toHaveLength(0)
    env.W.__geocoachMaps = [map]
    await settle()
    expect(env.dataLayers).toHaveLength(2)
  })

  it('gives up quietly if no map ever appears', async () => {
    const env = makeEnv()
    env.W.__geocoachMaps = []
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(env.dataLayers).toHaveLength(0)
    expect(env.tlogLines.join(' ')).toMatch(/no visible map/)
  })

  it('reports what it drew to the timing log', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.tlogLines).toHaveLength(1)
    expect(env.tlogLines[0]).toContain('Ontario, Canada')
  })
})

describe('teardown', () => {
  it('removes the layers from the map and drops them', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.api.removeScopeOverlay()
    expect(env.dataLayers.map((l) => l.map)).toEqual([null, null])
    expect(env.api.layers()).toEqual([])
  })

  it('cancels a draw whose geometry is still in flight', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    env.api.removeScopeOverlay() // what leaving the round triggers through removeCard
    await settle()
    expect(env.dataLayers).toHaveLength(0)
  })

  it('replaces the previous round’s shape rather than stacking on it', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.api.drawScopeOverlay({ roundId: 'r2', scope: { country: 'SE', regions: null } })
    await settle()
    expect(env.dataLayers).toHaveLength(4)
    expect(env.dataLayers.slice(0, 2).map((l) => l.map)).toEqual([null, null])
    expect(env.api.layers()).toHaveLength(2)
  })
})

describe('caching', () => {
  it('fetches a repeated meta once', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.api.drawScopeOverlay({ roundId: 'r2', scope: { country: 'CA', regions: ['Ontario'] } })
    await settle()
    expect(env.requests).toHaveLength(1)
    expect(env.dataLayers).toHaveLength(4) // and the second card still got its shape
    expect(env.dataLayers[3].geo).toEqual([ONTARIO])
  })

  it('treats a different region list as a different area', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: { country: 'CA', regions: ['Ontario'] } })
    await settle()
    env.api.drawScopeOverlay({ roundId: 'r2', scope: { country: 'CA', regions: ['Quebec'] } })
    await settle()
    expect(env.requests).toHaveLength(2)
  })

  it('does not cache a failure — the Mac may simply have been asleep', async () => {
    let asleep = true
    const env = makeEnv({ reply: () => (asleep ? 'error' : { status: 200, responseText: JSON.stringify(PAYLOAD) }) })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(0)
    asleep = false
    env.api.drawScopeOverlay({ roundId: 'r2', scope: SCOPE })
    await settle()
    expect(env.requests).toHaveLength(2)
    expect(env.dataLayers).toHaveLength(2)
  })
})

describe('failure is silent and total', () => {
  const cases = {
    'server unreachable': () => 'error',
    'request timed out': () => 'timeout',
    '404 with no boundary on file': () => ({ status: 404, responseText: JSON.stringify({ ok: false, error: 'no boundary' }) }),
    '503 from the server': () => ({ status: 503, responseText: JSON.stringify({ ok: false, error: 'busy' }) }),
    'malformed body': () => ({ status: 200, responseText: '<html>nope' }),
    'ok:true with no features': () => ({ status: 200, responseText: JSON.stringify({ ok: true, geojson: { type: 'FeatureCollection', features: [] } }) }),
    'ok:true with no geojson': () => ({ status: 200, responseText: JSON.stringify({ ok: true }) }),
  }
  for (const [name, reply] of Object.entries(cases)) {
    it(`draws nothing and throws nothing on ${name}`, async () => {
      const env = makeEnv({ reply })
      expect(() => env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })).not.toThrow()
      await settle()
      expect(env.dataLayers).toHaveLength(0)
      expect(env.api.layers()).toEqual([])
      expect(env.tlogLines).toHaveLength(1) // diagnosable, but never toasted
    })
  }

  it('asks for nothing when the card carries no scope', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', metaName: 'Sweden: yellow-topped poles' })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: { country: '', regions: null } })
    env.api.drawScopeOverlay(null)
    await settle()
    expect(env.requests).toHaveLength(0)
    expect(env.dataLayers).toHaveLength(0)
    expect(env.tlogLines).toEqual([]) // an older payload is not a fault
  })

  it('draws nothing on a Maps API with no Data class', async () => {
    const env = makeEnv()
    delete env.W.google.maps.Data
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.api.layers()).toEqual([])
  })
})

describe('ranked duels get no help', () => {
  for (const pathname of ['/duels/abc123', '/team-duels/abc123']) {
    it(`draws nothing on ${pathname}`, async () => {
      const env = makeEnv({ pathname })
      env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
      await settle()
      expect(env.requests).toHaveLength(0)
      expect(env.dataLayers).toHaveLength(0)
    })
  }
})

describe('choosing the map to draw on', () => {
  const stub = (width, height, isConnected = true) => ({
    getDiv: () => ({ isConnected, getBoundingClientRect: () => ({ width, height }) }),
  })

  it('picks the biggest one actually on screen', () => {
    const env = makeEnv()
    const detachedHuge = stub(2000, 2000, false)
    const miniMap = stub(300, 200)
    const resultMap = stub(1200, 800)
    const throws = {
      getDiv() {
        throw new Error('detached')
      },
    }
    env.W.__geocoachMaps = [detachedHuge, miniMap, throws, resultMap, { getDiv: () => null }]
    expect(env.api.pickResultMap()).toBe(resultMap)
  })

  it('ignores maps too small to be the result map', () => {
    const env = makeEnv()
    env.W.__geocoachMaps = [stub(120, 90), stub(300, 100)]
    expect(env.api.pickResultMap()).toBeNull()
  })

  it('answers null when nothing has been captured', () => {
    const env = makeEnv()
    env.W.__geocoachMaps = undefined
    expect(env.api.pickResultMap()).toBeNull()
  })
})

describe('bounds and the one-time widen', () => {
  const viewport = (s, w, n, e) => ({
    getSouthWest: () => ({ lat: () => s, lng: () => w }),
    getNorthEast: () => ({ lat: () => n, lng: () => e }),
  })
  const BOX = { n: 57, s: 41, e: -74, w: -95 }

  it('reads the bounding box off the raw coordinates', () => {
    expect(makeEnv().api.scopeBounds(ONTARIO)).toEqual(BOX)
  })

  it('answers null for geometry it cannot measure', () => {
    const { api } = makeEnv()
    expect(api.scopeBounds({ features: [] })).toBeNull()
    expect(api.scopeBounds({ features: [{ geometry: null }] })).toBeNull()
    expect(api.scopeBounds({})).toBeNull()
  })

  it('widens once when the shape is nowhere near the current view', () => {
    const env = makeEnv({ viewport: viewport(-40, 100, 0, 160) }) // an Australian framing
    env.api.widenIfOffscreen(env.map, BOX, 'r1:CA|Ontario')
    expect(env.fitCalls).toHaveLength(1)
    const [bounds, padding] = env.fitCalls[0]
    expect(padding).toBeGreaterThan(0)
    expect(bounds.pts).toContainEqual({ lat: 57, lng: -74 }) // the shape
    expect(bounds.pts).toContainEqual({ lat: -40, lng: 100 }) // and what was already framed
    env.api.widenIfOffscreen(env.map, BOX, 'r1:CA|Ontario')
    expect(env.fitCalls).toHaveLength(1)
  })

  it('leaves GeoGuessr’s framing alone when the shape is already visible', () => {
    const env = makeEnv({ viewport: viewport(35, -100, 60, -70) })
    env.api.widenIfOffscreen(env.map, BOX, 'k')
    expect(env.fitCalls).toEqual([])
  })

  it('leaves the framing alone before the map has settled', () => {
    const env = makeEnv({ viewport: null })
    env.api.widenIfOffscreen(env.map, BOX, 'k')
    expect(env.fitCalls).toEqual([])
  })

  it('never re-frames on a shape whose plain bbox spans the antimeridian', () => {
    const env = makeEnv({ viewport: viewport(-40, 100, 0, 160) })
    env.api.widenIfOffscreen(env.map, { n: 70, s: 40, e: 179, w: -179 }, 'k')
    expect(env.fitCalls).toEqual([])
  })

  it('may widen again for the next round', () => {
    const env = makeEnv({ viewport: viewport(-40, 100, 0, 160) })
    env.api.widenIfOffscreen(env.map, BOX, 'r1:CA|Ontario')
    env.api.widenIfOffscreen(env.map, BOX, 'r2:CA|Ontario')
    expect(env.fitCalls).toHaveLength(2)
  })
})
