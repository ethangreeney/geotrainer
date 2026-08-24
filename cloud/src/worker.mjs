/**
 * GeoCoach cloud bridge — the coach/server.mjs round pipeline on a Cloudflare
 * Worker, so capture and FSRS grading survive the laptop being closed.
 *
 * Same shapes as the local bridge on purpose: a client switches by changing
 * its base URL and adding a bearer token. D1 holds users, per-user state
 * (coach/state.json minus `rounds`) and one row per round; the meta catalogs
 * and region scopes are bundled into the Worker at deploy time. R2 (optional,
 * not yet provisioned) would hold the Plonkit snapshot and pano imagery. The
 * FSRS layer is coach/scheduler.mjs imported verbatim — one scheduler, two hosts.
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
import SCOPE_REGIONS from '../../coach/scope-regions.json'
import { loadPack, locate } from '../../coach/geo/locate.mjs'
// Boundary packs, built by coach/geo/pack.mjs from the same geoBoundaries
// slices the result-map overlay draws.
import COUNTRY_PACK from '../../coach/geo/pack/admin0.bin'
import REGION_PACK from '../../coach/geo/pack/admin1.bin'
// The userscript source, bundled as text (see the "rules" entry in
// wrangler.jsonc) so GET /geocoach.user.js can stamp a user's credentials in.
// The loader is what Tampermonkey installs; it fetches the body fresh on every
// page load, so body changes ship without a Tampermonkey reinstall.
import USERSCRIPT_SRC from '../../coach/geocoach.user.js'
import LOADER_SRC from '../../coach/geocoach.loader.js'
// The four meta catalogs, bundled at deploy time (≈600KB gzipped, well under
// the Worker limit) — deck building and meta resolution need no R2 at all.
// Import order is tier order: Basics 0, Beginner 1, Intermediate 2, World 3.
import CATALOG_BASICS from '../../coach/catalog/66fda352ee1c8ee4735e1aa8.json'
import CATALOG_BEGINNER from '../../coach/catalog/66c0d3feff4dbe492e06174e.json'
import CATALOG_INTERMEDIATE from '../../coach/catalog/67695a0a9c0874b92709eedb.json'
import CATALOG_WORLD from '../../coach/catalog/66fda2e27e08dc03b5bb3d6e.json'

const CATALOGS = [CATALOG_BASICS, CATALOG_BEGINNER, CATALOG_INTERMEDIATE, CATALOG_WORLD]

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

// Region-scoped grading: same curated subdivision test as the local bridge
// (see coach/server.mjs and coach/scope-regions.json for the rationale). The
// map is bundled at deploy time, so this works without R2.
const normRegion = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\b(prefecture|province|region|state|district|county|governorate|oblast)\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()

function inMetaScope(metaName, guessRegion) {
  const scopedTo = SCOPE_REGIONS[metaName]
  if (!scopedTo || !guessRegion) return true
  const got = normRegion(guessRegion)
  return scopedTo.some((r) => normRegion(r) === got)
}

// Reverse geocoding is offline: the boundary packs are bundled (see
// wrangler.jsonc) and decoded once per isolate, so a round never depends on a
// third-party lookup. It used to — BigDataCloud's free endpoint is browser-only
// and answers a Worker with 402, which is why every round captured here
// recorded itself as "??". Catalogs are bundled too (CATALOGS above).
let packs = null
const boundaries = () => {
  packs ??= { country: loadPack(COUNTRY_PACK), region: loadPack(REGION_PACK) }
  return packs
}

/** The country and subdivision a point falls in. Subdivisions are only carried
 * for the countries some meta is scoped to, so `region` is empty everywhere
 * else — which is what inMetaScope already treats as "no reason to doubt it".
 * `locality` has no offline source and is no longer reported; nothing grades
 * on it. */
function countryOf(lat, lng) {
  const { country, region } = boundaries()
  const hit = locate(country, lat, lng)
  if (!hit) return { code: '??', name: 'unknown', region: '', locality: '' }
  return {
    code: hit.code,
    name: hit.name,
    region: locate(region, lat, lng)?.name ?? '',
    locality: '',
  }
}

/**
 * The geo half of a round's grade, from coordinates alone. Capture and the
 * repair endpoint both go through here so a rebuilt round is graded exactly as
 * a fresh one is — the two drifting apart is how a repair quietly invents
 * history that never happened.
 *
 * "??" is the boundary lookup finding nothing, not a country. Comparing two
 * unknowns would mark the round correct, so an unresolved answer grades as if
 * there were no guess at all.
 */
