// ==UserScript==
// @name         GeoCoach bridge
// @description  Sends each GeoGuessr round to the local coaching server so Claude can debrief it.
// @version      1.6.2
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

  function removeCard() {
    document.getElementById('geocoach-card')?.remove()
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
   * Clicking it opens the Plonkit guide; it clears itself on the next round. */
  function showCard(card) {
    if (!card || (!card.note && !card.metaName)) return
    if (/^\/(duels|team-duels)\//.test(location.pathname)) return // never during ranked
    removeCard()
    const url = guideUrl(card)
    const el = document.createElement('div')
    el.id = 'geocoach-card'
    el.style.cssText =
      'position:fixed;bottom:80px;right:16px;z-index:999998;width:380px;max-width:calc(100vw - 32px);' +
      'max-height:calc(100vh - 120px);display:flex;flex-direction:column;' +
      'background:linear-gradient(165deg,#2b1b58 0%,#1a1038 100%);color:#e8e4f6;' +
      'border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;' +
      'box-shadow:0 16px 48px rgba(5,0,25,.6);font-size:13px;line-height:1.55;' +
      (url ? 'cursor:pointer;' : 'cursor:grab;') +
      'opacity:0;transform:translateY(10px);transition:opacity .25s ease,transform .25s ease'
    // Size persists like position: the resize grip stores the card's width and
    // height cap, so every card arrives at the size you chose.
    try {
      const size = JSON.parse(localStorage.getItem('gc-card-size'))
      if (size && size.w) el.style.width = Math.max(300, Math.min(innerWidth - 24, size.w)) + 'px'
      if (size && size.h) el.style.maxHeight = Math.max(160, Math.min(innerHeight - 24, size.h)) + 'px'
    } catch {}
    const badge = card.correct
      ? '<span style="background:#a3e961;color:#1c2a08;font-weight:700;font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap">✓ Got it</span>'
      : '<span style="background:#ffb84c;color:#33230a;font-weight:700;font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap">✗ Missed clue</span>'
    // Content scrolls inside the card; the card itself never leaves the screen.
    // Images stay full-width but are height-capped (object-fit keeps the whole
    // photo visible) so one tall Plonkit image can't blow the card up.
    const wrap = document.createElement('div')
    wrap.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto'
    wrap.innerHTML =
      `<div style="padding:14px 16px 12px">` +
      `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px">` +
      `<b style="font-size:15px;letter-spacing:.01em">${card.metaName ?? ''}</b>` +
      `<div style="display:flex;gap:8px;align-items:center">${badge}` +
      `<span class="gc-close" style="cursor:pointer;opacity:.55;font-size:16px;line-height:1;padding:2px">✕</span></div></div>` +
      `<div style="color:#d6d0ea">${card.note ?? ''}</div></div>` +
      (card.images && card.images.length
        ? `<div style="display:grid;gap:2px">` +
          card.images
            .slice(0, 2)
            .map((u) => `<img src="${u}" style="width:100%;display:block;max-height:38vh;object-fit:contain;background:#150c33">`)
            .join('') +
          `</div>`
        : '') +
      (url
        ? `<a href="${url}" target="_blank" rel="noopener" style="display:block;padding:10px 16px;font-size:11.5px;font-weight:700;color:#a3e961;letter-spacing:.02em;text-decoration:none">Open Plonkit guide ↗</a>`
        : '')
    el.appendChild(wrap)
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
        el.style.maxHeight = 'none'
        el.style.height = Math.max(180, Math.min(innerHeight - rect.top - 10, ev.clientY - rect.top + 8)) + 'px'
      }
      const up = () => {
        removeEventListener('pointermove', resize)
        removeEventListener('pointerup', up)
        localStorage.setItem(
          'gc-card-size',
          JSON.stringify({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) }),
        )
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
      if (e.clientX > rect.right - 16 && wrap.scrollHeight > wrap.clientHeight) return // scrollbar
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
          setTimeout(() => (dragMoved = false), 0) // let the click handler see the drag first
        }
      }
      addEventListener('pointermove', move)
      addEventListener('pointerup', up)
    })
    el.addEventListener('click', (e) => {
      if (dragMoved) return // that was a drag, not a click
      // real <a> handles its own navigation; window.open covers body clicks
      if (url && !e.target.closest('a')) window.open(url, '_blank')
      el.remove()
    })
    el.querySelector('.gc-close').addEventListener('click', (e) => {
      e.stopPropagation()
      el.remove()
    })
    document.body.appendChild(el)
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      el.style.transform = 'translateY(0)'
    })
    setTimeout(() => el.remove(), 45000)
  }

  /** onAccepted fires only when the server actually recorded the round — a
   * reloaded page re-posts everything it can see, and the server answers
   * those with {duplicate:true}: no toast, no card, no downstream triggers. */
  function post(key, payload, onAccepted) {
    if (sent.has(key)) return
    sent.add(key)
    const body = JSON.stringify(payload)
    // Success is silent — the card (or its absence) is the signal. Only
    // failures toast, since those need acting on.
    const accepted = (j) => {
      if (j && j.duplicate) return
      if (j) showCard(j.card)
      if (onAccepted) onAccepted()
    }
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
            let j = null
            try { j = JSON.parse(res.responseText) } catch {}
            accepted(j)
          } else {
            sent.delete(key) // the next intercepted game-state response retries
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
          if (!res.ok) {
            sent.delete(key)
            toast('Coach server error (' + res.status + ')', false)
            return
          }
          res.json().then(accepted).catch(() => {})
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

  function handleGameState(g) {
    if (!g || !g.token || !g.player || !Array.isArray(g.player.guesses)) return
    // A served-but-unguessed round means play has moved on: clear the card.
    if (g.rounds && g.rounds.length > g.player.guesses.length) removeCard()
    sendFromGameState(g)
  }

  // ------------------------------------------------------------- duels
  // Ranked duels are captured for after-match review only: rounds become
  // dossiers, but no lesson card and no toasts — ranked play gets no help.
  let myId = null
  function resolveMyId() {
    fetch('https://www.geoguessr.com/api/v3/profiles/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m && m.id) myId = m.id })
      .catch(() => {})
  }

  function handleDuelState(d) {
    if (!d || !d.gameId || !Array.isArray(d.rounds) || !Array.isArray(d.teams) || !myId) return
    for (const team of d.teams) {
      for (const pl of team.players || []) {
        if (pl.playerId !== myId) continue
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
  }

  // Duel state lives on game-server and mostly moves over websockets, so the
  // page may never re-fetch it; reading it is side-effect-free for duels
  // (rounds advance on the server's own clock, unlike singleplayer games).
  function pollDuel() {
    const m = location.pathname.match(/^\/(?:duels|team-duels)\/([\w-]+)/)
    if (!m) return
    fetch(`https://game-server.geoguessr.com/api/duels/${m[1]}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then(handleDuelState)
      .catch(() => {})
  }

  // ------------------------------------------------------------- capture
  // Passive interception of the page's own traffic. The old 4s poller is gone
  // for cause: a bare GET on /api/v3/games/<token> SERVES the next round, so
  // polling on the result screen started the round (and its timer) long
  // before the player clicked Next. Reading responses adds no requests, and
  // every guess POST echoes the full game state back, so capture is instant.
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
  const pageFetch = W.fetch.bind(W)
  W.fetch = function (input, opts) {
    const p = pageFetch(input, opts)
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (/\/api\/v3\/games\/[A-Za-z0-9]+/.test(url)) {
        p.then((res) => res.clone().json().then(handleGameState).catch(() => {})).catch(() => {})
      } else if (/\/api\/duels\/[\w-]+(\?|$)/.test(url)) {
        p.then((res) => res.clone().json().then(handleDuelState).catch(() => {})).catch(() => {})
      }
    } catch {}
    return p
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
  function checkArrival() {
    if (arrivalChecked) return
    arrivalChecked = true
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    if (Date.now() - last > 60 * 60 * 1000) rebuildSilently('arrival')
  }

  function init() {
    resolveMyId()
    setInterval(pollDuel, 10000)
    const watchPage = () => {
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
