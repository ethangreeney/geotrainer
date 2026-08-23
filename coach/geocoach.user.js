// ==UserScript==
// @name         GeoCoach bridge
// @description  Spaced repetition for GeoGuessr: captures every round, shows the meta you missed, and rebuilds your trainer map from what's due.
// @version      2.8.1
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

  tlog('body 2.8.1 up — GM=' + typeof GM_xmlhttpRequest + ' cloud=' + !!CLOUD)

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

  // -------------------------------------------------------- scope overlay
  // A meta is a claim about a place and the card only names it. Drawing the
  // area the clue actually covers — the answer's country, or just the admin-1
  // subdivisions when the meta is narrower than the country — onto GeoGuessr's
  // own result map puts that claim right next to where the guess landed.
  //
  // The geometry comes from the Mac's LAN server, which is http while the page
  // is https, so this leg goes through GM_xmlhttpRequest like every other LOCAL
  // call in this file. The Mac being asleep is a normal condition rather than a
  // fault: every failure below is silent and total — no overlay, no exception,
  // card untouched — and leaves a tlog line as the only trace.
  const SCOPE_GEO_URL = LOCAL + '/api/scope-geo'
  // The card's own chrome, so the shape reads as GeoCoach's annotation and not
  // as something GeoGuessr drew: the panel violet for the crisp outline and the
  // tint, its muted violet for the soft glow that sits under the outline.
  const SCOPE_INK = '#2b1b58'
  const SCOPE_GLOW = '#a99fce'
  // Light enough that both pins and the line between them stay readable
  // through it — the outline is the statement, the fill only says "inside".
  const SCOPE_FILL_ALPHA = 0.14
  // Roughly where a per-frame restyle stops being free on a mid-range laptop.
  // Well above a province and well below a big country's full coastline.
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
    for (const f of geojson.features || []) walk(f && f.geometry && f.geometry.coordinates)
    return n
  }

  // A meta repeats far more often than it varies (that is the whole point of
  // the deck), and a country outline can run to a few hundred KB, so the last
  // few answers stay in memory. Only successes are cached: a server that was
  // asleep a minute ago may well be awake now.
  const scopeGeoCache = new Map()
  const SCOPE_CACHE_MAX = 6

  const scopeKey = (scope) =>
    scope.country + '|' + (Array.isArray(scope.regions) ? scope.regions.join('|') : '')

  function fetchScopeGeo(scope) {
    const key = scopeKey(scope)
    const hit = scopeGeoCache.get(key)
    if (hit) return Promise.resolve(hit)
    let url = SCOPE_GEO_URL + '?country=' + encodeURIComponent(scope.country)
    if (Array.isArray(scope.regions) && scope.regions.length)
      url += '&regions=' + encodeURIComponent(scope.regions.join('|'))
    return new Promise((resolve, reject) => {
      const parsed = (text) => {
        let j = null
        try {
          j = JSON.parse(text)
        } catch {}
        // A 200 with nothing drawable is treated exactly like a failure: the
        // only thing this code is allowed to do is draw a real shape.
        if (!j || !j.ok || !j.geojson || !Array.isArray(j.geojson.features) || !j.geojson.features.length)
          return reject(new Error('no geometry'))
        scopeGeoCache.set(key, j)
        if (scopeGeoCache.size > SCOPE_CACHE_MAX) scopeGeoCache.delete(scopeGeoCache.keys().next().value)
        resolve(j)
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 8000,
          onload: (r) => (r.status === 200 ? parsed(r.responseText) : reject(new Error('scope-geo ' + r.status))),
          onerror: () => reject(new Error('server unreachable')),
          ontimeout: () => reject(new Error('timed out')),
        })
      } else {
        // Only reachable on a direct install without the GM grant, where the
        // browser blocks https→http anyway — i.e. straight down the silent path.
        fetch(url)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error('scope-geo ' + r.status))))
          .then(parsed, reject)
      }
    })
  }

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
      let div = null
      try {
        div = m && typeof m.getDiv === 'function' ? m.getDiv() : null
      } catch {}
      if (!div || !div.isConnected) continue
      let r = null
      try {
        r = div.getBoundingClientRect()
      } catch {}
      // A collapsed or thumbnail-sized map is never the result map, and
      // drawing a country outline into one would be illegible anyway.
      if (!r || r.width < 240 || r.height < 160) continue
      const area = r.width * r.height
      if (area > bestArea) {
        bestArea = area
        best = m
      }
    }
    return best
  }

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
    for (const f of geojson.features || []) walk(f && f.geometry && f.geometry.coordinates)
    return n > s && e > w ? { n, s, e, w } : null
  }

  /** GeoGuessr frames the result around the guess and the answer, which is
   * nearly always the right framing — so the default is to leave it alone. The
   * one case worth correcting is a shape the user cannot see at all: the
   * answer country two continents from a wild guess, with the overlay drawn
   * politely off-screen. Then the view opens once, wide enough to hold both,
   * and never again for this round. */
  function widenIfOffscreen(map, box, key) {
    if (scopeWidenedFor === key) return
    // A shape crossing the antimeridian (Russia, Fiji) has a meaningless plain
    // bbox; rather than frame it wrongly, leave GeoGuessr's view as it is.
    if (box.e - box.w > 180) return
    let vb = null
    try {
      vb = map.getBounds()
    } catch {}
    if (!vb) return // the map hasn't settled yet — its framing isn't ours to judge
    const sw = vb.getSouthWest()
    const ne = vb.getNorthEast()
    const vs = sw.lat()
    const vn = ne.lat()
    const vw = sw.lng()
    const ve = ne.lng()
    if (ve < vw) return // the viewport itself wraps — same reasoning
    const overlapLat = Math.min(box.n, vn) - Math.max(box.s, vs)
    const overlapLng = Math.min(box.e, ve) - Math.max(box.w, vw)
    const area = (box.n - box.s) * (box.e - box.w)
    const shown = overlapLat > 0 && overlapLng > 0 && area > 0 ? (overlapLat * overlapLng) / area : 0
    if (shown > 0.35) return
    scopeWidenedFor = key
    const b = new W.google.maps.LatLngBounds()
    b.extend({ lat: box.n, lng: box.e })
    b.extend({ lat: box.s, lng: box.w })
    b.extend({ lat: vn, lng: ve })
    b.extend({ lat: vs, lng: vw })
    try {
      map.fitBounds(b, 64)
      tlog('scope: widened to keep the shape in view')
    } catch {}
  }

  // Bumped by every draw and every teardown. A geometry fetch that lands after
  // the card it belongs to is gone — dismissed, next round, navigated away —
  // sees a stale generation and does nothing.
  let scopeGen = 0
  let scopeLayers = []
  let scopeWidenedFor = null

  function removeScopeOverlay() {
    scopeGen++
    for (const layer of scopeLayers) {
      try {
        layer.setMap(null)
      } catch {}
    }
    scopeLayers = []
  }

  /** Two passes over the same shape: a wide, soft violet stroke underneath and
   * a crisp thin one on top, which reads as a faint glow around the border
   * instead of a flat line — and keeps the edge findable where it runs over
   * dark water or a busy coastline. Both fade up together, because a
   * few-hundred-KB outline snapping into existence looks like a glitch. */
  function paintScope(map, geojson) {
    const g = W.google && W.google.maps
    if (!g || typeof g.Data !== 'function') return false
    const glow = new g.Data({ map })
    scopeLayers.push(glow)
    const main = new g.Data({ map })
    scopeLayers.push(main)
    // clickable:false throughout: the overlay must never swallow a click meant
    // for the map underneath it.
    const style = (k) => {
      glow.setStyle({
        clickable: false,
        zIndex: 1,
        fillOpacity: 0,
        strokeColor: SCOPE_GLOW,
        strokeOpacity: 0.5 * k,
        strokeWeight: 7,
      })
      main.setStyle({
        clickable: false,
        zIndex: 2,
        strokeColor: SCOPE_INK,
        strokeOpacity: 0.95 * k,
        strokeWeight: 2,
        fillColor: SCOPE_INK,
        fillOpacity: SCOPE_FILL_ALPHA * k,
      })
    }
    style(0) // styled before the features land, so no default-blue first frame
    glow.addGeoJson(geojson)
    main.addGeoJson(geojson)
    // Every frame of the fade is a full restyle of both layers, and a restyle
    // costs whatever the geometry costs. Canada's coastline is two orders of
    // magnitude heavier than Aragón's, and a fade that stutters looks worse
    // than no fade at all — so past a point the shape simply appears.
    if (countPoints(geojson) > FADE_POINT_LIMIT) {
      style(1)
      return true
    }
    const gen = scopeGen
    const t0 = Date.now()
    const FADE = 320
    const step = () => {
      if (gen !== scopeGen) return
      const t = Math.min(1, (Date.now() - t0) / FADE)
      style(t * (2 - t)) // ease-out: arrives gently rather than stopping dead
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    return true
  }

  /** Draws the card's scope on the result map. Called by showCard and torn
   * down by removeCard, so the overlay and the card share one lifetime. */
  function drawScopeOverlay(card) {
    try {
      const scope = card && card.scope
      // Older payloads have no scope at all, and that is not a failure — it
      // simply means there is nothing to draw.
      if (!scope || typeof scope.country !== 'string' || !scope.country) return
      // showCard already refuses to run during ranked, but this path is async:
      // the answer could arrive after the user has started a duel, and ranked
      // play gets no help of any kind.
      if (/^\/(duels|team-duels)\//.test(location.pathname)) return
      ensureMapCapture()
      removeScopeOverlay()
      const gen = scopeGen
      const key = scopeKey(scope)
      const t0 = Date.now()
      fetchScopeGeo(scope).then(
        (res) => {
          try {
            if (gen !== scopeGen) return
            // The card is drawn the instant the guess is graded, which can be
            // a beat before the result map is mounted and sized; wait a short
            // while for one to appear rather than missing it by 200ms.
            const deadline = Date.now() + 4000
            const tick = () => {
              if (gen !== scopeGen) return
              const map = pickResultMap()
              if (!map) {
                if (Date.now() < deadline) return setTimeout(tick, 250)
                tlog('scope ' + key + ': no visible map to draw on')
                return
              }
              try {
                if (!paintScope(map, res.geojson)) return removeScopeOverlay()
                tlog(
                  'scope drawn: ' +
                    (res.kind || '?') +
                    ' ' +
                    (res.label || key) +
                    ' (' +
                    res.geojson.features.length +
                    ' feature(s), ' +
                    (Date.now() - t0) +
                    'ms)',
                )
                const box = scopeBounds(res.geojson)
                if (box) widenIfOffscreen(map, box, (card.roundId || '') + ':' + key)
              } catch (err) {
                // A half-drawn overlay is worse than none.
                removeScopeOverlay()
                tlog('scope ' + key + ' draw failed: ' + (err && err.message))
              }
            }
            tick()
          } catch {}
        },
        (err) => tlog('scope ' + key + ': ' + ((err && err.message) || 'failed')),
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
      tlog('post ' + key + ' accepted after ' + (Date.now() - tPost) + 'ms' + (j && j.duplicate ? ' (duplicate)' : j && j.card ? ' (card)' : ' (no card)') + (j && j.timings ? ' server=' + JSON.stringify(j.timings) : ''))
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
  // server then and the lookup is cached long before the card needs it.
  const prewarmed = new Set()
  function prewarmRound(g) {
    const cur = g.rounds[g.rounds.length - 1]
    const pano = cur && cur.panoId ? hex2a(cur.panoId) : null
    if (!pano) return
    const key = g.token + ':' + g.rounds.length
    if (prewarmed.has(key)) return
    prewarmed.add(key)
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
  function onRequest(rec) {
    try {
      const url = rec.url || ''
      if (/\/api\/v3\/games\/[A-Za-z0-9]+/.test(url)) {
        const tFetch = Date.now()
        tlog('games ' + rec.method + ' intercepted')
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
  } else {
    const pageFetch = W.fetch.bind(W)
    W.fetch = function (input, opts) {
      const p = pageFetch(input, opts)
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase()
        onRequest({ url, method, promise: p })
      } catch {}
      return p
    }
    tlog('no tap — wrapped fetch directly')
  }

  // ---------------------------------------------------------------- deck
  // The trainer widget: asks the local server what is due, rebuilds the
  // trainer map through GeoGuessr's own draft API (session cookies), and
  // publishes it. Contract per coach/API-CONTRACTS.md: GET the draft, PUT the
  // full object back with version+1 and new customCoordinates, then PUT
  // /publish with an empty object — draft edits alone never go live.
  const SERVER = 'http://127.0.0.1:5177'

  function serverGet(path) {
    const base = CLOUD ? CLOUD.url : SERVER
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: base + path,
          headers: { ...AUTH_HEADERS },
          timeout: 60000,
          onload: (r) => (r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(new Error('server ' + r.status))),
          onerror: () => reject(new Error('server unreachable')),
          ontimeout: () => reject(new Error('server timeout')),
        })
      } else {
        fetch(base + path, { headers: { ...AUTH_HEADERS } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('server ' + r.status))))
          .then(resolve, reject)
      }
    })
  }

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
    const url = (CLOUD ? CLOUD.url : SERVER) + '/trainer-map'
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

  let rebuilding = false
  // Map creation needs a signed-in GeoGuessr session. If it fails once we stop
  // trying for this page load: retrying every rebuild would toast on a loop.
  let mapCreationBlocked = false

  /** All rebuilds are automatic: after a game finishes, and on arriving at the
   * site with reviews due (or a deck that has never been built). The throttle
   * stops the menu re-mount from repeating the game-finished rebuild. */
  async function rebuildSilently(reason) {
    if (rebuilding) return
    // Leaving a game is the moment a just-finished duel becomes fetchable and
    // the moment its rounds are most likely to be missing.
    sweepRecentDuels('arrival')
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    if (reason !== 'game finished' && Date.now() - last < 3 * 60 * 1000) return
    rebuilding = true
    try {
      const deck = await serverGet('/deck')
      if (!deck.customCoordinates || deck.customCoordinates.length < 5) return
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
      // Silent by design: rebuilds are routine housekeeping. Only failures
      // (the catch below / server toasts) deserve attention.
      console.log(`[geocoach] deck rebuilt (${reason}): ${deck.summary.due} due, ${deck.summary.introduced} new`)
    } catch (err) {
      console.error('[geocoach] auto-rebuild failed', err)
    } finally {
      rebuilding = false
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
