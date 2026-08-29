/**
 * GeoCoach bridge — receives each GeoGuessr round from the userscript and
 * builds a coaching dossier on disk for Claude to read.
 *
 * Deliberately makes NO LLM API calls: the coaching intelligence is the
 * Claude Code session watching coach/rounds/. This process only does plumbing:
 *   - reverse-geocodes the answer and the guess against bundled boundaries
 *   - fetches street-view tiles for the round's panorama (public tile CDN, no key)
 *   - asks Learnable Meta for the round's intended meta, when the map has one
 *   - embeds the Plonk It clues for both countries from the app's own data
 *   - keeps running per-country stats and a confusion log in coach/state.json
 *
 * Run:  node coach/server.mjs     (listens on 127.0.0.1:5177)
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { saveRoundTiles } from './pano.mjs'
import { countryCode, countryShape, geoReady, lodFor, regionShapes } from './geo/resolve.mjs'
import { loadPack, locate } from './geo/locate.mjs'
import { COUNTRY_PACK, REGION_PACK } from './geo/pack.mjs'
import { clipGeometry } from './geo/shape.mjs'
import { buildRankedDeck, deckSizeFor, metaKeyOf } from './deck.mjs'
import {
  deckSummary,
  DEFAULT_DAILY_NEW,
  gradeRound,
  MASTERY_DAYS,
  newIntroducedToday,
  reviewsCompletedToday,
  ratingNameFor,
  retrievabilityOf,
} from './scheduler.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const ROUNDS_DIR = join(ROOT, 'rounds')

/* Old captures only kept the pano_0_* row; newer ones hold the full tile grid.
   Resolve a tile that is actually on disk so the round log never asks for a
   404, and memoise it — a round's files never change once it is captured.
   Returns null when nothing was captured, which the client draws as a gap. */
const THUMB_CANDIDATES = ['pano_3_6.jpg', 'pano_0_3.jpg', 'pano.jpg']
const thumbCache = new Map()
function thumbFor(id) {
  if (!id) return null
  if (thumbCache.has(id)) return thumbCache.get(id)
  const hit = THUMB_CANDIDATES.find((f) => existsSync(join(ROUNDS_DIR, id, f))) ?? null
  const url = hit && `/rounds/${id}/${hit}`
  thumbCache.set(id, url)
  return url
}
const STATE_PATH = join(ROOT, 'state.json')
const PORT = 5177

/* The userscript's own debug lines, shipped home every ~10s so a silent
   capture failure on the gaming PC is diagnosable here rather than invisible.
   Bounded at every end: one request can't flood the file, one line can't be a
   novel, and the file is trimmed back to a tail once it passes ~1MB. */
const TLOG_PATH = join(ROOT, 'tlog.log')
const TLOG_MAX_LINES = 200
const TLOG_MAX_BYTES = 1_000_000
const TLOG_KEEP_LINES = 2000

async function appendTlog(lines) {
  const chunk = lines
    .map((e) => {
      const t = Number(e?.t)
      const ts = new Date(Number.isFinite(t) ? t : Date.now()).toISOString()
      // Newlines would break the one-entry-per-line contract this file exists for.
      const line = String(e?.line ?? '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 500)
      return `${ts} ${line}\n`
    })
    .join('')
  await appendFile(TLOG_PATH, chunk)
  const { size } = await stat(TLOG_PATH)
  if (size > TLOG_MAX_BYTES) {
    const kept = (await readFile(TLOG_PATH, 'utf8')).split('\n').slice(-TLOG_KEEP_LINES)
    await writeFile(TLOG_PATH, kept.join('\n'))
  }
}

// The full Plonk It scrape lives in the app; the dossier embeds the relevant
// slice so a coaching session needs no repo lookups to cite real clues.
const CLUES = JSON.parse(await readFile(join(ROOT, '..', 'src', 'data', 'clues.json'), 'utf8'))
const cluesFor = (cc) =>
  CLUES.filter((c) => c.country === cc).map(({ category, description, notes, source }) => ({
    category,
    description,
    notes,
    source,
  }))

async function loadState() {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    state.metas ??= {}
    state.deckCards ??= {}
    state.lastDeck ??= null
    return state
  } catch {
    return { rounds: [], countries: {}, confusions: {}, metas: {}, deckCards: {}, lastDeck: null }
  }
}

const CONFIG = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'))

/**
 * The player's new-metas-a-day allowance, as the config file gives it — or the
 * scheduler's default when the file has nothing sane to say.
 *
 * `dailyNew` is optional and absent from the shipped config on purpose: the
 * number that matters is argued out in scheduler.mjs, and a host that has not
 * been told otherwise should get that argument rather than a copy of it that
 * can drift. So this only exists to catch a hand-edit — the file is edited by
 * hand, which is exactly where a "10 " or a 1000 ends up.
 *
 * Validated rather than trusted because the failure is silent in the worst
 * direction: a NaN allowance subtracts to NaN, every comparison against it is
 * false, and the deck quietly stops introducing anything at all with nothing
 * in the log to say why. Zero survives the check — "review only today" is a
 * real setting — and the ceiling is only there so a stray extra digit cannot
 * commit the next fortnight to a thousand new metas.
 *
 * The same reading the Worker gives its own stored setting, down to the
 * ceiling and the tolerance of "10" for 10: the two hosts serve the same deck
 * to the same player, and a config that means one thing on the laptop and
 * another in the cloud is a bug that only shows up on the day one of them is
 * unreachable.
 */
const MAX_DAILY_NEW = 100
function resolveDailyNew(raw) {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) return DEFAULT_DAILY_NEW
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n >= 0 && n <= MAX_DAILY_NEW ? n : DEFAULT_DAILY_NEW
}
const DAILY_NEW = resolveDailyNew(CONFIG.dailyNew)

/**
 * Meta-tagged location catalogs built by index-catalog.mjs, ordered by tier.
 * Reloaded lazily so a freshly indexed map is picked up without a restart.
 */
async function loadCatalogs() {
  const catalogs = []
  try {
    for (const file of await readdir(join(ROOT, 'catalog'))) {
      if (!file.endsWith('.json')) continue
      catalogs.push(JSON.parse(await readFile(join(ROOT, 'catalog', file), 'utf8')))
    }
  } catch {}
  catalogs.sort((a, b) => a.tier - b.tier)
  return catalogs
}

/**
 * Meta identity is country + name: LM reuses bare names across countries
 * ("Pole" is a Thai meta and a Brazilian one), so bare names would merge
 * unrelated cards.
 */

/** Metas whose physical design is shared across countries: any country in the
 * set is a correct read. Codes are the uppercase ISO codes countryOf returns. */
