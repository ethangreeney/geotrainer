// ==UserScript==
// @name         GeoCoach bridge
// @description  Loader: fetches the current GeoCoach script on every page load, so script changes never need a Tampermonkey reinstall.
// @version      3.7.0
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
  // Templated exactly like the body it loads: the serving host rewrites
  // 127.0.0.1 to itself and bakes in the cloud credentials, so every install
  // refreshes from wherever it was installed from — the Mac's LAN server when
  // it's reachable, the Worker otherwise.
  // Synchronous fetch tap, installed before any page script runs. The body
  // arrives async (GM_xmlhttpRequest), long after the page has bound its own
  // fetch reference, so a wrap inside the body sees nothing. This tap buffers
  // every request until the body attaches a handler. Deliberately dumb — all
  // real logic lives in the hot-reloadable body, so this loader never changes.
  //
  // The same wrap also HOLDS game creation, and that half has to be here for
  // exactly the reason the tap does. GeoGuessr freezes a game's five locations
  // at POST /api/v3/games and never reads the map again, so the rebuild has to
  // land before that request goes out. The body used to install the hold
  // itself and it worked only when it won a race it had no business being in:
  // on a page load where GeoGuessr bound its fetch before the body finished
  // downloading, the hold simply was not in the chain, and a "Play again"
  // pressed a second after the last guess started on the previous deck. From
  // one evening's log, a card correctly pushed three days out came back within
  // the minute because creation beat its own republish by a single second.
  //
  // So the *timing* lives here, where it is early enough to be certain, and
  // the *decision* — what a rebuild is, how long it may take, where it logs —
  // stays on the gate object, which the hot-reloadable body fills in. Until it
  // does, `hold` is null and every request passes straight through: there is
  // nothing to rebuild before the body exists.
  try {
    const W = unsafeWindow
    const tap = (W.__geocoachTap = { queue: [], handler: null })
    const gate = (W.__geocoachGate = {
      hold: null, // set by the body: the rebuild to run before creation
      log: null, // set by the body: where these lines go home
      budgetMs: 6000, // the body's own budget replaces this on load
      pending: null,
      held: 0,
    })
    const say = (line) => {
      try {
        if (gate.log) gate.log(line)
      } catch {}
    }
    /** The bare collection path and nothing else. `/api/v3/games/<token>` is
     * game *state* — read every round, written on every guess — and holding
     * that one would stall the game rather than seed it. */
    const isGameCreate = (url, method) =>
      method === 'POST' && /\/api\/v3\/games\/?(\?|#|$)/.test(url || '')
    /** One rebuild however many creation requests arrive at once, capped by
     * the budget, and never rejecting — a hold that throws is a game that
     * never starts. */
    const wait = (gate.wait = () => {
      if (gate.pending) return gate.pending
      gate.held++
      const t0 = Date.now()
      const budget = gate.budgetMs || 6000
      let settled = false
      say('deck: holding game creation while the map is rebuilt')
      const done = Promise.resolve()
        .then(() => gate.hold())
        .then(
          () => {
            settled = true
            say('deck: rebuilt in ' + (Date.now() - t0) + 'ms — this game gets the new deck')
          },
          (err) => {
            settled = true
            say(
              'deck: rebuild before the game FAILED after ' + (Date.now() - t0) + 'ms (' +
                ((err && err.message) || err) + ') — starting the game anyway',
            )
          },
        )
      const deadline = new Promise((resolve) =>
        setTimeout(() => {
          if (!settled)
            say('deck: rebuild still running after ' + budget + 'ms — starting the game on the deck already published')
          resolve()
        }, budget),
      )
      const clear = () => (gate.pending = null)
      gate.pending = Promise.race([done, deadline]).then(clear, clear)
      return gate.pending
    })
    const origFetch = W.fetch
    W.fetch = function (input, opts) {
      let url = ''
      let method = 'GET'
      try {
        url = typeof input === 'string' ? input : (input && input.url) || ''
        method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase()
      } catch {}
      // Resolve-then-call rather than await: the arguments go through
      // untouched, so an AbortSignal, a Request object or a body stream is the
      // same object GeoGuessr handed us.
      const call = () => {
        const p = origFetch.apply(this, arguments)
        try {
          const rec = { url, method, promise: p }
          if (tap.handler) tap.handler(rec)
          else if (tap.queue.length < 500) tap.queue.push(rec)
        } catch {}
        return p
      }
      try {
        if (gate.hold && isGameCreate(url, method)) return wait().then(call)
      } catch {}
      return call()
    }
  } catch (e) {
    console.error('[geocoach loader] fetch tap failed', e)
  }

  // Map-instance capture, and it lives here for exactly the same reason the
  // fetch tap does: GeoGuessr builds its result map with the Google Maps API,
  // and by the time the body arrives the constructor has usually already run —
  // a wrap installed there would never see it. This grabs the constructor as
  // soon as it exists (or the moment `google.maps` is assigned, whichever
  // comes later) and buffers every instance built through it. Deliberately
  // dumb, like the tap: which map matters and what gets drawn on it is decided
  // entirely in the hot-reloadable body.
  try {
    const W = unsafeWindow
    const buf = (W.__geocoachMaps = [])
    // A Proxy rather than a wrapper function: statics, prototype identity,
    // instanceof and `class X extends google.maps.Map` all survive it, so
    // nothing downstream can tell the constructor was touched.
    // Keyed on the original so the same constructor always yields the same
    // proxy: `google.maps.Map` and whatever `importLibrary('maps')` hands
    // back are the same function, reached twice, and a second wrap must not
    // return it bare. Proxies are keyed to themselves, and the registry is
    // shared with the body — which re-arms this wrap after a hot reload, and
    // would otherwise wrap our proxy in its own and buffer every map twice.
    const wrapped = W.__geocoachMapWrap || (W.__geocoachMapWrap = new WeakMap())
    const wrapCtor = (Ctor) => {
      if (typeof Ctor !== 'function') return Ctor
      if (wrapped.has(Ctor)) return wrapped.get(Ctor)
      const proxy = new Proxy(Ctor, {
        construct(target, args, newTarget) {
          const inst = Reflect.construct(target, args, newTarget)
          try {
            buf.push(inst)
            // A single page load can mount and discard many maps; only the
            // recent ones can still be on screen, so the buffer is capped
            // rather than left to grow for the life of the tab.
            if (buf.length > 20) buf.shift()
          } catch {}
          return inst
        },
      })
      wrapped.set(Ctor, proxy)
      wrapped.set(proxy, proxy)
      return proxy
    }
    // Modern Google Maps bootstraps hand out `Map` through
    // `google.maps.importLibrary('maps')` rather than off the namespace, and
    // a caller that destructures from there would never touch our accessor.
    // Wrapping the loader too covers both shapes for the price of one hook.
    const hookImportLibrary = (maps) => {
      const orig = maps.importLibrary
      if (typeof orig !== 'function' || orig.__geocoachWrapped) return
      const patched = function () {
        const p = orig.apply(this, arguments)
        if (!p || typeof p.then !== 'function') return p
        return p.then((lib) => {
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
    // The namespace fills in piecemeal — `google`, then `google.maps`, then
    // `Map` on it — so every level that doesn't exist yet gets an accessor
    // that arms the next one the moment it's assigned.
    const hookMaps = (maps) => {
      if (!maps || typeof maps !== 'object') return
      hookImportLibrary(maps)
      // `importLibrary` is sometimes bolted onto the namespace a tick after
      // the namespace object itself exists, so one late re-check catches that
      // without polling. Once per namespace object, whichever way we got here.
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
  } catch (e) {
    console.error('[geocoach loader] map capture failed', e)
  }

  const LOCAL = 'http://127.0.0.1:5177'
  const CLOUD_URL = '__CLOUD_URL__'
  const CLOUD_TOKEN = '__CLOUD_TOKEN__'
  const cloud = CLOUD_URL.startsWith('http')
  // The laptop is asked first because it serves the body straight off disk, so
  // an edit is live on the next page load with nothing to deploy. That is worth
  // a probe only where the probe is free: on the Mac the address is loopback
  // and a stopped server refuses in microseconds. Installed over the LAN onto
  // the gaming PC it is a real host that is usually asleep, and the probe
  // becomes a second and a half of nothing in front of every single page. With
  // a cloud configured, that install goes straight to the cloud.
  const nearby = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(LOCAL)
  const sources = []
  if (nearby || !cloud) sources.push(LOCAL + '/geocoach.body.js?t=' + Date.now())
  if (cloud) sources.push(CLOUD_URL + '/geocoach.body.js?token=' + encodeURIComponent(CLOUD_TOKEN) + '&t=' + Date.now())

  const run = (code) => {
    try {
      // Direct eval on purpose: the body is our own script and must see
      // GM_xmlhttpRequest and unsafeWindow through this closure.
      eval(code)
    } catch (e) {
      console.error('[geocoach loader] body failed to run', e)
    }
  }
  const tryNext = (i) => {
    if (i >= sources.length) {
      console.warn('[geocoach loader] no source reachable — GeoCoach inactive this page load')
      return
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: sources[i],
      timeout: i === 0 && sources.length > 1 ? 1500 : 10000,
      onload: (r) => (r.status === 200 && r.responseText ? run(r.responseText) : tryNext(i + 1)),
      onerror: () => tryNext(i + 1),
      ontimeout: () => tryNext(i + 1),
    })
  }
  tryNext(0)
})()
