/**
 * GeoCoach cloud bridge — the coach/server.mjs round pipeline on a Cloudflare
 * Worker, so capture and FSRS grading survive the laptop being closed.
 *
 * Same shapes as the local bridge on purpose: a client switches by changing
 * its base URL and adding a bearer token. D1 holds users, per-user state
 * (coach/state.json minus `rounds`) and one row per round; R2 holds the meta
 * catalogs, the personal Plonkit snapshot, and (later) pano imagery. The FSRS
 * layer is coach/scheduler.mjs imported verbatim — one scheduler, two hosts.
 *
 * Not ported: street-view tile fetching/stitching (Workers have no canvas —
 * panos will be stitched client-side and uploaded), the Vite dashboard, and
 * demo state. Zero LLM calls, as everywhere in this system.
 */
import {
  buildDeck,
  deckSummary,
  gradeRound,
  ratingNameFor,
} from '../../coach/scheduler.mjs'

const metaKeyOf = (country, name) => (name ? (country ? `${country}: ${name}` : name) : null)

/** Metas whose physical design is shared across countries: any country in the
 * set is a correct read. Codes are the uppercase ISO codes countryOf returns. */
const LOOKALIKE_METAS = {
  'Czechia: Bollard': new Set(['CZ', 'SK']),
  'Slovakia: Bollard': new Set(['CZ', 'SK']),
}

const toLadder = (catalogs) =>
  catalogs.map((c) => ({
    mapId: c.mapId,
    name: c.name,
    tier: c.tier,
    metas: [...new Set(c.locations.map((l) => metaKeyOf(l.country, l.metaName)).filter(Boolean))],
  }))

const haversineKm = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)))
}

// Module-scope caches live for the isolate's lifetime — perfect for data that
// changes rarely (catalogs) or is keyed finely enough to never go stale (geocode).
let catalogCache = null
const geocodeCache = new Map()

async function loadCatalogs(env) {
  if (catalogCache) return catalogCache
  if (!env.STORE) return [] // R2 not provisioned yet — degrade to no catalogs
  const catalogs = []
  const list = await env.STORE.list({ prefix: 'catalog/' })
  for (const obj of list.objects) {
    const body = await env.STORE.get(obj.key)
    if (body) catalogs.push(await body.json())
  }
  catalogs.sort((a, b) => a.tier - b.tier)
  catalogCache = catalogs
  return catalogs
}

async function countryOf(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`
  if (geocodeCache.has(key)) return geocodeCache.get(key)
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
      { signal: AbortSignal.timeout(8000) },
    )
    const data = await res.json()
    const out = {
      code: data.countryCode || '??',
      name: data.countryName || 'unknown',
      region: data.principalSubdivision || '',
      locality: data.locality || '',
    }
    geocodeCache.set(key, out)
    return out
  } catch {
    return { code: '??', name: 'unknown', region: '', locality: '' }
  }
}

/** The intended meta for this location, when the map is a Learnable Meta map. */
async function lmMeta(mapId, panoId) {
  try {
    const params = new URLSearchParams({ panoId, mapId, userscriptVersion: '1.0.0', source: 'map' })
    const res = await fetch(`https://learnablemeta.com/api/userscript/location?${params}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Our own trainer-map rounds carry no LM data — resolve the meta from the catalogs. */
async function metaFromCatalogs(env, panoId) {
  if (!panoId) return null
  for (const c of await loadCatalogs(env)) {
    const hit = c.locations.find((l) => l.panoId === panoId)
    if (hit && hit.metaName) {
      const lm = await lmMeta(c.mapId, panoId)
      return {
        metaName: hit.metaName,
        country: hit.country,
        note: lm?.note ?? null,
        images: lm?.images ?? [],
        footer: lm?.footer ?? null,
      }
    }
  }
  return null
}

// ---------- per-user persistence ----------

const EMPTY_STATE = { countries: {}, confusions: {}, metas: {}, deckCards: {}, lastDeck: null }

async function loadUserState(env, userId) {
  const row = await env.DB.prepare('SELECT json FROM states WHERE user_id = ?').bind(userId).first()
  return row ? JSON.parse(row.json) : structuredClone(EMPTY_STATE)
}

async function saveUserState(env, userId, state) {
  await env.DB.prepare(
    'INSERT INTO states (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json',
  )
    .bind(userId, JSON.stringify(state))
    .run()
}

/** Bearer token (or ?token= for browser GETs) → user row, or null. */
async function authUser(env, request, url) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const token = bearer || url.searchParams.get('token')
  if (!token) return null
  const row = await env.DB.prepare('SELECT id, name, config FROM users WHERE token = ?')
    .bind(token)
    .first()
  return row ? { id: row.id, name: row.name, config: JSON.parse(row.config ?? '{}') } : null
}

