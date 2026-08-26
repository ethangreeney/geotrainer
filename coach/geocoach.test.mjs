import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The userscript is browser source with no build step and no exports, so it
 * cannot be imported — but it is also the one part of the system that never
 * runs on this machine, which makes a copy-paste test worthless. So both files
 * are read and executed as shipped: the loader whole, under stub globals, and
 * three of the body's sections sliced out and given their dependencies as
 * function parameters. Anything that drifts out of a section, or renames its
 * markers, fails the slice tests below rather than quietly testing nothing.
 */
const read = (name) => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8')
const loaderSrc = read('geocoach.loader.js')
const bodySrc = read('geocoach.user.js')

/** Marked-out region of the body, start marker included, end marker excluded. */
const cut = (from, to) => {
  const a = bodySrc.indexOf(from)
  const b = bodySrc.indexOf(to)
  return { ok: a >= 0 && b > a, at: a, to: b, src: a >= 0 && b > a ? bodySrc.slice(a, b) : '' }
}

// The shared GET client — GEO_SOURCES, serverGet, geoGet — which the overlay
// now goes through, so it is prepended to that slice rather than stubbed: which
// machine answers, in what order, is the whole point of the thing.
const CLIENT_START = "  // ---------------------------------------------------- the coach's servers"
const SECTION_START = '  // -------------------------------------------------------- scope overlay'
const SECTION_END = '  function removeCard() {'
const client = cut(CLIENT_START, SECTION_START)
const overlay = cut(SECTION_START, SECTION_END)
const startAt = overlay.at
const endAt = overlay.to
const sliceOk = client.ok && overlay.ok
const section = sliceOk ? client.src + overlay.src : ''

// The gate that holds game creation until the deck is republished. Sliced up to
// its own install call, which is left out: it names rebuildSilently, which lives
// in the deck section and would be an undefined reference here.
const JIT_START = '  // ------------------------------------------------- the deck, just in time'
const JIT_END = '  installRequestGate(W, '
const jit = cut(JIT_START, JIT_END)
const JIT_EXPORTS = ';return { isGameCreate, installRequestGate, holdForRebuild, JIT_BUDGET_MS }'

/**
 * The gate, run as shipped over a stub window whose fetch records calls and
 * never resolves on its own. `rebuild` is what the gate is told to wait for.
 */
function makeGate({ rebuild = () => Promise.resolve(), install = true } = {}) {
  if (!jit.ok) throw new Error('just-in-time section not found in geocoach.user.js')
  const calls = []
  const tlogLines = []
  const fetched = []
  const sent = []
  // A page's XMLHttpRequest, near enough: it remembers what it was opened with
  // and records the moment it is actually put on the wire.
  class XHR {
    open(method, url, async) {
      this.method = method
      this.url = url
      this.async = async
    }
    send(body) {
      sent.push({ method: this.method, url: this.url, body })
    }
  }
  const W = {
    XMLHttpRequest: XHR,
    fetch: function (input, opts) {
      fetched.push({ input, opts, self: this })
      return Promise.resolve({ ok: true, input })
    },
  }
  const api = new Function('tlog', jit.src + JIT_EXPORTS)((line) => tlogLines.push(line))
  const hold = (...args) => {
    calls.push(args)
    return rebuild()
  }
  const gate = install ? api.installRequestGate(W, hold) : null
  return { api, W, XHR, gate, hold, calls, fetched, sent, tlogLines }
}

/** A promise the test settles by hand, so a rebuild can be made to take as
 * long as the test needs it to. */
function deferred() {
  let settle
  const promise = new Promise((resolve, reject) => (settle = { resolve, reject }))
  return { promise, ...settle }
}

/** Let every pending microtask run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)

/** The section's own top-level names, handed back for the tests to drive. */
const EXPORTS = `;return { fetchScopeGeo, warmScopeGeo, scopeKey, ensureMapCapture, pickResultMap,
  paintScope, drawScopeOverlay, removeScopeOverlay, layers: () => scopeLayers,
  lodForZoom, scopeWeights, boxOfBounds, countPoints,
  boxCovers, boxParam, viewBox, padBox,
  scopeStoreGet, scopeStorePut }`

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

const LOCAL = 'http://127.0.0.1:5177'
const CLOUD_BASE = 'https://geofsrs.example.dev'

/**
 * One page's worth of stubs: a Maps API with the two classes the overlay
 * touches, one result-map-sized map, and a GM_xmlhttpRequest whose reply is
 * whatever the test says it is. `reply` returns a response object, or the
 * string 'error'/'timeout' to take those callbacks instead.
 *
 * `cloud` is off by default so the bulk of the suite keeps describing the
 * laptop-only install; the tests that care about which machine is asked first
 * turn it on.
 */
