// ==UserScript==
// @name         GeoCoach bridge
// @description  Sends each GeoGuessr round to the local coaching server so Claude can debrief it.
// @version      1.3.0
// @author       Ethan + Claude
// @match        https://www.geoguessr.com/*
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/gh/miraclewhips/geoguessr-event-framework@master/geoguessr-event-framework.min.js
// @updateURL    http://127.0.0.1:5177/geocoach.user.js
// @downloadURL  http://127.0.0.1:5177/geocoach.user.js
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/* global GeoGuessrEventFramework, GM_xmlhttpRequest */
;(function () {
  'use strict'
  const COACH_URL = 'http://127.0.0.1:5177/round'

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

  /** Post-round lesson card: the meta you were meant to spot, LM's own words. */
  function showCard(card) {
    if (!card || (!card.note && !card.metaName)) return
    document.getElementById('geocoach-card')?.remove()
    const el = document.createElement('div')
    el.id = 'geocoach-card'
    el.style.cssText =
      'position:fixed;bottom:76px;right:18px;z-index:999998;max-width:360px;' +
      'background:rgba(18,22,18,.96);color:#e9ede8;border:1px solid rgba(255,255,255,.14);' +
      'border-radius:12px;padding:14px 16px;font:13px/1.5 system-ui;box-shadow:0 12px 40px rgba(0,0,0,.5)'
    const badge = card.correct
      ? '<span style="color:#7fd6a4;font-weight:700">✓ got it</span>'
      : '<span style="color:#e8b04b;font-weight:700">✗ the clue you missed</span>'
    el.innerHTML =
      `<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:6px">` +
      `<b style="font-size:14px">${card.metaName ?? ''}</b>${badge}</div>` +
      `<div>${card.note ?? ''}</div>` +
      (card.images && card.images.length
        ? `<div style="display:flex;gap:6px;margin-top:8px">` +
          card.images.slice(0, 2).map((u) => `<img src="${u}" style="width:50%;border-radius:8px">`).join('') +
          `</div>`
        : '') +
      (card.footer ? `<div style="margin-top:8px;font-size:11px;opacity:.65">${card.footer}</div>` : '') +
      `<div style="margin-top:8px;font-size:11px;opacity:.5">click to dismiss</div>`
    el.addEventListener('click', () => el.remove())
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 45000)
  }

  function post(key, payload) {
    if (sent.has(key)) return
    sent.add(key)
    const body = JSON.stringify(payload)
    // GM_xmlhttpRequest when running under Tampermonkey; plain fetch otherwise
    // (Chrome allows https pages to reach localhost, and the server answers the
    // private-network preflight).
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: COACH_URL,
        headers: { 'Content-Type': 'application/json' },
        data: body,
        timeout: 30000,
        onload: (res) => {
          if (res.status === 200) {
            toast('Round sent to coach', true)
            try { showCard(JSON.parse(res.responseText).card) } catch {}
          } else {
            sent.delete(key) // let the poller retry
            toast('Coach server error (' + res.status + ')', false)
          }
        },
        onerror: () => {
          sent.delete(key)
          toast('Coach server not running', false)
        },
        ontimeout: () => {
          sent.delete(key)
          toast('Coach server timed out', false)
        },
      })
    } else {
      fetch(COACH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then((res) => {
          if (!res.ok) sent.delete(key)
          toast(res.ok ? 'Round sent to coach' : 'Coach server error (' + res.status + ')', res.ok)
          if (res.ok) res.json().then((j) => showCard(j.card)).catch(() => {})
        })
        .catch(() => {
          sent.delete(key)
          toast('Coach server not running', false)
        })
    }
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
      if (i + 1 === 5 && !sent.has(g.token + ':rebuilt')) {
        sent.add(g.token + ':rebuilt')
        setTimeout(() => rebuildSilently('game finished'), 1500)
      }
      post(`${g.token}:${i + 1}`, {
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
      })
    }
  }

  function sendRound(state) {
    const round = state.rounds[state.rounds.length - 1]
    if (!round || !round.location) return
    post(`${state.current_game_id}:${state.rounds.length}`, {
      mapId: state.map && state.map.id,
      mapName: state.map && state.map.name,
      roundNumber: state.rounds.length,
      score: round.score && round.score.amount,
      location: {
        lat: round.location.lat,
        lng: round.location.lng,
        panoId: round.location.panoId,
        heading: round.location.heading,
      },
      guess: round.player_guess
        ? { lat: round.player_guess.lat, lng: round.player_guess.lng }
        : null,
    })
  }

  // Fallback: the event framework can miss rounds when the page captured its
  // fetch reference before the hook installed. Polling the game state directly
  // is timing-proof, and the dedupe set makes the two paths safe together.
  function poll() {
    const m = location.pathname.match(/^\/(?:game|challenge)\/([^/]+)/)
    if (!m) return
    fetch(`https://www.geoguessr.com/api/v3/games/${m[1]}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then(sendFromGameState)
      .catch(() => {})
  }

  // ---------------------------------------------------------------- deck
  // The trainer widget: asks the local server what is due, rebuilds the
  // trainer map through GeoGuessr's own draft API (session cookies), and
  // publishes it. Contract per coach/API-CONTRACTS.md: GET the draft, PUT the
  // full object back with version+1 and new customCoordinates, then PUT
  // /publish with an empty object — draft edits alone never go live.
  const SERVER = 'http://127.0.0.1:5177'

  function serverGet(path) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: SERVER + path,
          timeout: 60000,
          onload: (r) => (r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(new Error('server ' + r.status))),
          onerror: () => reject(new Error('server unreachable')),
          ontimeout: () => reject(new Error('server timeout')),
        })
      } else {
        fetch(SERVER + path)
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

  let rebuilding = false

  /** All rebuilds are automatic: after a game finishes, and on arriving at the
   * site with reviews due (or a deck that has never been built). The throttle
   * stops the menu re-mount from repeating the game-finished rebuild. */
  async function rebuildSilently(reason) {
    if (rebuilding) return
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    if (reason !== 'game finished' && Date.now() - last < 3 * 60 * 1000) return
    rebuilding = true
    try {
      const deck = await serverGet('/deck')
      if (!deck.customCoordinates || deck.customCoordinates.length < 5) return
      const draftUrl = `https://www.geoguessr.com/api/v4/user-maps/drafts/${deck.trainerMapId}`
      const draft = await gg(draftUrl)
      await gg(draftUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatar: draft.avatar,
          description: deck.description,
          highlighted: draft.highlighted,
          name: draft.name,
          customCoordinates: deck.customCoordinates,
          version: draft.version + 1,
        }),
      })
      await gg(`${draftUrl}/publish`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      localStorage.setItem('gc-last-rebuild', String(Date.now()))
      toast(`Deck rebuilt (${reason}): ${deck.summary.due} due, ${deck.summary.introduced} new`, true)
      const w = document.getElementById('geocoach-widget')
      if (w) w.querySelector('.gc-status').textContent =
        `Deck fresh: ${deck.summary.due} due, ${deck.summary.introduced} new, tier ${deck.summary.unlockedTiers}`
    } catch (err) {
      console.error('[geocoach] auto-rebuild failed', err)
    } finally {
      rebuilding = false
    }
  }

  function mountWidget() {
    if (document.getElementById('geocoach-widget')) return
    const w = document.createElement('div')
    w.id = 'geocoach-widget'
    w.style.cssText =
      'position:fixed;bottom:16px;left:16px;z-index:999998;background:rgba(12,14,20,.94);' +
      'color:#ece9e2;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:12px 14px;' +
      'font:500 12.5px/1.45 system-ui;max-width:250px;box-shadow:0 4px 18px rgba(0,0,0,.4)'
    w.innerHTML =
      '<div style="font-weight:700;margin-bottom:4px">GeoCoach</div>' +
      '<div class="gc-status" style="color:#a8adb8;margin-bottom:8px">Checking…</div>' +
      '<a class="gc-play" style="display:none;color:#7fd7a8;font-weight:700" href="#">Play trainer map</a>'
    document.body.appendChild(w)
    serverGet('/status')
      .then((s) => {
        w.querySelector('.gc-status').textContent =
          `${s.due} due · ${s.unseen} unseen · tier ${s.unlockedTiers}`
        const play = w.querySelector('.gc-play')
        play.style.display = 'inline-block'
        play.href = `https://www.geoguessr.com/maps/${s.trainerMapId}/play`
        // Keep the published deck current without any manual step: rebuild when
        // reviews are waiting, or if the deck has never been built at all.
        if (s.due > 0 || !localStorage.getItem('gc-last-rebuild')) rebuildSilently('reviews due')
      })
      .catch(() => (w.querySelector('.gc-status').textContent = 'Coach server offline'))
  }

  function init() {
    setInterval(poll, 4000)
    // The widget lives on non-game pages only — never over an active round.
    const placeWidget = () => {
      const inGame = /^\/(game|challenge|live-challenge)\//.test(location.pathname)
      const existing = document.getElementById('geocoach-widget')
      if (inGame && existing) existing.remove()
      if (!inGame) mountWidget()
    }
    placeWidget()
    setInterval(placeWidget, 3000)
    if (typeof GeoGuessrEventFramework === 'undefined') return
    GeoGuessrEventFramework.init().then(() => {
      GeoGuessrEventFramework.events.addEventListener('round_end', (event) => {
        try {
          sendRound(event.detail)
        } catch (err) {
          console.error('[geocoach]', err)
        }
      })
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
