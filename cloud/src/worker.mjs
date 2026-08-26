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
  deckSummary,
  gradeRound,
  ratingNameFor,
  retrievabilityOf,
} from '../../coach/scheduler.mjs'
import { buildRankedDeck, deckSizeFor, metaKeyOf } from '../../coach/deck.mjs'
import SCOPE_REGIONS from '../../coach/scope-regions.json'
import { loadPack, locate } from '../../coach/geo/locate.mjs'
// The result-map overlay's geometry. Both modules are pure — no `node:`
// anything, no fs, no network — which is the whole reason they are modules
// rather than inlined halves of coach/server.mjs: the laptop and the Worker
// draw the same outline because they run the same code, not because two
// implementations were kept in step by hand.
import { loadMergedPack, norm, scopeOutline } from '../../coach/geo/outline.mjs'
import { LODS, clipGeometry, countVertices, simplifyAt } from '../../coach/geo/shape.mjs'
// Boundary packs, built by coach/geo/pack.mjs from the same geoBoundaries
// slices the result-map overlay draws.
import COUNTRY_PACK from '../../coach/geo/pack/admin0.bin'
import REGION_PACK from '../../coach/geo/pack/admin1.bin'
// The dissolved multi-region scopes, so "Paraná + Santa Catarina + Rio Grande
// do Sul" draws as one outline instead of three with their shared borders
// stroked down the middle.
import MERGED_PACK from '../../coach/geo/pack/merged.bin'
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

