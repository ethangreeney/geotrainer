/**
 * GeoCoach bridge — receives each GeoGuessr round from the userscript and
 * builds a coaching dossier on disk for Claude to read.
 *
 * Deliberately makes NO LLM API calls: the coaching intelligence is the
 * Claude Code session watching coach/rounds/. This process only does plumbing:
 *   - reverse-geocodes the answer and the guess (BigDataCloud, free, no key)
 *   - fetches street-view tiles for the round's panorama (public tile CDN, no key)
 *   - asks Learnable Meta for the round's intended meta, when the map has one
 *   - embeds the Plonk It clues for both countries from the app's own data
 *   - keeps running per-country stats and a confusion log in coach/state.json
 *
 * Run:  node coach/server.mjs     (listens on 127.0.0.1:5177)
 */
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveRoundTiles } from './pano.mjs'
import {
  buildDeck,
  deckSummary,
  gradeRound,
  MASTERY_DAYS,
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
const metaKeyOf = (country, name) => (name ? (country ? `${country}: ${name}` : name) : null)

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

const geocodeCache = new Map()
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
async function inMetaScope(metaName, guessRegion) {
  const scopedTo = (await loadScopeRegions())[metaName]
  if (!scopedTo || !guessRegion) return true
  const got = normRegion(guessRegion)
  return scopedTo.some((r) => normRegion(r) === got)
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
  const correctCountry = guessed
    ? guessed.code === answer.code || !!(twins && twins.has(guessed.code) && twins.has(answer.code))
    : false
  const distanceKm = guess ? haversineKm(location, guess) : null
  // Scope-gated correctness drives the FSRS grade and the card's verdict:
  // the right country outside a region-scoped meta's subdivisions means the
  // country was deduced but the meta wasn't read. Country-level stats and
  // confusions keep using plain correctCountry.
  const correctScope =
    correctCountry && (!metaName || (await inMetaScope(metaName, guessed?.region)))

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
  let inferredRating = null
  if (round.metaName) {
    const isPadding = !!state.lastDeck?.padding?.includes(round.metaName)
    inferredRating = ratingNameFor(correctScope, !state.deckCards[round.metaName])
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
    if (correctScope) {
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
        { metaName: round.metaName, correct: correctScope },
        new Date(),
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
  return {
    ok: true,
    id,
    // The userscript renders this as the post-round lesson card. Duels never
    // get one: metas are unknowable for arbitrary world locations, and ranked
    // play gets no live assistance — duel dossiers are for after-match review.
    card:
      meta && source !== 'duel'
        ? {
            metaName: round.metaName,
            correct: correctScope,
            note: meta.note ?? null,
            images: meta.images ?? [],
            footer: meta.footer ?? null,
            // FSRS rating row: the inferred grade to pre-select, and the round
            // id to override it against. Absent when the round wasn't gradeable.
            roundId: round.metaName ? id : null,
            rating: inferredRating,
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
  // The just-in-time deck: what to test right now, as GeoGuessr locations.
  if (req.method === 'GET' && req.url === '/deck') {
    const catalogs = await loadCatalogs()
    if (catalogs.length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no catalogs indexed yet — run index-catalog.mjs' }))
      return
    }
    const state = await loadState()
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

    // Padding metas sit at the tail of deck.metas; remember them so a correct
    // answer there is not FSRS-graded (see the grading rule in handleRound).
    const paddingNames = deck.metas.slice(deck.metas.length - deck.stats.padding).map((m) => m.name)
    state.lastDeck = { ts: now.toISOString(), metas: deck.metas.map((m) => m.name), padding: paddingNames }
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        trainerMapId: CONFIG.trainerMapId,
        customCoordinates,
        summary: { due: deck.stats.due, introduced: deck.stats.introduced, unlockedTiers: deck.stats.unlockedTiers },
        description: `Auto-generated spaced-repetition deck — ${deck.stats.due} due, ${deck.stats.introduced} new (${now.toISOString().slice(0, 16)})`,
      }),
    )
    console.log(
      `[coach] deck: ${deck.metas.length} metas (${deck.stats.due} due, ${deck.stats.introduced} new, ${deck.stats.padding} padding), ${customCoordinates.length} locations`,
    )
    return
  }
  // Widget status line.
  if (req.method === 'GET' && req.url === '/status') {
    const state = await loadState()
    const summary = deckSummary(state.deckCards, toLadder(await loadCatalogs()), new Date())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...summary, trainerMapId: CONFIG.trainerMapId }))
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