const LOOKALIKE_METAS = {
  'Czechia: Bollard': new Set(['CZ', 'SK']),
  'Slovakia: Bollard': new Set(['CZ', 'SK']),
}

/** The scheduler's view: tiers with their meta key lists. */
function toLadder(catalogs) {
  return catalogs.map((c) => ({
    mapId: c.mapId,
    name: c.name,
    tier: c.tier,
    metas: [...new Set(c.locations.map((l) => metaKeyOf(l.country, l.metaName)).filter(Boolean))],
  }))
}

/**
 * The session as things-done against things-to-do, in one place.
 *
 * Field-for-field what the cloud Worker's /round and /status return, because
 * the same userscript draws the same readout whichever host answered it: a
 * laptop that named the halves differently would simply stop the progress bar
 * appearing on the machine it was developed on.
 *
 * Neither half decides what "today" means — both counters take the
 * scheduler's rolling window and its own line between a review and an
 * introduction.
 */
function dayState(cards, summary, now) {
  const newIntroduced = newIntroducedToday(cards, now)
  const newAllowance = Math.max(0, DAILY_NEW - newIntroduced)
  return {
    reviewsDone: reviewsCompletedToday(cards, now),
    reviewsDue: summary.due,
    newIntroduced,
    dailyNew: DAILY_NEW,
    newAllowance,
    doneForToday: summary.due === 0 && (newAllowance === 0 || summary.unseen === 0),
  }
}

