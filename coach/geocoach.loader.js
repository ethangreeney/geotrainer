// ==UserScript==
// @name         GeoCoach bridge
// @description  Loader: fetches the current GeoCoach script on every page load, so script changes never need a Tampermonkey reinstall.
// @version      3.1.0
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
  try {
    const W = unsafeWindow
    const tap = (W.__geocoachTap = { queue: [], handler: null })
    const origFetch = W.fetch
    W.fetch = function (input, opts) {
      const p = origFetch.apply(this, arguments)
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase()
        const rec = { url, method, promise: p }
        if (tap.handler) tap.handler(rec)
        else if (tap.queue.length < 500) tap.queue.push(rec)
      } catch {}
      return p
    }
  } catch (e) {
    console.error('[geocoach loader] fetch tap failed', e)
  }

  const LOCAL = 'http://127.0.0.1:5177'
  const CLOUD_URL = '__CLOUD_URL__'
  const CLOUD_TOKEN = '__CLOUD_TOKEN__'
  const sources = [LOCAL + '/geocoach.body.js?t=' + Date.now()]
  if (CLOUD_URL.startsWith('http'))
    sources.push(CLOUD_URL + '/geocoach.body.js?token=' + encodeURIComponent(CLOUD_TOKEN) + '&t=' + Date.now())

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
      timeout: i === 0 ? 1500 : 10000,
      onload: (r) => (r.status === 200 && r.responseText ? run(r.responseText) : tryNext(i + 1)),
      onerror: () => tryNext(i + 1),
      ontimeout: () => tryNext(i + 1),
    })
  }
  tryNext(0)
})()