function inMetaScope(metaName, guessRegions) {
  const scopedTo = SCOPE_REGIONS[metaName]
  const spellings = (guessRegions ?? []).filter(Boolean).map(normRegion)
  if (!scopedTo || !spellings.length) return true
  return scopedTo.some((r) => spellings.includes(normRegion(r)))
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
  if (!hit) return { code: '??', name: 'unknown', region: '', regionNames: [], locality: '' }
  const sub = locate(region, lat, lng)
  return {
    code: hit.code,
    name: hit.name,
    region: sub?.name ?? '',
    // Every spelling the boundary knows, because a scope is written in one of
    // them and the round only records the first. Stripped before the round is
    // stored: it is scaffolding for the grade, not part of the history.
    regionNames: sub?.names ?? [],
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
  const place = ({ regionNames, ...rest }) => rest
  return {
    answer: place(answer),
    guessed: guessed && place(guessed),
    correctCountry,
    correctScope: correctCountry && (!metaName || inMetaScope(metaName, guessed?.regionNames)),
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

// ---------- scope outlines ----------

/**
 * The shape the result map highlights behind a card's scope.
 *
 * This used to be served only by coach/server.mjs, which meant the overlay was
 * exactly as awake as that laptop: a Brazil round recently drew no outline at
 * all because the lid was shut. The Worker has been carrying the boundary
 * packs all along to reverse-geocode rounds, so the geometry was already
 * sitting next to it — the only thing missing was a way to ask. These routes
 * are that, and they are the primary path now; the laptop is the fallback.
 *
 * Response-compatible with the laptop's, field for field, so a client switches
 * by changing its base URL and nothing else.
 */

/** The merged pack is wanted by this route and by nothing else, so it is
 * decoded apart from boundaries() rather than inside it: a round's reverse
 * geocode has no use for dissolved shapes and should not pay to decode them. */
let mergedPack = null
function outlinePacks() {
  const { country, region } = boundaries()
  mergedPack ??= loadMergedPack(MERGED_PACK)
  return { country, region, merged: mergedPack }
}

/** A scope is a handful of subdivisions; anything longer is a malformed query,
 * not a country's worth of real work to do. The laptop's ceiling, unchanged. */
const SCOPE_GEO_MAX_REGIONS = 40

/**
 * The point budget, and why the cloud needs one at all.
 *
 * The laptop serves pre-simplified slices, one directory per rung of the
 * ladder. The packs carry a single rung — the geocoder's full 1/2000°
 * resolution — because reverse geocoding wants precision, not thrift. Handed
 * straight to the browser that is Canada: 258,842 points and 4.6MB, which is
 * not a bandwidth problem so much as a frame-rate one. Every point the overlay
 * is given is held twice, in a glow layer and a line layer, and reprojected on
 * every frame of a zoom.
 *
 * So the same 12,000 the laptop uses, reached the same way: thin at a rung's
 * tolerance, and if it still does not fit, take the rung below. What does the
 * thinning is coach/geo/shape.mjs — the very simplifier that built the
 * laptop's slices, so a shape thinned here and the same shape read off disk
 * there are the same shape.
 */
const SCOPE_GEO_MAX_POINTS = 12_000

/**
 * Past the bottom of the ladder, the tolerance keeps going.
 *
 * LOD 0 is sized for a zoom-5 map and Canada still lands at 25,007 points
 * there, twice the budget, with no rung left to step down to. Rather than give
 * up and send it — which is what a bare `lod > 0` guard would do — the
 * tolerance is quadrupled until the budget is met. Canada settles at 0.08°:
 * the Arctic islands drop out (shape.mjs's own rule, a ring smaller than the
 * line that would draw it), the mainland survives whole, and 84KB goes over
 * the wire instead of 4.6MB.
 *
 * The ceiling is a stop, not a target — 4° is a shape the size of a continent
 * having its outline described by a dozen points, and nothing real should ever
 * reach it. It exists so a pathological input cannot spin here forever.
 */
const COARSEST_TOL = 4

const thinAt = (features, tol) =>
  features.map((f) => ({ ...f, geometry: simplifyAt(f.geometry, tol) })).filter((f) => f.geometry)

const pointsIn = (features) => features.reduce((n, f) => n + countVertices(f.geometry), 0)

const clipTo = (features, box) =>
  features
    .map((f) => ({ ...f, geometry: clipGeometry(f.geometry, [box.w, box.s, box.e, box.n]) }))
    .filter((f) => f.geometry)

/** `w,s,e,n` in degrees, or null for anything that is not four sane numbers
 * describing a rectangle with area. Rounded to five decimals — about a metre —
 * exactly as the laptop rounds it, so the two agree on what window was asked
 * for. Copied from coach/server.mjs's parseBox. */
function parseBox(raw) {
  const n = String(raw ?? '')
    .split(',')
    .map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null
  const [w, s, e, no] = n.map((v) => Math.round(v * 1e5) / 1e5)
  if (e <= w || no <= s || s < -90 || no > 90 || w < -180 || e > 180) return null
  return { w, s, e, n: no }
}

/** Plain extent of a feature list, in raw degrees — so a country straddling the
 * antimeridian reports the full -180..180 span rather than the narrow box the
 * eye sees, and the client can decide what to do about that. */
function extentOf(features) {
  let n = -Infinity
  let s = Infinity
  let e = -Infinity
  let w = Infinity
  for (const f of features)
    for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      for (const [x, y] of poly[0]) {
        if (y > n) n = y
        if (y < s) s = y
        if (x > e) e = x
        if (x < w) w = x
      }
  return n > s && e > w ? { n, s, e, w } : null
}

// Chile's outline reaches Easter Island, 3,500km out in the Pacific, and
// France's reaches Guyane. Framing the map on the full extent of either puts
// the country the round is actually about in one corner of an ocean. So the
// camera gets a second box: the main mass, grown outwards from the largest
// ring by absorbing whatever lies close to it, which keeps a coastal
// archipelago (all of Patagonia) and drops a mid-ocean territory.
//
// Ported from coach/server.mjs's framingBox rather than imported, because that
// file is the local bridge and reaches for node:fs on its first line. The
// client prefers `frame` over `bbox`, so a cloud answer without one would
// quietly reframe every Chile round on the Pacific.
const FRAME_GAP = 4 // degrees of open water an outlier may sit across
function framingBox(features) {
  const rings = []
  for (const f of features)
    for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) {
      let n = -Infinity
      let s = Infinity
      let e = -Infinity
      let w = Infinity
      for (const [x, y] of poly[0]) {
        if (y > n) n = y
        if (y < s) s = y
        if (x > e) e = x
        if (x < w) w = x
      }
      if (n > s && e > w) rings.push({ n, s, e, w, a: (n - s) * (e - w) })
    }
  if (!rings.length) return null
  rings.sort((a, b) => b.a - a.a)
  const box = { n: rings[0].n, s: rings[0].s, e: rings[0].e, w: rings[0].w }
  const taken = new Set([0])
  for (let grew = true; grew; ) {
    grew = false
    for (let i = 1; i < rings.length; i++) {
      if (taken.has(i)) continue
      const r = rings[i]
      const dy = Math.max(0, r.s - box.n, box.s - r.n)
      const dx = Math.max(0, r.w - box.e, box.w - r.e)
      if (dy > FRAME_GAP || dx > FRAME_GAP) continue
      taken.add(i)
      grew = true
      if (r.n > box.n) box.n = r.n
      if (r.s < box.s) box.s = r.s
      if (r.e > box.e) box.e = r.e
      if (r.w < box.w) box.w = r.w
    }
  }
  return box
}

/** A rung of the ladder that this build has. Anything outside it is clamped
 * rather than refused: the LOD is a rendering hint and the client still wants
 * its shape drawn. */
const lodFor = (raw) => Math.min(LODS.length - 1, Math.max(0, Math.trunc(Number(raw) || 0)))

/**
 * One scope query, resolved to the object to send back.
 *
 * The order of the four cases below is the whole of the behaviour, and it is
 * outline.mjs that decides them — a missing boundary, a country outline, a
 * dissolved region outline, or a country outline again when the named regions
 * match nothing (a partial scope draws a border the meta does not have, which
 * teaches the wrong thing; vague beats wrong).
 */
function buildScopeGeo(cc, regions, lod, clip) {
  const outline = scopeOutline(outlinePacks(), { country: cc, regions })
  // Nothing is broken and a retry will not help — geoBoundaries folds some
  // small territories into their sovereign and omits others — so this is "no
  // such shape" rather than "not ready": the client drops the overlay for this
  // round and moves on.
  if (!outline.ok)
    return { status: 404, body: { ok: false, kind: 'none', country: cc, lod, error: outline.error } }

  const source = outline.geojson.features
  const sourcePoints = pointsIn(source)

  // Down the ladder until the budget is met. `whole` is the untrimmed shape at
  // whatever rung we settled on: the camera is framed on the whole scope even
  // when only a window of it is sent, so the extents are taken before anything
  // is cut away.
  let served = lodFor(lod)
  let tol = LODS[served].tol
  let window = clip
  let whole = thinAt(source, tol)
  let features = window ? clipTo(whole, window) : whole
  // The window fell entirely outside the scope — which is a real thing for a
  // guess placed on the wrong continent. Nothing to draw there, but the shape
  // itself is fine, so answer with the whole of it and let the client frame.
  if (window && !features.length) {
    window = null
    features = whole
  }
  while (pointsIn(features) > SCOPE_GEO_MAX_POINTS) {
    if (served > 0) tol = LODS[(served -= 1)].tol
    else if (tol < COARSEST_TOL) tol *= 4
    else break
    whole = thinAt(source, tol)
    features = window ? clipTo(whole, window) : whole
    if (window && !features.length) {
      window = null
      features = whole
    }
  }

  const bbox = extentOf(whole) ?? { n: 90, s: -90, e: 180, w: -180 }
  return {
    status: 200,
    body: {
      ok: true,
      kind: outline.kind,
      country: cc,
      lod: served,
      label: outline.label,
      names: outline.names,
      bbox,
      frame: framingBox(whole) ?? bbox,
      // The window this answer covers, so the client knows when panning has
      // taken the map past the edge of what it was given. Absent means whole.
      clip: window ?? null,
      // How hard the budget had to work, so an outline that looks too coarse
      // is diagnosable from the browser's network tab rather than by guessing.
      // The laptop has no equivalent because its rungs are pre-built; here the
      // thinning happens per request and is worth reporting.
      points: pointsIn(features),
      sourcePoints,
      tol,
      budget: SCOPE_GEO_MAX_POINTS,
      geojson: { type: 'FeatureCollection', features },
    },
  }
}

/**
 * A country's name back to its ISO code.
 *
 * The catalogs know a location's country only by name, but a card's scope — and
 * the key the client stores an outline under — is the ISO code the geocoder
 * returned. So /api/scope-for-pano has to go that way round or the warmed shape
 * would sit under a key the card never asks for.
 *
 * Two sources, because neither alone is enough: the pack carries one name per
 * country and it is the cartographer's ("Czech Republic", "United States of
 * America"), while Intl carries the everyday one ("Czechia", "United States").
 * Together they resolve 93 of the 95 country names across all four catalogs;
 * the two that miss, Christmas Island and Réunion, are exactly the territories
 * geoBoundaries has no outline for, so there was never an overlay to warm.
 * Matched on outline.mjs's `norm` so the spelling rules are the ones the rest
 * of the geo layer uses. Built once per isolate.
 */
let codeByName = null
function countryCodeOf(name) {
  if (!name) return null
  if (!codeByName) {
    codeByName = new Map()
    const put = (key, code) => {
      if (key && !codeByName.has(key)) codeByName.set(key, code)
    }
    const codes = new Set()
    for (const f of boundaries().country.features) {
      codes.add(f.code)
      put(norm(f.name), f.code)
      for (const n of f.names ?? []) put(norm(n), f.code)
    }
    let display = null
    try {
      display = new Intl.DisplayNames(['en'], { type: 'region' })
    } catch {
      // No ICU region data — the pack names still carry most of the ladder.
    }
    if (display)
      for (const code of codes) {
        try {
          const shown = display.of(code)
          if (shown && shown !== code) put(norm(shown), code)
        } catch {
          // Not a region Intl knows; the pack name already covered it.
        }
      }
  }
  return codeByName.get(norm(name)) ?? null
}

/** The scope a pano will eventually be graded against, named a whole guess
 * early. Read-only, and deliberately mute about *why* there is no answer: a
 * pano from a map we never indexed and a country name no pack has a code for
 * are both simply "nothing to warm", and the client treats them identically. */
function scopeForPano(pano) {
  const loc = catalogLocation(pano)
  if (!loc) return null
  const cc = countryCodeOf(loc.country)
  if (!cc) return null
  return { country: cc.toUpperCase(), regions: SCOPE_REGIONS[metaKeyOf(loc.country, loc.metaName)] ?? null }
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

/**
 * The one number the dashboard leads with: how many clues the player is
 * holding right now, where "holding" means FSRS puts recall at or above the
 * retention the scheduler is actually tuned for. A clue below that line is one
 * the deck is about to hand back, so the count is a live measure of what has
 * stuck rather than a tally of what has been seen.
 */
const HELD_AT = 0.9
const WEEK = 7 * 24 * 60 * 60 * 1000
// Enough points to show a shape, few enough that the line stays readable and
// the replay below stays cheap.
const SERIES_POINTS = 26

function heldCount(cards, at) {
  let held = 0
  for (const card of Object.values(cards)) if (retrievabilityOf(card, at) >= HELD_AT) held += 1
  return held
}

/**
 * The same count over time — and it cannot be read off today's card table.
 * Evaluating a current card at a past date claims the player held a clue they
 * had not yet seen, which draws a line that starts high and sags. So this is a
 * replay: every round folded back in at the moment it was really played, with
 * the count taken at each step along the way. The final point is taken from
 * the live table instead, so the end of the line always agrees with the number
 * printed above it.
 */
async function buildProgress(env, user, live, now) {
  const rows = await env.DB.prepare(
    `SELECT ts,
            json_extract(json, '$.metaName') AS metaName,
            json_extract(json, '$.rating') AS rating,
            COALESCE(json_extract(json, '$.correctScope'), json_extract(json, '$.correctCountry')) AS correct
       FROM rounds WHERE user_id = ? ORDER BY ts ASC`,
  )
    .bind(user.id)
    .all()
  const played = (rows?.results ?? []).filter((r) => r.metaName)

  const series = []
  if (played.length) {
    const from = new Date(played[0].ts).getTime()
    // Widen the bucket rather than thinning the points, so every sample is a
    // real reading at a real date instead of a survivor of a decimation pass.
    const span = Math.max(now.getTime() - from, WEEK)
    const step = Math.max(WEEK, Math.ceil(span / SERIES_POINTS / WEEK) * WEEK)
    let cards = {}
    let mark = from + step
    for (const r of played) {
      const at = new Date(r.ts)
      while (at.getTime() >= mark && series.length < SERIES_POINTS) {
        const on = new Date(mark)
        series.push({ t: on.toISOString(), held: heldCount(cards, on) })
        mark += step
      }
      cards = gradeRound(
        cards,
        { metaName: r.metaName, rating: r.rating ?? undefined, correct: !!r.correct },
        at,
      )
    }
  }
  series.push({ t: now.toISOString(), held: heldCount(live, now) })
  return series
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

  const [countRow, roundRows, weakestImages, series] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM rounds WHERE user_id = ?').bind(user.id).first(),
    env.DB.prepare('SELECT json FROM rounds WHERE user_id = ? ORDER BY ts DESC LIMIT 300')
      .bind(user.id)
      .all(),
    // A slipping clue is worth looking at, not just reading — so each one
    // carries the picture from its LM card.
    Promise.all(weakest.map((m) => metaImage(env, m.metaName))),
    buildProgress(env, user, state.deckCards, now),
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
    progress: {
      held: series[series.length - 1].held,
      total: introduced + summary.unseen,
      series,
    },
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
  let firstSight = false
  if (metaName) {
    const isPadding = !!state.lastDeck?.padding?.includes(metaName)
    // A first-sight meta answered correctly is the one grade this system used to
    // guess at. Everything else is measured: you either recalled a card that was
    // already in the deck or you didn't. But the first time a meta is served,
    // "correct" only says the pin landed in the right place — it does not say
    // you read the clue the location was chosen for. Get Ecuador off the Spanish
    // and the mountains, never look at the truck, and the truck meta would be
    // marked known and pushed eight days out on the strength of a round it was
    // never tested in.
    //
    // So the card asks, and until it is answered the round counts as uncredited:
    // not correct, no streak, graded Again. Tapping "yes, I knew it" is what
    // turns it into the Easy this used to assume. Padding rounds are excluded
    // because a correct one is not graded at all, and so are duels — the card
    // never appears there, so there is no question to leave unanswered.
    firstSight = !state.deckCards[metaName] && correctScope && !isPadding && !!meta && source !== 'duel'
    const credited = correctScope && !firstSight
    inferredRating = ratingNameFor(credited, !state.deckCards[metaName])
    snapshot = {
      metaName,
      ts: round.ts,
      padding: isPadding,
      prevCard: state.deckCards[metaName] ?? null,
      prevMeta: state.metas[metaName] ? { ...state.metas[metaName] } : null,
    }

    const m = (state.metas[metaName] ??= { seen: 0, correct: 0, streak: 0 })
    m.seen += 1
    if (credited) {
      m.correct += 1
      m.streak += 1
    } else {
      m.streak = 0
    }
    // Correct padding rounds are free practice, ungraded (see the local bridge
    // for the FSRS rationale); a wrong padding answer is real forgetting.
    if (!(isPadding && correctScope)) {
      state.deckCards = gradeRound(state.deckCards, { metaName, correct: credited }, new Date())
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
            firstSight,
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

/**
 * JSON with the body gzipped when the caller says it can take it.
 *
 * Only the overlay routes use this, and only because of what they carry: a
 * country outline is a list of coordinates, which is about the most
 * compressible thing there is — Canada goes 84KB → 21KB. Cloudflare would
 * compress at the edge anyway for a browser, but the userscript reaches these
 * through GM_xmlhttpRequest from geoguessr.com, and doing it here means the
 * saving does not depend on which path the request took.
 *
 * `Vary: Accept-Encoding` because the body genuinely differs by it, and a
 * cache that missed that would hand a gzipped body to a client that asked for
 * plain bytes.
 */
function cachedJson(obj, status = 200, cacheControl = 'no-store') {
  // These bodies are geometry and compress ten to one, but the compressing is
  // Cloudflare's job and not this Worker's. It used to be done here — gzip the
  // bytes, set Content-Encoding, hand it over — and the edge then compressed
  // the already-compressed body a second time while leaving the single header
  // in place. A browser decodes once, exactly as the header instructs, and is
  // left holding gzip bytes it was told were JSON. The parse fails, the
  // userscript reads a working server as unusable and moves to the next one,
  // and the overlay draws only if the laptop happens to be awake to answer.
  // Nothing local reproduced it: the tests call this module directly, so the
  // second compression never happened, and the LAN server never compressed at
  // all. Shipping plain JSON and letting the edge negotiate its own encoding
  // is both smaller on the wire and the only version that cannot disagree
  // with its own header.
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      Vary: 'Accept-Encoding',
      ...CORS,
    },
  })
}

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
/**
 * API routes that carry no token.
 *
 * The overlay routes answer with boundary geometry and with catalog facts —
 * where a border runs, which meta a pano teaches. None of it is anybody's, and
 * gating it would mean an edge cache keyed per token, which is the opposite of
 * what a shape every player asks for the same answer to wants. They are listed
 * here so the workers.dev redirect and the SPA fallback leave them alone; the
 * handlers themselves sit above the auth wall.
 */
const PUBLIC_API_PATHS = new Set(['/api/scope-geo', '/api/scope-for-pano'])

const isApiPath = (path) =>
  AUTHED_PATHS.has(path) ||
  PUBLIC_API_PATHS.has(path) ||
  path.startsWith('/plonkit/') ||
  path.startsWith('/rounds/')

/** Every path the client router draws a page for; site/App.tsx holds the same
 * list and the two have to agree. A trailing slash is the same page. */
const KNOWN_PAGES = new Set(['/', '/start', '/app'])
const isKnownPage = (path) => KNOWN_PAGES.has(path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path)

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
  const shell = await env.ASSETS.fetch(new Request(`${url.origin}/`, request))
  // The shell is the right body for an unknown path too — the client router
  // renders its own not-found page from it — but not with a 200 on it. A
  // mistyped URL answering 200 meant crawlers indexed junk paths as real
  // pages and link checkers reported a site with no broken links at all.
  if (isKnownPage(url.pathname)) return shell
  return new Response(shell.body, { status: 404, headers: shell.headers })
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

      // The shape behind a card's `scope`, and the primary source of it — the
      // laptop's /api/scope-geo is the fallback now, not the other way round.
      //   /api/scope-geo?country=ES[&regions=Cataluña|Aragón][&lod=0][&box=w,s,e,n]
      // Parameters and response are coach/server.mjs's, field for field.
      if (request.method === 'GET' && path === '/api/scope-geo') {
        const country = (url.searchParams.get('country') ?? '').trim()
        if (!/^[A-Za-z]{2}$/.test(country))
          return cachedJson({ ok: false, error: 'country must be an ISO 3166-1 alpha-2 code' }, 400)
        const regions = (url.searchParams.get('regions') ?? '')
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, SCOPE_GEO_MAX_REGIONS)
        // &box=w,s,e,n asks for only the part of the shape inside that
        // rectangle — the window the client is looking at, grown past the
        // screen edge — so a zoomed-in map is not paying for a whole country.
        const clip = parseBox(url.searchParams.get('box'))
        const { status, body } = buildScopeGeo(country.toUpperCase(), regions, url.searchParams.get('lod') ?? 0, clip)
        // Borders do not move and the packs only change on a deploy, so a
        // shape is good for the day at the edge and in the browser alike. A
        // miss is not cached at all: a country that gains a boundary in the
        // next pack build should draw the moment that build ships.
        return cachedJson(body, status, status === 200 ? 'public, max-age=86400, s-maxage=86400' : 'no-store')
      }

      // The same scope the card will eventually carry, named a whole guess
      // early: the pano id is on screen the moment the round is served, so the
      // client asks for this then and has the boundary in its store long
      // before the card needs it.
      //   /api/scope-for-pano?pano=<panoId>
      if (request.method === 'GET' && path === '/api/scope-for-pano') {
        const scope = scopeForPano((url.searchParams.get('pano') ?? '').trim())
        // A hit is a fact about a bundled catalog and cannot change until the
        // next deploy, so it caches; a miss might be a catalog not yet
        // reindexed, and should be asked again.
        return cachedJson(
          scope ? { ok: true, scope } : { ok: false },
          200,
          scope ? 'public, max-age=86400, s-maxage=86400' : 'no-store',
        )
      }
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500)
    }

    if (!isApiPath(path)) return serveStatic(request, env, url)

    const user = await authUser(env, request, url)
    if (!user) {
      // The script paths are the one place a person, rather than a program,
      // reads a 401 — they got here by clicking an install link that had gone
      // stale, and `{"ok":false,"error":"missing or unknown token"}` in a
      // Tampermonkey error pane tells them nothing about what to do next.
      if (path === '/geocoach.user.js' || path === '/geocoach.body.js')
        return new Response(
          `// This GeoCoach install link is no longer valid.\n` +
            `// Open ${url.origin}/start to get a working one.\n`,
          {
            status: 401,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
          },
        )
      return json({ ok: false, error: 'missing or unknown token' }, 401)
    }

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
        const size = deckSizeFor(url.searchParams.get('n'))
        const { customCoordinates, ranking, stats } = buildRankedDeck(
          state.deckCards,
          CATALOGS,
          toLadder(CATALOGS),
          size,
          now,
        )

        // Not-yet-due metas are this deck's padding: they only appear when the
        // queue runs out of real work, and getting one right proves nothing
        // FSRS did not already know. Same contract buildDeck's padding had, so
        // the grading rule in handleRound needs no change.
        const paddingNames = ranking.filter((r) => r.kind === 'future').map((r) => r.name)
        state.lastDeck = { ts: now.toISOString(), metas: ranking.map((r) => r.name), padding: paddingNames }
        await saveUserState(env, user.id, state)

        const prewarm = ranking.filter((r) => r.panoId).map((r) => ({ mapId: r.mapId, panoId: r.panoId }))

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

        // `summary` keeps the field names the userscript already logs, mapped
        // onto rankDeck's counts: `introduced` was buildDeck's word for metas
        // entering the deck for the first time, which is rankDeck's `new`.
        const due = ranking.filter((r) => r.kind === 'due').length
        const fresh = ranking.filter((r) => r.kind === 'new').length
        return json({
          trainerMapId: user.config.trainerMapId ?? null,
          customCoordinates,
          summary: { due, introduced: fresh, unlockedTiers: stats.unlockedTiers },
          // Why these, in the order that decided it. The whole point of a
          // just-in-time deck is that the priority is what GeoGuessr draws
          // from, so the priority has to be inspectable — from the userscript,
          // from a debug view, from a browser tab.
          ranking,
          stats,
          description: `Auto-generated spaced-repetition deck — ${due} due, ${fresh} new (${now.toISOString().slice(0, 16)})`,
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
        // @updateURL and @downloadURL are committed pointing at the laptop's
        // own server, which is right for the laptop and wrong for everybody
        // else: a stranger's install checked http://127.0.0.1:5177 for updates
        // forever, on a machine with nothing listening there, so the loader
        // could never be upgraded once it was installed. Repointed at whatever
        // origin actually served it, token and all, exactly as the install
        // link was.
        const selfUrl = `${url.origin}/geocoach.user.js?token=${encodeURIComponent(user.token)}`
        const src = raw
          .replace("'__CLOUD_URL__'", JSON.stringify(url.origin))
          .replace("'__CLOUD_TOKEN__'", JSON.stringify(user.token))
          .replaceAll('http://127.0.0.1:5177/geocoach.user.js', selfUrl)
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