function makeEnv({
  payload = PAYLOAD,
  reply,
  pathname = '/results/xyz',
  viewport = null,
  zoom = 4,
  quota = Infinity,
  cloud = null,
} = {}) {
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
  /** Google's bounds object accumulates points and reports the corners; the
   * overlay both builds one (to widen a fitBounds) and reads one back out. */
  class LatLngBounds {
    constructor() {
      this.pts = []
    }
    extend(p) {
      this.pts.push(p)
      return this
    }
    getSouthWest() {
      const s = Math.min(...this.pts.map((p) => p.lat))
      const w = Math.min(...this.pts.map((p) => p.lng))
      return { lat: () => s, lng: () => w }
    }
    getNorthEast() {
      const n = Math.max(...this.pts.map((p) => p.lat))
      const e = Math.max(...this.pts.map((p) => p.lng))
      return { lat: () => n, lng: () => e }
    }
  }
  const divListeners = {}
  const div = {
    isConnected: true,
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    addEventListener: (ev, fn) => ((divListeners[ev] ||= []).push(fn)),
  }
  const listeners = {}
  let view = viewport
  const cam = { zoom, center: { lat: 0, lng: 0 } }
  const map = {
    getDiv: () => div,
    fitBounds: (...args) => fitCalls.push(args),
    getBounds: () => view,
    getZoom: () => cam.zoom,
    setZoom: (z) => (cam.zoom = z),
    getCenter: () => ({ lat: () => cam.center.lat, lng: () => cam.center.lng }),
    setCenter: (c) => (cam.center = c),
    addListener: (ev, fn) => {
      ;(listeners[ev] ||= []).push(fn)
      return { remove: () => (listeners[ev] = listeners[ev].filter((f) => f !== fn)) }
    },
  }
  const fire = (ev) => (listeners[ev] || []).forEach((f) => f())
  const fireDiv = (ev) => (divListeners[ev] || []).forEach((f) => f())
  /** Zooming the way the user does: the value changes, then the map says so. */
  const zoomTo = (z) => {
    cam.zoom = z
    fire('zoom_changed')
  }
  // A localStorage that behaves like the real one where it matters: string
  // values, and a quota that throws once the tests want to see eviction.
  const cells = new Map()
  const localStorage = {
    getItem: (k) => (cells.has(k) ? cells.get(k) : null),
    removeItem: (k) => cells.delete(k),
    setItem(k, v) {
      const other = [...cells].reduce((n, [kk, vv]) => (kk === k ? n : n + kk.length + vv.length), 0)
      if (other + k.length + String(v).length > quota) throw new Error('QuotaExceededError')
      cells.set(k, String(v))
    },
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
  const seenOnce = new Set()
  const CLOUD = cloud ? { url: CLOUD_BASE, token: 'tok' } : null
  const api = new Function(
    'W',
    'LOCAL',
    'CLOUD',
    'AUTH_HEADERS',
    'tlog',
    'tlogOnce',
    'GM_xmlhttpRequest',
    'document',
    'location',
    'localStorage',
    'requestAnimationFrame',
    'fetch',
    section + EXPORTS,
  )(
    W,
    LOCAL,
    CLOUD,
    CLOUD ? { Authorization: 'Bearer ' + CLOUD.token } : {},
    (line) => tlogLines.push(line),
    (key, line) => {
      if (seenOnce.has(key)) return
      seenOnce.add(key)
      tlogLines.push(line)
    },
    GM_xmlhttpRequest,
    { getElementById: () => null },
    { pathname },
    localStorage,
    (fn) => setTimeout(fn, 16),
    () => Promise.reject(new Error('mixed content')),
  )
  /** Panning: the bounds change, then the map settles and says so. */
  const panTo = (b) => {
    view = b
    fire('idle')
  }
  return { api, W, map, div, cam, cells, dataLayers, fitCalls, requests, tlogLines, fire, fireDiv, zoomTo, panTo }
}

const urlsOf = (env) => env.requests.map((r) => r.url)
const styleOf = (layer) => layer.styles[layer.styles.length - 1]
/** Lets the GM reply land, the map be found, and the fade run to completion. */
const settle = () => vi.advanceTimersByTimeAsync(500)
/** The same, plus the 600ms framing tween — so a test that drives the camera
 * afterwards is not fighting the one move the overlay makes on arrival. */
const arrive = () => vi.advanceTimersByTimeAsync(1200)

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

  it('finds the shared server client, and runs the overlay through it', () => {
    expect(client.ok, "the coach's-servers marker moved or vanished").toBe(true)
    expect(client.src).toContain('const GEO_SOURCES')
    expect(client.src).toContain('function serverGet')
    expect(client.src).toContain('function geoGet')
    // Two clients is how the overlay ended up LAN-only in the first place.
    expect(overlay.src).not.toContain('GM_xmlhttpRequest({')
  })

  it('finds the just-in-time section, and leaves its install call out of the slice', () => {
    expect(jit.ok, 'just-in-time markers moved or vanished').toBe(true)
    expect(jit.src).toContain('function installRequestGate')
    expect(jit.src).not.toContain('rebuildSilently')
  })

  it('logs the same version it declares', () => {
    // The "body X up" line is the only thing that says which body a machine we
    // are not sitting at is running, and it drifted once already.
    const body = read('geocoach.user.js')
    const declared = body.match(/@version\s+([\d.]+)/)
    const logged = body.match(/const BODY_VERSION = '([\d.]+)'/)
    expect(declared, '@version missing').toBeTruthy()
    expect(logged, 'BODY_VERSION missing').toBeTruthy()
    expect(logged[1]).toBe(declared[1])
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
      'http://127.0.0.1:5177/api/scope-geo?country=CA&regions=Ontario%7CQuebec&lod=0',
      'http://127.0.0.1:5177/api/scope-geo?country=ES&regions=Catalu%C3%B1a&lod=0',
      'http://127.0.0.1:5177/api/scope-geo?country=ID&regions=Nusa%20Tenggara%20Timur&lod=0',
    ])
  })

  it('omits the regions parameter for a countrywide meta', () => {
    const env = makeEnv()
    env.api.fetchScopeGeo({ country: 'SE', regions: null }).catch(() => {})
    env.api.fetchScopeGeo({ country: 'SE', regions: [] }).catch(() => {})
    expect(urlsOf(env)).toEqual([
      'http://127.0.0.1:5177/api/scope-geo?country=SE&lod=0',
      'http://127.0.0.1:5177/api/scope-geo?country=SE&lod=0',
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

// The Brazil round: the Mac was asleep, the overlay asked it anyway, and
// neither the sub-region nor the country drew. The cloud holds the same packs
// and is always awake, so it is asked first and the laptop is the fallback.
describe('which machine is asked', () => {
  const cloudEnv = (opts = {}) => makeEnv({ cloud: true, ...opts })
  const isCloud = (u) => u.startsWith(CLOUD_BASE)

  it('asks the cloud first, and stops there when it answers', async () => {
    const env = cloudEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(urlsOf(env)).toEqual([CLOUD_BASE + '/api/scope-geo?country=CA&regions=Ontario&lod=0'])
    expect(env.dataLayers).toHaveLength(2)
    expect(env.tlogLines.join(' ')).toContain('cloud')
  })

  it('carries the bearer token, or the Worker would refuse it', () => {
    const env = cloudEnv()
    env.api.fetchScopeGeo(SCOPE).catch(() => {})
    expect(env.requests[0].headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  const cloudDown = {
    'unreachable': 'error',
    'timing out': 'timeout',
    '500ing': { status: 500, responseText: '' },
    // The Worker's packs can be a country short of the laptop's, and that is
    // the whole reason the laptop is still on the list.
    'answering with no shape it has': { status: 200, responseText: JSON.stringify({ ok: false, error: 'no boundary' }) },
  }
  for (const [name, cloudReply] of Object.entries(cloudDown)) {
    it(`falls back to the laptop with the cloud ${name}`, async () => {
      const env = cloudEnv({
        reply: (req) => (isCloud(req.url) ? cloudReply : { status: 200, responseText: JSON.stringify(PAYLOAD) }),
      })
      env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
      await settle()
      expect(urlsOf(env).filter(isCloud)).toHaveLength(1) // asked once; the laptop IS the retry
      expect(urlsOf(env).some((u) => u.startsWith(LOCAL))).toBe(true)
      expect(env.dataLayers).toHaveLength(2) // the shape still lands on the map
      expect(env.tlogLines.join(' ')).toContain('answered by the laptop')
    })
  }

  it('says the cloud is out once a page load, not once a round', async () => {
    const env = cloudEnv({
      reply: (req) => (isCloud(req.url) ? 'error' : { status: 200, responseText: JSON.stringify(PAYLOAD) }),
    })
    env.api.fetchScopeGeo({ country: 'SE' }).catch(() => {})
    await settle()
    env.api.fetchScopeGeo({ country: 'NO' }).catch(() => {})
    await settle()
    expect(env.tlogLines.filter((l) => l.includes('answered by the laptop'))).toHaveLength(1)
  })

  it('names both machines and both reasons when neither answers', async () => {
    const env = cloudEnv({ reply: (req) => (isCloud(req.url) ? 'timeout' : 'error') })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(0)
    // The one trace of an overlay that was meant to be there. "server
    // unreachable" on its own is what made the Brazil round a week-long
    // mystery: it never said which server.
    expect(env.tlogLines).toHaveLength(1)
    expect(env.tlogLines[0]).toContain('CA|Ontario: no shape')
    expect(env.tlogLines[0]).toContain('cloud: timed out')
    expect(env.tlogLines[0]).toContain('laptop: server unreachable')
  })

  it('asks the pano lookup of the cloud first too', async () => {
    const env = cloudEnv({
      reply: (req) =>
        /scope-for-pano/.test(req.url)
          ? { status: 200, responseText: JSON.stringify({ ok: true, scope: SCOPE }) }
          : { status: 200, responseText: JSON.stringify(PAYLOAD) },
    })
    env.api.warmScopeGeo('pano1')
    await settle()
    expect(urlsOf(env)[0]).toBe(CLOUD_BASE + '/api/scope-for-pano?pano=pano1')
    expect(env.tlogLines.join(' ')).toContain('warmed ahead of the round from the cloud')
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

  it('never moves the camera, whatever the shape turns out to be', async () => {
    // The overlay used to widen GeoGuessr's result framing to take in the whole
    // region. The player read every one of those as the map jumping out from
    // under them, and worst on the rounds they got right — a tight frame is the
    // one a union has to pull furthest out of. The outline is now drawn on
    // whatever GeoGuessr chose to show, and the zoom is theirs.
    const env = makeEnv()
    const before = { ...env.cam }
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(2) // it did draw
    expect(env.fitCalls).toEqual([])
    expect(env.cam).toEqual(before)
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
      strokeWeight: 1.25, // the z4 rung of the weight ramp
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
    await vi.advanceTimersByTimeAsync(15_000)
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
    // Two of those requests are the first draw: a wire error is retried once
    // before it is believed, because a sleeping Mac and a dropped packet look
    // the same from here and only one of them is worth losing an overlay over.
    expect(env.requests).toHaveLength(2)
    asleep = false
    env.api.drawScopeOverlay({ roundId: 'r2', scope: SCOPE })
    await settle()
    expect(env.requests).toHaveLength(3)
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
    // A card that names a meta and carries no area is the server failing to
    // place the round, and it is the one shape of this that says so: an older
    // payload has no meta either and stays quiet.
    expect(env.tlogLines).toEqual(['scope: no area on the card for Sweden: yellow-topped poles'])
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

describe('detail follows the zoom', () => {
  it('picks a level for every zoom, and something sane for a broken one', () => {
    const { api } = makeEnv()
    expect([0, 1, 2, 3, 4, 5].map(api.lodForZoom)).toEqual([0, 0, 0, 0, 0, 0])
    expect([6, 7, 8].map(api.lodForZoom)).toEqual([1, 1, 1])
    expect([9, 12, 20].map(api.lodForZoom)).toEqual([2, 2, 2])
    expect(api.lodForZoom(NaN)).toBe(0)
    expect(api.lodForZoom(undefined)).toBe(0)
  })

  it('asks for the coarse level first, so the shape lands fast', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(urlsOf(env)[0]).toMatch(/[?&]lod=0(&|$)/)
  })

  it('fetches and swaps in a finer shape when the user zooms in', async () => {
    const FINE = JSON.parse(JSON.stringify(ONTARIO))
    // Finer means more points; the swap is refused if it is not.
    FINE.features[0].geometry.coordinates[0].splice(1, 0, [-90, 44], [-85, 43], [-80, 45])
    const env = makeEnv({
      reply: (req) => ({
        status: 200,
        responseText: JSON.stringify(/lod=2/.test(req.url) ? { ...PAYLOAD, geojson: FINE, lod: 2 } : PAYLOAD),
      }),
    })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(2)

    env.zoomTo(11)
    await settle()
    expect(urlsOf(env).some((u) => /lod=2/.test(u))).toBe(true)
    expect(env.api.layers()).toHaveLength(2) // still a pair, not four
    for (const layer of env.api.layers()) expect(layer.geo).toEqual([FINE])
    expect(env.tlogLines.join(' ')).toMatch(/detail up to lod 2/)
  })

  it('never goes back down a rung', async () => {
    const FINE = JSON.parse(JSON.stringify(ONTARIO))
    FINE.features[0].geometry.coordinates[0].splice(1, 0, [-90, 44], [-85, 43], [-80, 45])
    const env = makeEnv({
      reply: (req) => ({
        status: 200,
        responseText: JSON.stringify(/lod=2/.test(req.url) ? { ...PAYLOAD, geojson: FINE, lod: 2 } : PAYLOAD),
      }),
    })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.zoomTo(3)
    await settle()
    expect(urlsOf(env)).toHaveLength(asked) // nothing re-fetched
    for (const layer of env.api.layers()) expect(layer.geo).toEqual([FINE])
  })

  it('does not fire a request per notch while the wheel is spinning', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    const before = urlsOf(env).length
    env.zoomTo(6)
    env.zoomTo(7)
    env.zoomTo(9)
    await vi.advanceTimersByTimeAsync(20)
    expect(urlsOf(env)).toHaveLength(before) // still settling
    await settle()
    expect(urlsOf(env)).toHaveLength(before + 1) // one request, for where it landed
    expect(urlsOf(env)[before]).toMatch(/lod=2/)
  })

  it('stops asking for a level an old server answers no finer', async () => {
    const env = makeEnv() // every level replies with the same geometry
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.zoomTo(12)
    await settle()
    expect(urlsOf(env)).toHaveLength(asked)
    expect(env.tlogLines.join(' ')).toMatch(/no finer than what is drawn/)
  })

  it('keeps the drawn shape when a finer level cannot be had', async () => {
    const env = makeEnv({ reply: (req) => (/lod=2/.test(req.url) ? 'error' : { status: 200, responseText: JSON.stringify(PAYLOAD) }) })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.zoomTo(11)
    await settle()
    expect(env.api.layers()).toHaveLength(2)
    for (const layer of env.api.layers()) expect(layer.geo).toEqual([ONTARIO])
    expect(env.tlogLines.join(' ')).toMatch(/lod 2 unavailable/)
  })
})

// The two finer rungs are not the shape, they are a window on the shape.
// Canada's coastline at full detail is nine hundred thousand points and was the
// reason the overlay used to refuse detail to exactly the countries that needed
// it most; cut to the visible map it is two thousand, whatever the country —
// and a point on screen is held twice and reprojected on every frame, so that
// count is the frame rate during a zoom.
describe('the finest rung is a window on the shape', () => {
  const VIEW = { north: 44, south: 43, east: -79, west: -80 }

  it('grows the view by a quarter of a screen on every side', () => {
    const { api } = makeEnv()
    expect(api.padBox({ n: 44, s: 43, e: -79, w: -80 })).toEqual({ n: 44.25, s: 42.75, e: -78.75, w: -80.25 })
    // A view wide enough that cutting saves nothing is refused: the whole
    // shape is both the cheaper answer and the simpler one.
    expect(api.padBox({ n: 60, s: -60, e: 100, w: -100 })).toBe(null)
    expect(api.padBox(null)).toBe(null)
  })

  it('refuses a view it cannot reason about', () => {
    const env = makeEnv({ viewport: { north: 44, south: 43, east: -170, west: 170 } })
    expect(env.api.viewBox(env.map)).toBe(null) // across the antimeridian
    env.panTo(null)
    expect(env.api.viewBox(env.map)).toBe(null) // a map that has not settled
    env.panTo(VIEW)
    expect(env.api.viewBox(env.map)).toEqual({ n: 44, s: 43, e: -79, w: -80 })
  })

  it('asks for the visible map once the zoom is close enough to want it', async () => {
    const env = makeEnv({ viewport: VIEW })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await arrive()
    expect(urlsOf(env)[0]).not.toMatch(/box=/) // the first paint is the whole shape
    env.zoomTo(11)
    await settle()
    const fine = urlsOf(env).find((u) => /lod=2/.test(u))
    expect(fine).toContain('box=-80.25,42.75,-78.75,44.25')
    expect(env.tlogLines.join(' ')).toMatch(/cut to the visible map/)
  })

  it('does not go back to the server for a pan inside what it was given', async () => {
    const env = makeEnv({ viewport: VIEW })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await arrive()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.panTo({ north: 44.2, south: 43.2, east: -78.9, west: -79.9 })
    await settle()
    expect(urlsOf(env)).toHaveLength(asked)
  })

  it('fetches the next window once the map leaves the one it has', async () => {
    const env = makeEnv({ viewport: VIEW })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await arrive()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.panTo({ north: 46, south: 45, east: -76, west: -77 })
    await settle()
    expect(urlsOf(env)).toHaveLength(asked + 1)
    expect(urlsOf(env).pop()).toContain('box=-77.25,44.75,-75.75,46.25')
  })

  it('puts the whole shape back when the user zooms out again', async () => {
    const env = makeEnv({ viewport: VIEW })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await arrive()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.zoomTo(4)
    await settle()
    expect(env.tlogLines.join(' ')).toMatch(/back to the whole shape/)
    for (const layer of env.api.layers()) expect(layer.geo).toEqual([ONTARIO])
    // …and it came out of memory: the whole shape has been in hand since the
    // card appeared, so going back to it costs nothing at all.
    expect(urlsOf(env)).toHaveLength(asked)
  })

  it('never writes a window to the disk store', async () => {
    const env = makeEnv({ viewport: VIEW, zoom: 11 })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(urlsOf(env).some((u) => /box=/.test(u))).toBe(true)
    expect([...env.cells.keys()].some((k) => k.includes(','))).toBe(false)
  })

  it('takes the server\'s word for what a window covers, and stops asking', async () => {
    // The guess landed on the wrong continent, so the window missed the region
    // entirely and the server answered with the whole shape instead. Asking
    // again every time the map settles would be an endless loop.
    const env = makeEnv({
      viewport: VIEW,
      reply: () => ({ status: 200, responseText: JSON.stringify({ ...PAYLOAD, lod: 0, clip: null }) }),
    })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await arrive()
    env.zoomTo(11)
    await settle()
    const asked = urlsOf(env).length
    env.fire('idle')
    await settle()
    env.panTo({ north: 44.1, south: 43.1, east: -79.1, west: -80.1 })
    await settle()
    expect(urlsOf(env)).toHaveLength(asked)
  })

  it('knows when one box contains another', () => {
    const { api } = makeEnv()
    const outer = { n: 10, s: 0, e: 10, w: 0 }
    expect(api.boxCovers(outer, { n: 9, s: 1, e: 9, w: 1 })).toBe(true)
    expect(api.boxCovers(outer, outer)).toBe(true)
    expect(api.boxCovers(outer, { n: 11, s: 1, e: 9, w: 1 })).toBe(false)
    expect(api.boxCovers(null, outer)).toBe(false)
    expect(api.boxParam({ n: 44.123456, s: 43, e: -79, w: -80 })).toBe('-80,43,-79,44.12346')
  })
})

// A 7px glow is a handsome border at z9 and a solid smear across an archipelago
// at z4 — the southern Chilean islands were the case that proved it.
describe('stroke weight rides the zoom', () => {
  it('is a hairline zoomed out and full weight zoomed in', () => {
    const { api } = makeEnv()
    expect(api.scopeWeights(2)).toEqual({ glow: 2.5, main: 1 })
    expect(api.scopeWeights(12)).toEqual({ glow: 8, main: 2.5 })
    expect(api.scopeWeights(-5)).toEqual(api.scopeWeights(2)) // clamped both ends
    expect(api.scopeWeights(30)).toEqual(api.scopeWeights(12))
    expect(api.scopeWeights(7).glow).toBeGreaterThan(api.scopeWeights(4).glow)
    expect(api.scopeWeights(NaN)).toEqual(api.scopeWeights(4))
  })

  it('is quantised, so nudging the wheel inside a band restyles nothing', () => {
    const { api } = makeEnv()
    const w = api.scopeWeights(6)
    expect(api.scopeWeights(6.05)).toEqual(w)
    expect(w.glow * 4).toBe(Math.round(w.glow * 4))
  })

  it('re-weights the drawn shape the instant the zoom changes', async () => {
    const env = makeEnv({ zoom: 4 })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    const [glow, main] = env.dataLayers
    expect(styleOf(main).strokeWeight).toBe(env.api.scopeWeights(4).main)
    env.zoomTo(11)
    expect(styleOf(main).strokeWeight).toBe(env.api.scopeWeights(11).main)
    expect(styleOf(glow).strokeWeight).toBe(env.api.scopeWeights(11).glow)
  })
})

// Shapes are hundreds of KB over a LAN that may be asleep, and the same handful
// of metas come round again and again — so the coarse level lives on disk and a
// repeat meta paints on the frame the card appears.
describe('the shape store on disk', () => {
  const KEY = 'CA|Ontario|0'

  it('paints a repeat meta with no request at all', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.requests).toHaveLength(1)

    const next = makeEnv({ reply: () => 'error' }) // a fresh page, a dead server
    for (const [k, v] of env.cells) next.cells.set(k, v)
    next.api.drawScopeOverlay({ roundId: 'r2', scope: SCOPE })
    await settle()
    expect(next.requests).toEqual([])
    expect(next.dataLayers).toHaveLength(2)
    expect(next.tlogLines.join(' ')).toContain('stored')
  })

  it('re-fetches a shape stored more than a week ago', async () => {
    const { api, cells } = makeEnv()
    api.scopeStorePut(KEY, JSON.stringify(PAYLOAD))
    const rec = JSON.parse(cells.get('gc-scope1:' + KEY))
    rec.t -= 8 * 24 * 60 * 60 * 1000
    cells.set('gc-scope1:' + KEY, JSON.stringify(rec))
    expect(api.scopeStoreGet(KEY)).toBeNull()
    expect(cells.has('gc-scope1:' + KEY)).toBe(false) // and tidies itself up
  })

  it('treats a corrupt entry as an absent one', () => {
    const { api, cells } = makeEnv()
    cells.set('gc-scope1:' + KEY, '{not json')
    expect(api.scopeStoreGet(KEY)).toBeNull()
    expect(cells.has('gc-scope1:' + KEY)).toBe(false)
  })

  it('refuses a shape too big to be worth the whole budget', () => {
    const { api } = makeEnv()
    expect(api.scopeStorePut(KEY, '{"res":"' + 'x'.repeat(1_000_000) + '"}')).toBe(false)
    expect(api.scopeStoreGet(KEY)).toBeNull()
  })

  it('evicts the oldest shapes rather than failing the write', () => {
    const { api, cells } = makeEnv({ quota: 4000 })
    const body = JSON.stringify({ ...PAYLOAD, pad: 'x'.repeat(1200) })
    expect(api.scopeStorePut('a', body)).toBe(true)
    expect(api.scopeStorePut('b', body)).toBe(true)
    expect(api.scopeStorePut('c', body)).toBe(true)
    expect(api.scopeStoreGet('c')).toBeTruthy() // the newest always survives
    expect(cells.has('gc-scope1:a')).toBe(false) // the oldest paid for it
  })

  it('gives up on a write it cannot make room for, rather than throwing', () => {
    const { api } = makeEnv({ quota: 100 })
    expect(api.scopeStorePut(KEY, JSON.stringify(PAYLOAD))).toBe(false)
    expect(api.scopeStoreGet(KEY)).toBeNull()
  })

  it('keeps a shape read recently and drops one that was not', () => {
    const { api, cells } = makeEnv({ quota: 4200 })
    const body = JSON.stringify({ ...PAYLOAD, pad: 'x'.repeat(1200) })
    api.scopeStorePut('a', body)
    api.scopeStorePut('b', body)
    api.scopeStoreGet('a') // reading 'a' makes 'b' the oldest
    api.scopeStorePut('c', body)
    expect(cells.has('gc-scope1:a')).toBe(true)
    expect(cells.has('gc-scope1:b')).toBe(false)
  })

  it('only ever stores the coarse level', async () => {
    const FINE = JSON.parse(JSON.stringify(ONTARIO))
    FINE.features[0].geometry.coordinates[0].splice(1, 0, [-90, 44], [-85, 43], [-80, 45])
    const env = makeEnv({
      reply: (req) => ({
        status: 200,
        responseText: JSON.stringify(/lod=2/.test(req.url) ? { ...PAYLOAD, geojson: FINE, lod: 2 } : PAYLOAD),
      }),
    })
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.zoomTo(11)
    await settle()
    expect([...env.cells.keys()].filter((k) => k.startsWith('gc-scope1:'))).toEqual(['gc-scope1:CA|Ontario|0'])
  })
})

// The store only ever helped the second time a meta came round; warming it at
// round start — a whole guess before the card — makes the first time a hit too.
describe('warming the store at round start', () => {
  /** A server that answers both legs: the pano→scope lookup, then the shape. */
  const warmEnv = (scope = SCOPE, opts = {}) =>
    makeEnv({
      reply: (req) =>
        /scope-for-pano/.test(req.url)
          ? { status: 200, responseText: JSON.stringify(scope ? { ok: true, scope } : { ok: false }) }
          : { status: 200, responseText: JSON.stringify(PAYLOAD) },
      ...opts,
    })

  it('asks the LAN server what area the round is about, by pano id', async () => {
    const env = warmEnv()
    env.api.warmScopeGeo('AbC-123_pano')
    await settle()
    expect(urlsOf(env)[0]).toBe('http://127.0.0.1:5177/api/scope-for-pano?pano=AbC-123_pano')
    expect(env.requests[0]).toMatchObject({ method: 'GET' }) // GM, like every other LOCAL leg
    expect(urlsOf(env)[1]).toBe('http://127.0.0.1:5177/api/scope-geo?country=CA&regions=Ontario&lod=0')
    expect(env.tlogLines.join(' ')).toContain('CA|Ontario warmed ahead of the round')
  })

  it('leaves the card with nothing to fetch and a shape already on disk', async () => {
    const env = warmEnv()
    env.api.warmScopeGeo('pano1')
    await settle()
    expect(env.requests).toHaveLength(2)
    expect([...env.cells.keys()]).toContain('gc-scope1:CA|Ontario|0')

    // The real draw, a guess later: nothing left to ask for, and it paints.
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.requests).toHaveLength(2)
    expect(env.dataLayers).toHaveLength(2)
  })

  it('survives the page reloading between the warm and the card', async () => {
    const env = warmEnv()
    env.api.warmScopeGeo('pano1')
    await settle()

    const next = makeEnv({ reply: () => 'error' }) // a fresh page, and now a dead server
    for (const [k, v] of env.cells) next.cells.set(k, v)
    next.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(next.requests).toEqual([])
    expect(next.dataLayers).toHaveLength(2)
    expect(next.tlogLines.join(' ')).toContain('stored')
  })

  it('warms nothing for a pano the server does not know', async () => {
    const env = warmEnv(null)
    env.api.warmScopeGeo('pano-from-some-other-map')
    await settle()
    expect(env.requests).toHaveLength(1)
    expect(env.cells.size).toBe(0)
    expect(env.tlogLines).toEqual([])
  })

  it('asks for nothing at all without a pano id', async () => {
    const env = warmEnv()
    env.api.warmScopeGeo(null)
    env.api.warmScopeGeo('')
    await settle()
    expect(env.requests).toEqual([])
  })

  it('does not fetch a shape it already has', async () => {
    const env = warmEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.requests).toHaveLength(1)
    env.api.warmScopeGeo('pano1')
    await settle()
    expect(urlsOf(env).filter((u) => /scope-geo/.test(u))).toHaveLength(1)
    expect(env.tlogLines.join(' ')).not.toContain('warmed')
  })

  // A sleeping Mac is the normal condition away from home, and a warm nobody
  // asked for must never be the thing that says so.
  const quiet = {
    'the server is unreachable': () => 'error',
    'the lookup times out': () => 'timeout',
    'the lookup answers garbage': () => ({ status: 200, responseText: '<html>nope' }),
    'the lookup 404s': () => ({ status: 404, responseText: '' }),
    'the shape itself cannot be had': (req) =>
      /scope-for-pano/.test(req.url)
        ? { status: 200, responseText: JSON.stringify({ ok: true, scope: SCOPE }) }
        : 'error',
  }
  for (const [name, reply] of Object.entries(quiet)) {
    it(`says nothing and throws nothing when ${name}`, async () => {
      const env = makeEnv({ reply })
      expect(() => env.api.warmScopeGeo('pano1')).not.toThrow()
      await settle()
      expect(env.tlogLines).toEqual([])
      expect(env.cells.size).toBe(0)
    })
  }
})

// "The region overlay doesn't always seem to take": GeoGuessr re-mounts the
// result map, and a shape drawn on the outgoing instance is gone from the
// screen while every variable still says it was drawn.
describe('a result map that moves under the overlay', () => {
  const otherMap = (env) => {
    const div = {
      isConnected: true,
      getBoundingClientRect: () => ({ width: 1000, height: 700 }), // bigger: it wins pickResultMap
      addEventListener: () => {},
    }
    return {
      getDiv: () => div,
      fitBounds: () => {},
      getBounds: () => null,
      getZoom: () => env.cam.zoom,
      setZoom: () => {},
      getCenter: () => ({ lat: () => 0, lng: () => 0 }),
      setCenter: () => {},
      addListener: () => ({ remove() {} }),
    }
  }

  it('redraws itself on the new map without being told', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    expect(env.dataLayers).toHaveLength(2)

    const fresh = otherMap(env)
    env.W.__geocoachMaps = [fresh]
    await vi.advanceTimersByTimeAsync(1000) // the next watchdog
    expect(env.dataLayers).toHaveLength(4)
    for (const layer of env.api.layers()) {
      expect(layer.map).toBe(fresh)
      expect(layer.geo).toEqual([ONTARIO])
    }
    expect(env.tlogLines.join(' ')).toMatch(/result map changed under the overlay/)
  })

  it('takes the old pair down once the new one is up', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    const [glow, main] = env.dataLayers
    env.W.__geocoachMaps = [otherMap(env)]
    await vi.advanceTimersByTimeAsync(1000)
    expect(glow.map).toBeNull()
    expect(main.map).toBeNull()
    expect(env.api.layers().every((l) => l.map !== null)).toBe(true)
  })

  it('stops chasing after a few moves rather than thrashing forever', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    for (let i = 0; i < 6; i++) {
      env.W.__geocoachMaps = [otherMap(env)]
      await vi.advanceTimersByTimeAsync(1500)
    }
    expect(env.dataLayers.length).toBeLessThanOrEqual(2 + 3 * 2)
  })

  it('gives up on all of it once the card is gone', async () => {
    const env = makeEnv()
    env.api.drawScopeOverlay({ roundId: 'r1', scope: SCOPE })
    await settle()
    env.api.removeScopeOverlay()
    env.W.__geocoachMaps = [otherMap(env)]
    await vi.advanceTimersByTimeAsync(8000)
    expect(env.api.layers()).toEqual([])
    expect(env.dataLayers).toHaveLength(2) // nothing new was ever drawn
  })
})

// GeoGuessr freezes a game's five locations at POST /api/v3/games, so a deck
// published after that request is a deck the game will never look at. Every
// rating used to land one game late for exactly that reason.
describe('holding game creation until the deck is republished', () => {
  describe('which request is the one that freezes the deck', () => {
    const creates = [
      '/api/v3/games',
      'https://www.geoguessr.com/api/v3/games',
      '/api/v3/games/',
      '/api/v3/games?something=1',
    ]
    for (const url of creates) {
      it(`holds POST ${url}`, () => {
        expect(makeGate().api.isGameCreate(url, 'POST')).toBe(true)
      })
    }

    const passes = [
      // Game *state*: read every round, written on every guess. Holding this
      // one would stall the game rather than seed it.
      ['/api/v3/games/XEb0zuHB2bsm4pVT', 'POST'],
      ['https://www.geoguessr.com/api/v3/games/XEb0zuHB2bsm4pVT', 'GET'],
      ['/api/v3/games', 'GET'],
      ['/api/v4/user-maps/drafts', 'POST'],
      ['/api/duels/abc-123', 'POST'],
      ['', 'POST'],
    ]
    for (const [url, method] of passes) {
      it(`lets ${method} ${url || '(no url)'} through`, () => {
        expect(makeGate().api.isGameCreate(url, method)).toBe(false)
      })
    }
  })

  it('makes the creation request only once the rebuild has published', async () => {
    const d = deferred()
    const g = makeGate({ rebuild: () => d.promise })
    const answer = g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    expect(g.calls).toHaveLength(1)
    expect(g.fetched, 'the game was created before the deck was published').toHaveLength(0)
    d.resolve()
    await flush()
    expect(g.fetched).toHaveLength(1)
    await expect(answer).resolves.toMatchObject({ ok: true })
    expect(g.tlogLines.join(' ')).toContain('holding game creation')
    expect(g.tlogLines.join(' ')).toContain('this game gets the new deck')
  })

  it('hands the request through untouched — same arguments, same `this`', async () => {
    const g = makeGate()
    const opts = { method: 'POST', body: '{}', signal: {} }
    const input = { url: '/api/v3/games', method: 'POST' }
    g.W.fetch(input, opts)
    await flush()
    expect(g.fetched[0].input).toBe(input)
    expect(g.fetched[0].opts).toBe(opts)
    expect(g.fetched[0].self).toBe(g.W)
  })

  it('never holds game state, and never holds it asynchronously either', () => {
    const g = makeGate({ rebuild: () => deferred().promise })
    g.W.fetch('/api/v3/games/XEb0zuHB2bsm4pVT', { method: 'POST' }) // the guess
    g.W.fetch('/api/v3/games/XEb0zuHB2bsm4pVT') // the round being served
    // Synchronously, on the same tick: a guess POST that waits on a promise is
    // a card that arrives after the result screen has moved on.
    expect(g.fetched).toHaveLength(2)
    expect(g.calls).toHaveLength(0)
  })

  it('releases the request on the deadline when the rebuild runs long', async () => {
    const g = makeGate({ rebuild: () => deferred().promise }) // never settles
    g.W.fetch('/api/v3/games', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(g.api.JIT_BUDGET_MS - 1)
    expect(g.fetched).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(g.fetched, 'a slow rebuild must never stop the user playing').toHaveLength(1)
    expect(g.tlogLines.join(' ')).toContain('still running after ' + g.api.JIT_BUDGET_MS + 'ms')
  })

  it('keeps the deadline to a few seconds', () => {
    // The number is a judgement call, but the shape of it is not: long enough
    // for a rebuild, short enough that the wait reads as the game loading.
    expect(makeGate().api.JIT_BUDGET_MS).toBeGreaterThanOrEqual(2000)
    expect(makeGate().api.JIT_BUDGET_MS).toBeLessThanOrEqual(10000)
  })

  it('starts the game anyway when the rebuild throws', async () => {
    const g = makeGate({ rebuild: () => Promise.reject(new Error('server unreachable')) })
    const answer = g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    expect(g.fetched).toHaveLength(1)
    await expect(answer).resolves.toMatchObject({ ok: true })
    expect(g.tlogLines.join(' ')).toContain('FAILED')
    expect(g.tlogLines.join(' ')).toContain('starting the game anyway')
  })

  it('starts the game anyway when the rebuild throws synchronously', async () => {
    const g = makeGate({
      rebuild: () => {
        throw new Error('nope')
      },
    })
    const answer = g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    expect(g.fetched).toHaveLength(1)
    await expect(answer).resolves.toMatchObject({ ok: true })
  })

  it('runs one rebuild for two creation requests at once', async () => {
    const d = deferred()
    const g = makeGate({ rebuild: () => d.promise })
    g.W.fetch('/api/v3/games', { method: 'POST' })
    g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    // Two publishes at the same draft is a version conflict waiting to happen.
    expect(g.calls).toHaveLength(1)
    d.resolve()
    await flush()
    expect(g.fetched).toHaveLength(2)
  })

  it('rebuilds again for the game after that', async () => {
    const g = makeGate()
    g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    expect(g.calls).toHaveLength(2)
    expect(g.fetched).toHaveLength(2)
  })

  it('wraps fetch once, and a hot-reloaded body takes over the old wrap', async () => {
    const g = makeGate()
    const wrapped = g.W.fetch
    const second = []
    g.api.installRequestGate(g.W, () => {
      second.push(1)
      return Promise.resolve()
    })
    expect(g.W.fetch, 'the gate wrapped its own wrap').toBe(wrapped)
    g.W.fetch('/api/v3/games', { method: 'POST' })
    await flush()
    // A gate still publishing through the previous body is a gate publishing
    // through a dead script.
    expect(g.calls).toHaveLength(0)
    expect(second).toHaveLength(1)
  })

  it('holds a creation request that goes out over XMLHttpRequest instead', async () => {
    const d = deferred()
    const g = makeGate({ rebuild: () => d.promise })
    const xhr = new g.XHR()
    xhr.open('POST', '/api/v3/games')
    xhr.send('{}')
    await flush()
    expect(g.calls).toHaveLength(1)
    expect(g.sent).toHaveLength(0)
    d.resolve()
    await flush()
    expect(g.sent).toEqual([{ method: 'POST', url: '/api/v3/games', body: '{}' }])
    // If this line ever shows up in a real log, the fetch tap was never the
    // whole story and the comment above it needs rewriting.
    expect(g.tlogLines.join(' ')).toContain('went out over XMLHttpRequest')
  })

  it('leaves every other XMLHttpRequest alone, synchronous ones included', () => {
    const g = makeGate({ rebuild: () => deferred().promise })
    const state = new g.XHR()
    state.open('POST', '/api/v3/games/XEb0zuHB2bsm4pVT')
    state.send('{}')
    const sync = new g.XHR()
    sync.open('POST', '/api/v3/games', false) // blocking: it cannot be deferred
    sync.send('{}')
    expect(g.sent).toHaveLength(2)
    expect(g.calls).toHaveLength(0)
  })
})

// --------------------------------------------------------------- live duels
// The capture that broke without anyone noticing. GeoGuessr moved live ranked
// off /duels/<id> and onto a websocket, and the fetch tap — which learns the
// game id by overhearing a request that names it — went blind: every round
// still arrived, but only once the player opened the summary screen. These
// tests run the duel section as shipped and assert the thing that actually
// matters, which is that a round posts *while the match is still being played*
// with nothing but socket traffic to go on.
const DUEL_START = '  // ------------------------------------------------------------- duels'
const DUEL_END = '  // --------------------------------------------------------- backfill'
const duels = cut(DUEL_START, DUEL_END)
const DUEL_EXPORTS =
  ';return { noteDuelId, onSocket, pollDuel, handleDuelState, duelCandidates, fetchDuel }'

const SOCKET_START = '  // The same wrap for websockets, and it can live here rather than in the'
const socketWrap = cut(SOCKET_START, JIT_START)

/** One duel's state as game-server answers it, with `n` rounds guessed. */
const duelState = (gameId, n) => ({
  gameId,
  rounds: Array.from({ length: n }, (_, i) => ({
    roundNumber: i + 1,
    panorama: { panoId: 'abc', lat: 1 + i, lng: 2 + i, heading: 0 },
  })),
  teams: [{ players: [{ playerId: 'me', guesses: Array.from({ length: n }, (_, i) => ({ roundNumber: i + 1, lat: 3, lng: 4, score: 5000 })) }] }],
})

/**
 * The duel section over stubs: a fetch that answers only for the ids it was
 * given, a location that is the live-ranked page (no id in the path, which is
 * the whole problem), and a socket the test can push frames through.
 */
function makeDuels({ pathname = '/multiplayer/duels', states = {} } = {}) {
  if (!duels.ok) throw new Error('duel section not found in geocoach.user.js')
  const posted = []
  const fetched = []
  const tlogLines = []
  const listeners = []
  const socket = { addEventListener: (type, fn) => listeners.push([type, fn]) }
  const fetch = (url) => {
    fetched.push(url)
    const id = url.match(/duels\/([\w-]+)/)?.[1]
    const body = states[id]
    return Promise.resolve(body ? { ok: true, json: () => Promise.resolve(body) } : { ok: false, status: 404 })
  }
  const W = { __NEXT_DATA__: { props: { accountProps: { account: { user: { userId: 'me' } } } } } }
  const api = new Function(
    'W', 'fetch', 'location', 'tlog', 'tlogOnce', 'post', 'hex2a', 'console',
    duels.src + DUEL_EXPORTS,
  )(
    W, fetch, { pathname },
    (m) => tlogLines.push(m), (_k, m) => tlogLines.push(m),
    (key, payload) => posted.push({ key, payload }),
    (h) => h, { warn() {} },
  )
  /** Deliver a text frame to whatever the section subscribed with. */
  const frame = (data) => listeners.filter(([t]) => t === 'message').forEach(([, fn]) => fn({ data }))
  return { ...api, posted, fetched, tlogLines, socket, frame }
}

describe('live duels are captured from the socket', () => {
  const GAME = '6a8e81bd8972125225421744'

  it('slices the duel section', () => {
    expect(duels.ok).toBe(true)
    expect(socketWrap.ok).toBe(true)
  })

  it('learns the game id from the socket URL and posts mid-match', async () => {
    const d = makeDuels({ states: { [GAME]: duelState(GAME, 2) } })
    d.onSocket({ url: `wss://game-server.geoguessr.com/duels?gameId=${GAME}`, socket: d.socket })
    d.pollDuel()
    await flush()
    // Two rounds guessed so far, posted without a summary screen in sight.
    expect(d.posted.map((p) => p.key)).toEqual([`${GAME}:1:duel`, `${GAME}:2:duel`])
  })

  it('falls back to the id inside a frame when the URL does not carry one', async () => {
    const d = makeDuels({ states: { [GAME]: duelState(GAME, 1) } })
    d.onSocket({ url: 'wss://game-server.geoguessr.com/socket', socket: d.socket })
    d.pollDuel()
    await flush()
    expect(d.posted).toHaveLength(0) // nothing named the game yet
    d.frame(JSON.stringify({ type: 'RoundStarted', gameId: GAME }))
    d.pollDuel()
    await flush()
    expect(d.posted.map((p) => p.key)).toEqual([`${GAME}:1:duel`])
  })

  it('keeps capturing as later rounds are guessed', async () => {
    const states = { [GAME]: duelState(GAME, 1) }
    const d = makeDuels({ states })
    d.onSocket({ url: `wss://x/${GAME}`, socket: d.socket })
    d.pollDuel()
    await flush()
    expect(d.posted).toHaveLength(1)
    states[GAME] = duelState(GAME, 3) // two more rounds played
    d.pollDuel()
    await flush()
    expect(d.posted.map((p) => p.key)).toEqual([
      `${GAME}:1:duel`, `${GAME}:1:duel`, `${GAME}:2:duel`, `${GAME}:3:duel`,
    ])
  })

  it('tries a wrong id once and never again', async () => {
    const junk = '0123456789abcdef01234567'
    const d = makeDuels({ states: {} })
    d.onSocket({ url: `wss://x/${junk}`, socket: d.socket })
    d.pollDuel()
    await flush()
    d.pollDuel()
    d.pollDuel()
    await flush()
    expect(d.fetched.filter((u) => u.includes(junk))).toHaveLength(1)
  })

  it('spends at most one request a tick however many ids go past', async () => {
    const d = makeDuels({ states: {} })
    d.onSocket({ url: 'wss://x/', socket: d.socket })
    d.frame(Array.from({ length: 12 }, (_, i) => String(i).padStart(24, 'a')).join(' '))
    d.pollDuel()
    await flush()
    expect(d.fetched).toHaveLength(1)
  })

  it('ignores binary frames rather than guessing at them', async () => {
    const d = makeDuels({ states: { [GAME]: duelState(GAME, 1) } })
    d.onSocket({ url: 'wss://x/', socket: d.socket })
    d.frame(new ArrayBuffer(8))
    d.pollDuel()
    await flush()
    expect(d.fetched).toHaveLength(0)
  })

  it('lets a new duel overtake the one that just finished', async () => {
    const NEXT = 'aa8e81bd8972125225421799'
    const d = makeDuels({ states: { [GAME]: duelState(GAME, 1), [NEXT]: duelState(NEXT, 1) } })
    d.onSocket({ url: `wss://x/${GAME}`, socket: d.socket })
    d.pollDuel()
    await flush()
    d.frame(JSON.stringify({ gameId: NEXT }))
    d.pollDuel()
    await flush()
    expect(d.posted.map((p) => p.key)).toContain(`${NEXT}:1:duel`)
  })
})

describe('the websocket wrap does not break its host', () => {
  /** The wrap as shipped, over a stub window carrying a stub WebSocket. */
  function wrap() {
    const seen = []
    class PageSocket {
      constructor(url, protocols) {
        this.url = url
        this.protocols = protocols
      }
    }
    PageSocket.CONNECTING = 0
    PageSocket.OPEN = 1
    PageSocket.CLOSING = 2
    PageSocket.CLOSED = 3
    const W = { WebSocket: PageSocket }
    new Function('W', 'onSocket', socketWrap.src)(W, (rec) => seen.push(rec))
    return { W, seen, PageSocket }
  }

  it('passes the socket through and reports it', () => {
    const { W, seen } = wrap()
    const ws = new W.WebSocket('wss://x/1')
    expect(ws.url).toBe('wss://x/1')
    expect(seen).toEqual([{ url: 'wss://x/1', socket: ws }])
  })

  it('keeps instanceof and the readyState constants working', () => {
    const { W, PageSocket } = wrap()
    expect(new W.WebSocket('wss://x/1') instanceof PageSocket).toBe(true)
    expect(W.WebSocket.OPEN).toBe(1)
    expect(W.WebSocket.CLOSED).toBe(3)
  })

  it('forwards subprotocols, and omits them when the page did', () => {
    const { W } = wrap()
    expect(new W.WebSocket('wss://x/1', 'json').protocols).toBe('json')
    expect(new W.WebSocket('wss://x/1').protocols).toBe(undefined)
  })

  it('survives a reporter that throws', () => {
    const seen = []
    class PageSocket { constructor(url) { this.url = url } }
    const W = { WebSocket: PageSocket }
    new Function('W', 'onSocket', socketWrap.src)(W, () => { throw new Error('body reloaded') })
    expect(new W.WebSocket('wss://x/1').url).toBe('wss://x/1')
    expect(seen).toHaveLength(0)
  })

  it('wraps once however many times the body reloads', () => {
    const { W } = wrap()
    const first = W.WebSocket
    new Function('W', 'onSocket', socketWrap.src)(W, () => {})
    expect(W.WebSocket).toBe(first)
  })
})
