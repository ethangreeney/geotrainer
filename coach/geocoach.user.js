// ==UserScript==
// @name         GeoCoach bridge
// @description  Spaced repetition for GeoGuessr: captures every round, shows the meta you missed, and rebuilds your trainer map from what's due.
// @version      2.2.1
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
   * The footer link opens the Plonkit guide; the card stays until the next
   * round starts (or you ✕ it) so you can read the guide and come back. */
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
      el.remove()
    })
    document.body.appendChild(el)
    clampH()
    requestAnimationFrame(() => {
      el.style.opacity = '1'
      el.style.transform = 'translateY(0)'
    })
  }

  /** onAccepted fires only when the server actually recorded the round — a
   * reloaded page re-posts everything it can see, and the server answers
   * those with {duplicate:true}: no toast, no card, no downstream triggers. */
  function post(key, payload, onAccepted) {
    if (sent.has(key)) return
    sent.add(key)
    const body = JSON.stringify(payload)
    postLocalDossier(body)
    // Success is silent — the card (or its absence) is the signal. Only
    // failures toast, since those need acting on.
    const accepted = (j) => {
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
    // GM_xmlhttpRequest when running under Tampermonkey; plain fetch otherwise
    // (Chrome allows https pages to reach localhost, and the server answers the
    // private-network preflight).
    if (typeof GM_xmlhttpRequest === 'function') {
      const attempt = (retriesLeft) => {
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
          onerror: () => fail(retriesLeft, attempt, 'Coach server not running'),
          ontimeout: () => fail(retriesLeft, attempt, 'Coach server timed out'),
        })
      }
      attempt(RETRIES)
    } else {
      const attempt = (retriesLeft) => {
        fetch(COACH_URL, {
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
          .catch(() => fail(retriesLeft, attempt, 'Coach server not running'))
      }
      attempt(RETRIES)
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
    // The account id ships in every page's Next.js payload — synchronous, no
    // fetch to fail at startup. The API call stays as a markup-change fallback.
    try {
      const id = W.__NEXT_DATA__?.props?.accountProps?.account?.user?.userId
      if (id) { myId = id; return }
    } catch {}
    fetch('https://www.geoguessr.com/api/v3/profiles/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m && m.id) myId = m.id })
      .catch(() => {})
  }

  function handleDuelState(d) {
    if (!d || !d.gameId || !Array.isArray(d.rounds) || !Array.isArray(d.teams)) return
    if (!myId) {
      console.warn('[geocoach] duel state seen but profile id unresolved — rounds not captured yet')
      return
    }
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
    if (!myId) resolveMyId() // self-heal: without it every duel round is silently skipped
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
  function checkArrival() {
    if (arrivalChecked) return
    arrivalChecked = true
    const last = Number(localStorage.getItem('gc-last-rebuild') || 0)
    if (Date.now() - last > 60 * 60 * 1000) rebuildSilently('arrival')
  }

  /** The website signs in with ?token= in the URL, so any machine running
   * this script can open the dashboard already signed in. Styled as a native
   * GeoGuessr button — exact gradient, shadows, and italic ggFont lifted from
   * the variantPurple "Edit avatar" button on the signed-in home (green
   * variantPrimary clashed there) — and hidden mid-round so it never sits
   * over gameplay. */
  function mountDashboardLink() {
    if (!CLOUD) return null
    const a = document.createElement('a')
    a.id = 'geocoach-dash'
    a.textContent = 'GeoCoach'
    a.href = CLOUD.url + '/app?token=' + encodeURIComponent(CLOUD.token)
    a.target = '_blank'
    a.rel = 'noreferrer'
    a.style.cssText =
      'position:fixed;bottom:18px;left:18px;z-index:999997;' +
      'display:inline-flex;align-items:center;height:38px;padding:0 24px 2px;' +
      'border-radius:60px;font:italic 700 14px ggFont,sans-serif;' +
      'text-transform:uppercase;color:#fff;text-decoration:none;' +
      'text-shadow:oklch(0.2115 0.066 285.82) 0 1px 2px;' +
      'background:linear-gradient(oklch(0.7005 0.1745 293.89),oklch(0.3879 0.1768 290.8));' +
      'box-shadow:rgba(0,0,0,.25) 0 4.4px 18px,' +
      'oklch(1 0 0/.2) 0 1px 0 inset,rgba(0,0,0,.3) 0 -2px 0 inset;' +
      'transition:filter .15s,transform .15s'
    a.addEventListener('mouseenter', () => {
      a.style.filter = 'brightness(1.1)'
      a.style.transform = 'translateY(-1px)'
    })
    a.addEventListener('mouseleave', () => {
      a.style.filter = ''
      a.style.transform = ''
    })
    document.body.appendChild(a)
    return a
  }

  function init() {
    resolveMyId()
    const dash = mountDashboardLink()
    setInterval(pollDuel, 10000)
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
      const inGame = /^\/(game|challenge|live-challenge|duels|team-duels)\//.test(location.pathname)
      if (dash) dash.style.display = inGame ? 'none' : ''
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