function geoGrade(location, guess, metaName) {
  const answer = countryOf(location.lat, location.lng)
  const guessed = guess ? countryOf(guess.lat, guess.lng) : null
  const twins = metaName ? LOOKALIKE_METAS[metaName] : null
  const correctCountry =
    guessed && answer.code !== '??' && guessed.code !== '??'
      ? guessed.code === answer.code || !!(twins && twins.has(guessed.code) && twins.has(answer.code))
      : false
  return {
    answer,
    guessed,
    correctCountry,
    correctScope: correctCountry && (!metaName || inMetaScope(metaName, guessed?.region)),
    distanceKm: guess ? haversineKm(location, guess) : null,
  }
}

/** The intended meta for this location, when the map is a Learnable Meta map.
 * Cached in D1 forever and shared across users — a pano's clue note is a fact
 * about the world, not about the player, and these notes almost never change.
 * Only real payloads are cached; a miss or an outage stays retryable. */
async function lmMeta(env, mapId, panoId, ctx) {
  const key = `${mapId}:${panoId}`
  try {
    const row = await env.DB.prepare('SELECT json FROM cards WHERE cache_key = ?').bind(key).first()
    if (row) {
      const cached = JSON.parse(row.json)
      if (cached) return cached
    }
  } catch {
    // Cache table missing (pre-migration) — fall through to the live fetch.
  }

  let data = null
  try {
    const params = new URLSearchParams({ panoId, mapId, userscriptVersion: '1.0.0', source: 'map' })
    const res = await fetch(`https://learnablemeta.com/api/userscript/location?${params}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    data = await res.json()
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null

  // Cache write is fire-and-forget (waitUntil when we have a ctx): a write
  // failure — or its latency — must never cost the caller its clue card.
  const cacheWrite = env.DB.prepare(
    'INSERT INTO cards (cache_key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at',
  )
    .bind(key, JSON.stringify(data), new Date().toISOString())
    .run()
    .catch(() => {})
  if (ctx) ctx.waitUntil(cacheWrite)
  else await cacheWrite
  return data
}

/** Our own trainer-map rounds carry no LM data — resolve the meta from the
 * bundled catalogs. Synchronous on purpose: knowing the catalog's mapId BEFORE
 * calling LM lets handleRound skip the doomed lookup against the played
 * trainer map (LM has never heard of it) and query the right map in one go.
 * Index built once per isolate. */
let panoIndex = null
function catalogLocation(panoId) {
  if (!panoId) return null
  if (!panoIndex) {
    panoIndex = new Map()
    for (const c of CATALOGS)
      for (const l of c.locations)
        if (l.panoId && l.metaName && !panoIndex.has(l.panoId))
          panoIndex.set(l.panoId, { ...l, mapId: c.mapId })
  }
  return panoIndex.get(panoId) ?? null
}

/** The reverse of metaFromCatalogs: a meta key ("Brazil: Pole") back to some
 * location that teaches it. Built once per isolate — the catalogs are bundled,
 * so this is a few hundred entries of pure in-memory work. */
let metaLocations = null
function locationForMeta(metaName) {
  if (!metaLocations) {
    metaLocations = new Map()
    for (const c of CATALOGS)
      for (const l of c.locations) {
        const key = metaKeyOf(l.country, l.metaName)
        if (key && !metaLocations.has(key)) metaLocations.set(key, { mapId: c.mapId, panoId: l.panoId })
      }
  }
  return metaLocations.get(metaName) ?? null
}

/** The picture that goes with a clue, borrowed from its LM card (cached in D1
 * forever by lmMeta, so the dashboard pays the network cost once per clue).
 * Every failure is a null image, never a broken dashboard. */
async function metaImage(env, metaName) {
  const loc = locationForMeta(metaName)
  if (!loc) return null
  try {
    const lm = await lmMeta(env, loc.mapId, loc.panoId)
    return lm?.images?.[0] ?? null
  } catch {
    return null
  }
}

// ---------- per-user persistence ----------

const EMPTY_STATE = { countries: {}, confusions: {}, metas: {}, deckCards: {}, lastDeck: null }

async function loadUserState(env, userId) {
  const row = await env.DB.prepare('SELECT json FROM states WHERE user_id = ?').bind(userId).first()
  return row ? JSON.parse(row.json) : structuredClone(EMPTY_STATE)
}

const saveUserStateStmt = (env, userId, state) =>
  env.DB.prepare(
    'INSERT INTO states (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json',
  ).bind(userId, JSON.stringify(state))

async function saveUserState(env, userId, state) {
  await saveUserStateStmt(env, userId, state).run()
}

/** Bearer token (or ?token= for browser GETs) → user row, or null.
 * Warm-isolate cache: every D1 query is a round trip to the primary, and the
 * token→user mapping barely changes, so a short TTL shaves a serial hop off
 * every authed request. Config writes go through setConfig, which drops the
 * entry. */
const authCache = new Map() // token → { user, until }
async function authUser(env, request, url) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const token = bearer || url.searchParams.get('token')
  if (!token) return null
  const hit = authCache.get(token)
  if (hit && hit.until > Date.now()) return hit.user
  const row = await env.DB.prepare('SELECT id, name, config, created_at FROM users WHERE token = ?')
    .bind(token)
    .first()
  const user = row
    ? {
        id: row.id,
        name: row.name,
        token,
        createdAt: row.created_at ?? null,
        config: JSON.parse(row.config ?? '{}'),
      }
    : null
  if (user) authCache.set(token, { user, until: Date.now() + 5 * 60 * 1000 })
  return user
}

// ---------- accounts ----------

const HOURS_24 = 24 * 60 * 60 * 1000

const mintToken = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** Names are display-only, so the rules are just "short, printable, non-empty". */
const cleanName = (raw) =>
  typeof raw === 'string'
    ? raw
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 40)
    : ''

/** The token is the account — no email, no password, nothing to reset. The only
 * gate is a global signup ceiling, so a bot can't mint tokens all night. */
async function handleSignup(env, body) {
  const name = cleanName(body?.name)
  if (!name) return { status: 400, body: { ok: false, error: 'name must be 1-40 characters' } }

  const since = new Date(Date.now() - HOURS_24).toISOString()
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at > ?')
    .bind(since)
    .first()
  if ((recent?.n ?? 0) >= 50)
    return { status: 429, body: { ok: false, error: 'signups are rate-limited, try again tomorrow' } }

  const token = mintToken()
  const row = await env.DB.prepare(
    "INSERT INTO users (token, name, config, created_at) VALUES (?, ?, '{}', ?) RETURNING id",
  )
    .bind(token, name, new Date().toISOString())
    .first()
  await env.DB.prepare('INSERT INTO states (user_id, json) VALUES (?, ?)')
    .bind(row.id, JSON.stringify(EMPTY_STATE))
    .run()

  return { status: 200, body: { ok: true, token, name } }
}

async function setConfig(env, user, patch) {
  const config = { ...user.config, ...patch }
  await env.DB.prepare('UPDATE users SET config = ? WHERE id = ?')
    .bind(JSON.stringify(config), user.id)
    .run()
  user.config = config
  authCache.delete(user.token)
  return config
}

// ---------- dashboard ----------

const pct = (correct, seen) => (seen ? correct / seen : 0)

let regionNames = null
function countryName(code, fromRounds) {
  if (fromRounds.has(code)) return fromRounds.get(code)
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Everything the personal dashboard draws, in one round trip: deck health,
 * meta mastery buckets, per-country accuracy and a recent-rounds feed. */
async function buildDashboard(env, user) {
  const now = new Date()
  const state = await loadUserState(env, user.id)
  const summary = deckSummary(state.deckCards, toLadder(CATALOGS), now)
  const introduced = Object.keys(state.deckCards).length

  const metaRows = Object.entries(state.metas ?? {}).map(([metaName, m]) => ({
    metaName,
    seen: m.seen ?? 0,
    correct: m.correct ?? 0,
    lapses: state.deckCards[metaName]?.lapses ?? 0,
  }))
  const solid = metaRows.filter((m) => m.seen >= 3 && pct(m.correct, m.seen) >= 0.8)
  const shaky = metaRows.filter((m) => pct(m.correct, m.seen) < 0.5)
  const weakest = [...metaRows]
    .sort((a, b) => pct(a.correct, a.seen) - pct(b.correct, b.seen) || b.seen - a.seen)
    .slice(0, 12)

  const [countRow, roundRows, weakestImages] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE user_id = ?').bind(user.id).first(),
    env.DB.prepare('SELECT json FROM rounds WHERE user_id = ? ORDER BY ts DESC LIMIT 300')
      .bind(user.id)
      .all(),
    // A slipping clue is worth looking at, not just reading — so each one
    // carries the picture from its LM card.
    Promise.all(weakest.map((m) => metaImage(env, m.metaName))),
  ])
  const weakestWithImages = weakest.map((m, i) => ({ ...m, image: weakestImages[i] }))

  const nameByCode = new Map()
  const rounds = (roundRows?.results ?? []).map((row) => {
    const r = JSON.parse(row.json)
    if (r.answer?.code && r.answer?.name) nameByCode.set(r.answer.code, r.answer.name)
    return {
      id: r.id,
      ts: r.ts,
      from: r.guess ? [r.guess.lat, r.guess.lng] : null,
      to: [r.answer.lat, r.answer.lng],
      correct: r.correctScope ?? r.correctCountry,
      country: r.answer?.name ?? null,
      guessCountry: r.guess?.name ?? null,
      metaName: r.metaName ?? null,
      score: r.score ?? null,
      distanceKm: r.distanceKm ?? null,
    }
  })

  let seenAll = 0
  let correctAll = 0
  const countries = Object.entries(state.countries ?? {})
    .map(([code, c]) => {
      seenAll += c.seen ?? 0
      correctAll += c.correctCountry ?? 0
      return {
        code,
        name: countryName(code, nameByCode),
        rounds: c.seen ?? 0,
        correct: c.correctCountry ?? 0,
      }
    })
    .sort((a, b) => b.rounds - a.rounds)

  return {
    ok: true,
    name: user.name,
    generatedAt: now.toISOString(),
    deck: {
      due: summary.due,
      learning: summary.learning,
      unseen: summary.unseen,
      introduced,
      total: introduced + summary.unseen,
      nextDue: summary.nextDue,
    },
    metas: {
      solid: solid.length,
      holding: metaRows.length - solid.length - shaky.length,
      shaky: shaky.length,
      total: metaRows.length,
      weakest: weakestWithImages,
    },
    countries,
    totals: { rounds: countRow?.n ?? 0, correctPct: Math.round(100 * pct(correctAll, seenAll)) },
    rounds,
  }
}

// ---------- the round pipeline (mirrors coach/server.mjs handleRound) ----------

// dupKeys with an in-flight deferred write: the INSERT lands after the response
// (ctx.waitUntil), so the D1 dup-check alone would miss a fast double-post.
const pendingWrites = new Set()

async function handleRound(env, user, payload, ctx) {
  const t0 = Date.now()
  const since = (from) => Date.now() - from
  const { location, mapId, roundNumber, score, source } = payload
  const dupKey = payload.token
    ? `t:${payload.token}:r${roundNumber ?? 0}`
    : `p:${location?.panoId ?? `${location?.lat},${location?.lng}`}:r${roundNumber ?? 0}`
  if (pendingWrites.has(dupKey)) return { ok: true, id: null, duplicate: true, card: null }

  // A timed-out round records a (0,0) guess — that is "no guess", not the Atlantic.
  const guess =
    payload.guess && !(Math.abs(payload.guess.lat) < 0.001 && Math.abs(payload.guess.lng) < 0.001)
      ? payload.guess
      : null
  const id = `${Date.now()}_r${roundNumber ?? 0}`

  // Catalog hit tells us the real LM mapId up front — one LM call, never the
  // doomed one against the played trainer map. Everything the response needs
  // from elsewhere — dup-check, rate-limit, LM meta, user state — rides one
  // parallel block, so the whole read side costs a single slowest-leg wait
  // instead of a chain of serial D1 round trips. Both geocodes sit outside it:
  // they are local polygon tests now, not round trips.
  const catalogHit = source !== 'duel' ? catalogLocation(location.panoId) : null
  const lmMapId = catalogHit ? catalogHit.mapId : mapId
  const timed = {}
  const lap = (name, p) => {
    const from = Date.now()
    return Promise.resolve(p).then((v) => ((timed[name] = since(from)), v))
  }
  const [prior, overLimit, lm, state] = await Promise.all([
    lap(
      'dup',
      env.DB.prepare('SELECT id, ts FROM rounds WHERE user_id = ? AND dup_key = ?')
        .bind(user.id, dupKey)
        .first(),
    ),
    lap('limit', overRoundLimit(env, user.id)),
    lmMapId && source !== 'duel' && location.panoId
      ? lap('lm', lmMeta(env, lmMapId, location.panoId, ctx))
      : null,
    lap('state', loadUserState(env, user.id)),
  ])
  if (prior && (payload.token || Date.now() - new Date(prior.ts).getTime() < 30 * 60 * 1000)) {
    return { ok: true, id: prior.id, duplicate: true, card: null }
  }
  if (overLimit) return { ok: false, error: 'round limit reached, try again later', limited: true }
  const meta = catalogHit
    ? {
        metaName: catalogHit.metaName,
        country: catalogHit.country,
        note: lm?.note ?? null,
        images: lm?.images ?? [],
        footer: lm?.footer ?? null,
      }
    : lm
  const metaName = metaKeyOf(meta?.country, meta?.metaName ?? meta?.name) ?? null
  const { answer, guessed, correctCountry, correctScope, distanceKm } = geoGrade(
    location,
    guess,
    metaName,
  )

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
    correctScope,
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
    inferredRating = ratingNameFor(correctScope, !state.deckCards[metaName])
    snapshot = {
      metaName,
      ts: round.ts,
      padding: isPadding,
      prevCard: state.deckCards[metaName] ?? null,
      prevMeta: state.metas[metaName] ? { ...state.metas[metaName] } : null,
    }

    const m = (state.metas[metaName] ??= { seen: 0, correct: 0, streak: 0 })
    m.seen += 1
    if (correctScope) {
      m.correct += 1
      m.streak += 1
    } else {
      m.streak = 0
    }
    // Correct padding rounds are free practice, ungraded (see the local bridge
    // for the FSRS rationale); a wrong padding answer is real forgetting.
    if (!(isPadding && correctScope)) {
      state.deckCards = gradeRound(state.deckCards, { metaName, correct: correctScope }, new Date())
    }
  }

  // One D1 round trip for both writes, atomic (batch = transaction) — and off
  // the response path: the card's content never depends on the write landing,
  // so the client shouldn't wait out another hop to the D1 primary for it.
  pendingWrites.add(dupKey)
  const write = env.DB.batch([
    env.DB.prepare(
      'INSERT INTO rounds (user_id, id, dup_key, ts, answer_code, json, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(user.id, id, dupKey, round.ts, cc, JSON.stringify(round), snapshot ? JSON.stringify(snapshot) : null),
    saveUserStateStmt(env, user.id, state),
  ]).finally(() => pendingWrites.delete(dupKey))
  if (ctx) ctx.waitUntil(write)
  else await write

  // The area the post-round map should highlight — identity only. Boundary
  // geometry is far too big to bundle into a Worker, so the client takes this
  // and fetches the shape from the Mac's /api/scope-geo over the LAN. Null
  // regions means countrywide, straight from the same curated file that
  // decided whether the guess was in scope.
  // A scope on the card is a promise the client can draw something, so when
  // the geocoder failed (countryOf answers "??") there is no area to promise
  // and the whole field goes null — better to say nothing than to send the
  // client after a shape that cannot exist.
  const scopedTo = metaName ? (SCOPE_REGIONS[metaName] ?? null) : null
  const scope = /^[A-Z]{2}$/.test(cc ?? '') ? { country: cc, regions: scopedTo } : null

  return {
    ok: true,
    id,
    timings: { ...timed, total: since(t0) },
    card:
      meta && source !== 'duel'
        ? {
            metaName,
            correct: correctScope,
            scope,
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
      { metaName: snap.metaName, rating, correct: success },
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

// ---------- userscript debug log ----------

/** The userscript posts its own console lines here every ~10s, so a silent
 * capture failure on the gaming PC is diagnosable instead of invisible.
 * Bounded at both ends: one request can't flood the table, and each user keeps
 * only a tail — this is a live console, not an archive. */
const TLOG_MAX_LINES = 200
const TLOG_KEEP_ROWS = 500

async function handleTlog(env, user, body) {
  const lines = body?.lines
  if (!Array.isArray(lines))
    return { status: 400, body: { ok: false, error: 'lines must be an array' } }
  // An oversized batch is a client bug; drop it rather than write it down.
  if (!lines.length || lines.length > TLOG_MAX_LINES)
    return { status: 200, body: { ok: true, stored: 0 } }

  const rows = lines.map((e) => {
    const t = Number(e?.t)
    return { ts: Number.isFinite(t) ? t : Date.now(), line: String(e?.line ?? '').slice(0, 500) }
  })
  // One D1 round trip for the inserts and the prune, atomic (batch = transaction).
  await env.DB.batch([
    ...rows.map((r) =>
      env.DB.prepare('INSERT INTO tlog (user_id, ts, line) VALUES (?, ?, ?)').bind(
        user.id,
        r.ts,
        r.line,
      ),
    ),
    env.DB.prepare(
      'DELETE FROM tlog WHERE user_id = ? AND id NOT IN (SELECT id FROM tlog WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT ?)',
    ).bind(user.id, user.id, TLOG_KEEP_ROWS),
  ])
  return { status: 200, body: { ok: true, stored: rows.length } }
}

// ---------- HTTP ----------

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

/** Token-gated routes. Everything else belongs to the static site, so /start
 * and /app render as pages instead of 401s. */
const AUTHED_PATHS = new Set([
  '/round',
  '/rate',
  '/regeocode',
  '/prewarm',
  '/deck',
  '/status',
  '/plan',
  '/me',
  '/trainer-map',
  '/api/dashboard',
  '/api/rounds',
  '/api/tlog',
  '/geocoach.user.js',
  '/geocoach.body.js',
])
const isApiPath = (path) =>
  AUTHED_PATHS.has(path) || path.startsWith('/plonkit/') || path.startsWith('/rounds/')

/** The public site (dist-site/), with an index.html fallback so client-routed
 * pages survive a hard refresh. Absent binding = API-only deploy. */
async function serveStatic(request, env, url) {
  if (!env.ASSETS) return new Response('GeoCoach API', { headers: { 'Content-Type': 'text/plain' } })
  const res = await env.ASSETS.fetch(request)
  if (res.status !== 404) return res
  const wantsHtml =
    request.method === 'GET' && (request.headers.get('Accept') ?? '').includes('text/html')
  if (!wantsHtml) return res
  // Fetch "/" rather than "/index.html": the assets layer 308-redirects the
  // latter back to "/", which would strip the client route from the URL.
  return env.ASSETS.fetch(new Request(`${url.origin}/`, request))
}

/** A day's worth of rounds is ~50; 800 is a wall for runaway clients only. */
async function overRoundLimit(env, userId) {
  const since = new Date(Date.now() - HOURS_24).toISOString()
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE user_id = ? AND ts > ?')
    .bind(userId, since)
    .first()
  return (row?.n ?? 0) > 800
}

/**
 * Repairs rounds whose country never resolved, and rebuilds the tallies that
 * were computed from them.
 *
 * Every round captured while the old network geocoder was failing recorded
 * "??" for both the answer and the guess, which graded as a miss however good
 * the guess was — a correct call on Ecuador went into the history as wrong.
 * The coordinates were always stored, so the grade can simply be recomputed
 * from them now that the lookup is local.
 *
 * The country and confusion tallies are rebuilt from every round rather than
 * patched, since they are pure sums over the rounds and a patch would carry
 * forward whatever the outage already put in them. Meta stats are rebuilt the
 * same way, in time order, because `streak` depends on it. The FSRS cards are
 * deliberately left alone: a card's state is the path its reviews took, not a
 * sum, and replaying it would be inventing a review history rather than
 * correcting one. Scheduling re-converges on its own as the metas come up
 * again.
 */
async function handleRegeocode(env, user, { dryRun = false } = {}) {
  const rows = await env.DB.prepare('SELECT id, json FROM rounds WHERE user_id = ? ORDER BY ts')
    .bind(user.id)
    .all()

  const repaired = []
  const rounds = []
  for (const row of rows.results ?? []) {
    let round
    try {
      round = JSON.parse(row.json)
    } catch {
      continue // A corrupt row is not something a re-geocode can rescue.
    }
    const before = round.answer?.code
    if (before === '??' && Number.isFinite(round.answer?.lat)) {
      const graded = geoGrade(round.answer, round.guess, round.metaName ?? null)
      round.answer = { ...graded.answer, lat: round.answer.lat, lng: round.answer.lng }
      if (round.guess && graded.guessed)
        round.guess = { ...graded.guessed, lat: round.guess.lat, lng: round.guess.lng }
      round.correctCountry = graded.correctCountry
      round.correctScope = graded.correctScope
      round.distanceKm = graded.distanceKm ?? round.distanceKm
      if (round.answer.code !== '??') repaired.push(round)
    }
    rounds.push(round)
  }

  const countries = {}
  const confusions = {}
  const metas = {}
  for (const round of rounds) {
    const cc = round.answer?.code
    if (!cc) continue
    const tally = (countries[cc] ??= { seen: 0, correctCountry: 0 })
    tally.seen += 1
    if (round.correctCountry) tally.correctCountry += 1
    if (round.guess && !round.correctCountry) {
      const pair = `${cc}>${round.guess.code}`
      confusions[pair] = (confusions[pair] ?? 0) + 1
    }
    if (round.metaName) {
      const m = (metas[round.metaName] ??= { seen: 0, correct: 0, streak: 0 })
      m.seen += 1
      if (round.correctScope) {
        m.correct += 1
        m.streak += 1
      } else {
        m.streak = 0
      }
    }
  }

  const summary = {
    ok: true,
    rounds: rounds.length,
    repaired: repaired.length,
    stillUnknown: rounds.filter((r) => r.answer?.code === '??').length,
    nowCorrect: repaired.filter((r) => r.correctCountry).length,
    countries: Object.fromEntries(
      Object.entries(countries)
        .sort((a, b) => b[1].seen - a[1].seen)
        .slice(0, 15),
    ),
  }
  if (dryRun) return summary

  // D1 caps how much one batch may carry, so the updates go in chunks. The
  // state write goes last, after every round it summarises has landed.
  for (let i = 0; i < repaired.length; i += 50) {
    await env.DB.batch(
      repaired.slice(i, i + 50).map((round) =>
        env.DB.prepare('UPDATE rounds SET answer_code = ?, json = ? WHERE user_id = ? AND id = ?')
          .bind(round.answer.code, JSON.stringify(round), user.id, round.id),
      ),
    )
  }
  const state = await loadUserState(env, user.id)
  await saveUserState(env, user.id, { ...state, countries, confusions, metas })
  return summary
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (path === '/health') return json({ ok: true })

    // People should read geofsrs.pages.dev in the address bar. Only page
    // navigations hop domains — the userscript's API calls and Tampermonkey's
    // update checks (no text/html Accept) must keep working wherever they
    // were installed to point.
    if (
      url.hostname.endsWith('.workers.dev') &&
      request.method === 'GET' &&
      (request.headers.get('Accept') ?? '').includes('text/html') &&
      !isApiPath(path)
    ) {
      return Response.redirect(`https://geofsrs.pages.dev${path}${url.search}`, 301)
    }

    // ---------- public ----------
    try {
      if (request.method === 'POST' && path === '/signup') {
        const { status, body } = await handleSignup(env, await request.json())
        return json(body, status)
      }

      // Landing-page counters: cheap, real, and nothing personal in them.
      if (request.method === 'GET' && path === '/api/stats') {
        const [users, rounds, states] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(),
          env.DB.prepare('SELECT COUNT(*) AS n FROM rounds').first(),
          env.DB.prepare('SELECT json FROM states').all(),
        ])
        let metasTracked = 0
        for (const row of states?.results ?? []) {
          try {
            metasTracked += Object.keys(JSON.parse(row.json).metas ?? {}).length
          } catch {
            // A corrupt state row shouldn't take the counter down.
          }
        }
        return json({ ok: true, users: users?.n ?? 0, rounds: rounds?.n ?? 0, metasTracked })
      }
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500)
    }

    if (!isApiPath(path)) return serveStatic(request, env, url)

    const user = await authUser(env, request, url)
    if (!user) return json({ ok: false, error: 'missing or unknown token' }, 401)

    try {
      if (request.method === 'POST' && path === '/round') {
        const result = await handleRound(env, user, await request.json(), ctx)
        return json(result, result.limited ? 429 : 200)
      }

      // Fired by the userscript the moment a round is served, a guess-time
      // before the card is needed. The LM lookup is the one slow leg of /round
      // (~900ms cold); doing it here means /round always hits warm cache. The
      // response never waits on the fetch.
      if (request.method === 'POST' && path === '/prewarm') {
        const { mapId, panoId } = await request.json()
        if (panoId) {
          const hit = catalogLocation(panoId)
          const lmMapId = hit ? hit.mapId : mapId
          if (lmMapId) ctx.waitUntil(lmMeta(env, lmMapId, panoId, ctx).catch(() => {}))
        }
        return json({ ok: true })
      }

      // Maintenance: re-grade rounds the old network geocoder left as "??".
      // Authenticated like everything else and scoped to the caller's own
      // rounds, so it can be run again the next time the boundary data moves.
      if (request.method === 'POST' && path === '/regeocode') {
        const body = await request.json().catch(() => ({}))
        return json(await handleRegeocode(env, user, body))
      }

      if (request.method === 'POST' && path === '/rate') {
        const { status, body } = await handleRate(env, user, await request.json())
        return json(body, status)
      }

      if (request.method === 'GET' && path === '/deck') {
        const state = await loadUserState(env, user.id)
        const now = new Date()
        const deck = buildDeck(state.deckCards, toLadder(CATALOGS), { minNew: 5, minSize: 18 }, now)

        // Up to 4 locations per chosen meta, so one or two games sweep the deck.
        const byMap = new Map(CATALOGS.map((c) => [c.mapId, c]))
        const usedPanos = new Set()
        const customCoordinates = []
        const prewarm = []
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
            if (loc.panoId) prewarm.push({ mapId: m.mapId, panoId: loc.panoId })
          }
        }

        const paddingNames = deck.metas.slice(deck.metas.length - deck.stats.padding).map((m) => m.name)
        state.lastDeck = { ts: now.toISOString(), metas: deck.metas.map((m) => m.name), padding: paddingNames }
        await saveUserState(env, user.id, state)

        // Pre-warm the LM clue cache for every pano this deck can serve, so
        // the first play of a location never pays the ~900ms live LM fetch on
        // its card. Small batches: fast enough to beat the player to round 1
        // (~15s for a full deck), gentle enough on LM's API. lmMeta's D1 cache
        // check makes re-warming a no-op.
        ctx.waitUntil(
          (async () => {
            for (let i = 0; i < prewarm.length; i += 5) {
              await Promise.all(
                prewarm.slice(i, i + 5).map((p) => lmMeta(env, p.mapId, p.panoId).catch(() => {})),
              )
            }
          })(),
        )

        return json({
          trainerMapId: user.config.trainerMapId ?? null,
          customCoordinates,
          summary: { due: deck.stats.due, introduced: deck.stats.introduced, unlockedTiers: deck.stats.unlockedTiers },
          description: `Auto-generated spaced-repetition deck — ${deck.stats.due} due, ${deck.stats.introduced} new (${now.toISOString().slice(0, 16)})`,
        })
      }

      if (request.method === 'GET' && path === '/status') {
        const state = await loadUserState(env, user.id)
        const summary = deckSummary(state.deckCards, toLadder(CATALOGS), new Date())
        return json({ ...summary, trainerMapId: user.config.trainerMapId ?? null })
      }

      if (request.method === 'GET' && path === '/me')
        return json({
          ok: true,
          name: user.name,
          createdAt: user.createdAt,
          trainerMapId: user.config.trainerMapId ?? null,
        })

      // The userscript registers the draft map it auto-created for a new user.
      // Idempotent and first-write-wins: a retry (or a second script instance)
      // must never orphan the map already carrying someone's deck.
      if (request.method === 'POST' && path === '/trainer-map') {
        const existing = user.config.trainerMapId
        if (existing) return json({ ok: true, trainerMapId: existing })
        const { mapId } = await request.json()
        if (typeof mapId !== 'string' || !/^[0-9a-f]{24}$/i.test(mapId))
          return json({ ok: false, error: 'mapId must be a 24-character map id' }, 400)
        await setConfig(env, user, { trainerMapId: mapId })
        return json({ ok: true, trainerMapId: mapId })
      }

      if (request.method === 'GET' && path === '/api/dashboard')
        return json(await buildDashboard(env, user))

      // The stored dossier, verbatim. The dashboard's round list is a trimmed
      // projection for charts; coaching needs the whole thing — panoId above
      // all, which is what lets a round played on another machine have its
      // panorama rebuilt locally (see coach/brief.mjs).
      if (request.method === 'GET' && path === '/api/rounds') {
        // ?id= fetches one specific round (the quiz replays old misses);
        // otherwise the newest ?limit= rounds.
        const id = url.searchParams.get('id')
        const rows = id
          ? await env.DB.prepare('SELECT json FROM rounds WHERE user_id = ? AND id = ?')
              .bind(user.id, id)
              .all()
          : await env.DB.prepare('SELECT json FROM rounds WHERE user_id = ? ORDER BY ts DESC LIMIT ?')
              .bind(user.id, Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 1)))
              .all()
        const rounds = (rows?.results ?? []).map((r) => JSON.parse(r.json))
        return json({ ok: true, rounds })
      }

      if (request.method === 'POST' && path === '/api/tlog') {
        const { status, body } = await handleTlog(env, user, await request.json())
        return json(body, status)
      }

      // The newest ?limit= lines, handed back oldest-first so they read as a
      // console rather than in reverse.
      if (request.method === 'GET' && path === '/api/tlog') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
        const rows = await env.DB.prepare(
          'SELECT ts, line FROM tlog WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
        )
          .bind(user.id, limit)
          .all()
        const lines = (rows?.results ?? []).reverse().map((r) => ({ ts: r.ts, line: r.line }))
        return json({ ok: true, lines })
      }

      // Tampermonkey installs straight from /geocoach.user.js (the loader);
      // the loader then pulls /geocoach.body.js fresh each page load. Both are
      // stamped with this Worker's origin and the caller's own token — the
      // committed source never carries either (see coach/server.mjs).
      if (
        request.method === 'GET' &&
        (path === '/geocoach.user.js' || path === '/geocoach.body.js')
      ) {
        const raw = path === '/geocoach.user.js' ? LOADER_SRC : USERSCRIPT_SRC
        const src = raw
          .replace("'__CLOUD_URL__'", JSON.stringify(url.origin))
          .replace("'__CLOUD_TOKEN__'", JSON.stringify(user.token))
          .replace(
            '// @connect      127.0.0.1',
            `// @connect      127.0.0.1\n// @connect      ${url.hostname}`,
          )
        return new Response(src, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            ...CORS,
          },
        })
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
        if (!env.STORE) return json({ ok: false, error: 'plonkit not provisioned (no R2)' }, 503)
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
