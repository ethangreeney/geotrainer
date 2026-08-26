// ==UserScript==
// @name         GeoCoach bridge
// @description  Spaced repetition for GeoGuessr: captures every round, shows the meta you missed, and rebuilds your trainer map from what's due.
// @version      2.14.0
// @author       Ethan + Claude
// @match        https://www.geoguessr.com/*
// @run-at       document-start
// @updateURL    http://127.0.0.1:5177/geocoach.user.js
// @downloadURL  http://127.0.0.1:5177/geocoach.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */
;(function () {
  'use strict'
  // Cloud bridge: the local server injects the real URL and token from the
  // gitignored coach/config.json when it serves this file. Installed raw from
  // the repo the placeholders survive, CLOUD stays null, and everything talks
  // to the local server exactly as before.
  const CLOUD_URL = '__CLOUD_URL__'
  const CLOUD_TOKEN = '__CLOUD_TOKEN__'
  const CLOUD = CLOUD_URL.startsWith('http') ? { url: CLOUD_URL, token: CLOUD_TOKEN } : null
  const AUTH_HEADERS = CLOUD ? { Authorization: 'Bearer ' + CLOUD.token } : {}
  const LOCAL = 'http://127.0.0.1:5177'
  const COACH_URL = (CLOUD ? CLOUD.url : LOCAL) + '/round'
  const RATE_URL = (CLOUD ? CLOUD.url : LOCAL) + '/rate'
  const PREWARM_URL = (CLOUD ? CLOUD.url : LOCAL) + '/prewarm'

  // Timing trace for the guess→card path. Cheap, permanent: reading the
  // timeline is how latency regressions get caught. Mirrored onto <html
  // data-geocoach-log> because Tampermonkey sandbox console output is not
  // always visible to page-context tooling.
  const tlogLines = []
  const tlogQueue = []
  const tlog = (msg) => {
    const line = '[' + new Date().toISOString().slice(11, 23) + '] ' + msg
    console.log('[geocoach ⏱]' + line)
    tlogLines.push(line)
    tlogQueue.push({ t: Date.now(), line: line.slice(0, 500) })
    try {
      document.documentElement.setAttribute('data-geocoach-log', tlogLines.slice(-20).join('\n'))
    } catch {}
  }
  // One line per key: the 10s duel poll would otherwise flood the 20-line window.
  const tlogged = new Set()
  function tlogOnce(key, line) {
    if (tlogged.has(key)) return
    tlogged.add(key)
    tlog(line)
  }
  /** The on-page log is visible only on the machine that made it and dies on
   * navigation, so every line also goes home: the LAN server for the dossier
   * machine, and the cloud when configured — that copy is the only one
   * readable from the Mac while the gaming PC is the one playing.
   * Never call tlog from in here: shipping a line would queue another. */
  function shipTlog() {
    if (!tlogQueue.length) return
    const lines = tlogQueue.splice(0)
    const body = JSON.stringify({ lines })
    // Same transport split as post(): GM for the http LAN server (an https
    // page can't reach it with fetch), page-context fetch for the https cloud.
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LOCAL + '/tlog',
        headers: { 'Content-Type': 'application/json' },
        data: body,
        timeout: 15000,
      })
    } else {
      fetch(LOCAL + '/tlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {})
    }
    if (!CLOUD) return
    // Only the cloud leg is worth retrying — it is the copy we read remotely.
    // A long outage caps at the newest 200 lines rather than growing forever.
    const requeue = () => {
      tlogQueue.unshift(...lines)
      if (tlogQueue.length > 200) tlogQueue.splice(0, tlogQueue.length - 200)
    }
    const viaGM = () => {
      if (typeof GM_xmlhttpRequest !== 'function') return requeue()
      GM_xmlhttpRequest({
        method: 'POST',
        url: CLOUD.url + '/api/tlog',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        data: body,
        timeout: 15000,
        onerror: requeue,
        ontimeout: requeue,
      })
    }
    W.fetch(CLOUD.url + '/api/tlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body,
    }).catch(viaGM)
  }

  // Kept equal to @version above by a test — the log line is how a machine we
  // are not sitting at says which body it is actually running, and a stale
  // literal here sends the reader looking for a bug that was fixed hours ago.
  const BODY_VERSION = '2.14.0'
  tlog('body ' + BODY_VERSION + ' up — GM=' + typeof GM_xmlhttpRequest + ' cloud=' + !!CLOUD)

  /** Best-effort dossier capture: with the cloud as FSRS authority, the LAN
   * server still gets every round so pano dossiers keep building at home.
   * Fire-and-forget — away from the Mac this fails silently, and its card
   * and grading are ignored (the cloud response drives the UI). */
  function postLocalDossier(body) {
    if (!CLOUD) return
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LOCAL + '/round',
        headers: { 'Content-Type': 'application/json' },
        data: body,
        timeout: 30000,
      })
    } else {
      fetch(LOCAL + '/round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {})
    }
  }

  /** Fire-and-forget rating override; only failures surface. Unlike round
   * posts there is no game-state backstop, so a transient LAN blip would lose
   * the rating for good — retry silently before giving up. */
  function postRate(id, rating) {
    const body = JSON.stringify({ id, rating })
    const attempt = (retriesLeft) => {
      const failed = (message) => {
        if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 1500)
        else toast(message, false)
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url: RATE_URL,
          headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
          data: body,
          timeout: 15000,
          onload: (res) => {
            if (res.status !== 200) toast('Rating not saved (' + res.status + ')', false)
          },
          onerror: () => failed('Rating not saved — server unreachable'),
          ontimeout: () => failed('Rating not saved — timed out'),
        })
      } else {
        fetch(RATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS }, body })
          .then((res) => {
            if (!res.ok) toast('Rating not saved (' + res.status + ')', false)
          })
          .catch(() => failed('Rating not saved — server unreachable'))
      }
    }
    attempt(2)
  }

  function toast(text, ok) {
    const el = document.createElement('div')
    el.textContent = text
    el.style.cssText =
      'position:fixed;bottom:18px;right:18px;z-index:999999;padding:10px 16px;' +
      'border-radius:8px;font:600 13px/1.2 system-ui;color:#fff;transition:opacity .4s;' +
      `background:${ok ? 'rgba(30,120,70,.92)' : 'rgba(150,45,35,.92)'}`
    document.body.appendChild(el)
    setTimeout(() => (el.style.opacity = '0'), 2600)
    setTimeout(() => el.remove(), 3100)
  }

  // One send per (game, round), whichever path notices it first.
  const sent = new Set()

  // ---------------------------------------------------- the coach's servers
  // One GET client for everything GeoCoach itself answers — the deck, the
  // boundary shapes, the pano→scope lookup — and one list of machines to ask,
  // in the order they are asked.
  //
  // The cloud is first for cause, and the cause has a date on it: a Brazil
  // round where neither the sub-region nor the country drew, because the Mac
  // was asleep and /api/scope-geo went nowhere. The overlay had been a LAN-only
  // feature and behaved like one — the rounds that *did* draw that evening were
  // drawing out of localStorage, not off a server. The Worker holds the same
  // packs and answers the same two routes with the same JSON, so the machine
  // that is always awake is the one asked first. The laptop stays on the list
  // as the fallback, which is a real job: it catches a Worker that is down, and
  // it holds shapes the Worker may not have yet while the packs are rebuilt.
  const GEO_SOURCES = CLOUD
    ? [
        { base: CLOUD.url, name: 'cloud' },
        { base: LOCAL, name: 'laptop' },
      ]
    : [{ base: LOCAL, name: 'laptop' }]

  /** One GET, one machine, parsed JSON out.
   *
   * `base` picks the machine (default: the cloud when it is configured, the
   * laptop otherwise), `timeout` the patience, and `retry` how many times a
   * *wire* failure is worth asking again about — a status code is a real
   * answer and is never retried, however unwelcome it is. The defaults are the
   * deck's: one shot and a minute of patience, because a rebuild is allowed to
   * be slow and has nowhere else to go.
   *
   * GM_xmlhttpRequest rather than fetch because the laptop leg is http while
   * the page is https; the plain-fetch branch only exists for a direct install
   * with no GM grant, where that leg is blocked by the browser anyway. */
  function serverGet(path, opts) {
    const { base = CLOUD ? CLOUD.url : LOCAL, timeout = 60000, retry = 0 } = opts || {}
    const url = base + path
    return new Promise((resolve, reject) => {
      const parsed = (text) => {
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('unreadable answer'))
        }
      }
      const ask = (left) => {
        const wire = (message) => (left > 0 ? ask(left - 1) : reject(new Error(message)))
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: { ...AUTH_HEADERS },
            timeout,
            onload: (r) => (r.status === 200 ? parsed(r.responseText) : reject(new Error('server ' + r.status))),
            onerror: () => wire('server unreachable'),
            ontimeout: () => wire('timed out'),
          })
        } else {
          fetch(url, { headers: { ...AUTH_HEADERS } }).then(
            (r) => (r.status === 200 ? r.text().then(parsed) : reject(new Error('server ' + r.status))),
            (err) => wire((err && err.message) || 'server unreachable'),
          )
        }
      }
      ask(retry)
    })
  }

  /** The same GET, asked of each source in turn until one gives a usable
   * answer. Resolves { json, source }.
   *
   * "Usable" is the caller's test and not the HTTP status, because a source
   * can answer perfectly and still be no help: a Worker whose packs are missing
   * a country replies 200 with ok:false, and the entire point of keeping the
   * laptop on the list is that it may still have that shape. So a shapeless 200
   * retires a source exactly the way a refused connection does.
   *
   * Rejects only once every source has failed, and names all of them: a log
   * line reading "timed out" leaves the reader guessing which machine timed
   * out, which is how the Brazil round stayed a mystery for a week. */
  function geoGet(path, timeout, usable) {
    const why = []
    const ask = (i) => {
      if (i >= GEO_SOURCES.length) return Promise.reject(new Error(why.join('; ') || 'nowhere to ask'))
      const src = GEO_SOURCES[i]
      // The retry belongs to the last source alone: for the others, moving on
      // to the next machine *is* the retry, and it is a better one.
      const last = i === GEO_SOURCES.length - 1
      return serverGet(path, { base: src.base, timeout, retry: last ? 1 : 0 })
        .then((json) => {
          if (!usable(json)) throw new Error('nothing usable in the answer')
          // Falling back is a working overlay and a broken primary at the same
          // time, and only one of those is visible on screen. Once per page
          // load is enough to say so — the alternative is a line per round.
          if (i > 0) tlogOnce('geo-fallback:' + src.name, 'geo: answered by the ' + src.name + ' — ' + why.join('; '))
          return { json, source: src.name }
        })
        .catch((err) => {
          why.push(src.name + ': ' + ((err && err.message) || 'failed'))
          return ask(i + 1)
        })
    }
    return ask(0)
  }

  // -------------------------------------------------------- scope overlay
  // A meta is a claim about a place and the card only names it. Drawing the
  // area the clue actually covers — the answer's country, or just the admin-1
  // subdivisions when the meta is narrower than the country — onto GeoGuessr's
  // own result map puts that claim right next to where the guess landed.
  //
  // The geometry comes from whichever coach server answers first (see
  // GEO_SOURCES: the cloud, then the laptop). A sleeping Mac used to mean no
  // overlay at all; now it only means the second-choice machine is out. Every
  // failure below is still silent and total — no overlay, no exception, card
  // untouched — but a *total* failure now names both machines and the reason
  // each gave, because "server unreachable" on its own says nothing about
  // which server.
  //
  // Three things separate "correct" from "feels instant", and each is a section
  // of its own below:
  //   · the coarse outline survives page loads in localStorage, and the store is
  //     filled at round start rather than at card time, so the shape is in hand
  //     on the frame the card appears rather than a LAN trip later;
  //   · GeoGuessr's own result fitBounds is held for a beat and widened in
  //     place, so the camera makes one move instead of zooming in and back out;
  //   · detail rides the zoom, because a coastline nobody can see is only a
  //     download.
  const SCOPE_GEO_PATH = '/api/scope-geo'
  // Which area a round is about, asked by pano id at round start — the same
  // sources in the same order, because both machines hold the catalogs as well
  // as the shapes.
  const SCOPE_FOR_PANO_PATH = '/api/scope-for-pano'
  // Long enough for a cold Worker or a Mac still waking, short enough that two
  // dead sources cost the card well under the time a result screen is up.
  const SCOPE_TIMEOUT = 8000
  // The card's own chrome, so the shape reads as GeoCoach's annotation and not
  // as something GeoGuessr drew: the panel violet for the crisp outline and the
  // tint, its muted violet for the soft glow that sits under the outline.
  const SCOPE_INK = '#2b1b58'
  const SCOPE_GLOW = '#a99fce'
  // Light enough that both pins and the line between them stay readable
  // through it — the outline is the statement, the fill only says "inside".
  const SCOPE_FILL_ALPHA = 0.14
  // Roughly where a per-frame restyle stops being free on a mid-range laptop.
  // Since the LOD split this guard is about *first paints* and nothing else,
  // which is exactly what it should be. A first paint is always lod 0 — a few
  // thousand points for a whole country — so essentially everything fades,
  // which is what the user wants. The finer levels arrive as silent swaps
  // styled once rather than frame by frame, so their size never meets this
  // number at all. What it still catches is the case that matters most: a
  // server that predates the ladder and answers a lod-0 request with the full
  // coastline anyway. That is precisely when a frame-by-frame fade would
  // stutter, and a shape that simply appears beats one that judders in.
  const FADE_POINT_LIMIT = 8000

  /** Total coordinate pairs in a FeatureCollection — the only cost measure
   * that matters here, since it is what the renderer walks per restyle. */
  function countPoints(geojson) {
    let n = 0
    const walk = (c) => {
      if (!Array.isArray(c)) return
      if (typeof c[0] === 'number') return void n++
      for (const x of c) walk(x)
    }
    for (const f of (geojson && geojson.features) || []) walk(f && f.geometry && f.geometry.coordinates)
    return n
  }

  /** The server's ladder, mirrored: z ≤ 5 is a continent, where a generalised
   * outline is all the pixels could show anyway; 6–8 is a country filling the
   * frame; 9+ is close enough that a smoothed coastline reads as simply wrong.
   * Coarser levels are dramatically smaller, so guessing low costs nothing and
   * guessing high costs the whole point of the ladder. */
  function lodForZoom(z) {
    if (typeof z !== 'number' || !isFinite(z)) return 0
    if (z <= 5) return 0
    if (z <= 8) return 1
    return 2
  }

  /** The rung from which the shape is drawn as a window on itself rather than
   * whole. It has to be: the finest rung of Canada is nine hundred thousand
   * points, and the reason the overlay used to refuse that detail to precisely
   * the countries that needed it most. Cut to the visible map it is two
   * thousand, whatever the country.
   *
   * The middle rung joined it because of what a point costs once it is on
   * screen. Every vertex is held twice — a wide soft stroke under a crisp one —
   * and Google reprojects both on every frame of a zoom, so the frame rate is a
   * straight function of the point count. Canada's middle rung whole is a
   * hundred and fifteen thousand points, i.e. two hundred and thirty thousand
   * reprojections per frame, which is exactly the stutter that showed up on a
   * Canada round. Windowed it is a few thousand and the zoom is smooth, and
   * nothing is lost: the part of the shape being cut away is off-screen. */
  const FINE_LOD = 1

  /** Stroke weights in *pixels*, and a pixel does not mean the same thing at
   * every zoom. A 7px glow traces a national border handsomely at z9; at z4 it
   * is wider than the water between the islands of southern Chile, so an
   * archipelago renders as one dark smear and the shape it was meant to teach
   * is lost. The weights ride the zoom instead: a hairline when the country is
   * a thumbnail, full weight once a border is a real edge on screen.
   * Quantised to ¼px so spinning the wheel inside one band restyles nothing. */
  function scopeWeights(z) {
    const t = Math.max(0, Math.min(1, ((typeof z === 'number' && isFinite(z) ? z : 4) - 2) / 10))
    const q = (a, b) => Math.round((a + (b - a) * t) * 4) / 4
    return { glow: q(2.5, 8), main: q(1, 2.4) }
  }

  // --------------------------------------------------------------- boxes
  // Everything the camera does is decided on plain {n,s,e,w} lat/lng boxes:
  // the shape's, the frame GeoGuessr asked for, and the union of the two.

  /** A plain box only means anything when it does not wrap. A shape or a
   * viewport crossing the antimeridian (Russia, Fiji, a map spun right round)
   * has a bbox that claims most of the planet, and framing on it would be
   * worse than not framing at all. */
  const boxIsSane = (b) =>
    !!b &&
    isFinite(b.n) &&
    isFinite(b.s) &&
    isFinite(b.e) &&
    isFinite(b.w) &&
    b.n > b.s &&
    b.e > b.w &&
    b.e - b.w < 180

  /** The shape's bounding box straight off the coordinates: cheaper than
   * walking the rendered features, and available before anything is drawn. */
  function scopeBounds(geojson) {
    let n = -Infinity
    let s = Infinity
    let e = -Infinity
    let w = Infinity
    const walk = (c) => {
      if (!Array.isArray(c)) return
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        if (c[1] > n) n = c[1]
        if (c[1] < s) s = c[1]
        if (c[0] > e) e = c[0]
        if (c[0] < w) w = c[0]
        return
      }
      for (const x of c) walk(x)
    }
    for (const f of (geojson && geojson.features) || []) walk(f && f.geometry && f.geometry.coordinates)
    return n > s && e > w ? { n, s, e, w } : null
  }

  /** The scope's box: the server sends one alongside the geometry, and a server
   * that predates the ladder does not — but the coordinates always carry it. */
  function boxOf(res) {
    // `frame` is the main mass and `bbox` the true extent: a Chile round should
    // end up framed on Chile, not on the 43° of Pacific between the mainland
    // and Easter Island. Either beats walking the coordinates.
    for (const b of [res && res.frame, res && res.bbox])
      if (b && isFinite(b.n) && isFinite(b.s) && isFinite(b.e) && isFinite(b.w) && b.n > b.s && b.e > b.w)
        return { n: b.n, s: b.s, e: b.e, w: b.w }
    return res ? scopeBounds(res.geojson) : null
  }

  /** Whatever Google handed us for a fitBounds call, as a box. It accepts both
   * a LatLngBounds and a bare literal, so both have to come back out. */
  function boxOfBounds(b) {
    if (!b || typeof b !== 'object') return null
    try {
      if (typeof b.getSouthWest === 'function' && typeof b.getNorthEast === 'function') {
        const sw = b.getSouthWest()
        const ne = b.getNorthEast()
        return { n: ne.lat(), s: sw.lat(), e: ne.lng(), w: sw.lng() }
      }
      if (isFinite(b.north) && isFinite(b.south) && isFinite(b.east) && isFinite(b.west))
        return { n: b.north, s: b.south, e: b.east, w: b.west }
    } catch {}
    return null
  }

  const boxUnion = (a, b) => ({
    n: Math.max(a.n, b.n),
    s: Math.min(a.s, b.s),
    e: Math.max(a.e, b.e),
    w: Math.min(a.w, b.w),
  })

  const boxCenter = (b) => ({ lat: (b.n + b.s) / 2, lng: (b.e + b.w) / 2 })

  const boxCovers = (outer, inner) =>
    !!outer && !!inner && outer.n >= inner.n && outer.s <= inner.s && outer.e >= inner.e && outer.w <= inner.w

  /** The wire form the server parses: west,south,east,north, at five decimals.
   * Rounded on this side too, so a map settling through sub-pixel jitter asks
   * for the same window twice and the second ask is a cache hit. */
  const boxParam = (b) => [b.w, b.s, b.e, b.n].map((v) => Math.round(v * 1e5) / 1e5).join(',')

  /** What the map is showing, or null when it is showing something this code
   * refuses to reason about — an unsettled map, or a view across the
   * antimeridian, where Google reports east *west* of west and every
   * containment test below would quietly invert. Null means "no window", which
   * means the whole shape, which is always correct and merely larger. */
  function viewBox(map) {
    let b = null
    try {
      b = boxOfBounds(map.getBounds())
    } catch {}
    return b && b.n > b.s && b.e > b.w ? b : null
  }

  /** The window actually requested: the view grown by a quarter of its own
   * size on every side, so a small pan or a zoom step lands inside geometry already
   * in hand and only real travel goes back to the server. Refused for a view
   * wide enough that cutting it saves nothing — at that width the whole shape
   * is the cheaper answer as well as the simpler one.
   *
   * A quarter rather than a half is the cheaper half of the same trade: the pad
   * applies on both axes, so half asks for four times the area of the view and
   * a quarter for two and a quarter. Points are frame time — see FINE_LOD — and
   * a pan far enough to leave the smaller margin is far enough to be worth a
   * request. */
  const SCOPE_CLIP_PAD = 0.25
  function padBox(view) {
    if (!view) return null
    const dy = (view.n - view.s) * SCOPE_CLIP_PAD
    const dx = (view.e - view.w) * SCOPE_CLIP_PAD
    const b = {
      n: Math.min(85, view.n + dy),
      s: Math.max(-85, view.s - dy),
      e: Math.min(180, view.e + dx),
      w: Math.max(-180, view.w - dx),
    }
    return b.n > b.s && b.e > b.w && b.e - b.w < 120 && b.n - b.s < 60 ? b : null
  }

  /** How much of the shape's box a given frame actually shows, 0..1. An
   * unmeasurable pair answers 1 — "already visible" — because the only thing
   * this number is used for is deciding to move the camera, and a camera move
   * we cannot justify is one we should not make. */
  function visibleFraction(box, view) {
    if (!boxIsSane(box) || !boxIsSane(view)) return 1
    const area = (box.n - box.s) * (box.e - box.w)
    if (!(area > 0)) return 1
    const lat = Math.min(box.n, view.n) - Math.max(box.s, view.s)
    const lng = Math.min(box.e, view.e) - Math.max(box.w, view.w)
    return lat > 0 && lng > 0 ? (lat * lng) / area : 0
  }

  // The old overlay corrected the framing with a second fitBounds after
  // GeoGuessr's own, which the user saw as a jerk — so it only fired when the
  // shape was almost entirely off-screen (0.35 visible). Widening is now folded
  // into GeoGuessr's single camera move and costs nothing at all to look at, so
  // that bar drops to "any meaningful part of the region is cut off": the user
  // likes ending up with the whole region in frame, and now they can have it
  // for free. The late path is the one that still costs a visible 600ms tween,
  // so it keeps a stricter bar and only fires when the shape is half missing.
  const WIDEN_FREE = 0.8
  const WIDEN_LATE = 0.45

  const shouldWiden = (box, view, threshold) =>
    boxIsSane(box) && boxIsSane(view) && visibleFraction(box, view) < threshold

  /** Web Mercator's y, normalised 0 (north pole) to 1 (south). */
  function mercN(lat) {
    const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
  }

  /** The zoom Google would choose for this box in a div this size. fitBounds
   * works it out internally and will not say, and the number is needed to tween
   * toward: panToBounds pans but never zooms, and fitBounds snaps. 256 is the
   * Maps tile size, i.e. the width of the whole world at zoom 0. */
  function zoomForBox(box, width, height, padding) {
    if (!boxIsSane(box) || !(width > 0) || !(height > 0)) return null
    const pad = padding || 0
    const w = Math.max(32, width - pad * 2)
    const h = Math.max(32, height - pad * 2)
    const fx = (box.e - box.w) / 360
    const fy = Math.abs(mercN(box.s) - mercN(box.n))
    const zx = fx > 0 ? Math.log2(w / (256 * fx)) : 22
    const zy = fy > 0 ? Math.log2(h / (256 * fy)) : 22
    return Math.max(0, Math.min(22, Math.min(zx, zy)))
  }

  /** ease-in-out cubic: leaves and arrives at rest, which is the whole
   * difference between a camera move and a jump. */
  function easeInOut(t) {
    const k = Math.max(0, Math.min(1, t))
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
  }

  /** Longitudes interpolate the short way round, or a tween between Alaska and
   * Kamchatka would sweep the camera across the entire Atlantic. */
  function lerpLng(a, b, k) {
    return a + (((b - a + 540) % 360) - 180) * k
  }

  // ------------------------------------------------------------- storage
  // The in-memory cache dies with the tab, and a cold cache is exactly the case
  // the user notices: the first result after a page load waits on the LAN, and
  // if the Mac is slow to answer the overlay lands late or never. The coarse
  // level is small enough to keep on disk, so it does — LRU, budgeted, and only
  // ever lod 0. The finer levels are large and wanted rarely; a session's worth
  // of those in memory is plenty.
  //
  // GM_setValue is not granted to this script (the installed loader only asks
  // for GM_xmlhttpRequest and unsafeWindow, and the body must never assume a
  // newer loader), so localStorage it is — the same store the card's position
  // and size already live in.
  const SCOPE_STORE_PREFIX = 'gc-scope1:'
  const SCOPE_STORE_LRU = 'gc-scope1-lru'
  const SCOPE_STORE_MAX = 2.5 * 1024 * 1024
  // No single shape may own the budget: past this it is cheaper to re-fetch it
  // than to evict everything else for it.
  const SCOPE_STORE_ONE_MAX = 900 * 1024
  // Boundaries only change when the Mac's Natural Earth slices are rebuilt, and
  // nothing in the browser would ever hear about it. A week is short enough
  // that a rebuild reaches the page by itself and long enough that the store is
  // warm for every session that matters.
  const SCOPE_STORE_TTL = 7 * 24 * 60 * 60 * 1000

  function scopeStoreLru() {
    try {
      const a = JSON.parse(localStorage.getItem(SCOPE_STORE_LRU))
      return Array.isArray(a) ? a.filter((e) => e && typeof e.k === 'string' && typeof e.n === 'number') : []
    } catch {
      return []
    }
  }
  function scopeStoreSaveLru(list) {
    try {
      localStorage.setItem(SCOPE_STORE_LRU, JSON.stringify(list))
    } catch {}
  }
  function scopeStoreDrop(k) {
    try {
      localStorage.removeItem(SCOPE_STORE_PREFIX + k)
    } catch {}
  }

  /** The stored payload for a key, or null. Expired, corrupt and absent are all
   * the same answer — go and ask the server — and all three tidy up after
   * themselves so a bad entry cannot be read twice. */
  function scopeStoreGet(k) {
    let raw = null
    try {
      raw = localStorage.getItem(SCOPE_STORE_PREFIX + k)
    } catch {
      return null
    }
    if (!raw) return null
    let rec = null
    try {
      rec = JSON.parse(raw)
    } catch {}
    if (!rec || !rec.res || typeof rec.t !== 'number' || Date.now() - rec.t > SCOPE_STORE_TTL) {
      scopeStoreDrop(k)
      scopeStoreSaveLru(scopeStoreLru().filter((e) => e.k !== k))
      return null
    }
    const list = scopeStoreLru().filter((e) => e.k !== k)
    list.push({ k, n: raw.length }) // newest last: the eviction end is the front
    scopeStoreSaveLru(list)
    return rec.res
  }

  /** `text` is the server's own response body, embedded rather than re-
   * serialised: a country outline is a few hundred KB and a parse-then-
   * stringify round trip of that is real time on the paint path. */
  function scopeStorePut(k, text) {
    if (typeof text !== 'string' || !text || text.length > SCOPE_STORE_ONE_MAX) return false
    const raw = '{"t":' + Date.now() + ',"res":' + text + '}'
    const list = scopeStoreLru().filter((e) => e.k !== k)
    list.push({ k, n: raw.length })
    let total = 0
    for (const e of list) total += e.n
    // Oldest first, and never the entry being written: a budget that one shape
    // alone exceeds is a reason to give up on it, not to empty the store.
    while (list.length > 1 && total > SCOPE_STORE_MAX) {
      const old = list.shift()
      total -= old.n
      scopeStoreDrop(old.k)
    }
    for (;;) {
      try {
        localStorage.setItem(SCOPE_STORE_PREFIX + k, raw)
        scopeStoreSaveLru(list)
        return true
      } catch {
        // Quota, and the origin is shared with GeoGuessr's own storage, so the
        // pressure is as likely to be theirs as ours. Evict our oldest and try
        // again; when there is nothing left of ours to give, abandon the write
        // rather than throwing — a missing cache entry costs one LAN request.
        if (list.length > 1) {
          scopeStoreDrop(list.shift().k)
          continue
        }
        scopeStoreDrop(k)
        scopeStoreSaveLru([])
        return false
      }
    }
  }

  // --------------------------------------------------------------- fetch
  // A meta repeats far more often than it varies (that is the whole point of
  // the deck), so answers stay in memory for the session, keyed by level as
  // well as by area. Only successes are cached: a server that was asleep a
  // minute ago may well be awake now.
  const scopeGeoCache = new Map()
  // Windows made this a busier cache than it was: one whole shape per rung
  // plus a handful of windows as the user moves around. All of them small
  // except the whole shapes, and those are the ones worth never evicting.
  const SCOPE_CACHE_MAX = 24

  const scopeKey = (scope) =>
    scope.country + '|' + (Array.isArray(scope.regions) ? scope.regions.join('|') : '')

  const scopeCacheKey = (key, lod, win) => key + '|' + lod + (win ? '|' + win : '')

  function rememberScopeGeo(ck, res) {
    scopeGeoCache.set(ck, res)
    if (scopeGeoCache.size > SCOPE_CACHE_MAX) scopeGeoCache.delete(scopeGeoCache.keys().next().value)
  }

  /** Everything that can be had without touching the network. Memory first,
   * then — for the whole coarse shape only — the disk store. A window is never
   * stored: it belongs to one camera position and would be a waste of the
   * budget the shapes worth keeping are competing for. */
  function cachedScopeGeo(key, lod, win) {
    const ck = scopeCacheKey(key, lod, win)
    const hit = scopeGeoCache.get(ck)
    if (hit) {
      // Touched, so the eviction order is least-recently-*used* and a whole
      // shape still in play cannot be pushed out by the windows it feeds.
      scopeGeoCache.delete(ck)
      scopeGeoCache.set(ck, hit)
      return hit
    }
    if (lod !== 0 || win) return null
    const stored = scopeStoreGet(ck)
    if (stored) rememberScopeGeo(ck, stored)
    return stored || null
  }

  function fetchScopeGeo(scope, lod, win) {
    const level = lod || 0
    const key = scopeKey(scope)
    const box = win ? boxParam(win) : ''
    const ck = scopeCacheKey(key, level, box)
    const hit = cachedScopeGeo(key, level, box)
    if (hit) return Promise.resolve(hit)
    let path = SCOPE_GEO_PATH + '?country=' + encodeURIComponent(scope.country)
    if (Array.isArray(scope.regions) && scope.regions.length)
      path += '&regions=' + encodeURIComponent(scope.regions.join('|'))
    // Always explicit, including the level the server would default to: the
    // request URL is what shows up in a log when detail looks wrong.
    path += '&lod=' + level
    if (box) path += '&box=' + box
    // A 200 with nothing drawable counts as that source failing, not as an
    // answer: the only thing this code is allowed to do is draw a real shape,
    // and the next source may still have one.
    const drawable = (j) => !!(j && j.ok && j.geojson && Array.isArray(j.geojson.features) && j.geojson.features.length)
    return geoGet(path, SCOPE_TIMEOUT, drawable).then(({ json, source }) => {
      // Which machine drew this round's shape, carried on the payload so the
      // "scope drawn" line can say so — the same trip costing 40ms or 900ms is
      // the difference between the cloud and a laptop two rooms away, and that
      // is invisible from the timing alone.
      json.via = source
      rememberScopeGeo(ck, json)
      // Off the paint path deliberately: cheap as the write is, nothing waits
      // on it and the very next thing that happens is a draw. Re-serialised
      // rather than kept as the response text, which costs a millisecond on a
      // timer and keeps the stored copy identical to the cached one.
      if (level === 0 && !box) setTimeout(() => scopeStorePut(ck, JSON.stringify(json)), 0)
      return json
    })
  }

  /** Fetches the round's shape while the user is still guessing.
   *
   * The store is what makes the overlay feel instant, but it can only ever help
   * the *second* time a meta comes round: on a first encounter the card waits
   * on a LAN trip that costs about a second — nearly all of it GM_xmlhttpRequest
   * overhead rather than the server, which answers in under a millisecond — and
   * the camera moves twice, once for GeoGuessr's framing and again when the
   * shape finally turns up. A guess takes far longer than a second, so asking at
   * round start turns every first encounter into a store hit.
   *
   * The pano id is all the client has that early — the card, and with it the
   * scope, does not exist yet — so the server resolves it to the same scope the
   * card will carry. Everything here is best-effort: both machines down, a pano
   * from a map that was never indexed, a country with no boundary on file all
   * end the same way, with nothing warmed and nothing said. Deliberately the
   * one silent path in this file: a warm nobody asked for must never be the
   * thing that fills the log, and the card's own fetch says it far louder a
   * minute later. */
  function warmScopeGeo(panoId) {
    // Called once per round the moment the pano is served, which makes it the
    // one place that reliably knows a new round has begun — so last round's
    // answer is dropped here, before anything can mistake it for this one's.
    scopeWarm = null
    if (!panoId) return
    const t0 = Date.now()
    const placed = (j) => !!(j && j.ok && j.scope && typeof j.scope.country === 'string')
    geoGet(SCOPE_FOR_PANO_PATH + '?pano=' + encodeURIComponent(panoId), SCOPE_TIMEOUT, placed)
      .then(({ json }) => {
        const scope = json.scope
        scopeWarm = scope
        const key = scopeKey(scope)
        // Already in hand from an earlier round: the warm has done its job by
        // finding nothing left to do, and a request here would be pure waste.
        if (cachedScopeGeo(key, 0)) return
        return fetchScopeGeo(scope, 0).then((res) =>
          tlog('scope: ' + key + ' warmed ahead of the round from the ' + res.via + ' (' + (Date.now() - t0) + 'ms)'),
        )
      })
      .catch(() => {})
  }

  // ----------------------------------------------------------- the maps
  /** Arms the constructor wrap that feeds `__geocoachMaps`. The loader carries
   * the same hook and gets there first when it is current, but the body cannot
   * assume that: a loader is installed once and only updates when Tampermonkey
   * decides to, while the body reloads on every page. So this stands on its own —
   * an install still running an older loader, a body hot-reloaded mid-session, a
   * legacy direct install with no loader at all. Idempotent against the loader's
   * copy: the two share `__geocoachMapWrap`, so an already-wrapped constructor
   * comes back as the same proxy rather than being wrapped twice and buffering
   * every map twice. */
  function ensureMapCapture() {
    try {
      const buf = W.__geocoachMaps || (W.__geocoachMaps = [])
      // Every map that reaches the buffer gets its camera armed, and the buffer
      // is where that hook has to live. When the installed loader is current it
      // is *its* proxy the page constructs through, not ours, so a construct
      // trap here would never see the result map — but the loader still pushes
      // the instance into this array, so shadowing the array's own `push` sees
      // every map either wrapper builds. Non-enumerable, so nothing that walks
      // the buffer notices.
      if (!buf.__geocoachArmed) {
        const push = Array.prototype.push
        try {
          Object.defineProperty(buf, '__geocoachArmed', { value: true, configurable: true })
          Object.defineProperty(buf, 'push', {
            configurable: true,
            writable: true,
            value: function () {
              for (const m of arguments) armMapCamera(m)
              return push.apply(this, arguments)
            },
          })
        } catch {}
      }
      // Maps built before this ran (a body that loaded late) are armed here.
      for (const m of buf) armMapCamera(m)
      // The loader's own registry, shared: a constructor it already wrapped
      // must come back as the same proxy rather than be wrapped a second time,
      // or a hot-reloaded body would buffer every map once per layer.
      const wrapped = W.__geocoachMapWrap || (W.__geocoachMapWrap = new WeakMap())
      // Same proxy for the same constructor however it is reached — off the
      // namespace or out of importLibrary — so a second pass never hands back
      // the bare original.
      const wrapCtor = (Ctor) => {
        if (typeof Ctor !== 'function') return Ctor
        if (wrapped.has(Ctor)) return wrapped.get(Ctor)
        const proxy = new Proxy(Ctor, {
          construct(target, args, newTarget) {
            const inst = Reflect.construct(target, args, newTarget)
            try {
              buf.push(inst)
              if (buf.length > 20) buf.shift()
            } catch {}
            return inst
          },
        })
        wrapped.set(Ctor, proxy)
        wrapped.set(proxy, proxy)
        return proxy
      }
      // Mirrors the loader: cover both the namespace constructor and the
      // importLibrary handout, since either can be the one the page uses.
      const hookImportLibrary = (maps) => {
        const orig = maps.importLibrary
        if (typeof orig !== 'function' || orig.__geocoachWrapped) return
        const patched = function () {
          const pr = orig.apply(this, arguments)
          if (!pr || typeof pr.then !== 'function') return pr
          return pr.then((lib) => {
            try {
              if (lib && typeof lib.Map === 'function') lib.Map = wrapCtor(lib.Map)
            } catch {}
            return lib
          })
        }
        patched.__geocoachWrapped = true
        try {
          maps.importLibrary = patched
        } catch {}
      }
      // The namespace fills in piecemeal — `google`, then `google.maps`, then `Map`
      // on it — and the body normally loads before any of it exists. Reading the
      // namespace once and giving up when it is absent is the same as not hooking
      // at all: the map is built minutes later, unwrapped, and the result screen
      // has nothing to draw on. Every level that is missing gets an accessor that
      // arms the next one the moment it is assigned.
      const hookMaps = (maps) => {
        if (!maps || typeof maps !== 'object') return
        hookImportLibrary(maps)
        // `importLibrary` is sometimes bolted on a tick after the namespace object
        // itself exists; one late re-check catches that without polling.
        if (!maps.__geocoachLateChecked) {
          maps.__geocoachLateChecked = true
          setTimeout(() => hookImportLibrary(maps), 0)
        }
        if (typeof maps.Map === 'function') {
          const w = wrapCtor(maps.Map)
          if (w !== maps.Map) {
            try {
              maps.Map = w
            } catch {}
          }
          return
        }
        let val
        try {
          Object.defineProperty(maps, 'Map', {
            configurable: true,
            enumerable: true,
            get: () => val,
            set: (v) => (val = wrapCtor(v)),
          })
        } catch {}
      }
      const hookGoogle = (g) => {
        if (!g || typeof g !== 'object') return
        if (g.maps) return hookMaps(g.maps)
        let val
        try {
          Object.defineProperty(g, 'maps', {
            configurable: true,
            enumerable: true,
            get: () => val,
            set: (v) => {
              val = v
              hookMaps(v)
            },
          })
        } catch {}
      }
      if (W.google) hookGoogle(W.google)
      else {
        let val
        Object.defineProperty(W, 'google', {
          configurable: true,
          enumerable: true,
          get: () => val,
          set: (v) => {
            val = v
            hookGoogle(v)
          },
        })
      }
    } catch {}
  }

  // A collapsed or thumbnail-sized map is never the result map, and drawing a
  // country outline into one would be illegible anyway.
  const RESULT_MIN_W = 240
  const RESULT_MIN_H = 160

  function mapRect(m) {
    let div = null
    try {
      div = m && typeof m.getDiv === 'function' ? m.getDiv() : null
    } catch {}
    if (!div || !div.isConnected) return null
    try {
      return div.getBoundingClientRect()
    } catch {
      return null
    }
  }

  const isResultSized = (m) => {
    const r = mapRect(m)
    return !!r && r.width >= RESULT_MIN_W && r.height >= RESULT_MIN_H
  }

  function mapZoom(m) {
    try {
      const z = m && typeof m.getZoom === 'function' ? m.getZoom() : null
      if (typeof z === 'number' && isFinite(z)) return z
    } catch {}
    return 4 // a country-sized view: the middle of the weight ramp, lod 0
  }

  /** Several maps exist at once — the guess mini-map, the result map, whatever
   * the menu behind it rendered — and the one worth drawing on is simply the
   * biggest one actually on screen. Decided at draw time and never cached: the
   * same instance changes size and role between guessing and the result. */
  function pickResultMap() {
    const buf = W.__geocoachMaps
    if (!Array.isArray(buf)) return null
    let best = null
    let bestArea = 0
    for (const m of buf) {
      const r = mapRect(m)
      if (!r || r.width < RESULT_MIN_W || r.height < RESULT_MIN_H) continue
      const area = r.width * r.height
      if (area > bestArea) {
        bestArea = area
        best = m
      }
    }
    return best
  }

  /** What the buffer looked like when something went wrong. "No overlay this
   * round" has three quite different causes — nothing captured, nothing on
   * screen, nothing big enough — and this line is what tells them apart
   * afterwards, from a log shipped off a machine we were not sitting at. */
  function describeMaps() {
    const buf = W.__geocoachMaps
    if (!Array.isArray(buf)) return 'no capture buffer'
    if (!buf.length) return 'buffer empty'
    return buf
      .map((m) => {
        const r = mapRect(m)
        return r ? Math.round(r.width) + '×' + Math.round(r.height) : 'detached'
      })
      .join(' ')
  }

  // -------------------------------------------------------------- camera
  // The sequence this replaces: GeoGuessr fitBounds to frame guess+answer, the
  // map zooms in, our geometry lands a second later, a second fitBounds jerks
  // it back out. Two camera moves in opposite directions, which reads as a
  // glitch however good each one is on its own.
  //
  // So the widen happens *inside* GeoGuessr's own move. Their fitBounds is held
  // for a few hundred milliseconds — invisible, where a double zoom is not —
  // and released once over the union of what they asked for and the region. One
  // move, straight to the final framing. The hold is armed by the guess POST
  // (see onRequest), which is the earliest moment anything knows a result is
  // coming, and expires by itself, so the worst a bug here can do is delay
  // GeoGuessr's framing by SCOPE_HOLD_MS.
  const SCOPE_HOLD_MS = 350
  // From guess POST to result framing is well under a second; the window only
  // has to be generous enough to cover a slow render and mean enough that a map
  // resize twenty seconds later is not mistaken for one.
  const SCOPE_ARM_MS = 12000
  const SCOPE_TWEEN_MS = 600

  let scopeHoldArmed = 0 // when the guess POST went out, 0 once spent
  let scopeHeld = null // a fitBounds call being sat on
  let scopeBox = null // the region's box, once known, for this round
  let scopeCamTouched = false // the user has taken the map; we never move it again
  let scopeCamSettled = false // our one framing decision has been made
  let scopeCamRound = null // which round the three flags above belong to
  let scopeTween = null
  // The scope the server resolved for the round being played, if the warm got
  // there in time. Cleared when a new round is served, read by the guess POST.
  let scopeWarm = null

  /** Called the instant the guess POST leaves the page — before GeoGuessr has
   * its answer, let alone its result map — because that is the last moment at
   * which the hold can be armed ahead of the framing it means to catch. */
  function armScopeHold() {
    releaseHeld() // a hold left over from a previous round must never linger
    cancelScopeTween()
    scopeHoldArmed = Date.now()
    scopeBox = null
    scopeCamTouched = false
    scopeCamSettled = false
    scopeCamRound = 'armed'
    // The warm resolved this round's region while the user was still guessing,
    // so its extent is in hand a good half-second before the card that names
    // it. Handing it over here is what lets the hold below end the moment it
    // begins: GeoGuessr's own fitBounds goes out already widened, and the
    // region is framed by the same move that frames the guess. Without it the
    // hold can only wait out its few hundred milliseconds and give up, and the
    // framing has to be corrected afterwards — the visible jump.
    try {
      const warm = scopeWarm && cachedScopeGeo(scopeKey(scopeWarm), 0)
      if (warm) offerScopeBox(boxOf(warm))
    } catch {}
  }

  /** Adopts the round's camera state. If armScopeHold already ran for this
   * round the flags are its, untouched — the user may have grabbed the map in
   * the meantime and that decision outranks everything here. */
  function startRoundCamera(roundKey) {
    if (scopeCamRound === 'armed') {
      scopeCamRound = roundKey
      return
    }
    if (scopeCamRound === roundKey) return
    scopeCamRound = roundKey
    scopeBox = null
    scopeCamTouched = false
    scopeCamSettled = false
  }

  function cancelScopeTween() {
    if (!scopeTween) return
    scopeTween.dead = true
    scopeTween = null
  }

  /** The region's extent, from wherever it came from — the disk store on the
   * frame the card appeared, or the LAN a second later. A hold waiting on it
   * ends here. */
  function offerScopeBox(box) {
    if (!boxIsSane(box)) return
    scopeBox = box
    if (scopeHeld) releaseHeld()
  }

  const holdWanted = (map) =>
    !!scopeHoldArmed &&
    Date.now() - scopeHoldArmed < SCOPE_ARM_MS &&
    !scopeCamTouched &&
    !scopeHeld &&
    isResultSized(map)

  /** Lets the held fitBounds through, widened to hold the region if the region
   * would otherwise be cut off. Called by the geometry arriving, by the hold
   * timing out, and by a new round arming over the top of it — whichever comes
   * first, and never twice. */
  function releaseHeld() {
    const held = scopeHeld
    if (!held) return
    scopeHeld = null
    try {
      clearTimeout(held.timer)
    } catch {}
    const args = held.args
    try {
      const asked = boxOfBounds(args[0])
      if (asked && scopeBox && !scopeCamTouched) {
        if (shouldWiden(scopeBox, asked, WIDEN_FREE)) {
          const b = latLngBounds(boxUnion(asked, scopeBox))
          if (b) {
            args[0] = b
            scopeCamSettled = true
            tlog('scope: region folded into GeoGuessr’s own camera move after ' + (Date.now() - held.t) + 'ms')
          }
        } else {
          scopeCamSettled = true // already in frame — this framing is the final one
        }
      }
    } catch {}
    try {
      held.orig.apply(held.map, args)
    } catch {}
  }

  function latLngBounds(box) {
    const g = W.google && W.google.maps
    if (!g || typeof g.LatLngBounds !== 'function') return null
    try {
      const b = new g.LatLngBounds()
      b.extend({ lat: box.n, lng: box.e })
      b.extend({ lat: box.s, lng: box.w })
      return b
    } catch {
      return null
    }
  }

  /** Wraps one map instance's fitBounds and watches for the user taking the
   * wheel. Done per instance rather than in the constructor proxy on purpose:
   * when the installed loader is current the page constructs through *its*
   * proxy, so a construct trap in this file never runs — see ensureMapCapture. */
  function armMapCamera(map) {
    if (!map || typeof map !== 'object' || map.__geocoachCam) return
    let orig = null
    try {
      orig = map.fitBounds
    } catch {}
    if (typeof orig !== 'function') return
    try {
      Object.defineProperty(map, '__geocoachCam', { value: true, configurable: true })
      map.fitBounds = function () {
        const args = Array.prototype.slice.call(arguments)
        try {
          if (holdWanted(this)) {
            scopeHoldArmed = 0 // one hold per round, whatever else calls fitBounds
            const held = { map: this, orig, args, t: Date.now(), timer: 0 }
            held.timer = setTimeout(() => {
              if (scopeHeld !== held) return
              tlog('scope: camera hold expired with no geometry — GeoGuessr’s framing stands')
              releaseHeld()
            }, SCOPE_HOLD_MS)
            scopeHeld = held
            // The store can answer before this call is even made, in which case
            // the hold is over as soon as it began.
            if (scopeBox) releaseHeld()
            return undefined
          }
          // Not the held call — GeoGuessr re-framing later, or nothing armed at
          // all. Their move wins over any tween of ours, and if the region is
          // in hand it may as well ride along in this one too.
          if (scopeBox && !scopeCamTouched) {
            cancelScopeTween()
            const asked = boxOfBounds(args[0])
            if (asked && shouldWiden(scopeBox, asked, WIDEN_FREE)) {
              const b = latLngBounds(boxUnion(asked, scopeBox))
              if (b) {
                args[0] = b
                scopeCamSettled = true
              }
            }
          }
        } catch {}
        return orig.apply(this, args)
      }
    } catch {
      return
    }
    // Once the user has moved the map it is theirs for the rest of the round —
    // no widen, no tween, nothing. A drag fires through the Maps API; a wheel
    // or a press only ever reaches the div.
    const touched = () => {
      if (scopeCamTouched) return
      scopeCamTouched = true
      cancelScopeTween()
      tlog('scope: user took the map — the camera is left alone for this round')
    }
    try {
      if (typeof map.addListener === 'function') map.addListener('dragstart', touched)
    } catch {}
    try {
      const div = typeof map.getDiv === 'function' ? map.getDiv() : null
      if (div && typeof div.addEventListener === 'function') {
        div.addEventListener('wheel', touched, { passive: true, capture: true })
        div.addEventListener('pointerdown', touched, { capture: true })
      }
    } catch {}
  }

  /** An eased move of centre and zoom, for when the geometry missed the hold.
   * fitBounds would snap and panToBounds will not zoom, so the target zoom is
   * worked out here and both are stepped by hand. Abandoned the moment the user
   * touches anything. */
  function tweenCamera(map, center, zoom, ms) {
    let from = null
    try {
      const c = map.getCenter()
      const z = map.getZoom()
      if (c && typeof z === 'number' && isFinite(z)) from = { lat: c.lat(), lng: c.lng(), z }
    } catch {}
    if (!from || typeof map.setCenter !== 'function' || typeof map.setZoom !== 'function') return false
    cancelScopeTween()
    const tw = { dead: false }
    scopeTween = tw
    const t0 = Date.now()
    const step = () => {
      if (tw.dead || scopeCamTouched) return
      const k = easeInOut((Date.now() - t0) / ms)
      try {
        map.setZoom(from.z + (zoom - from.z) * k)
        map.setCenter({ lat: from.lat + (center.lat - from.lat) * k, lng: lerpLng(from.lng, center.lng, k) })
      } catch {
        tw.dead = true
        return
      }
      if (k < 1) requestAnimationFrame(step)
      else if (scopeTween === tw) scopeTween = null
    }
    requestAnimationFrame(step)
    return true
  }

  /** The framing the hold could not make, because the geometry arrived after
   * GeoGuessr's camera had already moved. This one the user *will* see move, so
   * it only fires when the region is genuinely half off-screen, and it eases
   * rather than snaps. Once per round either way: settling the question counts
   * as answering it, even when the answer is "leave it". */
  function frameScope(map) {
    if (scopeCamSettled || scopeCamTouched || scopeHeld || !scopeBox) return
    let view = null
    try {
      view = boxOfBounds(map.getBounds())
    } catch {}
    if (!view) return // the map has not settled yet — its framing is not ours to judge
    if (!shouldWiden(scopeBox, view, WIDEN_LATE)) {
      scopeCamSettled = true
      return
    }
    const rect = mapRect(map)
    if (!rect) return
    const target = boxUnion(view, scopeBox)
    const zoom = zoomForBox(target, rect.width, rect.height, 64)
    if (zoom == null) return
    scopeCamSettled = true
    // Widening only: the union can never need a closer zoom than the view it
    // contains, and a rounding error that zoomed *in* would be very visible.
    const to = Math.min(zoom, mapZoom(map))
    if (tweenCamera(map, boxCenter(target), to, SCOPE_TWEEN_MS))
      tlog('scope: eased out to hold the region (z' + mapZoom(map).toFixed(1) + '→z' + to.toFixed(1) + ')')
  }

  // -------------------------------------------------------------- paint
  // Bumped by every draw and every teardown. A geometry fetch that lands after
  // the card it belongs to is gone — dismissed, next round, navigated away —
  // sees a stale generation and does nothing.
  let scopeGen = 0
  let scopeLayers = [] // the Data pair currently on the map
  let scopeStyle = null // restyles that pair
  let scopeStyled = '' // the weights it was last styled with
  let scopeFadeK = 1 // and the opacity level, so a restyle mid-fade keeps it
  let scopeMap = null
  let scopeGeojson = null
  let scopeScope = null // the round's scope, for fetching finer levels
  let scopeLod = -1
  let scopeClip = null // the window the drawn geometry covers; null means all of it
  let scopeFine = false // …and whether that geometry came from a windowed ask
  let scopeFetching = '' // the request in flight, so a settling map cannot stack them
  let scopeRehomes = 0
  let scopeTimers = []
  let scopeListeners = []

  function removeScopeOverlay() {
    scopeGen++
    for (const layer of scopeLayers) {
      try {
        layer.setMap(null)
      } catch {}
    }
    scopeLayers = []
    scopeStyle = null
    scopeStyled = ''
    scopeFadeK = 1
    scopeMap = null
    scopeGeojson = null
    scopeScope = null
    scopeLod = -1
    scopeClip = null
    scopeFine = false
    scopeFetching = ''
    scopeRehomes = 0
    for (const t of scopeTimers) {
      try {
        clearTimeout(t)
      } catch {}
    }
    scopeTimers = []
    for (const l of scopeListeners) {
      try {
        l.remove()
      } catch {}
    }
    scopeListeners = []
    cancelScopeTween()
    // The round is over, so its box must not widen the summary screen's map.
    // A held fitBounds is deliberately *not* released here: showCard tears the
    // previous overlay down microseconds before drawing the new one, and
    // releasing there would spend the hold on the round it was armed for.
    scopeBox = null
  }

  /** Two passes over the same shape: a wide, soft violet stroke underneath and
   * a crisp thin one on top, which reads as a faint glow around the border
   * instead of a flat line — and keeps the edge findable where it runs over
   * dark water or a busy coastline. `k` is the opacity the pair starts at: 0
   * for a first paint about to fade up, the level already on screen for a pair
   * being swapped in mid-round. Either way it is styled before the features
   * land, so there is never a default-blue first frame. */
  function paintScope(map, geojson, k) {
    const g = W.google && W.google.maps
    if (!g || typeof g.Data !== 'function') return null
    const glow = new g.Data({ map })
    const main = new g.Data({ map })
    // clickable:false throughout: the overlay must never swallow a click meant
    // for the map underneath it.
    const style = (op, w) => {
      glow.setStyle({
        clickable: false,
        zIndex: 1,
        fillOpacity: 0,
        strokeColor: SCOPE_GLOW,
        strokeOpacity: 0.5 * op,
        strokeWeight: w.glow,
      })
      main.setStyle({
        clickable: false,
        zIndex: 2,
        strokeColor: SCOPE_INK,
        strokeOpacity: 0.95 * op,
        strokeWeight: w.main,
        fillColor: SCOPE_INK,
        fillOpacity: SCOPE_FILL_ALPHA * op,
      })
    }
    style(k, scopeWeights(mapZoom(map)))
    glow.addGeoJson(geojson)
    main.addGeoJson(geojson)
    return { layers: [glow, main], style }
  }

  function applyScopeStyle(k) {
    if (!scopeStyle) return
    scopeFadeK = k
    const w = scopeWeights(mapZoom(scopeMap))
    scopeStyled = w.glow + ':' + w.main
    scopeStyle(k, w)
  }

  /** Weights follow the zoom, but only when they actually change — a restyle
   * walks every coordinate in the shape, and at lod 2 that is not free. */
  function restyleScope() {
    if (!scopeStyle) return
    const w = scopeWeights(mapZoom(scopeMap))
    if (scopeStyled === w.glow + ':' + w.main) return
    applyScopeStyle(scopeFadeK)
  }

  /** A few-hundred-KB outline snapping into existence looks like a glitch, so
   * the first paint arrives instead: both layers fade up together, ease-out, in
   * a third of a second. Only ever the first paint — see FADE_POINT_LIMIT. */
  function fadeScopeIn() {
    const gen = scopeGen
    const t0 = Date.now()
    const FADE = 320
    const step = () => {
      if (gen !== scopeGen) return
      const t = Math.min(1, (Date.now() - t0) / FADE)
      applyScopeStyle(t * (2 - t))
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  function adoptScopePair(map, pair) {
    const old = scopeLayers
    scopeLayers = pair.layers
    scopeStyle = pair.style
    scopeMap = map
    if (!old.length) return
    // Remove-then-add flashes the map bare for a frame. Inverted: the new pair
    // is already styled and attached, so the old one only has to survive until
    // the browser has painted the new one — one frame.
    requestAnimationFrame(() => {
      for (const l of old) {
        try {
          l.setMap(null)
        } catch {}
      }
    })
  }

  /** The same region drawn from different geometry. No fade: this is not an
   * arrival, it is an outline changing resolution, and fading it would
   * advertise a change nobody asked to see. */
  function swapScopeGeometry(map, res, win, key) {
    const pair = paintScope(map, res.geojson, scopeFadeK)
    if (!pair) return
    adoptScopePair(map, pair)
    const was = scopeLod
    scopeGeojson = res.geojson
    scopeLod = typeof res.lod === 'number' ? res.lod : scopeLod
    // What the server says it covered, not what was asked for — a window that
    // missed the region entirely comes back as the whole shape, and the two
    // must not be confused. Falling back to the ask keeps the loop below from
    // re-asking for a window the server has already declined to cut.
    scopeClip = (res.clip && { n: res.clip.n, s: res.clip.s, e: res.clip.e, w: res.clip.w }) || win || null
    scopeFine = !!win
    scopeStyled = '' // the new pair has its own styles; let the next zoom restyle it
    tlog(
      'scope ' +
        key +
        ': ' +
        (win
          ? 'lod ' + scopeLod + ' cut to the visible map'
          : scopeLod > was
            ? 'detail up to lod ' + scopeLod
            : 'back to the whole shape at lod ' + scopeLod) +
        ' (' +
        countPoints(res.geojson) +
        ' pts)',
    )
  }

  /** Detail follows the camera.
   *
   * The coarsest rung is the whole shape, because at that zoom the whole shape
   * is what is on screen. The finer two are a window: the visible map grown by
   * a quarter in each direction, cut server-side, so the cost of drawing a
   * coastline properly is set by the size of the map and not by the size of the
   * country. Panning out of that window fetches the next one; zooming back out
   * puts the whole shape back, which is free, because it has been in memory
   * since the card appeared. */
  function syncScopeDetail(map, gen) {
    if (gen !== scopeGen || !scopeScope || !scopeMap) return
    const want = lodForZoom(mapZoom(map))
    const view = viewBox(map)
    const win = want >= FINE_LOD ? padBox(view) : null
    // Already showing what this camera is asking for. Two different questions:
    // a window has to still contain the map, while the whole shape only has to
    // be at least as fine as the rung wants — zooming out never degrades it.
    if (win ? scopeFine && boxCovers(scopeClip, view) : !scopeFine && want <= scopeLod) return
    const scope = scopeScope
    const key = scopeKey(scope)
    const ck = scopeCacheKey(key, want, win && boxParam(win))
    if (ck === scopeFetching) return
    scopeFetching = ck
    fetchScopeGeo(scope, want, win).then(
      (res) => {
        if (scopeFetching === ck) scopeFetching = ''
        if (gen !== scopeGen || !scopeMap) return
        // A server that predates the ladder ignores ?lod and answers with the
        // same full geometry every time. Swapping identical shapes would cost a
        // rebuild for nothing, so a whole-shape swap needs the detail to have
        // actually gone up — and once it has not, this rung is not worth asking
        // for again this round. A window is exempt: it is *meant* to have fewer
        // points than the shape it was cut from.
        if (!win && !scopeFine && countPoints(res.geojson) <= countPoints(scopeGeojson)) {
          scopeLod = Math.max(scopeLod, want)
          tlogOnce(
            'scope-lod-flat:' + key + ':' + want,
            'scope ' + key + ': lod ' + want + ' is no finer than what is drawn — staying put',
          )
          return
        }
        swapScopeGeometry(scopeMap, res, win, key)
      },
      (err) => {
        if (scopeFetching === ck) scopeFetching = ''
        tlogOnce(
          'scope-lod-fail:' + key + ':' + want,
          'scope ' + key + ': lod ' + want + ' unavailable (' + ((err && err.message) || 'failed') + ')',
        )
      },
    )
  }

  /** The result map is not always the map that existed when the card appeared:
   * GeoGuessr re-mounts it, and a shape drawn on the outgoing instance is gone
   * from the screen while every variable here still says it was drawn. That is
   * the shape of "sometimes the overlay doesn't take". So the choice of map is
   * re-made for a few seconds after the first paint, and the geometry moves
   * house without a flicker when it turns out to have changed. */
  function rehomeIfMoved(gen) {
    if (gen !== scopeGen || !scopeMap || !scopeGeojson || scopeRehomes >= 3) return
    const map = pickResultMap()
    if (!map || map === scopeMap) return
    const pair = paintScope(map, scopeGeojson, scopeFadeK)
    if (!pair) return
    scopeRehomes++
    adoptScopePair(map, pair)
    scopeStyled = ''
    watchMap(map, false)
    tlog('scope: result map changed under the overlay — redrawn on the new one (' + describeMaps() + ')')
    frameScope(map)
  }

  function watchMap(map, watchdog) {
    const gen = scopeGen
    const on = (evt, fn) => {
      try {
        if (typeof map.addListener !== 'function') return
        const l = map.addListener(evt, fn)
        if (l) scopeListeners.push(l)
      } catch {}
    }
    let settleTimer = 0
    const settled = () => {
      if (gen !== scopeGen) return
      restyleScope()
      syncScopeDetail(map, gen)
      rehomeIfMoved(gen)
    }
    on('idle', settled)
    on('zoom_changed', () => {
      if (gen !== scopeGen) return
      restyleScope() // weights track the zoom immediately; only the fetch waits
      try {
        clearTimeout(settleTimer)
      } catch {}
      settleTimer = setTimeout(settled, 250) // a spun wheel must not fire three requests
      scopeTimers.push(settleTimer)
    })
    if (!watchdog) return
    // `idle` alone is not enough for the re-mount case: the new map fires its
    // own idle, not the old one's, and the old one may never fire again.
    for (const ms of [400, 1200, 3000, 6000]) scopeTimers.push(setTimeout(() => rehomeIfMoved(gen), ms))
  }

  // The card is drawn the instant the guess is graded, which can be a beat
  // before the result map is mounted and sized. Twelve seconds of looking is
  // not a fix for anything on its own — the fix is rehomeIfMoved and the log
  // line below — but it costs nothing and it covers a genuinely slow mount.
  const SCOPE_MAP_WAIT = 12000

  function waitForResultMap(gen, cb) {
    const t0 = Date.now()
    let looks = 0
    const tick = () => {
      if (gen !== scopeGen) {
        // The overlay was torn down while it was still looking for a map: the
        // next round started, or the card was closed. Common and correct — but
        // indistinguishable from a bug in a log that says nothing.
        if (looks) tlog('scope: gave up looking for a map after ' + looks + ' looks — the round had moved on')
        return
      }
      looks++
      const map = pickResultMap()
      if (map) {
        try {
          cb(map, Date.now() - t0)
        } catch (err) {
          // A half-drawn overlay is worse than none.
          removeScopeOverlay()
          tlog('scope draw failed: ' + (err && err.message))
        }
        return
      }
      if (Date.now() - t0 < SCOPE_MAP_WAIT) {
        scopeTimers.push(setTimeout(tick, 200))
        return
      }
      tlog(
        'scope: no visible map to draw on after ' +
          (Date.now() - t0) +
          'ms and ' +
          looks +
          ' looks — ' +
          describeMaps(),
      )
    }
    tick()
  }

  /** Draws the card's scope on the result map. Called by showCard and torn
   * down by removeCard, so the overlay and the card share one lifetime. */
  function drawScopeOverlay(card) {
    try {
      const scope = card && card.scope
      // Older payloads have no scope at all, and that is not a failure — it
      // simply means there is nothing to draw.
      if (!scope || typeof scope.country !== 'string' || !scope.country) {
        // Not a failure on old payloads, which carry no scope at all — but on a
        // current one it means the server had no country for the round, and
        // that is worth a line rather than an overlay that never appears.
        if (card && card.metaName) tlog('scope: no area on the card for ' + card.metaName)
        return
      }
      // showCard already refuses to run during ranked, but this path is async:
      // the answer could arrive after the user has started a duel, and ranked
      // play gets no help of any kind.
      if (/^\/(duels|team-duels)\//.test(location.pathname)) return
      ensureMapCapture()
      removeScopeOverlay()
      const gen = scopeGen
      const key = scopeKey(scope)
      startRoundCamera((card.roundId || '') + ':' + key)
      scopeScope = scope
      const t0 = Date.now()
      const arrived = (res, source) => {
        if (gen !== scopeGen) return tlog('scope ' + key + ': the round ended before the shape arrived')
        // Before the paint, and before the map even has to exist: the box is
        // what a held fitBounds is waiting on, and every millisecond of that
        // hold is one GeoGuessr's framing is late by. Its own try: a camera
        // that cannot be aimed is no reason to skip drawing the outline.
        try {
          offerScopeBox(boxOf(res))
        } catch (err) {
          tlog('scope ' + key + ': camera box failed — ' + ((err && err.message) || 'unknown'))
        }
        const lod = typeof res.lod === 'number' ? res.lod : 0
        waitForResultMap(gen, (map, waited) => {
          const fade = countPoints(res.geojson) <= FADE_POINT_LIMIT
          const pair = paintScope(map, res.geojson, fade ? 0 : 1)
          if (!pair) return tlog('scope ' + key + ': google.maps.Data is not there to draw with')
          adoptScopePair(map, pair)
          scopeGeojson = res.geojson
          scopeLod = lod
          scopeClip = null
          scopeFine = false
          scopeFadeK = fade ? 0 : 1
          if (fade) fadeScopeIn()
          tlog(
            'scope drawn: ' +
              (res.kind || '?') +
              ' ' +
              (res.label || key) +
              ' (' +
              res.geojson.features.length +
              ' feature(s), lod ' +
              lod +
              ', ' +
              countPoints(res.geojson) +
              ' pts, ' +
              source +
              ', map after ' +
              waited +
              'ms, ' +
              (Date.now() - t0) +
              'ms total)',
          )
          frameScope(map)
          watchMap(map, true)
          syncScopeDetail(map, gen)
        })
      }
      // The whole point of the disk store: on a repeated meta the shape is in
      // hand synchronously, so the card, the outline and GeoGuessr's camera all
      // land together instead of a second apart.
      const cached = cachedScopeGeo(key, 0)
      if (cached) {
        arrived(cached, 'stored')
        return
      }
      fetchScopeGeo(scope, 0).then(
        (res) => arrived(res, (res.via || 'server') + ' ' + (Date.now() - t0) + 'ms'),
        // The one line that says the overlay was meant to be here and is not,
        // naming every source that was asked and what each said. It is the only
        // trace: nothing is toasted, and the map simply looks normal.
        (err) => tlog('scope ' + key + ': no shape — ' + ((err && err.message) || 'failed')),
      )
    } catch {}
  }

  function removeCard() {
    document.getElementById('geocoach-card')?.remove()
    removeScopeOverlay()
  }

  /** The Plonkit guide for this card: LM's footer usually links it; otherwise
   * derive the country page from the "Country: Meta" name. */
  function guideUrl(card) {
    const m = (card.footer ?? '').match(/https?:\/\/(?:www\.)?plonkit\.net\/[a-z0-9-]+/i)
    if (m) return m[0]
    const country = (card.metaName ?? '').split(':')[0].trim()
    if (!country) return null
    const slug = country
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
    return slug ? `https://www.plonkit.net/${slug}` : null
  }

  /** Post-round lesson card: the meta you were meant to spot, LM's own words.
   * The footer link opens the Plonkit guide; the card stays until the next
   * round starts (or you ✕ it) so you can read the guide and come back. */
  function showCard(card) {
    if (!card || (!card.note && !card.metaName)) return
    if (/^\/(duels|team-duels)\//.test(location.pathname)) return // never during ranked
    tlog('showCard: ' + (card.metaName || 'note-only'))
    removeCard()
    const url = guideUrl(card)
    const el = document.createElement('div')
    el.id = 'geocoach-card'
    el.style.cssText =
      'position:fixed;bottom:80px;right:16px;z-index:999998;width:380px;max-width:calc(100vw - 32px);' +
      'max-height:calc(100vh - 120px);display:flex;flex-direction:column;' +
      'background:linear-gradient(165deg,#2b1b58 0%,#1a1038 100%);color:#e8e4f6;' +
      'border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;' +
      // Layered depth: a hairline top highlight (light from above), a tight
      // contact shadow, and two soft falloffs — reads as a raised panel.
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 2px 6px rgba(5,0,25,.4),' +
      '0 14px 28px -6px rgba(5,0,25,.55),0 32px 64px -12px rgba(5,0,25,.65);' +
      'font-size:13px;line-height:1.55;cursor:grab;' +
      'opacity:0;transform:translateY(10px);transition:opacity .25s ease,transform .25s ease'
    // Size persists like position — but only as a *cap*. The card's real height
    // is min(content, your cap, space to the bottom of the screen), so it can
    // never be stretched past its content or hang off the viewport.
    let capH = Infinity
    try {
      const size = JSON.parse(localStorage.getItem('gc-card-size'))
      if (size && size.w) el.style.width = Math.max(300, Math.min(innerWidth - 24, size.w)) + 'px'
      if (size && size.h) capH = Math.max(160, size.h)
    } catch {}
    // Room is measured from fixed anchors only (the bottom offset, or the
    // dragged top), never from the card's own rect — a bottom-anchored card's
    // top moves down as the cap shrinks, so rect-based room would feed back
    // into an ever-smaller cap.
    const clampH = () => {
      const room =
        el.style.bottom === 'auto'
          ? innerHeight - Math.max(0, parseFloat(el.style.top) || 0) - 12
          : innerHeight - 92 // 80px bottom offset + 12px top margin
      // The head never scrolls and the foot never clips: a too-small saved cap
      // is overruled by what those two bands actually need (plus an image
      // sliver), up to whatever the viewport can hold.
      const need = head.offsetHeight + foot.offsetHeight + (mid.childElementCount ? 90 : 0) + 2
      el.style.maxHeight = Math.max(Math.min(capH, room), Math.min(need, room), 160) + 'px'
    }
    const onResize = () =>
      el.isConnected ? clampH() : removeEventListener('resize', onResize)
    addEventListener('resize', onResize)
    const badgeDepth = 'box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 2px 5px rgba(5,0,25,.4);'
    const badge = card.correct
      ? `<span style="background:linear-gradient(180deg,#c9f75d,#97e851);color:#17300d;${badgeDepth}font-weight:700;font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap">✓ Got it</span>`
      : `<span style="background:linear-gradient(180deg,#ffcf7c,#f5a838);color:#33230a;${badgeDepth}font-weight:700;font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap">✗ Missed clue</span>`
    // Three bands: header and footer are always visible; only the images
    // scroll. However small the card gets, you can read what the meta is and
    // reach the rating buttons — the middle absorbs all the overflow.
    const head = document.createElement('div')
    // Never shrinks, never scrolls — the note is always fully readable.
    // clampH grows the card to guarantee this fits alongside the footer.
    head.style.cssText = 'flex:0 0 auto;padding:14px 16px 12px'
    head.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px">` +
      `<b style="font-size:15px;letter-spacing:.01em">${card.metaName ?? ''}</b>` +
      `<div style="display:flex;gap:8px;align-items:center">${badge}` +
      `<span class="gc-close" style="cursor:pointer;opacity:.55;font-size:16px;line-height:1;padding:2px">✕</span></div></div>` +
      `<div style="color:#d6d0ea">${card.note ?? ''}</div>`
    el.appendChild(head)
    const mid = document.createElement('div')
    // Absorbs the overflow first (shrink 99), but keeps a scrollable sliver
    // when images exist so they never vanish entirely from a squeezed card.
    mid.style.cssText = `flex:1 99 auto;min-height:${card.images && card.images.length ? 90 : 0}px;overflow-y:auto`
    if (card.images && card.images.length)
      mid.innerHTML =
        `<div style="display:grid;gap:2px">` +
        card.images
          .slice(0, 2)
          // Tall/thin images letterbox inside a capped frame instead of
          // scaling to full width and forcing a mile of scrolling.
          .map((u) => `<img src="${u}" style="width:100%;max-height:min(45vh,360px);object-fit:contain;display:block;background:#150c33">`)
          .join('') +
        `</div>`
    el.appendChild(mid)
    // What each grade means for the schedule — hover any button to see it.
    const RATE_TIP = {
      again: "Didn't know it — the meta comes back within minutes",
      hard: 'Got it, but slowly or unsurely — shorter wait than normal',
      good: 'Recalled it with a bit of thought — the normal interval',
      easy: 'Knew it instantly — waits much longer before returning',
    }
    const foot = document.createElement('div')
    foot.style.cssText = 'flex:0 0 auto'
    foot.innerHTML =
      (card.rating && card.roundId
        ? `<div class="gc-rate" style="padding:12px 14px 4px">` +
          // The ⓘ advertises the button tooltips (and carries one itself) —
          // without it there's no hint that hovering a grade explains it.
          `<div style="display:flex;justify-content:space-between;align-items:center;margin:0 2px 7px">` +
          `<span style="font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:rgba(232,228,246,.42)">Rate your recall</span>` +
          `<span title="Hover any grade to see what it means for your review schedule" style="cursor:help;font-size:9px;font-weight:700;font-style:italic;font-family:Georgia,serif;color:rgba(232,228,246,.5);border:1px solid rgba(232,228,246,.32);border-radius:999px;width:13px;height:13px;line-height:11px;text-align:center;user-select:none">i</span></div>` +
          `<div style="display:flex;gap:7px">` +
          ['again', 'hard', 'good', 'easy']
            .map((r) => `<button data-rate="${r}" title="${RATE_TIP[r]}">${r[0].toUpperCase() + r.slice(1)}</button>`)
            .join('') +
          `</div></div>`
        : '') +
      (url
        ? `<a href="${url}" target="_blank" rel="noopener" style="display:block;padding:11px 16px;margin-top:8px;font-size:11.5px;font-weight:700;color:#a3e961;letter-spacing:.02em;text-decoration:none;background:rgba(5,0,25,.25);border-top:1px solid rgba(255,255,255,.07)">Open Plonkit guide ↗</a>`
        : '')
    el.appendChild(foot)
    // FSRS rating row: the server pre-selects the inferred grade; tapping a
    // different button re-grades the round. Doing nothing keeps the default,
    // so the zero-interaction flow behaves exactly as before.
    const rateRow = foot.querySelector('.gc-rate')
    if (rateRow) {
      // Hue tracks how well you knew it: red (forgot) through amber to
      // GeoGuessr's own green for good. Easy gets its own blue rather than a
      // deeper green — two greens next to each other read as the same button.
      const RATE_STYLE = {
        again: ['#ff8d7d', '#e2544a', '#330703'],
        hard: ['#ffc76e', '#ef9f2e', '#33230a'],
        good: ['#97e851', '#68c045', '#17300d'],
        easy: ['#7dc4ff', '#3f8fdf', '#081c33'],
      }
      if (!document.getElementById('gc-anim')) {
        const st = document.createElement('style')
        st.id = 'gc-anim'
        st.textContent =
          '@keyframes gc-pop{0%{transform:translateY(-1px) scale(1)}45%{transform:translateY(-2px) scale(1.05)}100%{transform:translateY(-1px) scale(1)}}'
        document.head.appendChild(st)
      }
      const btns = rateRow.querySelectorAll('button')
      // Selected = raised key (gradient, lifted, drop shadow); others = pressed
      // into the card (inset shadow) — the same light model as the card itself.
      const paint = (sel) =>
        btns.forEach((b) => {
          const on = b.dataset.rate === sel
          const [top, bot, ink] = RATE_STYLE[b.dataset.rate]
          b.style.cssText =
            'flex:1;padding:8px 0;border:0;border-radius:10px;font:700 11px/1 system-ui;' +
            'letter-spacing:.03em;cursor:pointer;user-select:none;transition:all .15s ease;' +
            (on
              ? `background:linear-gradient(180deg,${top},${bot});color:${ink};transform:translateY(-1px);` +
                'box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 3px 8px rgba(5,0,25,.5),0 1px 2px rgba(5,0,25,.4)'
              : 'background:rgba(255,255,255,.05);color:#a99fce;transform:none;' +
                'box-shadow:inset 0 2px 4px rgba(5,0,25,.35),inset 0 -1px 0 rgba(255,255,255,.05)')
        })
      paint(card.rating)
      rateRow.addEventListener('click', (e) => {
        e.stopPropagation() // a rating tap must never open the guide or dismiss
        const b = e.target.closest('button')
        if (!b || dragMoved) return
        paint(b.dataset.rate)
        // A quick overshoot-and-settle on the chosen button — enough motion
        // to confirm the tap without turning the card into a toy.
        b.style.animation = 'gc-pop .3s cubic-bezier(.34,1.56,.64,1)'
        postRate(card.roundId, b.dataset.rate)
      })
    }
    // Set by both gestures (move-drag and resize) so the click that fires on
    // release doesn't read as "open the guide and dismiss".
    let dragMoved = false
    // Corner grip: drag to resize; the chosen size sticks for future cards.
    const grip = document.createElement('div')
    grip.className = 'gc-grip'
    grip.style.cssText =
      'position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:2;' +
      'background:linear-gradient(135deg,transparent 55%,rgba(255,255,255,.35) 55%)'
    el.appendChild(grip)
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      dragMoved = true // a grip press is a resize, never a card click
      const rect = el.getBoundingClientRect()
      // Anchor top-left so the card grows toward the cursor.
      el.style.left = rect.left + 'px'
      el.style.top = rect.top + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      const resize = (ev) => {
        el.style.transition = 'none'
        el.style.width = Math.max(300, Math.min(640, ev.clientX - rect.left + 8)) + 'px'
        // Height is only ever a cap: dragging past the content does nothing,
        // so the card can't be stretched into empty space.
        el.style.maxHeight = Math.max(180, Math.min(innerHeight - rect.top - 10, ev.clientY - rect.top + 8)) + 'px'
      }
      const up = () => {
        removeEventListener('pointermove', resize)
        removeEventListener('pointerup', up)
        capH = parseFloat(el.style.maxHeight)
        localStorage.setItem(
          'gc-card-size',
          JSON.stringify({ w: parseFloat(el.style.width), h: capH }),
        )
        clampH() // snap back up if the drag went below what head+foot need
        localStorage.setItem(
          'gc-card-pos',
          JSON.stringify({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }),
        )
        setTimeout(() => (dragMoved = false), 0) // let the click handler see the resize first
      }
      addEventListener('pointermove', resize)
      addEventListener('pointerup', up)
    })
    // Drag anywhere on the card to move it; it remembers where you left it
    // (position persists in localStorage and applies to every future card).
    try {
      const pos = JSON.parse(localStorage.getItem('gc-card-pos'))
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        el.style.left = Math.max(0, Math.min(innerWidth - 100, pos.left)) + 'px'
        el.style.top = Math.max(0, Math.min(innerHeight - 60, pos.top)) + 'px'
      }
    } catch {}
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('a,.gc-close,.gc-grip')) return
      const rect = el.getBoundingClientRect()
      const scrolls = head.scrollHeight > head.clientHeight || mid.scrollHeight > mid.clientHeight
      if (e.clientX > rect.right - 16 && scrolls) return // scrollbar
      e.preventDefault() // stops native image-drag from hijacking the gesture
      const offX = e.clientX - rect.left
      const offY = e.clientY - rect.top
      const startX = e.clientX
      const startY = e.clientY
      const move = (ev) => {
        if (!dragMoved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
        dragMoved = true
        el.style.transition = 'none'
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        el.style.left = Math.max(0, Math.min(innerWidth - 100, ev.clientX - offX)) + 'px'
        el.style.top = Math.max(0, Math.min(innerHeight - 60, ev.clientY - offY)) + 'px'
      }
      const up = () => {
        removeEventListener('pointermove', move)
        removeEventListener('pointerup', up)
        if (dragMoved) {
          localStorage.setItem(
            'gc-card-pos',
            JSON.stringify({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }),
          )
          clampH() // wherever it landed, the bottom edge stays on screen
          setTimeout(() => (dragMoved = false), 0) // let the click handler see the drag first
        }
      }
      addEventListener('pointermove', move)
      addEventListener('pointerup', up)
    })
    // Dismissal is deliberate only: the ✕ or the next round. Opening the
    // Plonkit guide (the footer link) leaves the card exactly where it was.
    el.querySelector('.gc-close').addEventListener('click', (e) => {
      e.stopPropagation()
      removeCard() // the scope overlay is part of the card, and leaves with it
    })
    document.body.appendChild(el)
    clampH()
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      el.style.transform = 'translateY(0)'
    })
    drawScopeOverlay(card)
  }

  /** onAccepted fires only when the server actually recorded the round — a
   * reloaded page re-posts everything it can see, and the server answers
   * those with {duplicate:true}: no toast, no card, no downstream triggers. */
  function post(key, payload, onAccepted) {
    if (sent.has(key)) return
    sent.add(key)
    const tPost = Date.now()
    tlog('post ' + key + ' → ' + COACH_URL)
    const body = JSON.stringify(payload)
    postLocalDossier(body)
    // Success is silent — the card (or its absence) is the signal. Only
    // failures toast, since those need acting on.
    const accepted = (j) => {
      tlog('post ' + key + ' accepted after ' + (Date.now() - tPost) + 'ms' + (j && j.duplicate ? ' (duplicate)' : j && j.card ? (j.card.scope ? ' (card, scope ' + j.card.scope.country + ')' : ' (card, NO SCOPE)') : ' (no card)') + (j && j.timings ? ' server=' + JSON.stringify(j.timings) : ''))
      if (j && j.duplicate) return
      if (j) showCard(j.card)
      if (onAccepted) onAccepted()
    }
    // A single LAN blip (lost SYN, WiFi hiccup on the gaming PC) shouldn't
    // toast or defer the clue card to the next round screen — retry silently
    // first. Only after retries are exhausted do we toast and fall back to the
    // game-state re-post backstop.
    const RETRIES = 2
    const RETRY_DELAY = 1500
    const fail = (retriesLeft, retry, message) => {
      if (retriesLeft > 0) {
        setTimeout(() => retry(retriesLeft - 1), RETRY_DELAY)
        return
      }
      sent.delete(key) // the next intercepted game-state response retries
      toast(message, false)
    }
    // Transport is the latency story here: GM_xmlhttpRequest tunnels through
    // the extension background and opens a fresh TLS connection per request
    // (~800ms to the cloud), while page-context fetch rides the browser's warm
    // HTTP/2 pool (~30ms). Cloud posts go page-fetch-first with GM as the
    // fallback; the local server keeps GM (an https page can't always reach
    // http://127.0.0.1 without it).
    const viaGM = (retriesLeft) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: COACH_URL,
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        data: body,
        timeout: 30000,
        onload: (res) => {
          if (res.status === 200) {
            let j = null
            try { j = JSON.parse(res.responseText) } catch {}
            accepted(j)
          } else {
            sent.delete(key) // the next intercepted game-state response retries
            toast('Coach server error (' + res.status + ')', false)
          }
        },
        onerror: () => fail(retriesLeft, viaGM, 'Coach server not running'),
        ontimeout: () => fail(retriesLeft, viaGM, 'Coach server timed out'),
      })
    }
    const viaFetch = (retriesLeft) => {
      W.fetch(COACH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body,
      })
        .then((res) => {
          if (!res.ok) {
            sent.delete(key)
            toast('Coach server error (' + res.status + ')', false)
            return
          }
          res.json().then(accepted).catch(() => {})
        })
        .catch(() => {
          if (typeof GM_xmlhttpRequest === 'function') viaGM(retriesLeft)
          else fail(retriesLeft, viaFetch, 'Coach server not running')
        })
    }
    if (COACH_URL.startsWith('https')) viaFetch(RETRIES)
    else if (typeof GM_xmlhttpRequest === 'function') viaGM(RETRIES)
    else viaFetch(RETRIES)
  }

  const hex2a = (hex) => {
    let out = ''
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
    return out
  }

  /** Send every guessed round in a raw game-state object that we haven't sent yet. */
  function sendFromGameState(g) {
    if (!g || !g.token || !g.player || !Array.isArray(g.player.guesses)) return
    for (let i = 0; i < g.player.guesses.length; i++) {
      const loc = g.rounds && g.rounds[i]
      const guess = g.player.guesses[i]
      if (!loc || !guess) continue
      // The game-finished rebuild rides on the final round's ACCEPTED post, so
      // a reload's re-posted game (all duplicates) can't rebuild a third time.
      //
      // Kept, even though the gate in front of game creation is now what makes
      // the deck correct. It is the belt to that gate's braces: a fetch the
      // page swapped out from under us, a game started from a path our wrap
      // never saw, an install still running an older body — in every one of
      // those the gate never fires and this is the only thing keeping the map
      // roughly current. And when the user clicks play immediately, the gate
      // finds this rebuild still in flight and waits on it rather than starting
      // a second one, so the common case costs one publish, not two.
      const finishTrigger =
        i + 1 === 5
          ? () => {
              if (sent.has(g.token + ':rebuilt')) return
              sent.add(g.token + ':rebuilt')
              setTimeout(() => rebuildSilently('game finished'), 1500)
            }
          : null
      post(`${g.token}:${i + 1}`, {
        token: g.token,
        mapId: g.map,
        mapName: g.mapName,
        roundNumber: i + 1,
        score: guess.roundScore ? parseFloat(guess.roundScore.amount) : null,
        location: {
          lat: loc.lat,
          lng: loc.lng,
          panoId: loc.panoId ? hex2a(loc.panoId) : null,
          heading: loc.heading,
        },
        guess: { lat: guess.lat, lng: guess.lng },
      }, finishTrigger)
    }
  }

  // The clue lookup (Learnable Meta metadata, keyed by the round's pano id) is
  // the one slow server leg (~900ms cold). The round's pano id is visible the
  // moment the round is served — a whole guess-time earlier — so ping the
  // server then and the lookup is cached long before the card needs it. The
  // scope overlay's boundary costs about the same and is wanted at the same
  // moment, so it rides along on the same early sighting of the pano.
  const prewarmed = new Set()
  function prewarmRound(g) {
    const cur = g.rounds[g.rounds.length - 1]
    const pano = cur && cur.panoId ? hex2a(cur.panoId) : null
    const key = g.token + ':' + g.rounds.length
    if (prewarmed.has(key)) return
    // A round whose pano is not visible yet still has to drop the last round's
    // warm — it is precisely the round that must not inherit it — and it stays
    // unmarked so the next game-state can warm it properly.
    if (!pano) return warmScopeGeo(null)
    prewarmed.add(key)
    warmScopeGeo(pano)
    const body = JSON.stringify({ mapId: g.map, panoId: pano })
    const req = () =>
      W.fetch(PREWARM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
        body,
      })
    if (PREWARM_URL.startsWith('https')) req().catch(() => {})
    else if (typeof GM_xmlhttpRequest === 'function')
      GM_xmlhttpRequest({ method: 'POST', url: PREWARM_URL, headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS }, data: body })
    else req().catch(() => {})
  }

  function handleGameState(g) {
    if (!g || !g.token || !g.player || !Array.isArray(g.player.guesses)) return
    // A served-but-unguessed round means play has moved on: clear the card.
    if (g.rounds && g.rounds.length > g.player.guesses.length) {
      removeCard()
      prewarmRound(g)
    }
    sendFromGameState(g)
  }

  // ------------------------------------------------------------- duels
  // Ranked duels are captured for after-match review only: rounds become
  // dossiers, but no lesson card and no toasts — ranked play gets no help.
  let myId = null
  // GeoGuessr moved live ranked off /duels/<id>, so the URL no longer names the
  // game. The page still calls game-server about it (guesses, chat, state), and
  // the id in that traffic is what keeps capture working wherever it now lives.
  let lastDuelId = null
  let lastDuelSeen = 0
  // pollDuel's own request goes through the fetch tap too; ignoring it keeps
  // the freshness window measured from the page's traffic, not our own polling.
  let selfDuelFetch = ''
  function resolveMyId() {
    // The account id ships in every page's Next.js payload — synchronous, no
    // fetch to fail at startup. The API call stays as a markup-change fallback.
    try {
      const id = W.__NEXT_DATA__?.props?.accountProps?.account?.user?.userId
      if (id) { myId = id; tlogOnce('myid', 'myId via next-data'); return }
    } catch {}
    fetch('https://www.geoguessr.com/api/v3/profiles/me', { credentials: 'include' })
      .then((r) => {
        if (!r.ok) { tlogOnce('myid-fail', 'profiles/me → ' + r.status); return null }
        return r.json()
      })
      // GeoGuessr has shipped both the flat and the nested shape — take either.
      .then((m) => {
        const id = m && (m.id ?? m.user?.id ?? m.userId)
        if (id) { myId = id; tlogOnce('myid', 'myId via profiles/me') }
      })
      .catch(() => tlogOnce('myid-err', 'profiles/me unreachable'))
  }

  function handleDuelState(d) {
    if (!d) return // a failed fetch, already logged where it happened
    if (!d.gameId || !Array.isArray(d.rounds) || !Array.isArray(d.teams)) {
      tlogOnce('duel-shape:' + (d.gameId || '?'), 'duel state shape unexpected — keys: ' + Object.keys(d).slice(0, 12).join(','))
      return
    }
    if (!myId) {
      console.warn('[geocoach] duel state seen but profile id unresolved — rounds not captured yet')
      tlogOnce('duel-nomyid:' + d.gameId, 'duel seen but myId unresolved — will retry')
      return
    }
    const ids = []
    for (const team of d.teams) {
      for (const pl of team.players || []) {
        ids.push(pl.playerId)
        if (pl.playerId !== myId) continue
        tlogOnce('duel-hit:' + d.gameId, 'duel ' + d.gameId + ': me found, ' + (pl.guesses || []).length + ' guess(es)')
        for (const guess of pl.guesses || []) {
          const round = d.rounds.find((r) => r.roundNumber === guess.roundNumber)
          if (!round || !round.panorama) continue
          const pid = round.panorama.panoId
          post(`${d.gameId}:${guess.roundNumber}:duel`, {
            token: `${d.gameId}:duel`,
            source: 'duel',
            mapId: null,
            mapName: 'Ranked duel',
            roundNumber: guess.roundNumber,
            score: guess.score ?? null,
            location: {
              lat: round.panorama.lat,
              lng: round.panorama.lng,
              panoId: pid ? (/^[0-9A-Fa-f]+$/.test(pid) ? hex2a(pid) : pid) : null,
              heading: round.panorama.heading,
            },
            guess: { lat: guess.lat, lng: guess.lng },
          })
        }
      }
    }
    if (!ids.includes(myId)) tlogOnce('duel-nomatch:' + d.gameId, 'no player == myId (' + myId + ') among: ' + ids.join(','))
  }

  // Duel state lives on game-server and mostly moves over websockets, so the
  // page may never re-fetch it; reading it is side-effect-free for duels
  // (rounds advance on the server's own clock, unlike singleplayer games).
  function pollDuel() {
    const m = location.pathname.match(/^\/(?:duels|team-duels)\/([\w-]+)/)
    let id = m ? m[1] : null
    if (id) {
      tlogOnce('duel-page:' + id, 'duel page ' + id)
    } else if (lastDuelId && Date.now() - lastDuelSeen < 30 * 60 * 1000) {
      // The pathname is logged so the real live-ranked URL comes home with the
      // first game played; the 30min window stops a finished duel polling on.
      id = lastDuelId
      tlogOnce('duel-traffic-poll:' + id, 'polling duel ' + id + ' via traffic-learned id at ' + location.pathname)
    }
    if (!id) return
    if (!myId) resolveMyId() // self-heal: without it every duel round is silently skipped
    const url = `https://game-server.geoguessr.com/api/duels/${id}`
    selfDuelFetch = url
    fetch(url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) { tlogOnce('duel-fetch:' + id + ':' + r.status, 'duel fetch → ' + r.status); return null }
        return r.json()
      })
      .then(handleDuelState)
      .catch(() => tlogOnce('duel-fetch-err:' + id, 'duel fetch failed (network/CORS)'))
  }

  // --------------------------------------------------------- backfill
  // Live capture is best-effort by construction: the duel id has to be learned
  // from the page's own traffic, and ranked moves most of its state over
  // websockets, so a game can begin and end without ever naming itself over
  // HTTP. When that happens the rounds aren't merely late — they are lost,
  // because nothing ever knew the game existed. A scrape of the summary page
  // has the same failure in slow motion: it captures the guesses that exist at
  // the moment it fires, and every round played after it is never seen again.
  //
  // This is the second chance. GeoGuessr's own activity feed lists the games
  // you played whatever the page did over the wire, so recent duels can be
  // re-fetched from game-server and replayed through the normal capture path.
  // Posting is idempotent — the server answers a round it already holds with
  // {duplicate:true}, which suppresses the card and every downstream trigger —
  // so a sweep that finds nothing costs a handful of requests and stays silent.
  const DUELS_DONE_KEY = 'gc-duels-done'
  const sweptAt = new Map()
  const SWEEP_FLOOR = 2 * 60 * 1000 // don't re-fetch the same unfinished duel faster than this
  function duelsDone() {
    try {
      return new Set(JSON.parse(localStorage.getItem(DUELS_DONE_KEY)) || [])
    } catch {
      return new Set()
    }
  }
  /** A finished duel is fully captured and never needs fetching again. The tail
   * is bounded: an id only has to outlive the feed window it appears in. */
  function markDuelDone(id) {
    const s = duelsDone()
    s.add(id)
    try {
      localStorage.setItem(DUELS_DONE_KEY, JSON.stringify([...s].slice(-200)))
    } catch {}
  }

  /** Duel ids out of a feed response, whatever shape it arrives in. GeoGuessr
   * nests the part that matters as a JSON *string* under `payload`, sometimes
   * more than one level deep, so strings that look like JSON are parsed and
   * walked too. Ids are collected twice: `strict` wants the entry to call
   * itself a duel, `loose` takes any game id. Strict wins when it finds
   * anything; loose is the fallback for the day the feed renames its modes. */
  function extractDuelIds(node, strict, loose, depth) {
    if (node == null || depth > 8) return
    if (typeof node === 'string') {
      const t = node.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          extractDuelIds(JSON.parse(t), strict, loose, depth + 1)
        } catch {}
      }
      return
    }
    if (Array.isArray(node)) {
      for (const n of node) extractDuelIds(n, strict, loose, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const id = node.gameId ?? node.gameToken
    const mode = String(node.gameMode ?? node.gameType ?? node.mode ?? node.type ?? '')
    if (typeof id === 'string' && /^[0-9a-f]{24}$/.test(id)) {
      loose.add(id)
      if (/duel/i.test(mode)) strict.add(id)
    }
    for (const k of Object.keys(node)) extractDuelIds(node[k], strict, loose, depth + 1)
  }

  async function sweepRecentDuels(reason) {
    // handleDuelState drops every round without it, so a sweep before the
    // profile resolves would burn the feed window for nothing. Skip; the next
    // sweep runs with an id.
    if (!myId) {
      resolveMyId()
      tlogOnce('sweep-nomyid', 'sweep skipped: myId unresolved')
      return
    }
    let feed
    try {
      const res = await fetch('https://www.geoguessr.com/api/v4/feed/private', { credentials: 'include' })
      if (!res.ok) {
        tlogOnce('sweep-feed:' + res.status, 'feed → ' + res.status)
        return
      }
      feed = await res.json()
    } catch {
      tlogOnce('sweep-feed-err', 'feed unreachable')
      return
    }
    const strict = new Set()
    const loose = new Set()
    extractDuelIds(feed, strict, loose, 0)
    const ids = [...(strict.size ? strict : loose)]
    tlog('sweep(' + reason + '): feed → ' + strict.size + ' duel / ' + loose.size + ' game ids')
    const done = duelsDone()
    const now = Date.now()
    const todo = ids.filter((id) => !done.has(id) && now - (sweptAt.get(id) || 0) > SWEEP_FLOOR).slice(0, 10)
    if (!todo.length) return
    for (const id of todo) {
      sweptAt.set(id, Date.now())
      try {
        const r = await fetch('https://game-server.geoguessr.com/api/duels/' + id, { credentials: 'include' })
        if (!r.ok) {
          tlogOnce('sweep-duel:' + id + ':' + r.status, 'sweep ' + id + ' → ' + r.status)
          continue
        }
        const d = await r.json()
        tlog('sweep: replaying ' + id)
        handleDuelState(d)
        // Only a finished duel is safe to retire — retiring one mid-game would
        // freeze its capture at whatever rounds had been played.
        if (/finish|ended|complete/i.test(String(d.status ?? d.state ?? ''))) markDuelDone(id)
      } catch {
        tlogOnce('sweep-duel-err:' + id, 'sweep ' + id + ' failed')
      }
    }
  }

  // ------------------------------------------------------------- capture
  // Passive interception of the page's own traffic. The old 4s poller is gone
  // for cause: a bare GET on /api/v3/games/<token> SERVES the next round, so
  // polling on the result screen started the round (and its timer) long
  // before the player clicked Next. Reading responses adds no requests, and
  // every guess POST echoes the full game state back, so capture is instant.
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
  // The body arrives async (loader fetches it over GM_xmlhttpRequest), long
  // after the page has bound its own fetch reference — a wrap installed here
  // is never called. The loader installs a synchronous tap at document-start
  // and buffers requests until we attach; the direct wrap below only serves
  // legacy direct installs.
  // Two wraps can see the same request — see below — and a guess counted
  // twice is a round posted twice. The promise is the request's identity, and
  // a WeakSet of them costs nothing and holds nothing open.
  const seenRequests = new WeakSet()

  function onRequest(rec) {
    try {
      if (rec && rec.promise && typeof rec.promise === 'object') {
        if (seenRequests.has(rec.promise)) return
        seenRequests.add(rec.promise)
      }
      const url = rec.url || ''
      if (/\/api\/v3\/games\/[A-Za-z0-9]+/.test(url)) {
        const tFetch = Date.now()
        tlog('games ' + rec.method + ' intercepted')
        // The guess POST is the earliest moment anything knows a result screen
        // is coming — earlier than the answer, the card, or the map. Arming the
        // camera hold here is what lets the region be folded into GeoGuessr's
        // own framing instead of correcting it afterwards.
        if (rec.method === 'POST') armScopeHold()
        rec.promise.then((res) =>
          res.clone().json().then((g) => {
            if (rec.method === 'POST') tlog('game-state parsed ' + (Date.now() - tFetch) + 'ms after guess POST started')
            handleGameState(g)
          }).catch(() => {}),
        ).catch(() => {})
      } else if (/\/api\/duels\/([\w-]+)/.test(url)) {
        // Live duel state moves over websockets, so a guess POST is often the
        // only HTTP trace of the game — but it still names the id, which is all
        // pollDuel needs. Only the bare state endpoint answers with a state.
        const id = url.match(/\/api\/duels\/([\w-]+)/)[1]
        if (url !== selfDuelFetch) {
          lastDuelId = id
          lastDuelSeen = Date.now()
          tlogOnce('duel-traffic:' + id, 'duel id ' + id + ' learned from traffic')
        }
        if (/\/api\/duels\/[\w-]+(\?|$)/.test(url))
          rec.promise.then((res) => res.clone().json().then(handleDuelState).catch(() => {})).catch(() => {})
      }
    } catch {}
  }
  const tap = W.__geocoachTap
  if (tap && typeof tap === 'object' && Array.isArray(tap.queue)) {
    tap.handler = onRequest
    const backlog = tap.queue.splice(0)
    tlog('tap attached — ' + backlog.length + ' buffered request(s)')
    backlog.forEach(onRequest)
  }
  // And a second wrap on top of whatever fetch is *now*, tap or no tap.
  //
  // The loader's tap is installed at document-start and is normally the only
  // one needed, but it holds the fetch that existed at that instant — and
  // anything the page installs afterwards (a polyfill, an instrumentation
  // shim, a re-assignment during hydration) replaces it without replacing the
  // tap object the body checks for. The result is a tap that looks attached,
  // reports zero buffered requests, and never fires again: the guess POST goes
  // unseen and the round has no card. That is the shape of "it worked, then it
  // didn't, on the same machine and the same script".
  //
  // Wrapping again here cannot fix a fetch the page has yet to replace, but it
  // covers every replacement that happened before the body loaded — which is
  // the whole window the tap was blind to. Both wraps firing is expected and
  // harmless; onRequest ignores a promise it has already been given.
  // The handler goes on the window rather than into the closure for the same
  // reason the loader's tap has a settable one: the body hot-reloads, and a
  // wrapper holding the previous body's onRequest is a wrapper feeding a dead
  // script. There is only ever one wrap, and it always calls the current body.
  W.__geocoachOnRequest = onRequest
  if (!W.__geocoachWrapped) {
    W.__geocoachWrapped = true
    const pageFetch = W.fetch
    W.fetch = function (input, opts) {
      const p = pageFetch.apply(this, arguments)
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase()
        W.__geocoachOnRequest({ url, method, promise: p })
      } catch {}
      return p
    }
  }

  // ------------------------------------------------- the deck, just in time
  // GeoGuessr freezes a game's five locations when the game is created — POST
  // /api/v3/games — and never reads the map again for the rest of it. That one
  // fact is why every rating used to reach the game *after* next. From a real
  // log, one evening:
  //
  //   01:10:06  Estonia "tee" served → rated Easy; FSRS pushed it out 81 days
  //   01:10:44  round 5, game over
  //   01:10:50  the next game is created   ← the five locations freeze here
  //   01:10:53  the rebuild publishes, correctly without Estonia
  //   01:12:22  Estonia "tee" served again
  //
  // Nothing was broken. FSRS was right, the publish was right, and the publish
  // lost by three seconds. So the rebuild moves in front of the request that
  // does the freezing: hold creation, publish, then let it go.
  //
  // This sits directly between the user and the button that starts their game,
  // which sets every rule below. It holds one URL and one method. It has a
  // deadline it cannot miss. It cannot throw into GeoGuessr's call, and it
  // cannot fail in a way that ends with the request not being made.

  /** The bare collection path and nothing else. `/api/v3/games/<token>` is a
   * different endpoint entirely — that one is game *state*, it is read on every
   * round and written on every guess, and holding it would stall the game
   * rather than seed it. Trailing slash and query string are allowed; an id
   * after it is not. */
  function isGameCreate(url, method) {
    return method === 'POST' && /\/api\/v3\/games\/?(\?|#|$)/.test(url || '')
  }

  // How long game creation may be held. Measured rebuilds — fetch the deck,
  // then GeoGuessr's own draft GET, PUT and publish — ran between three and
  // eight seconds against the old 484-location bag; the ranked five is a
  // fraction of that payload, and the post-game rebuild has usually done the
  // work already, in which case this resolves the moment that one lands.
  // Six seconds is about where a wait still reads as "the game is loading"
  // rather than "GeoGuessr is broken", and overrunning it costs exactly what
  // every game cost before this existed — a deck one game stale — never a game
  // the user cannot start.
  const JIT_BUDGET_MS = 6000

  /** Runs the rebuild, but for at most the budget, and never rejects.
   *
   * Losing the race does not cancel anything: the rebuild carries on in the
   * background and its publish lands for the game after. Both outcomes are
   * logged, with the elapsed time, because this is a thing that happens
   * invisibly at the one moment nobody is looking at a console. */
  function holdForRebuild(rebuild) {
    const t0 = Date.now()
    let settled = false
    tlog('deck: holding game creation while the map is rebuilt')
    const done = Promise.resolve()
      .then(rebuild)
      .then(
        () => {
          settled = true
          tlog('deck: rebuilt in ' + (Date.now() - t0) + 'ms — this game gets the new deck')
        },
        (err) => {
          settled = true
          tlog('deck: rebuild before the game FAILED after ' + (Date.now() - t0) + 'ms (' +
            ((err && err.message) || err) + ') — starting the game anyway')
        },
      )
    const deadline = new Promise((resolve) =>
      setTimeout(() => {
        if (!settled)
          tlog('deck: rebuild still running after ' + JIT_BUDGET_MS + 'ms — starting the game on the deck already published')
        resolve()
      }, JIT_BUDGET_MS),
    )
    return Promise.race([done, deadline])
  }

  /** Installs the gate over `W.fetch` and `XMLHttpRequest`, calling `hold`
   * before a game-creation request is allowed out.
   *
   * Outermost by construction: it wraps whatever fetch is current, which is
   * already the capture wrap above, which is already the loader's tap. Those
   * two only *watch* a request — they are handed the promise after the call
   * has been made and cannot delay anything — so the delay has to live in its
   * own wrap, and that wrap has to go on last.
   *
   * `hold` lives on the gate object rather than in this closure because the
   * body hot-reloads and the wrap does not: a gate holding the previous body's
   * rebuild is a gate publishing through a dead script. */
  function installRequestGate(W, hold) {
    const existing = W.__geocoachGate
    if (existing) {
      existing.hold = hold
      return existing
    }
    // `held` counts the games this gate has stood in front of — nothing reads
    // it, but `__geocoachGate.held` in a console is the fastest way to tell a
    // gate that is working from one that never fired.
    const gate = (W.__geocoachGate = { hold, pending: null, held: 0 })
    /** One rebuild, however many creation requests arrive at once — a retry, a
     * second tab, a mutation React fired twice. They all wait on the same
     * publish rather than racing two of them at the same draft. Never rejects,
     * so every caller's `.then` runs and every original request is made. */
    const wait = () => {
      if (!gate.pending) {
        gate.held++
        const clear = () => (gate.pending = null)
        gate.pending = holdForRebuild(gate.hold).then(clear, clear)
      }
      return gate.pending
    }
    const pageFetch = W.fetch
    W.fetch = function (input, opts) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase()
        if (isGameCreate(url, method)) {
          const self = this
          const args = arguments
          // Resolve-then-call rather than await: the arguments go through
          // untouched, so an AbortSignal, a Request object or a body stream is
          // the same object GeoGuessr handed us.
          return wait().then(() => pageFetch.apply(self, args))
        }
      } catch {}
      return pageFetch.apply(this, arguments)
    }
    // Every /api/v3/games call this script has ever seen came through the fetch
    // tap, and there is no XMLHttpRequest anywhere in GeoGuessr's client that
    // this script has ever observed — so the wrap above is expected to be the
    // one that fires. But being wrong about that costs a card its review, and
    // being right about it costs fifteen lines, so the same hold goes in front
    // of XHR too. If the line below ever appears in the log, the assumption in
    // this paragraph is wrong and the fetch tap was never the whole story.
    try {
      const XHR = W.XMLHttpRequest && W.XMLHttpRequest.prototype
      if (XHR && !XHR.__geocoachGated) {
        XHR.__geocoachGated = true
        const open = XHR.open
        const send = XHR.send
        XHR.open = function (method, url) {
          try {
            // Only an async request may be held. Deferring a synchronous send
            // would hand control back to a caller that is about to block on a
            // request which has not left yet.
            const async = arguments[2] !== false
            this.__geocoachHeld = async && isGameCreate(String(url || ''), String(method || 'GET').toUpperCase())
          } catch {}
          return open.apply(this, arguments)
        }
        XHR.send = function () {
          if (!this.__geocoachHeld) return send.apply(this, arguments)
          this.__geocoachHeld = false
          const self = this
          const args = arguments
          tlog('deck: game creation went out over XMLHttpRequest, not fetch')
          // The send has to happen exactly once, whatever the hold does, so it
          // is its own try inside a chain that cannot reject.
          wait().then(() => {
            try {
              send.apply(self, args)
            } catch (err) {
              tlog('deck: releasing the held XHR threw — ' + ((err && err.message) || err))
            }
          })
        }
      }
    } catch {}
    return gate
  }

  installRequestGate(W, () => rebuildSilently('game starting'))

  // ---------------------------------------------------------------- deck
  // The trainer widget: asks the coach server what is due (serverGet, up with
  // the rest of the client), rebuilds the trainer map through GeoGuessr's own
  // draft API (session cookies), and publishes it. Contract per
  // coach/API-CONTRACTS.md: GET the draft, PUT the full object back with
  // version+1 and new customCoordinates, then PUT /publish with an empty
  // object — draft edits alone never go live.
  //
  // A game is five rounds and GeoGuessr picks them at creation, so a map
  // holding exactly the five highest-priority cards means the five played ARE
  // the five due — no sampling and no luck, which is the other half of the fix
  // that holds game creation above.
  //
  // Ranking is the Worker's contract: it answers /deck?n= with the n cards it
  // would pick. The laptop's server matches the path exactly and would 404 on
  // a query string, so it is asked the old way and answers with the whole bag.
  // Five drawn from 484 is a lottery, but it is the lottery this ran on for
  // months and it still works.
  const DECK_SIZE = 5
  const DECK_PATH = CLOUD ? '/deck?n=' + DECK_SIZE : '/deck'

  async function gg(url, options) {
    const res = await fetch(url, { credentials: 'include', ...options })
    if (!res.ok) throw new Error(`geoguessr ${res.status} on ${url}`)
    return res.status === 204 ? null : res.json()
  }

  /** A brand-new user has no trainer map yet (/deck answers trainerMapId:null),
   * so mint one with the browser's own session before the usual update+publish
   * flow runs against it. Nothing is stored locally — the id goes to the
   * server, and the next /deck comes back with it filled in. */
  async function createTrainerMap() {
    const draft = await gg('https://www.geoguessr.com/api/v4/user-maps/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const id = draft && (draft.id ?? draft.mapId)
    if (!id) throw new Error('draft create returned no id')
    return id
  }

  /** Hand the freshly minted map id to the server, which owns it from then on.
   * Fire-and-forget with one silent retry: losing this only costs a duplicate
   * map next rebuild, so it never interrupts the user. */
  function registerTrainerMap(mapId) {
    const url = (CLOUD ? CLOUD.url : LOCAL) + '/trainer-map'
    const body = JSON.stringify({ mapId })
    const attempt = (retriesLeft) => {
      const failed = (message) => {
        if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 2000)
        else console.warn('[geocoach] trainer map ' + mapId + ' not registered with the server: ' + message)
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
          data: body,
          timeout: 15000,
          onload: (res) => {
            if (res.status !== 200) failed('server ' + res.status)
          },
          onerror: () => failed('server unreachable'),
          ontimeout: () => failed('timed out'),
        })
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS }, body })
          .then((res) => {
            if (!res.ok) failed('server ' + res.status)
          })
          .catch(() => failed('server unreachable'))
      }
    }
    attempt(1)
  }

  // The rebuild in flight, or null — a promise rather than a flag, because
  // game creation now *waits* on this. A second caller has to join the publish
  // already running: sailing past it would start the game on the old map, and
  // starting a second one would put two versions of the same draft in the air.
  let rebuilding = null
  // Map creation needs a signed-in GeoGuessr session. If it fails once we stop
  // trying for this page load: retrying every rebuild would toast on a loop.
  let mapCreationBlocked = false

  /** All rebuilds are automatic: before a game starts, after one finishes, and
   * on arriving at the site with reviews due (or a deck that has never been
   * built). Always returns a promise that settles when there is nothing left to
   * publish — including when it decided not to publish at all.
   *
   * The throttle stops the menu re-mount from repeating the arrival rebuild. It
   * never applies to the two triggers either side of a game: those are the exact
   * moments the deck is known to be out of date. */
  function rebuildSilently(reason) {
    if (rebuilding) return rebuilding
    // Leaving a game is the moment a just-finished duel becomes fetchable and
    // the moment its rounds are most likely to be missing.
    sweepRecentDuels('arrival')
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    const aroundAGame = reason === 'game finished' || reason === 'game starting'
    if (!aroundAGame && Date.now() - last < 3 * 60 * 1000) return Promise.resolve()
    rebuilding = publishDeck(reason)
    // Cleared however it ends: a rebuild that threw must not wedge the handle
    // and block every rebuild after it for the life of the page.
    rebuilding.then(
      () => (rebuilding = null),
      () => (rebuilding = null),
    )
    return rebuilding
  }

  /** The publish itself, and the one place the deck is written. Never throws:
   * a caller may be a user standing in front of a game that has not started
   * yet, and nothing here is worth their game. */
  async function publishDeck(reason) {
    const t0 = Date.now()
    try {
      const deck = await serverGet(DECK_PATH)
      if (!deck.customCoordinates || deck.customCoordinates.length < 5)
        return tlog('rebuild (' + reason + '): the deck came back too small to publish')
      let mapId = deck.trainerMapId
      let created = false
      if (!mapId) {
        if (mapCreationBlocked) return
        try {
          mapId = await createTrainerMap()
          created = true
        } catch (err) {
          mapCreationBlocked = true
          console.warn('[geocoach] could not create your trainer map', err)
          toast('GeoCoach could not create your trainer map — are you signed in to GeoGuessr?', false)
          return
        }
      }
      const draftUrl = `https://www.geoguessr.com/api/v4/user-maps/drafts/${mapId}`
      const draft = await gg(draftUrl)
      await gg(draftUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatar: draft.avatar,
          description: deck.description,
          highlighted: draft.highlighted,
          // A fresh draft has no name of its own; an existing map keeps the one
          // the user gave it.
          name: draft.name || deck.name || 'GeoCoach Trainer',
          customCoordinates: deck.customCoordinates,
          version: draft.version + 1,
        }),
      })
      await gg(`${draftUrl}/publish`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      // Only once the map is live is it worth the server remembering it.
      if (created) {
        console.log('[geocoach] created trainer map ' + mapId)
        registerTrainerMap(mapId)
      }
      localStorage.setItem('gc-last-rebuild', String(Date.now()))
      // Silent on screen — rebuilds are routine housekeeping — but never silent
      // in the log: a rebuild that stops happening is invisible otherwise. The
      // elapsed time is here because game creation is now held against it, so
      // "how long does a rebuild take" stopped being idle curiosity.
      tlog(
        'rebuild (' + reason + '): map published in ' + (Date.now() - t0) + 'ms — ' +
          deck.customCoordinates.length + ' locations, ' + deck.summary.due + ' due, ' + deck.summary.introduced + ' new',
      )
    } catch (err) {
      tlog('rebuild (' + reason + ') FAILED after ' + (Date.now() - t0) + 'ms: ' + ((err && err.message) || err))
      console.error('[geocoach] auto-rebuild failed', err)
    }
  }

  // One rebuild per sitting: reviews come due with elapsed time, so the deck
  // is refreshed when you arrive after an hour-plus away. Between games the
  // game-finished trigger is the only one that fires. Runs once per return to
  // a non-game page, not on the 3s poll, so an offline server can't spam.
  let arrivalChecked = false
  // Breadcrumbs for the shipped log. Revisits matter (leaving a duel and coming
  // back), so only consecutive duplicates are suppressed — not tlogOnce.
  let lastPath = ''
  function checkArrival() {
    if (arrivalChecked) return
    arrivalChecked = true
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    if (Date.now() - last > 60 * 60 * 1000) rebuildSilently('arrival')
  }

  function init() {
    resolveMyId()
    ensureMapCapture() // before Google Maps loads, so the result map is built through our wrap
    setInterval(pollDuel, 10000)
    // The backfill runs on a slow clock on purpose: it exists to repair what
    // live capture missed, and what it missed is still there five minutes later.
    setTimeout(() => sweepRecentDuels('startup'), 8000)
    setInterval(() => sweepRecentDuels('heartbeat'), 5 * 60 * 1000)
    setInterval(shipTlog, 10000)
    // The last round's card outlives both removal triggers: "Show results"
    // keeps the /game/<token> path and serves no new round, so the card sat
    // on top of the final breakdown. Catch the advance click itself — the
    // same button is "Next round" mid-game, where removing is also right.
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target instanceof Element && e.target.closest('button,a,[data-qa]')
        if (!btn) return
        if (btn.closest('#geocoach-card')) return
        if (
          (btn.getAttribute('data-qa') || '').includes('close-round-result') ||
          /\b(show|view)\s+results\b/i.test(btn.textContent || '')
        )
          removeCard()
      },
      true
    )
    const watchPage = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname
        tlog('page ' + lastPath)
      }
      const inGame = /^\/(game|challenge|live-challenge|duels|team-duels)\//.test(location.pathname)
      if (inGame) {
        arrivalChecked = false
      } else {
        removeCard() // the last round's card follows you out of the game otherwise
        checkArrival()
      }
    }
    watchPage()
    setInterval(watchPage, 3000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