// ---------- the round pipeline (mirrors coach/server.mjs handleRound) ----------

async function handleRound(env, user, payload) {
  const { location, mapId, roundNumber, score, source } = payload
  const dupKey = payload.token
    ? `t:${payload.token}:r${roundNumber ?? 0}`
    : `p:${location?.panoId ?? `${location?.lat},${location?.lng}`}:r${roundNumber ?? 0}`
  const prior = await env.DB.prepare('SELECT id, ts FROM rounds WHERE user_id = ? AND dup_key = ?')
    .bind(user.id, dupKey)
    .first()
  if (prior && (payload.token || Date.now() - new Date(prior.ts).getTime() < 30 * 60 * 1000)) {
    return { ok: true, id: prior.id, duplicate: true, card: null }
  }

  // A timed-out round records a (0,0) guess — that is "no guess", not the Atlantic.
  const guess =
    payload.guess && !(Math.abs(payload.guess.lat) < 0.001 && Math.abs(payload.guess.lng) < 0.001)
      ? payload.guess
      : null
  const id = `${Date.now()}_r${roundNumber ?? 0}`

  const [answer, guessed, lmDirect] = await Promise.all([
    countryOf(location.lat, location.lng),
    guess ? countryOf(guess.lat, guess.lng) : null,
    mapId && source !== 'duel' && location.panoId ? lmMeta(mapId, location.panoId) : null,
  ])
  const meta = lmDirect ?? (await metaFromCatalogs(env, location.panoId))

  const state = await loadUserState(env, user.id)
  const metaName = metaKeyOf(meta?.country, meta?.metaName ?? meta?.name) ?? null
  const twins = metaName ? LOOKALIKE_METAS[metaName] : null
  const correctCountry = guessed
    ? guessed.code === answer.code || !!(twins && twins.has(guessed.code) && twins.has(answer.code))
    : false
  const distanceKm = guess ? haversineKm(location, guess) : null

  const round = {
    id,
    ts: new Date().toISOString(),
    mapId,
    mode: source === 'duel' ? 'duel' : 'trainer',
    roundNumber,
    score: score ?? null,
    panoId: location.panoId ?? null,
    answer: { ...answer, lat: location.lat, lng: location.lng },
    guess: guessed ? { ...guessed, lat: guess.lat, lng: guess.lng } : null,
    correctCountry,
    distanceKm,
    metaName,
  }

  const cc = answer.code
  const row = (state.countries[cc] ??= { seen: 0, correctCountry: 0 })
  row.seen += 1
  if (correctCountry) row.correctCountry += 1
  if (guessed && !correctCountry) {
    const pair = `${cc}>${guessed.code}`
    state.confusions[pair] = (state.confusions[pair] ?? 0) + 1
  }

  let inferredRating = null
  let snapshot = null
  if (metaName) {
    const isPadding = !!state.lastDeck?.padding?.includes(metaName)
    inferredRating = ratingNameFor(correctCountry, score ?? 0, !state.deckCards[metaName])
    snapshot = {
      metaName,
      ts: round.ts,
      padding: isPadding,
      prevCard: state.deckCards[metaName] ?? null,
      prevMeta: state.metas[metaName] ? { ...state.metas[metaName] } : null,
    }

    const m = (state.metas[metaName] ??= { seen: 0, correct: 0, streak: 0 })
    m.seen += 1
    if (correctCountry) {
      m.correct += 1
      m.streak += 1
    } else {
      m.streak = 0
    }
    // Correct padding rounds are free practice, ungraded (see the local bridge
    // for the FSRS rationale); a wrong padding answer is real forgetting.
    if (!(isPadding && correctCountry)) {
      state.deckCards = gradeRound(
        state.deckCards,
        { metaName, correctCountry, score: score ?? 0 },
        new Date(),
      )
    }
  }

  await env.DB.prepare(
    'INSERT INTO rounds (user_id, id, dup_key, ts, answer_code, json, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, id, dupKey, round.ts, cc, JSON.stringify(round), snapshot ? JSON.stringify(snapshot) : null)
    .run()
  await saveUserState(env, user.id, state)

  return {
    ok: true,
    id,
    card:
      meta && source !== 'duel'
        ? {
            metaName,
            correct: correctCountry,
            note: meta.note ?? null,
            images: meta.images ?? [],
            footer: meta.footer ?? null,
            roundId: metaName ? id : null,
            rating: inferredRating,
          }
        : null,
  }
}

async function handleRate(env, user, { id, rating }) {
  if (!['again', 'hard', 'good', 'easy'].includes(rating))
    return { status: 400, body: { ok: false, error: `unknown rating: ${rating}` } }
  const roundRow = await env.DB.prepare(
    'SELECT json, snapshot FROM rounds WHERE user_id = ? AND id = ?',
  )
    .bind(user.id, id)
    .first()
  if (!roundRow?.snapshot)
    return { status: 410, body: { ok: false, error: 'round not overridable' } }

  const snap = JSON.parse(roundRow.snapshot)
  const state = await loadUserState(env, user.id)
  const success = rating !== 'again'

  // Rewind to before the original grade, then replay with the explicit rating.
  // Country/confusion stats stay untouched — where the pin landed is a fact;
  // the buttons only re-judge meta recall.
  if (snap.prevCard) state.deckCards[snap.metaName] = snap.prevCard
  else delete state.deckCards[snap.metaName]
  const prevMeta = snap.prevMeta ?? { seen: 0, correct: 0, streak: 0 }
  state.metas[snap.metaName] = {
    ...prevMeta,
    seen: prevMeta.seen + 1,
    correct: prevMeta.correct + (success ? 1 : 0),
    streak: success ? prevMeta.streak + 1 : 0,
  }
  if (!(snap.padding && success)) {
    state.deckCards = gradeRound(
      state.deckCards,
      { metaName: snap.metaName, rating, correctCountry: success, score: 0 },
      new Date(snap.ts),
    )
  }
  const round = JSON.parse(roundRow.json)
  round.rating = rating
  await env.DB.prepare('UPDATE rounds SET json = ? WHERE user_id = ? AND id = ?')
    .bind(JSON.stringify(round), user.id, id)
    .run()
  await saveUserState(env, user.id, state)
  return { status: 200, body: { ok: true, metaName: snap.metaName, rating } }
}

// ---------- HTTP ----------

// The one public page. Everything else is a token-gated API; this stub is the
// seed of the "FSRS for GeoGuessr" landing/setup tour planned for Stage 2.
const LANDING = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoCoach — FSRS for GeoGuessr</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0b0620; color: #efeaff;
    font: 16px/1.6 system-ui, -apple-system, sans-serif; }
  main { max-width: 34rem; padding: 3rem 1.5rem; text-align: center; }
  h1 { font-size: 2rem; margin: 0 0 .3rem; letter-spacing: -.02em; }
  h1 span { background: linear-gradient(100deg, #7fd0ff, #b2ef73);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { color: #a89fc9; margin: .8rem 0; }
  code { background: rgba(255,255,255,.08); border-radius: 6px; padding: .1rem .45rem; }
</style>
<main>
  <h1><span>GeoCoach</span></h1>
  <p><strong>Spaced repetition (FSRS) for GeoGuessr metas.</strong>
  Every round you play is captured, graded, and scheduled for review —
  so the clues you forget come back until you don't.</p>
  <p>This instance is a personal, token-gated API. Public setup guide coming later.</p>
  <p><code>GET /health</code> is the only other public route.</p>
</main>`

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (path === '/health') return json({ ok: true })
    if (request.method === 'GET' && path === '/') return new Response(LANDING, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })

    const user = await authUser(env, request, url)
    if (!user) return json({ ok: false, error: 'missing or unknown token' }, 401)

    try {
      if (request.method === 'POST' && path === '/round')
        return json(await handleRound(env, user, await request.json()))

      if (request.method === 'POST' && path === '/rate') {
        const { status, body } = await handleRate(env, user, await request.json())
        return json(body, status)
      }

      if (request.method === 'GET' && path === '/deck') {
        const catalogs = await loadCatalogs(env)
        if (!catalogs.length) return json({ error: 'no catalogs uploaded yet' }, 503)
        const state = await loadUserState(env, user.id)
        const now = new Date()
        const deck = buildDeck(state.deckCards, toLadder(catalogs), { minNew: 5, minSize: 18 }, now)

        // Up to 4 locations per chosen meta, so one or two games sweep the deck.
        const byMap = new Map(catalogs.map((c) => [c.mapId, c]))
        const usedPanos = new Set()
        const customCoordinates = []
        for (const m of deck.metas) {
          const pool = (byMap.get(m.mapId)?.locations ?? []).filter(
            (l) => metaKeyOf(l.country, l.metaName) === m.name && !usedPanos.has(l.panoId),
          )
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[pool[i], pool[j]] = [pool[j], pool[i]]
          }
          for (const loc of pool.slice(0, 4)) {
            usedPanos.add(loc.panoId)
            customCoordinates.push(loc)
          }
        }

        const paddingNames = deck.metas.slice(deck.metas.length - deck.stats.padding).map((m) => m.name)
        state.lastDeck = { ts: now.toISOString(), metas: deck.metas.map((m) => m.name), padding: paddingNames }
        await saveUserState(env, user.id, state)

        return json({
          trainerMapId: user.config.trainerMapId ?? null,
          customCoordinates,
          summary: { due: deck.stats.due, introduced: deck.stats.introduced, unlockedTiers: deck.stats.unlockedTiers },
          description: `Auto-generated spaced-repetition deck — ${deck.stats.due} due, ${deck.stats.introduced} new (${now.toISOString().slice(0, 16)})`,
        })
      }

      if (request.method === 'GET' && path === '/status') {
        const state = await loadUserState(env, user.id)
        const summary = deckSummary(state.deckCards, toLadder(await loadCatalogs(env)), new Date())
        return json({ ...summary, trainerMapId: user.config.trainerMapId ?? null })
      }

      if (request.method === 'GET' && path === '/plan') {
        const state = await loadUserState(env, user.id)
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE user_id = ?')
          .bind(user.id)
          .first()
        const rows = Object.entries(state.metas).map(([name, m]) => ({ name, ...m }))
        return json({
          drop: rows.filter((m) => m.streak >= 3).map((m) => `${m.name} (${m.streak} straight)`),
          focus: rows
            .filter((m) => m.seen >= 2 && m.correct / m.seen < 0.5)
            .sort((a, b) => a.correct / a.seen - b.correct / b.seen)
            .map((m) => `${m.name} (${m.correct}/${m.seen})`),
          confusions: Object.entries(state.confusions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([pair, n]) => `${pair} x${n}`),
          totals: { rounds: count?.n ?? 0, metasTracked: rows.length },
        })
      }

      // One round's stored record (the dossier minus imagery, for now).
      {
        const m = request.method === 'GET' && path.match(/^\/rounds\/([\w-]+)\/dossier\.json$/)
        if (m) {
          const row = await env.DB.prepare('SELECT json FROM rounds WHERE user_id = ? AND id = ?')
            .bind(user.id, m[1])
            .first()
          if (!row) return json({ ok: false, error: 'not found' }, 404)
          return new Response(row.json, {
            headers: { 'Content-Type': 'application/json', ...CORS },
          })
        }
      }

      // The personal Plonkit snapshot, straight from R2. Token-gated on
      // purpose: this is a personal offline copy, not a public rehost.
      if (request.method === 'GET' && path.startsWith('/plonkit/')) {
        const key = path.slice(1) // "plonkit/..."
        if (key.includes('..')) return json({ ok: false, error: 'bad path' }, 400)
        const obj = await env.STORE.get(key)
        if (!obj) return json({ ok: false, error: 'not found' }, 404)
        const type = key.endsWith('.md')
          ? 'text/markdown; charset=utf-8'
          : key.endsWith('.zip')
            ? 'application/zip'
            : 'image/png'
        return new Response(obj.body, {
          headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400', ...CORS },
        })
      }

      return json({ ok: false, error: 'not found' }, 404)
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500)
    }
  },
}