/** Our own trainer-map rounds carry no LM data — resolve the meta locally. */
async function metaFromCatalogs(panoId) {
  if (!panoId) return null
  for (const c of await loadCatalogs()) {
    const hit = c.locations.find((l) => l.panoId === panoId)
    if (hit && hit.metaName) {
      // the catalog knows the meta name; LM's per-pano endpoint (queried with
      // the SOURCE map id it recognises) adds the annotated lesson + images
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

// Reverse geocoding is offline, from the same boundary packs the Worker
// bundles. It used to call BigDataCloud; their free endpoint is browser-only
// and answers a server with 402 (and bans the IP), so every lookup here was
// one outage away from recording the round as "??".
let packs = null
function boundaries() {
  if (!packs) {
    packs = {
      country: existsSync(COUNTRY_PACK) ? loadPack(readFileSync(COUNTRY_PACK)) : null,
      region: existsSync(REGION_PACK) ? loadPack(readFileSync(REGION_PACK)) : null,
    }
    if (!packs.country) console.warn('no boundary pack — run: node coach/geo/pack.mjs')
  }
  return packs
}

function countryOf(lat, lng) {
  const { country, region } = boundaries()
  const hit = country && locate(country, lat, lng)
  if (!hit) return { code: '??', name: 'unknown', region: '', regionNames: [], locality: '' }
  const sub = region && locate(region, lat, lng)
  return {
    code: hit.code,
    name: hit.name,
    region: sub?.name || '',
    // Every spelling the boundary knows. A scope is written in one of them and
    // the round records only the first, so the grade reads this and the stored
    // round drops it.
    regionNames: sub?.names ?? [],
    locality: '',
  }
}

/** A located point as a round stores it — the spelling list is grading
 * scaffolding and never becomes history. */
const place = ({ regionNames, ...rest }) => rest


/** The intended meta for this location, when the map is a Learnable Meta map. */
async function lmMeta(mapId, panoId) {
  try {
    const params = new URLSearchParams({
      panoId,
      mapId,
      userscriptVersion: '1.0.0',
      source: 'map',
    })
    const res = await fetch(`https://learnablemeta.com/api/userscript/location?${params}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Three weeks of plausible synthetic play, built from the real catalogs, so
 * the dashboard can be previewed in its lived-in state. Seeded PRNG: stable
 * between reloads, no persistence, never touches real state.
 */
async function demoState() {
  const catalogs = await loadCatalogs()
  let seed = 42
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const locs = catalogs.flatMap((c) => c.locations.filter((l) => l.metaName && l.country))
  const state = { rounds: [], countries: {}, confusions: {}, metas: {}, deckCards: {}, lastDeck: null }
  const NAME2CODE = (() => {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' })
    const map = {}
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (const a of A) for (const b of A) {
      const code = a + b
      try {
        const name = dn.of(code)
        if (name && name !== code) map[name] = code
      } catch {}
    }
    map['Russian Federation (the)'] = 'RU'
    return map
  })()
  const codeOf = (name) => NAME2CODE[name] ?? '??'
  const NEAR = { Thailand: 'LA', Colombia: 'EC', Germany: 'AT', Sweden: 'NO', Brazil: 'AR', Australia: 'NZ', Poland: 'CZ', Bulgaria: 'RO', Malaysia: 'ID', Peru: 'BO' }
  const DAYS = 21, perDay = () => 5 + Math.floor(rnd() * 20)
  // real dossiers on disk with tile imagery, reused for demo thumbnails
  const realTiles = ['1786754873405_r1', '1786756515965_r1']
  for (let day = 0; day < DAYS; day++) {
    const skill = 0.3 + (day / DAYS) * 0.5 // improves over the three weeks
    const n = day % 6 === 3 ? 0 : perDay() // one rest day a week
    for (let i = 0; i < n; i++) {
      const loc = locs[Math.floor(rnd() * locs.length)]
      const correct = rnd() < skill
      const ts = new Date(Date.now() - (DAYS - day) * 864e5 + i * 9e5).toISOString()
      const guessCode = correct ? null : NEAR[loc.country] ?? locs[Math.floor(rnd() * locs.length)].country
      const answer = { code: codeOf(loc.country), name: loc.country, region: '', lat: loc.lat, lng: loc.lng }
      // resolve a representative point for the guessed country from the pool
      const gLoc = correct ? loc : locs.find((l) => codeOf(l.country) === guessCode) ?? locs[Math.floor(rnd() * locs.length)]
      const guess = {
        code: correct ? answer.code : codeOf(gLoc.country ?? ''),
        name: correct ? loc.country : gLoc.country,
        lat: gLoc.lat + (rnd() - 0.5) * 4,
        lng: gLoc.lng + (rnd() - 0.5) * 4,
      }
      const metaKey = metaKeyOf(loc.country, loc.metaName)
      const round = {
        id: `demo_${day}_${i}`,
        thumb: realTiles[(day + i) % realTiles.length],
        ts, demo: true,
        answer, guess,
        correctCountry: correct,
        distanceKm: correct ? Math.floor(rnd() * 300) : 800 + Math.floor(rnd() * 6000),
        metaName: metaKey,
        score: correct ? 3600 + Math.floor(rnd() * 1400) : Math.floor(rnd() * 1600),
      }
      state.rounds.push(round)
      const row = (state.countries[answer.code] ??= { seen: 0, correctCountry: 0 })
      row.seen++; if (correct) row.correctCountry++
      if (!correct) {
        const pair = `${answer.code}>${guess.code}`
        state.confusions[pair] = (state.confusions[pair] ?? 0) + 1
      }
      state.deckCards = gradeRound(state.deckCards, { metaName: metaKey, correct }, new Date(ts))
    }
  }
  // mark demo rounds so the client knows dossier files may not exist
  for (const r of state.rounds) if (r.id.startsWith('demo_')) r.demo = true
  return state
}

// Dedupe ledger for /round posts. A page reload (Chrome memory-saver, F5 on
// the results screen) spawns a fresh userscript instance whose in-memory sent
// set is empty, so it re-posts every round of the game it next intercepts —
// which double-grades FSRS and duplicates dossiers. The server is the durable
// layer: keys with a game token are dropped forever (tokens are single-use);
// tokenless keys (older script versions) expire after 30 minutes so a genuine
// later replay of the same location still grades.
const SEEN_PATH = join(ROOT, 'seen.json')
let seenPosts = null
async function loadSeen() {
  if (!seenPosts) {
    try {
      seenPosts = new Map(Object.entries(JSON.parse(await readFile(SEEN_PATH, 'utf8'))))
    } catch {
      seenPosts = new Map()
    }
  }
  return seenPosts
}
function saveSeen() {
  while (seenPosts.size > 1000) seenPosts.delete(seenPosts.keys().next().value)
  writeFile(SEEN_PATH, JSON.stringify(Object.fromEntries(seenPosts))).catch(() => {})
}

const haversineKm = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)))
}

/**
 * Region-scoped grading. Some metas pin down a named REGION of their country —
 * WA yellow sign posts, Ontario diamonds, Kansai plates — and for those,
 * clicking the right country in the wrong region is still a miss.
 * scope-regions.json is hand-curated from the clue texts: metaKey → the admin
 * subdivisions the clue actually covers. The guess pin's reverse geocode
 * already carries its subdivision (countryOf's `region`), so the test costs
 * nothing extra. Metas absent from the file are countrywide, and a guess whose
 * geocode returned no subdivision passes rather than failing on missing data.
 */
let scopeRegions = null
async function loadScopeRegions() {
  if (!scopeRegions) {
    try {
      scopeRegions = JSON.parse(await readFile(join(ROOT, 'scope-regions.json'), 'utf8'))
    } catch {
      scopeRegions = {}
    }
  }
  return scopeRegions
}

/** Subdivision names compared loosely: case, diacritics, đ, and generic
 * suffixes ("Osaka Prefecture", "Vientiane Province") don't matter. */
const normRegion = (s) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\b(prefecture|province|region|state|district|county|governorate|oblast)\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()

/** True when the guess satisfies the meta's scope (which, for most metas, is
 * simply "anywhere" — the caller has already checked the country). */
async function inMetaScope(metaName, guessRegions) {
  const scopedTo = (await loadScopeRegions())[metaName]
  const spellings = (guessRegions ?? []).filter(Boolean).map(normRegion)
  if (!scopedTo || !spellings.length) return true
  return scopedTo.some((r) => spellings.includes(normRegion(r)))
}

/**
 * Resolved scope boundaries, keyed by the query that produced them and held as
 * finished response bytes. The deck replays the same few dozen metas, so the
 * second round on a meta should cost nothing; the cap keeps a long session
 * from pinning every country's coastline in memory at once. "We have no shape
 * for this" is cached the same way — a country that is missing today is
 * missing for the whole session, and re-deciding that per round is waste.
 *
 * The LOD is part of the key: the same meta at two zoom bands is two different
 * payloads, and Canada's finest rung is a megabyte that must not be handed out
 * in place of the coarse one the client asked for.
 */
const scopeGeoCache = new Map()
const SCOPE_GEO_LIMIT = 50
const SCOPE_GEO_MAX_REGIONS = 40
/**
 * The most coordinates worth putting on the screen at once.
 *
 * The boundary source went from Natural Earth to OpenStreetMap, and the finest
 * rung stopped being small: Japan is a comfortable twelve thousand points, but
 * Canada's coast at the same tolerance is two and a half million, which no
 * browser draws and no map needs — the whole of it is on screen only when the
 * map is zoomed out far enough that the coarse rung is indistinguishable.
 *
 * So a rung that overshoots is answered with the next one down, and the reply
 * says which rung it actually is. The client already handles being given less
 * detail than it asked for: it notices the point count did not go up, keeps
 * what it has, and stops asking for that rung this round.
 */
const SCOPE_GEO_MAX_POINTS = 12_000
/** And a ceiling on the cache itself, since these are now sometimes megabytes
 * rather than always kilobytes: fifty of Canada would be the whole process. */
const SCOPE_GEO_CACHE_BYTES = 64 * 1024 * 1024
const scopeGeoMissing = new Set()
const scopeGeoUnmerged = new Set()

/** `w,s,e,n` in degrees, or null for anything that is not four sane numbers
 * describing a rectangle with area. Rounded to five decimals — about a metre,
 * far finer than any window matters to, and enough to make the cache key stable
 * across the sub-pixel jitter of a map settling. */
function parseBox(raw) {
  const n = String(raw ?? '')
    .split(',')
    .map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null
  const [w, s, e, no] = n.map((v) => Math.round(v * 1e5) / 1e5)
  if (e <= w || no <= s || s < -90 || no > 90 || w < -180 || e > 180) return null
  return { w, s, e, n: no }
}

/** One scope query at one LOD, resolved to the exact bytes to send back (both
 * encodings, since which one goes out depends on the request). */
function buildScopeGeo(cc, regions, lod, clip) {
  const bytes = (status, obj) => {
    const json = Buffer.from(JSON.stringify(obj))
    return { status, json, gzip: gzipSync(json) }
  }

  const shape = countryShape(cc, lod)
  // Natural Earth carries no admin0 for some of the small territories the
  // geocoder still names — Christmas Island, Réunion — and a failed geocode
  // asks for shapes like ZZ. Nothing is broken and a retry will not help, so
  // this is "no such shape" rather than the "not ready" above: the client
  // drops the overlay for this round and moves on. Logged once per code, so a
  // gap that IS fixable stays visible without a line every round.
  if (!shape) {
    if (!scopeGeoMissing.has(cc)) {
      scopeGeoMissing.add(cc)
      console.log(`[coach] scope-geo: no boundary on file for ${cc} — no overlay for rounds there`)
    }
    return bytes(404, { ok: false, kind: 'none', country: cc, lod, error: `no boundary on file for ${cc}` })
  }

  const feature = (name, geometry) => ({ type: 'Feature', properties: { name }, geometry })
  let kind = 'country'
  let names = [shape.name]
  let features = [feature(shape.name, shape.geometry)]
  if (regions.length) {
    const { matched, missing } = regionShapes(cc, regions, lod)
    // Only a scope that resolves to *nothing* is worth a line here. Entries
    // deliberately list several spellings of the same subdivision — the
    // geocoder's English name beside the local one — so individual names going
    // unmatched is the normal case, not a fault. Whether every entry still
    // covers the ground it means to is coach/geo/audit.mjs's job.
    if (!matched.length)
      console.warn(
        `[coach] scope-geo: no ${cc} subdivision matches ${missing.join(', ')} — falling back to the country outline; check coach/scope-regions.json`,
      )
    // Partial scopes draw a border the meta does not actually have, which
    // teaches the wrong thing. Falling back to the whole country is merely
    // vague, so anything short of one match takes the country outline.
    if (matched.length) {
      kind = 'region'
      names = matched.map((f) => f.name)
      features = matched.map((f) => feature(f.name, f.geometry))
      // regionShapes collapses a known multi-region scope to one dissolved
      // feature; more than one here means build.mjs has no merge for this set,
      // and the overlay will show a stroke along every shared border. Almost
      // always the same cause: scope-regions.json gained an entry and the
      // slices were never rebuilt.
      if (features.length > 1 && !scopeGeoUnmerged.has(cc + '|' + names.join('|'))) {
        scopeGeoUnmerged.add(cc + '|' + names.join('|'))
        console.warn(
          `[coach] scope-geo: no dissolved shape for ${cc} ${names.join(' + ')} — internal borders will show; run: node coach/geo/build.mjs`,
        )
      }
    }
  }
  // The camera is framed on the whole scope even when only a window of it is
  // sent, so the extents are taken before anything is cut away.
  const whole = features
  // A window on the shape rather than the shape. What a zoomed-in map can show
  // is a few kilometres of coast; sending Canada to draw it is the reason the
  // finest rung had to be refused to exactly the countries that needed it most.
  if (clip) {
    features = features
      .map((f) => ({ ...f, geometry: clipGeometry(f.geometry, [clip.w, clip.s, clip.e, clip.n]) }))
      .filter((f) => f.geometry)
    // The window fell entirely outside the scope — which is a real thing for a
    // guess placed on the wrong continent. Nothing to draw here, but the shape
    // itself is fine, so answer with the whole of it and let the client frame.
    if (!features.length) return buildScopeGeo(cc, regions, lod, null)
  }
  // Too much to draw at this rung — answer with the next one down. The budget
  // is not about bandwidth: every point the client is given is held twice, in a
  // glow layer and a line layer, and reprojected on every frame of a zoom. A
  // shape that arrives whole and detailed is a shape that drops frames, so the
  // ceiling is set where a zoom still runs smoothly and detail is bought back
  // by narrowing the window instead of coarsening the outline.
  let points = 0
  for (const f of features)
    for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      for (const ring of poly) points += ring.length
  if (points > SCOPE_GEO_MAX_POINTS && lod > 0) return buildScopeGeo(cc, regions, lod - 1, clip)

  const shown = names.slice(0, 3).join(', ')
  const label =
    kind === 'country'
      ? shape.name
      : `${shown}${names.length > 3 ? ` +${names.length - 3} more` : ''}, ${shape.name}`

  // The extent of what was actually served, so the client can frame the map
  // without walking the coordinates itself — and, at a coarse rung, without
  // framing islands this rung dropped. Raw degrees, like everything else here,
  // so a country straddling the antimeridian reports the full -180..180 span
  // rather than the narrow box the eye sees.
  let n = -Infinity
  let s = Infinity
  let e = -Infinity
  let w = Infinity
  for (const f of whole)
    for (const poly of f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
      for (const [x, y] of poly[0]) {
        if (y > n) n = y
        if (y < s) s = y
        if (x > e) e = x
        if (x < w) w = x
      }

  return bytes(200, {
    ok: true,
    kind,
    country: cc,
    lod,
    label,
    names,
    bbox: { n, s, e, w },
    frame: framingBox(whole) || { n, s, e, w },
    // The window this answer covers, so the client knows when panning has
    // taken the map past the edge of what it was given. Absent means whole.
    clip: clip ?? null,
    geojson: { type: 'FeatureCollection', features },
  })
}

// Chile's outline reaches Easter Island, 3,500km out in the Pacific, and
// France's reaches Guyane. Framing the map on the full extent of either puts
// the country the round is actually about in one corner of an ocean. So the
// camera gets a second box: the main mass, grown outwards from the largest
// ring by absorbing whatever lies close to it, which keeps a coastal
// archipelago (all of Patagonia) and drops a mid-ocean territory.
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

/**
 * Pre-grade snapshots for rating overrides, keyed by round id. The card UI
 * pre-selects the inferred FSRS rating; tapping a different button POSTs
 * /rate, which restores this snapshot and re-grades with the explicit rating
 * at the original review time — so overriding (even repeatedly) is
 * indistinguishable from having graded it right the first time.
 * In-memory on purpose: an override only makes sense while the card is on
 * screen, and the map is pruned so a long session can't grow it unbounded.
 */
const rateSnapshots = new Map()
const SNAPSHOT_LIMIT = 50

function rememberSnapshot(id, snap) {
  rateSnapshots.set(id, snap)
  while (rateSnapshots.size > SNAPSHOT_LIMIT) {
    rateSnapshots.delete(rateSnapshots.keys().next().value)
  }
}

async function handleRound(payload) {
  const { location, mapId, roundNumber, score, source } = payload
  const dupKey = payload.token
    ? `t:${payload.token}:r${roundNumber ?? 0}`
    : `p:${location?.panoId ?? `${location?.lat},${location?.lng}`}:r${roundNumber ?? 0}`
  const seen = await loadSeen()
  const prior = seen.get(dupKey)
  if (prior && (payload.token || Date.now() - prior.ts < 30 * 60 * 1000)) {
    console.log(`[coach] duplicate round dropped (already saved as ${prior.id})`)
    return { ok: true, id: prior.id, duplicate: true, card: null }
  }
  // A timed-out round records a (0,0) guess — that is "no guess", not the Atlantic.
  const guess =
    payload.guess && !(Math.abs(payload.guess.lat) < 0.001 && Math.abs(payload.guess.lng) < 0.001)
      ? payload.guess
      : null
  const id = `${Date.now()}_r${roundNumber ?? 0}`
  seen.set(dupKey, { ts: Date.now(), id })
  saveSeen()
  const dir = join(ROUNDS_DIR, id)
  await mkdir(dir, { recursive: true })

  // Tiles are ~128 fetches + a stitch: they run in the background so the
  // response (and the in-game lesson card) is never held up by them.
  const tilesPromise = saveRoundTiles(location.panoId, dir, location)
  const [answer, guessed, lmDirect] = await Promise.all([
    countryOf(location.lat, location.lng),
    guess ? countryOf(guess.lat, guess.lng) : null,
    mapId && source !== 'duel' && location.panoId ? lmMeta(mapId, location.panoId) : null,
  ])
  // Rounds on the trainer map get their meta from our catalogs instead of LM.
  const meta = lmDirect ?? (await metaFromCatalogs(location.panoId))

  const state = await loadState()
  const metaName = metaKeyOf(meta?.country, meta?.metaName ?? meta?.name) ?? null
  // Identical-design metas: Plonkit documents the Czech and Slovak bollards as
  // the same design ("the only other country with the same design is..."), so
  // guessing the twin still means the clue was read correctly. Telling the
  // twins apart is a different skill; don't grade it here.
  const twins = metaName ? LOOKALIKE_METAS[metaName] : null
  // "??" is the geocoder failing, not a country. Comparing two failures marks
  // every round of an outage correct — a silently wrong grade that feeds FSRS
  // and the profile — so an unknown answer grades as no-guess instead.
  const correctCountry =
    guessed && answer.code !== '??' && guessed.code !== '??'
      ? guessed.code === answer.code || !!(twins && twins.has(guessed.code) && twins.has(answer.code))
      : false
  const distanceKm = guess ? haversineKm(location, guess) : null
  // Scope-gated correctness drives the FSRS grade and the card's verdict:
  // the right country outside a region-scoped meta's subdivisions means the
  // country was deduced but the meta wasn't read. Country-level stats and
  // confusions keep using plain correctCountry.
  const correctScope =
    correctCountry && (!metaName || (await inMetaScope(metaName, guessed?.regionNames)))

  const round = {
    id,
    ts: new Date().toISOString(),
    mapId,
    mode: source === 'duel' ? 'duel' : 'trainer',
    roundNumber,
    score: score ?? null,
    panoId: location.panoId ?? null,
    answer: { ...place(answer), lat: location.lat, lng: location.lng },
    guess: guessed ? { ...place(guessed), lat: guess.lat, lng: guess.lng } : null,
    correctCountry,
    correctScope,
    distanceKm,
    metaName,
  }

  // Running stats: what keeps going wrong is the coach's real curriculum.
  const cc = answer.code
  const row = (state.countries[cc] ??= { seen: 0, correctCountry: 0 })
  row.seen += 1
  if (correctCountry) row.correctCountry += 1
  if (guessed && !correctCountry) {
    const pair = `${cc}>${guessed.code}`
    state.confusions[pair] = (state.confusions[pair] ?? 0) + 1
  }
  // Per-meta mastery: consecutive cold hits are what earn a meta its way OFF
  // the personal map. One miss resets the streak.
  // One clock for the grade and for the day it lands in, so a round cannot be
  // written at one instant and counted at another.
  const now = new Date()
  let inferredRating = null
  let firstSight = false
  if (round.metaName) {
    const isPadding = !!state.lastDeck?.padding?.includes(round.metaName)
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
    firstSight =
      !state.deckCards[round.metaName] && correctScope && !isPadding && !!meta && source !== 'duel'
    const credited = correctScope && !firstSight
    inferredRating = ratingNameFor(credited, !state.deckCards[round.metaName])
    // Snapshot the pre-grade state so a rating-button tap can redo this grade.
    rememberSnapshot(id, {
      metaName: round.metaName,
      ts: round.ts,
      padding: isPadding,
      prevCard: state.deckCards[round.metaName] ?? null,
      prevMeta: state.metas[round.metaName] ? { ...state.metas[round.metaName] } : null,
    })

    const m = (state.metas[round.metaName] ??= { seen: 0, correct: 0, streak: 0 })
    m.seen += 1
    if (credited) {
      m.correct += 1
      m.streak += 1
    } else {
      m.streak = 0
    }
    // FSRS grading feeds the deck. One exception, per the scheduler's own
    // simulation: a CORRECT answer on a padding round (near-zero elapsed time)
    // reads to FSRS as a memory that needs propping up and wrecks the card's
    // difficulty — so correct padding rounds are free practice, ungraded.
    // A WRONG padding answer is real forgetting and always counts.
    if (!(isPadding && correctScope)) {
      state.deckCards = gradeRound(
        state.deckCards,
        { metaName: round.metaName, correct: credited },
        now,
      )
    }
  }
  state.rounds.push(round)
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2))

  const history = state.rounds.filter((r) => r.answer.code === cc)
  const dossier = {
    ...round,
    tiles: [],
    lm: meta,
    history: {
      thisCountry: { seen: row.seen, correctCountry: row.correctCountry },
      recentMissesHere: history.filter((r) => !r.correctCountry).slice(-5),
      topConfusions: Object.entries(state.confusions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    },
    plonkit: {
      answer: cluesFor(cc),
      guessed: guessed && !correctCountry ? cluesFor(guessed.code) : [],
    },
  }
  await writeFile(join(dir, 'dossier.json'), JSON.stringify(dossier, null, 2))
  console.log(
    `[coach] round ${id}: ${answer.name}${guessed ? ` (guessed ${guessed.name}${correctScope ? ', correct' : correctCountry ? ', right country wrong region' : ''})` : ''}${round.mode === 'duel' ? ' [duel]' : ''}${meta ? `, meta: ${round.metaName ?? 'yes'}` : ''}`,
  )
  tilesPromise
    .then((tiles) => {
      if (!tiles.length) return
      dossier.tiles = tiles
      console.log(`[coach] round ${id}: ${tiles.length} tiles ready`)
      return writeFile(join(dir, 'dossier.json'), JSON.stringify(dossier, null, 2))
    })
    .catch((err) => console.error(`[coach] tiles failed for ${id}:`, err))
  // Which area the post-round map should highlight. Only the *identity* of the
  // area travels with the card: the boundary itself is a few hundred KB of
  // coastline, which the cloud Worker could not carry at all, so the client
  // takes this and asks /api/scope-geo over the LAN for the shape. Null
  // regions means the meta is countrywide — the same file that decides
  // whether a guess was in scope decides what gets drawn.
  // A scope on the card is a promise the client can draw something, so when
  // the geocoder failed (countryOf answers "??") there is no area to promise
  // and the whole field goes null — better to say nothing than to send the
  // client after a shape that cannot exist.
  const scopedTo = round.metaName ? ((await loadScopeRegions())[round.metaName] ?? null) : null
  const scope = /^[A-Z]{2}$/.test(cc ?? '') ? { country: cc, regions: scopedTo } : null

  // How far this round moved the session along. Outside `card` on purpose: a
  // duel gets no clue card but still clears review, and a readout that left
  // with the card would stall on exactly the rounds that moved it. The
  // catalogs are already in memory by here (metaFromCatalogs loaded them), so
  // this costs one walk of the ladder and no disk at all.
  const day = dayState(
    state.deckCards,
    deckSummary(state.deckCards, toLadder(await loadCatalogs()), now),
    now,
  )

  return {
    ok: true,
    id,
    day,
    // The userscript renders this as the post-round lesson card. Duels never
    // get one: metas are unknowable for arbitrary world locations, and ranked
    // play gets no live assistance — duel dossiers are for after-match review.
    card:
      meta && source !== 'duel'
        ? {
            metaName: round.metaName,
            correct: correctScope,
            scope,
            note: meta.note ?? null,
            images: meta.images ?? [],
            footer: meta.footer ?? null,
            // FSRS rating row: the inferred grade to pre-select, and the round
            // id to override it against. Absent when the round wasn't gradeable.
            roundId: round.metaName ? id : null,
            rating: inferredRating,
            firstSight,
          }
        : null,
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  // The dashboard: the daily surface, built by Vite into dist/.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?'))) {
    try {
      const html = await readFile(join(ROOT, '..', 'dist', 'dashboard', 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(503)
      res.end('dashboard not built — run: npx vite build')
    }
    return
  }
  if (req.method === 'GET' && req.url.startsWith('/assets/')) {
    const name = req.url.split('?')[0].slice(8).replace(/[^\w.-]/g, '')
    const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'application/octet-stream'
    try {
      const buf = await readFile(join(ROOT, '..', 'dist', 'assets', name))
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' })
      res.end(buf)
    } catch {
      res.writeHead(404); res.end()
    }
    return
  }
  if (req.method === 'GET' && req.url.startsWith('/fonts/')) {
    const name = req.url.slice(7).replace(/[^a-z0-9.-]/gi, '')
    const pkg = name.startsWith('fraunces') ? 'fraunces' : 'inter'
    try {
      const buf = await readFile(join(ROOT, '..', 'node_modules', '@fontsource-variable', pkg, 'files', name))
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end()
    }
    return
  }
  // Dossier assets (tiles + json) for the dashboard's round browser.
  {
    const m = req.method === 'GET' && req.url.match(/^\/rounds\/([\w-]+)\/([\w.-]+)$/)
    if (m) {
      try {
        const buf = await readFile(join(ROUNDS_DIR, m[1], m[2]))
        const type = m[2].endsWith('.json') ? 'application/json' : 'image/jpeg'
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' })
        res.end(buf)
      } catch {
        res.writeHead(404)
        res.end()
      }
      return
    }
  }
  // Everything the dashboard renders, in one payload. ?demo=1 swaps in three
  // weeks of synthetic play so the page can be previewed as if well-used.
  if (req.method === 'GET' && req.url.startsWith('/api/dashboard')) {
    const demo = req.url.includes('demo=1')
    const state = demo ? await demoState() : await loadState()
    const catalogs = await loadCatalogs()
    const ladder = toLadder(catalogs)
    const now = new Date()

    const cards = Object.entries(state.deckCards).map(([name, c]) => ({
      name,
      state: c.state,
      due: c.due,
      scheduledDays: c.scheduled_days,
      reps: c.reps,
      lapses: c.lapses,
      retrievability: Math.round(retrievabilityOf(c, now) * 100) / 100,
      mastered: (c.scheduled_days ?? 0) >= MASTERY_DAYS,
    }))

    const tierRows = ladder.map((t) => {
      const learned = t.metas.filter((m) => (state.deckCards[m]?.scheduled_days ?? 0) >= MASTERY_DAYS).length
      const seen = t.metas.filter((m) => state.deckCards[m]).length
      return { name: t.name, tier: t.tier, metas: t.metas.length, seen, learned }
    })

    /* Old captures only have the pano_0_* row; newer ones have the full grid.
       Resolve a tile that is actually on disk so the log never requests a 404,
       and cache it — a round's files never change once it has been captured. */
    const rounds = state.rounds.map((r) => ({

      id: r.id,
      ts: r.ts,
      answer: { code: r.answer.code, name: r.answer.name, region: r.answer.region, lat: r.answer.lat, lng: r.answer.lng },
      guess: r.guess ? { code: r.guess.code, name: r.guess.name, lat: r.guess.lat, lng: r.guess.lng } : null,
      correct: r.correctCountry,
      distanceKm: r.distanceKm,
      metaName: r.metaName,
      score: r.score,
      demo: r.demo ?? false,
      thumb: thumbFor(r.demo ? r.thumb : r.id),
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        now: now.toISOString(),
        trainerMapId: CONFIG.trainerMapId,
        summary: deckSummary(state.deckCards, ladder, now),
        lastDeck: state.lastDeck,
        cards,
        tiers: tierRows,
        rounds,
        confusions: state.confusions,
        countries: state.countries,
        // a taste of the curriculum, for the ribbon
        metaSample: ladder[0] ? ladder[0].metas.slice(0, 36) : [],
      }),
    )
    return
  }
  // Serving the userscript from here lets Tampermonkey install and update it
  // by URL instead of copy-paste. /geocoach.user.js is now a small loader that
  // fetches /geocoach.body.js (the real script) on every page load, so script
  // changes ship by editing the file — no Tampermonkey reinstall. Both are
  // templated to whatever host they were fetched from, so installing from
  // another machine (e.g. the Windows PC hitting this MacBook over the LAN)
  // points them back at the right server.
  const urlPath = req.url.split('?')[0]
  if (req.method === 'GET' && (urlPath === '/geocoach.user.js' || urlPath === '/geocoach.body.js')) {
    const file = urlPath === '/geocoach.user.js' ? 'geocoach.loader.js' : 'geocoach.user.js'
    try {
      let src = (await readFile(join(ROOT, file), 'utf8'))
      const host = req.headers.host // e.g. "ethans-macbook-air-2.local:5177"
      if (host && host !== `127.0.0.1:${PORT}`) {
        const bare = host.replace(/:\d+$/, '')
        src = src
          .replaceAll(`127.0.0.1:${PORT}`, host)
          .replace('// @connect      127.0.0.1', `// @connect      127.0.0.1\n// @connect      ${bare}`)
      }
      // Cloud credentials live only in the gitignored config.json — injected
      // here so the installed script talks to the Worker while the committed
      // source never carries the token.
      if (CONFIG.cloud?.url && CONFIG.cloud?.token) {
        const cloudHost = new URL(CONFIG.cloud.url).host
        src = src
          .replace("'__CLOUD_URL__'", JSON.stringify(CONFIG.cloud.url))
          .replace("'__CLOUD_TOKEN__'", JSON.stringify(CONFIG.cloud.token))
          .replace('// @connect      127.0.0.1', `// @connect      127.0.0.1\n// @connect      ${cloudHost}`)
      }
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(src)
    } catch {
      res.writeHead(404)
      res.end()
    }
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  // The shape behind the card's `scope`. The Worker names the area; the
  // boundary is served from here because a country outline runs to hundreds of
  // kilobytes and this machine is on the same LAN as the browser that draws it.
  //   /api/scope-geo?country=ES[&regions=Cataluña|Aragón][&lod=0]
  // lod picks a rung of the detail ladder (coarse 0 → fine 2, see
  // coach/geo/shape.mjs); absent means 0, the rung a zoomed-out map wants and
  // the cheapest to send.
  if (req.method === 'GET' && urlPath === '/api/scope-geo') {
    const params = new URL(req.url, 'http://localhost').searchParams
    const country = (params.get('country') ?? '').trim()
    const regions = (params.get('regions') ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      // A scope is a handful of subdivisions; anything longer is a malformed
      // query, not a country's worth of real work to do.
      .slice(0, SCOPE_GEO_MAX_REGIONS)

    const fail = (code, error) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error }))
    }
    if (!/^[A-Za-z]{2}$/.test(country)) return fail(400, 'country must be an ISO 3166-1 alpha-2 code')
    // Slices are gitignored and built separately, so a fresh clone legitimately
    // has none. That is a "not yet", not a failure — the overlay just stays off.
    if (!geoReady()) return fail(503, 'boundary slices not built — run: node coach/geo/build.mjs')

    const cc = country.toUpperCase()
    // A rung this build does not have is clamped, not refused: the LOD is a
    // rendering hint and the client still wants its shape drawn.
    const lod = lodFor(params.get('lod') ?? 0).id
    // &box=w,s,e,n asks for only the part of the shape inside that rectangle.
    // The client sends the window it is looking at, grown well past the screen
    // edge, and gets the finest rung for it however large the country is.
    const clip = parseBox(params.get('box'))
    // Cached as finished bytes, not objects: the same meta comes round again
    // within a session, and re-serialising a megabyte of coordinates is the
    // whole cost of this endpoint. A window is part of the identity of the
    // answer, so it is part of the key — rounded, so that a map nudged by a
    // pixel does not miss.
    const boxKey = clip ? `${clip.w},${clip.s},${clip.e},${clip.n}` : ''
    const key = `${cc}|${lod}|${boxKey}|${regions.join('|')}`
    let hit = scopeGeoCache.get(key)
    if (!hit) {
      hit = buildScopeGeo(cc, regions, lod, clip)
      scopeGeoCache.set(key, hit)
      let held = 0
      for (const v of scopeGeoCache.values()) held += v.json.length + v.gzip.length
      while (scopeGeoCache.size > SCOPE_GEO_LIMIT || (held > SCOPE_GEO_CACHE_BYTES && scopeGeoCache.size > 1)) {
        const oldest = scopeGeoCache.keys().next().value
        held -= scopeGeoCache.get(oldest).json.length + scopeGeoCache.get(oldest).gzip.length
        scopeGeoCache.delete(oldest)
      }
    }

    // Coastlines gzip to roughly a third of their size, and the client is a
    // browser, so it always asks — but honour the header rather than assume it.
    const wantsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] ?? '')
    const body = wantsGzip ? hit.gzip : hit.json
    res.writeHead(hit.status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      // Borders do not move and the slices only change on a rebuild, so a
      // shape is good for the day. A miss is not cached in the browser at all:
      // the slices are rebuilt from this repo, and a country that gains a
      // boundary today should draw today.
      'Cache-Control': hit.status === 200 ? 'public, max-age=86400' : 'no-store',
      ...(wantsGzip ? { 'Content-Encoding': 'gzip' } : {}),
    })
    res.end(body)
    return
  }
  // The same scope the card will eventually carry, named a whole guess early.
  // The round's pano id is on screen the moment the round is served, so the
  // userscript asks for this then and has the boundary in its store long before
  // the card needs it — the difference between an outline that appears with the
  // card and one that arrives a second later, moving the camera a second time.
  //   /api/scope-for-pano?pano=<panoId>
  // Read-only and deliberately mute about *why* there is no answer: a pano from
  // a map we never indexed and a country name Natural Earth has no code for are
  // both simply "nothing to warm", and the client treats them identically.
  if (req.method === 'GET' && urlPath === '/api/scope-for-pano') {
    const pano = (new URL(req.url, 'http://localhost').searchParams.get('pano') ?? '').trim()
    const answer = (scope) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(scope ? { ok: true, scope } : { ok: false }))
    }
    if (!pano) return answer(null)
    let loc = null
    for (const c of await loadCatalogs()) {
      const hit = c.locations.find((l) => l.panoId === pano)
      if (hit) {
        loc = hit
        break
      }
    }
    if (!loc) return answer(null)
    // handleRound builds the card's scope from the geocoder's ISO code, and the
    // client keys its store on exactly that. The catalog knows the country only
    // by name, so the code has to be reached the other way round here or the
    // warmed shape would sit under a key the card never asks for.
    const cc = loc.country ? countryCode(loc.country) : null
    if (!cc) return answer(null)
    const regions = (await loadScopeRegions())[metaKeyOf(loc.country, loc.metaName)] ?? null
    return answer({ country: cc.toUpperCase(), regions })
  }
  // The just-in-time deck: what to test right now, as GeoGuessr locations.
  //
  // Same ranking and the same map size as the Worker, out of coach/deck.mjs.
  // When this route had its own older algorithm it published every meta's four
  // locations into one flat map, so losing the cloud for a minute did not mean
  // a slightly staler deck — it meant the scheduler's ordering was discarded
  // entirely and the player went back to 484 locations drawn at random.
  if (req.method === 'GET' && req.url.split('?')[0] === '/deck') {
    const catalogs = await loadCatalogs()
    if (catalogs.length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no catalogs indexed yet — run index-catalog.mjs' }))
      return
    }
    const state = await loadState()
    const now = new Date()
    const size = deckSizeFor(new URL(req.url, 'http://localhost').searchParams.get('n'))
    const { customCoordinates, ranking, stats } = buildRankedDeck(
      state.deckCards,
      catalogs,
      toLadder(catalogs),
      size,
      now,
      { dailyNew: DAILY_NEW },
    )

    // Not-yet-due metas are this deck's padding: getting one right proves
    // nothing FSRS did not already know, and handleRound's grading rule reads
    // this list to leave them ungraded.
    const paddingNames = ranking.filter((r) => r.kind === 'future').map((r) => r.name)
    state.lastDeck = { ts: now.toISOString(), metas: ranking.map((r) => r.name), padding: paddingNames }
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2))

    // Distinct names, not rows: the map floor can publish a second pano
    // of the same meta, and that repeat is not a second introduction.
    const due = new Set(ranking.filter((r) => r.kind === 'due').map((r) => r.name)).size
    const fresh = new Set(ranking.filter((r) => r.kind === 'new').map((r) => r.name)).size
    // The day's state travels with the counts, because a deck full of filler
    // and a deck full of work look identical from the outside: `newAllowance`
    // is what the rolling day still permits and `doneForToday` says nothing
    // here is owed. The description goes onto the published GeoGuessr map, so
    // when the queue is empty it says so rather than reciting two zeroes.
    const stamp = now.toISOString().slice(0, 16)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        trainerMapId: CONFIG.trainerMapId,
        customCoordinates,
        summary: {
          due,
          introduced: fresh,
          unlockedTiers: stats.unlockedTiers,
          newAllowance: stats.newAllowance,
          doneForToday: stats.doneForToday,
        },
        ranking,
        stats,
        description: stats.doneForToday
          ? `Auto-generated spaced-repetition deck — all done for today (${stamp})`
          : `Auto-generated spaced-repetition deck — ${due} due, ${fresh} new (${stamp})`,
      }),
    )
    console.log(
      `[coach] deck: ${ranking.length} metas (${due} due, ${fresh} new, ${paddingNames.length} padding), ` +
        `${customCoordinates.length} locations — ` +
        (stats.doneForToday
          ? 'all done for today'
          : `${stats.newAllowance} of ${DAILY_NEW} new left today`),
    )
    return
  }
  // Widget status line.
  //
  // The allowance is recomputed here rather than read off a deck, because
  // asking /deck for it would write state.lastDeck: a status read would then
  // rewrite what the next round is graded against. Same arithmetic rankDeck
  // does — the day's cap less what the rolling twenty-four hours already spent
  // — and the same reading of "done": nothing owed, and no new meta may be
  // introduced, either because the day is spent or because the ladder has
  // nothing left to show. One `now` for both halves, so the widget can never
  // be handed a due count and an allowance from two different instants.
  if (req.method === 'GET' && req.url === '/status') {
    const state = await loadState()
    const now = new Date()
    const summary = deckSummary(state.deckCards, toLadder(await loadCatalogs()), now)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ...summary,
        ...dayState(state.deckCards, summary, now),
        trainerMapId: CONFIG.trainerMapId,
      }),
    )
    return
  }
  // The prune list: which metas to drop from (and keep on) the LM personal map.
  if (req.method === 'GET' && req.url === '/plan') {
    const state = await loadState()
    const rows = Object.entries(state.metas).map(([name, m]) => ({ name, ...m }))
    const plan = {
      drop: rows.filter((m) => m.streak >= 3).map((m) => `${m.name} (${m.streak} straight)`),
      focus: rows
        .filter((m) => m.seen >= 2 && m.correct / m.seen < 0.5)
        .sort((a, b) => a.correct / a.seen - b.correct / b.seen)
        .map((m) => `${m.name} (${m.correct}/${m.seen})`),
      confusions: Object.entries(state.confusions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pair, n]) => `${pair} x${n}`),
      totals: { rounds: state.rounds.length, metasTracked: rows.length },
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(plan, null, 2))
    return
  }
  // Round-start cache warmer, cloud-parity no-op: local card lookups read
  // bundled files, so there is nothing to warm — acknowledged so a local-only
  // install's fire-and-forget ping doesn't 404 in the log every round.
  if (req.method === 'POST' && req.url === '/prewarm') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    return
  }
  // Rating override from the card's Again/Hard/Good/Easy row. Restores the
  // pre-grade snapshot and re-grades with the explicit rating at the original
  // review time — last tap wins, tapping the same button twice is a no-op.
  if (req.method === 'POST' && req.url === '/rate') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const respond = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      try {
        const { id, rating } = JSON.parse(body)
        if (!['again', 'hard', 'good', 'easy'].includes(rating))
          return respond(400, { ok: false, error: `unknown rating: ${rating}` })
        const snap = rateSnapshots.get(id)
        if (!snap)
          return respond(410, { ok: false, error: 'round no longer overridable (server restarted or too old)' })

        const state = await loadState()
        const success = rating !== 'again'

        // Rewind to before the original grade, then replay with the explicit
        // rating. Country/confusion stats stay untouched — where the pin
        // landed is a fact; the buttons only re-judge meta recall.
        if (snap.prevCard) state.deckCards[snap.metaName] = snap.prevCard
        else delete state.deckCards[snap.metaName]
        const prevMeta = snap.prevMeta ?? { seen: 0, correct: 0, streak: 0 }
        state.metas[snap.metaName] = {
          ...prevMeta,
          seen: prevMeta.seen + 1,
          correct: prevMeta.correct + (success ? 1 : 0),
          streak: success ? prevMeta.streak + 1 : 0,
        }
        // Same padding rule as the original grade: a successful padding round
        // stays ungraded; a failed one is real forgetting and counts.
        if (!(snap.padding && success)) {
          state.deckCards = gradeRound(
            state.deckCards,
            { metaName: snap.metaName, rating, correct: success },
            new Date(snap.ts),
          )
        }
        const roundRow = state.rounds.find((r) => r.id === id)
        if (roundRow) roundRow.rating = rating
        await writeFile(STATE_PATH, JSON.stringify(state, null, 2))
        console.log(`[coach] rating override: ${snap.metaName} → ${rating}`)
        respond(200, { ok: true, metaName: snap.metaName, rating })
      } catch (err) {
        console.error('[coach] rate failed:', err)
        respond(500, { ok: false, error: String(err) })
      }
    })
    return
  }
  // The userscript's debug tail, posted every ~10s. No token: this server is
  // LAN-only and the payload is the client's own console output.
  if (req.method === 'POST' && req.url === '/tlog') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const respond = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      try {
        const { lines } = JSON.parse(body)
        if (!Array.isArray(lines)) return respond(400, { ok: false, error: 'lines must be an array' })
        // An oversized batch is a client bug; drop it rather than write it down.
        if (lines.length > 0 && lines.length <= TLOG_MAX_LINES) await appendTlog(lines)
        respond(200, { ok: true })
      } catch (err) {
        respond(400, { ok: false, error: String(err) })
      }
    })
    return
  }
  if (req.method === 'POST' && req.url === '/round') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const result = await handleRound(JSON.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('[coach] round failed:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

await mkdir(ROUNDS_DIR, { recursive: true })
// 0.0.0.0 so the Windows machine can reach the coach over the LAN
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[coach] bridge listening on http://127.0.0.1:${PORT} (and LAN)`)
})
