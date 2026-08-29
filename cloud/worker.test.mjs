import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The Worker's routes, actually executed.
 *
 * This file used to open by explaining that they could not be: worker.mjs
 * pulls its geo packs and its userscript source in through wrangler's Text and
 * Data rules, which only exist inside workerd, so importing it under vitest
 * throws on the first `.bin`. That gap was not theoretical — a helper was once
 * deleted with three call sites still live, and every route that touched it
 * 500'd in production while all 266 tests stayed green.
 *
 * Wrangler's rules are twenty lines of Node module hook, though, so the suite
 * now brings its own: a child process with a loader that turns `.bin` into an
 * ArrayBuffer, `.user.js` into a string and `.json` into an object, exactly as
 * wrangler.jsonc says to. The child imports the real Worker, drives it against
 * an in-memory stand-in for D1, and prints what came back; everything below
 * asserts over that.
 *
 * The oxlint resolver pass stays regardless. Executing a route proves the code
 * on the route works; it says nothing about the branches no scenario reaches,
 * and a name that does not exist anywhere is an error rather than a deploy.
 */
const ROOT = new URL('..', import.meta.url).pathname

/** The one account the in-memory D1 knows about; the runner below binds it too. */
const TOKEN = 'test-token-0123456789abcdef'

/**
 * Accounts that differ only in their config row.
 *
 * A token each rather than one token with a config that changes, because the
 * Worker memoises token→user for five minutes per isolate and the whole suite
 * runs in one — a second call on the same token would be answered from the
 * cache with the first call's settings, and the test would pass while
 * measuring nothing.
 */
const TOKENS = {
  three: 'test-token-daily-three-0000',
  done: 'test-token-all-done-000000',
  doneStatus: 'test-token-all-done-status',
  write: 'test-token-config-write-001',
  writeZero: 'test-token-config-write-002',
  writeString: 'test-token-config-write-003',
  writeMax: 'test-token-config-write-004',
  reject: 'test-token-config-reject-01',
  doneDash: 'test-token-all-done-dash-0',
  partDash: 'test-token-part-day-dash-0',
  roundMixed: 'test-token-round-mixed-001',
  roundNew: 'test-token-round-new-00001',
  roundLast: 'test-token-round-last-0001',
  roundDuel: 'test-token-round-duel-0001',
}

describe('worker source', () => {
  it('references no name that does not exist', () => {
    let out = ''
    try {
      out = execFileSync('node_modules/.bin/oxlint', ['--deny', 'no-undef', 'cloud/src/worker.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
    } catch (err) {
      out = (err.stdout || '') + (err.stderr || '')
    }
    const undef = out.split('\n').filter((l) => l.includes('no-undef'))
    expect(undef.join('\n'), 'undefined references in the Worker').toBe('')
  })
})

/* -------------------------------------------------------------------------
 * The harness.
 * ---------------------------------------------------------------------- */

/** wrangler.jsonc's "rules", as a Node module-customisation hook. The three
 * non-JS shapes the Worker imports, each read off disk at import time rather
 * than inlined, so a 2.3MB pack does not become 3MB of generated source. */
const LOADER = `
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const src = (s) => ({ format: 'module', shortCircuit: true, source: s })

function load(url, context, next) {
  if (!url.startsWith('file:')) return next(url, context)
  const path = JSON.stringify(fileURLToPath(url))
  // Data rule: the boundary packs arrive as ArrayBuffers.
  if (url.endsWith('.bin'))
    return src(\`import { readFileSync } from 'node:fs'
const b = readFileSync(\${path})
export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)\`)
  // Text rule: the userscript and its loader arrive as strings.
  if (url.endsWith('.user.js') || url.endsWith('.loader.js'))
    return src(\`import { readFileSync } from 'node:fs'
export default readFileSync(\${path}, 'utf8')\`)
  // Bundlers take a bare JSON import as an object; Node wants an attribute.
  if (url.endsWith('.json'))
    return src(\`import { readFileSync } from 'node:fs'
export default JSON.parse(readFileSync(\${path}, 'utf8'))\`)
  return next(url, context)
}

registerHooks({ load })
`

/**
 * The scenarios, run once in one child process.
 *
 * One child rather than one per case because the packs cost about a second to
 * decode and every case wants them warm — the same reason the Worker memoises
 * them per isolate. Responses come back as plain JSON so the assertions below
 * read like ordinary vitest.
 */
const RUNNER = `
import { readFileSync } from 'node:fs'
import worker from ${JSON.stringify(join(ROOT, 'cloud/src/worker.mjs'))}

const ROOT = ${JSON.stringify(ROOT)}

// The Worker no longer bundles the boundary packs (they outgrew the free
// plan's script cap and moved to the assets store); outside workerd there is
// no assets store, so the runner hands the bins over directly.
const abin = (name) => {
  const b = readFileSync(ROOT + 'coach/geo/pack/' + name + '.bin')
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
globalThis.GEO_BINS = { admin0: abin('admin0'), admin1: abin('admin1'), merged: abin('merged') }

const TOKEN = ${JSON.stringify(TOKEN)}
const TOKENS = ${JSON.stringify(TOKENS)}

// Nothing in this suite is allowed to touch the network. The only route that
// would is the deck's Learnable Meta pre-warm, which is fire-and-forget and
// swallows its own failures.
globalThis.fetch = async () => {
  throw new Error('no network in tests')
}

/** Enough of D1 for the routes under test: one user, one state row, and a
 * clue cache that is always empty. Queries are matched on a distinctive
 * fragment of their SQL, which is fragile in exactly the way that is useful —
 * a rewritten query shows up here rather than silently returning nothing. */
function makeDB(state, rounds = [], account = { token: TOKEN, config: DEFAULT_CONFIG }) {
  const rows = { state: JSON.stringify(state), config: account.config }
  const run = (sql, args) => {
    // Four queries say FROM rounds and they want four different shapes, so
    // each is matched on the projection rather than the table. The region
    // aggregate is computed for real, because the dashboard's minimum-sample
    // gate is the thing its tests exist to check.
    if (sql.includes("'$.answer.region'")) {
      const agg = new Map()
      for (const r of rounds) {
        if (r.mode !== 'duel' || !Number.isFinite(r.score) || !r.answer?.region) continue
        const key = r.answer.code + '\u0000' + r.answer.region
        const row = agg.get(key) ?? { cc: r.answer.code, region: r.answer.region, plays: 0, lost: 0 }
        row.plays += 1
        row.lost += 5000 - r.score
        agg.set(key, row)
      }
      return [...agg.values()]
    }
    if (sql.includes('COUNT(*) AS n')) return { n: rounds.length }
    if (sql.includes("json_extract(json, '$.metaName')"))
      return rounds.map((r) => ({
        ts: r.ts,
        metaName: r.metaName ?? null,
        rating: r.rating ?? null,
        correct: r.correct ? 1 : 0,
      }))
    if (sql.includes('SELECT json FROM rounds')) return rounds.map((r) => ({ json: JSON.stringify(r) }))
    // The round pipeline's own two: the dup probe reads a different projection
    // again, and the insert is only ever asserted on through what it returns.
    if (sql.includes('SELECT id, ts FROM rounds')) return null
    if (sql.includes('INSERT INTO rounds')) return null
    if (sql.includes('FROM users WHERE token'))
      return args[0] === account.token
        ? { id: 1, name: 'Test', config: rows.config, created_at: '2026-01-01T00:00:00.000Z' }
        : null
    // The config write, so a settings route can be asserted on what it stored
    // rather than only on what it echoed.
    if (sql.includes('UPDATE users SET config')) {
      rows.config = args[0]
      return null
    }
    if (sql.includes('FROM states WHERE user_id')) return { json: rows.state }
    if (sql.includes('INTO states')) {
      rows.state = args[1]
      return null
    }
    if (sql.includes('FROM cards')) return null
    if (sql.includes('INTO cards')) return null
    throw new Error('unstubbed query: ' + sql)
  }
  return {
    saved: () => JSON.parse(rows.state),
    savedConfig: () => JSON.parse(rows.config),
    // D1's batch is a transaction; here it is only ever two statements that
    // must both land, so running them is faithful enough for the round path.
    batch: (stmts) => Promise.all(stmts.map((stmt) => stmt.run())),
    prepare(sql) {
      const answer = (args) => ({
        async first() {
          return run(sql, args)
        },
        async all() {
          const r = run(sql, args)
          return { results: Array.isArray(r) ? r : r ? [r] : [] }
        },
        async run() {
          return run(sql, args)
        },
      })
      return { bind: (...args) => answer(args), ...answer([]) }
    },
  }
}

const ctx = { waitUntil: () => {} }

/** The config row every account starts on unless a scenario says otherwise. */
const DEFAULT_CONFIG = '{"trainerMapId":"aaaaaaaaaaaaaaaaaaaaaaaa"}'

/** The static-asset binding, as the Worker uses it: anything not in the map is
 * a 404, which is what makes the SPA fallback run. */
function makeAssets(files = { '/': '<!doctype html><title>GeoCoach</title>' }) {
  return {
    async fetch(request) {
      const body = files[new URL(request.url).pathname]
      return body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    },
  }
}

async function call(
  path,
  {
    headers = {},
    state = null,
    rounds = [],
    assets = null,
    keepText = false,
    method = 'GET',
    payload = null,
    token = TOKEN,
    config = DEFAULT_CONFIG,
  } = {},
) {
  const db = makeDB(
    state ?? { countries: {}, confusions: {}, metas: {}, deckCards: {}, lastDeck: null },
    rounds,
    { token, config },
  )
  const res = await worker.fetch(
    new Request('https://geocoach.example' + path, {
      method,
      headers: payload === null ? headers : { 'Content-Type': 'application/json', ...headers },
      body: payload === null ? undefined : JSON.stringify(payload),
    }),
    assets ? { DB: db, ASSETS: assets } : { DB: db },
    ctx,
  )
  const buf = new Uint8Array(await res.arrayBuffer())
  const encoding = res.headers.get('Content-Encoding')
  // Decoded only if the Worker says it encoded, which it no longer does for
  // anything. Reading the first byte rather than trusting the header is the
  // point: a body that starts 0x1f 0x8b is gzip whatever the header claims,
  // and a mismatch between the two is the exact fault this file now guards.
  const text =
    encoding === 'gzip'
      ? await new Response(new Response(buf).body.pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf)
  const gzipMagic = buf[0] === 0x1f && buf[1] === 0x8b
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return {
    status: res.status,
    encoding,
    gzipMagic,
    bytes: buf.length,
    contentType: res.headers.get('Content-Type'),
    // Opt-in: most of these responses are geometry, and shipping megabytes of
    // coordinates back through stdout to assert on three of them would not be
    // a trade worth making.
    text: keepText ? text : null,
    cacheControl: res.headers.get('Cache-Control'),
    vary: res.headers.get('Vary'),
    cors: {
      origin: res.headers.get('Access-Control-Allow-Origin'),
      methods: res.headers.get('Access-Control-Allow-Methods'),
      headers: res.headers.get('Access-Control-Allow-Headers'),
    },
    body,
    saved: db.saved(),
    savedConfig: db.savedConfig(),
  }
}

const gz = { 'Accept-Encoding': 'gzip, deflate, br' }
const authFor = (token) => ({ Authorization: 'Bearer ' + token })
const auth = authFor(TOKEN)

/** Every ring of a FeatureCollection, so closure and vertex counts can be
 * checked without re-implementing the geometry walk in the parent. */
function ringStats(geojson) {
  let rings = 0
  let open = 0
  let points = 0
  let widest = 0
  for (const f of geojson.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const poly of polys)
      for (const ring of poly) {
        rings += 1
        points += ring.length
        const a = ring[0]
        const b = ring[ring.length - 1]
        if (a[0] !== b[0] || a[1] !== b[1]) open += 1
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
        for (const [x, y] of ring) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
        const ext = Math.hypot(x1 - x0, y1 - y0)
        if (ext > widest) widest = ext
      }
  }
  return { rings, open, points, widest }
}

const catalog = JSON.parse(readFileSync(ROOT + 'coach/catalog/66fda352ee1c8ee4735e1aa8.json', 'utf8'))
const sample = catalog.locations.find((l) => l.panoId && l.country && l.metaName)

/** metaKeyOf, spelled out rather than imported: the Worker's own convention is
 * what is under test, so the expectations have to be built from the catalog
 * files by hand or they only prove the code agrees with itself. */
const metaKey = (l) => (l.metaName ? (l.country ? l.country + ': ' + l.metaName : l.metaName) : null)

/** Every catalog the Worker bundles, in the import order that is tier order —
 * so "the first location that teaches this meta" means the same thing here as
 * it does in the Worker. */
const CATALOG_FILES = [
  '66fda352ee1c8ee4735e1aa8.json',
  '66c0d3feff4dbe492e06174e.json',
  '67695a0a9c0874b92709eedb.json',
  '66fda2e27e08dc03b5bb3d6e.json',
]

/** The first location of every meta across the whole ladder, and how many
 * distinct metas that ladder holds. The preview's pictures and the dashboard's
 * denominator are both checked against these. */
const firstLocation = {}
for (const file of CATALOG_FILES)
  for (const l of JSON.parse(readFileSync(ROOT + 'coach/catalog/' + file, 'utf8')).locations) {
    const key = metaKey(l)
    if (key && !(key in firstLocation))
      firstLocation[key] = { panoId: l.panoId, heading: l.heading, pitch: l.pitch, lat: l.lat, lng: l.lng }
  }
const ladderMetaTotal = Object.keys(firstLocation).length

/** A state in which a handful of metas are genuinely due, with memories weak
 * enough to separate them, so the ranking has something to order. Every other
 * meta is left unseen. */
function dueState(names) {
  const deckCards = {}
  names.forEach((name, i) => {
    deckCards[name] = {
      due: new Date(Date.now() - (i + 1) * 86400000 * (i + 1)).toISOString(),
      stability: 1 + i * 4,
      difficulty: 5,
      elapsed_days: 1,
      scheduled_days: 1,
      learning_steps: 0,
      reps: 2,
      lapses: 0,
      state: 2,
      last_review: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
      seen: 2,
      correct: 1,
      streak: 0,
    }
  })
  return { countries: {}, confusions: {}, metas: {}, deckCards, lastDeck: null }
}

const dueNames = [...new Set(catalog.locations.map((l) => l.country + ': ' + l.metaName))].slice(0, 12)

/** The first rung in catalog order, deduped, which is the order the ladder
 * introduces from. Built here off the catalog JSON rather than out of the
 * scheduler, so the dashboard's preview is checked against the source of the
 * ordering and not against the code that reads it. */
const ladderHead = [
  ...new Set(
    catalog.locations.map((l) => (l.metaName ? (l.country ? l.country + ': ' + l.metaName : l.metaName) : null)).filter(Boolean),
  ),
].slice(0, 24)

/** Ten weeks of play over a handful of metas: every one missed on first sight,
 * then hit from the second exposure on. That shape is the whole point — a
 * progress line replayed honestly has to start at zero, because on day one the
 * player held nothing. */
const WEEK_MS = 7 * 86400000
function history(names) {
  const start = Date.now() - 10 * WEEK_MS
  const out = []
  for (let week = 0; week < 10; week += 1)
    names.forEach((metaName, i) => {
      out.push({
        id: 'r' + week + '_' + i,
        ts: new Date(start + week * WEEK_MS + i * 3600000).toISOString(),
        metaName,
        correct: week > 0,
        correctScope: week > 0,
        answer: { lat: 0, lng: 0, code: 'BR', name: 'Brazil' },
        guess: { lat: 0, lng: 1, name: 'Brazil' },
        score: week > 0 ? 4800 : 900,
        distanceKm: week > 0 ? 12 : 3000,
      })
    })
  return out
}

/** The live card table those rounds would have left behind: well-learned, so
 * the hero count is above zero and the end of the line has somewhere to land. */
/** A duelling record: Brazil bleeding in one region often enough to name it,
 * Colombia's two rounds there staying an anecdote. */
function duelHistory() {
  const duel = (i, code, name, region, score) => ({
    id: 'duel' + i,
    ts: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
    mode: 'duel',
    score,
    answer: { lat: 0, lng: 0, code, name, region },
    guess: { lat: 1, lng: 1, name: 'Elsewhere' },
    correct: false,
    correctScope: false,
    metaName: null,
    distanceKm: 900,
  })
  const out = []
  for (let i = 0; i < 5; i += 1) out.push(duel(i, 'BR', 'Brazil', 'Minas Gerais', 3200))
  out.push(duel(5, 'CO', 'Colombia', 'Antioquia', 4600))
  out.push(duel(6, 'CO', 'Colombia', 'Antioquia', 4600))
  return out
}

function playedState(names) {
  const deckCards = {}
  const metas = {}
  names.forEach((name) => {
    deckCards[name] = {
      due: new Date(Date.now() + 30 * 86400000).toISOString(),
      stability: 90,
      difficulty: 5,
      elapsed_days: 7,
      scheduled_days: 30,
      learning_steps: 0,
      reps: 10,
      lapses: 1,
      state: 2,
      last_review: new Date(Date.now() - 86400000).toISOString(),
      seen: 10,
      correct: 9,
      streak: 9,
      source: 'round',
    }
    metas[name] = { seen: 10, correct: 9 }
  })
  return { countries: { BR: { seen: 40, correctCountry: 36 } }, confusions: {}, metas, deckCards, lastDeck: null }
}

/**
 * The end of a day's work: every card answered a moment ago, none of them due
 * again for a month, and each stamped firstSeen inside the rolling window so
 * the day's new-meta allowance counts as spent. Nothing is owed and nothing
 * more may be introduced, which is the state doneForToday exists to name.
 */
function spentState(names) {
  const deckCards = {}
  names.forEach((name) => {
    deckCards[name] = {
      due: new Date(Date.now() + 30 * 86400000).toISOString(),
      stability: 60,
      difficulty: 5,
      elapsed_days: 0,
      scheduled_days: 30,
      learning_steps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      last_review: new Date(Date.now() - 3600000).toISOString(),
      firstSeen: new Date(Date.now() - 3600000).toISOString(),
      seen: 1,
      correct: 1,
      streak: 1,
    }
  })
  return { countries: {}, confusions: {}, metas: {}, deckCards, lastDeck: null }
}

/** All three states at once: six clues genuinely owed, four met and holding,
 * and the whole rest of the ladder never seen. The dashboard's totals only
 * mean anything against a table that has more than one kind of card in it. */
function mixedState(dueOnes, heldOnes) {
  const due = dueState(dueOnes)
  const held = playedState(heldOnes)
  return { ...held, deckCards: { ...due.deckCards, ...held.deckCards } }
}


/* ---------------------------------------------------------------------------
 * A day with a round played into it.
 *
 * The card at the end of a round now carries how far through the session it
 * left the player, and the only way that number is worth anything is if it is
 * read off the state the round just wrote. So these states are built with all
 * three kinds of card in them — cleared this morning, still owed, met an hour
 * ago — and the assertions are about what one more round does to them.
 * ------------------------------------------------------------------------ */
const HOUR = 3600000
const DAY = 86400000
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const ahead = (ms) => new Date(Date.now() + ms).toISOString()

/** The meta the sample location teaches: what a posted round grades. */
const sampleName = metaKey(sample)
/** Ladder metas other than that one, to stack a day up around it. */
const otherNames = dueNames.filter((n) => n !== sampleName)

/** A review card placed by hand on the three dates that decide which half of
 * the day it counts in: when it was met, when it was last answered, when it
 * comes back. */
const dayCard = (firstSeen, lastReview, due) => ({
  due,
  stability: 12,
  difficulty: 5,
  elapsed_days: 3,
  scheduled_days: 6,
  learning_steps: 0,
  reps: 4,
  lapses: 0,
  state: 2,
  last_review: lastReview,
  firstSeen,
  seen: 4,
  correct: 3,
  streak: 1,
})

/**
 * Mid-session: two reviews cleared two hours ago, four still owed (the sample
 * among them), and two new metas met an hour ago out of an allowance of ten.
 */
function dayInProgress() {
  const deckCards = {}
  deckCards[sampleName] = dayCard(ago(30 * DAY), ago(3 * DAY), ago(HOUR))
  for (const n of otherNames.slice(0, 2)) deckCards[n] = dayCard(ago(20 * DAY), ago(2 * HOUR), ahead(30 * DAY))
  for (const n of otherNames.slice(2, 5)) deckCards[n] = dayCard(ago(40 * DAY), ago(5 * DAY), ago(2 * DAY))
  for (const n of otherNames.slice(5, 7)) deckCards[n] = dayCard(ago(HOUR), ago(HOUR), ahead(30 * DAY))
  return { countries: {}, confusions: {}, metas: {}, deckCards, lastDeck: null }
}

/**
 * One review short of the finish line: the sample is the last thing owed, and
 * an allowance of two was spent an hour ago. Answering it ends the day.
 */
function lastOwedOfTheDay() {
  const deckCards = {}
  deckCards[sampleName] = dayCard(ago(30 * DAY), ago(3 * DAY), ago(HOUR))
  for (const n of otherNames.slice(0, 2)) deckCards[n] = dayCard(ago(HOUR), ago(HOUR), ahead(30 * DAY))
  return { countries: {}, confusions: {}, metas: {}, deckCards, lastDeck: null }
}

/** A played round, pinned on the sample location and guessed exactly right, so
 * the grade is never what a case is really about. */
const roundPayload = (over) => ({
  location: { lat: sample.lat, lng: sample.lng, panoId: sample.panoId },
  guess: { lat: sample.lat, lng: sample.lng },
  mapId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  score: 5000,
  ...over,
})

/** Everything a settings write must refuse: none of these is a count of metas.
 * undefined is the field left off the payload entirely. */
const BAD_DAILY_NEW = [undefined, null, '', 'twenty', -1, 101, 1e9, true, {}, [1]]

const out = {
  optionsPreflight: await call('/api/scope-geo?country=BR', { headers: { ...gz } }).then(() => null),
  country: await call('/api/scope-geo?country=BR', { headers: gz }),
  countryPlain: await call('/api/scope-geo?country=BR'),
  region: await call('/api/scope-geo?country=BR&regions=' + encodeURIComponent('Paraná|Santa Catarina|Rio Grande do Sul'), { headers: gz }),
  unmatchedRegion: await call('/api/scope-geo?country=ES&regions=Nowhereland', { headers: gz }),
  unknownCountry: await call('/api/scope-geo?country=ZZ', { headers: gz }),
  malformed: await call('/api/scope-geo?country=BRAZIL', { headers: gz }),
  missingCountry: await call('/api/scope-geo', { headers: gz }),
  canada: await call('/api/scope-geo?country=CA', { headers: gz }),
  windowed: await call('/api/scope-geo?country=BR&box=-48,-24,-46,-22', { headers: gz }),
  windowElsewhere: await call('/api/scope-geo?country=BR&box=10,50,12,52', { headers: gz }),
  panoHit: await call('/api/scope-for-pano?pano=' + encodeURIComponent(sample.panoId), { headers: gz }),
  panoMiss: await call('/api/scope-for-pano?pano=not-a-real-pano', { headers: gz }),
  deckDefault: await call('/deck', { headers: auth, state: dueState(dueNames) }),
  deckSmall: await call('/deck?n=3', { headers: auth, state: dueState(dueNames) }),
  deckEight: await call('/deck?n=8', { headers: auth, state: dueState(dueNames) }),
  deckHuge: await call('/deck?n=9999', { headers: auth, state: dueState(dueNames) }),
  deckFresh: await call('/deck', { headers: auth }),
  deckNoToken: await call('/deck'),
  // A player who asked for three new metas a day, on an account with nothing
  // due: the deck may introduce three and no more.
  deckThreeNew: await call('/deck', {
    headers: authFor(TOKENS.three),
    token: TOKENS.three,
    config: '{"dailyNew":3}',
  }),
  // Two metas met an hour ago against an allowance of two, neither due again:
  // the day is over.
  deckAllDone: await call('/deck', {
    headers: authFor(TOKENS.done),
    token: TOKENS.done,
    config: '{"dailyNew":2}',
    state: spentState(dueNames.slice(0, 2)),
  }),
  status: await call('/status', { headers: auth, state: dueState(dueNames) }),
  // The same mid-session day the duel round is asked about, put to /status:
  // the two readouts sit on screen together and must agree.
  statusMidDay: await call('/status', { headers: auth, state: dayInProgress() }),
  statusAllDone: await call('/status', {
    headers: authFor(TOKENS.doneStatus),
    token: TOKENS.doneStatus,
    config: '{"dailyNew":2}',
    state: spentState(dueNames.slice(0, 2)),
  }),
  configSet: await call('/config', {
    method: 'POST',
    payload: { dailyNew: 3 },
    headers: authFor(TOKENS.write),
    token: TOKENS.write,
  }),
  // Zero is a setting, not an absence: review only, introduce nothing.
  configZero: await call('/config', {
    method: 'POST',
    payload: { dailyNew: 0 },
    headers: authFor(TOKENS.writeZero),
    token: TOKENS.writeZero,
  }),
  configString: await call('/config', {
    method: 'POST',
    payload: { dailyNew: '7' },
    headers: authFor(TOKENS.writeString),
    token: TOKENS.writeString,
  }),
  configMax: await call('/config', {
    method: 'POST',
    payload: { dailyNew: 100 },
    headers: authFor(TOKENS.writeMax),
    token: TOKENS.writeMax,
  }),
  configNoBody: await call('/config', { method: 'POST', headers: authFor(TOKENS.reject), token: TOKENS.reject }),
  configNoToken: await call('/config', { method: 'POST', payload: { dailyNew: 3 } }),
  configRejected: await Promise.all(
    BAD_DAILY_NEW.map((dailyNew) =>
      call('/config', {
        method: 'POST',
        payload: { dailyNew },
        headers: authFor(TOKENS.reject),
        token: TOKENS.reject,
      }),
    ),
  ),
  dashFresh: await call('/api/dashboard', { headers: auth }),
  dashHistory: await call('/api/dashboard', { headers: auth, state: playedState(dueNames.slice(0, 4)), rounds: history(dueNames.slice(0, 4)) }),
  // Duels have cost this account most in Russia, then Brazil, then Colombia —
  // the dashboard must say so and the day's new clues must follow the money.
  dashDuels: await call('/api/dashboard', {
    headers: auth,
    state: {
      deckCards: {},
      metas: {},
      confusions: {},
      lastDeck: null,
      countries: {
        RU: { seen: 8, correctCountry: 3, duelSeen: 6, duelLost: 21000 },
        BR: { seen: 7, correctCountry: 4, duelSeen: 5, duelLost: 9000 },
        CO: { seen: 2, correctCountry: 1, duelSeen: 2, duelLost: 800 },
      },
    },
    rounds: duelHistory(),
  }),
  dashNoToken: await call('/api/dashboard'),
  // The same finished day /status is asked about above, asked of the console
  // instead: nothing owed, the allowance of two already spent an hour ago.
  dashAllDone: await call('/api/dashboard', {
    headers: authFor(TOKENS.doneDash),
    token: TOKENS.doneDash,
    config: '{"dailyNew":2}',
    state: spentState(dueNames.slice(0, 2)),
  }),
  // A day half spent: an allowance of five with two clues met an hour ago, so
  // three remain and the console may name exactly those three.
  // Some met, some due, the rest unseen — the shape the dashboard's three
  // totals have to be read off.
  dashMixed: await call('/api/dashboard', {
    headers: auth,
    state: mixedState(dueNames.slice(0, 6), dueNames.slice(6, 10)),
  }),
  dashPartDay: await call('/api/dashboard', {
    headers: authFor(TOKENS.partDash),
    token: TOKENS.partDash,
    config: '{"dailyNew":5}',
    state: spentState(dueNames.slice(0, 2)),
  }),
  // One review answered mid-session: the day should show one more cleared and
  // one fewer owed, with the new-meta half untouched.
  roundReview: await call('/round', {
    method: 'POST',
    headers: authFor(TOKENS.roundMixed),
    token: TOKENS.roundMixed,
    state: dayInProgress(),
    payload: roundPayload({ token: 'game-mixed', roundNumber: 1 }),
  }),
  // The same location on an empty account: a first sighting, which spends
  // allowance rather than clearing review.
  roundFirstSight: await call('/round', {
    method: 'POST',
    headers: authFor(TOKENS.roundNew),
    token: TOKENS.roundNew,
    payload: roundPayload({ token: 'game-new', roundNumber: 2 }),
  }),
  // The round that ends the day.
  roundFinishes: await call('/round', {
    method: 'POST',
    headers: authFor(TOKENS.roundLast),
    token: TOKENS.roundLast,
    config: '{"dailyNew":2}',
    state: lastOwedOfTheDay(),
    payload: roundPayload({ token: 'game-last', roundNumber: 3 }),
  }),
  // A duel: no clue card at all, and the day must still come back.
  roundDuel: await call('/round', {
    method: 'POST',
    headers: authFor(TOKENS.roundDuel),
    token: TOKENS.roundDuel,
    state: dayInProgress(),
    payload: roundPayload({ token: 'game-duel', roundNumber: 4, source: 'duel' }),
  }),
  loader: await call('/geocoach.user.js', { headers: auth, keepText: true }),
  loaderByQuery: await call('/geocoach.user.js?token=' + TOKEN, { keepText: true }),
  body: await call('/geocoach.body.js', { headers: auth, keepText: true }),
  loaderStaleToken: await call('/geocoach.user.js?token=deadbeef', { keepText: true }),
  page: await call('/start', { headers: { Accept: 'text/html' }, assets: makeAssets(), keepText: true }),
  pageSlash: await call('/start/', { headers: { Accept: 'text/html' }, assets: makeAssets(), keepText: true }),
  pageRoot: await call('/', { headers: { Accept: 'text/html' }, assets: makeAssets(), keepText: true }),
  pageUnknown: await call('/no-such-page', { headers: { Accept: 'text/html' }, assets: makeAssets(), keepText: true }),
  asset: await call('/robots.txt', {
    headers: { Accept: 'text/html' },
    assets: makeAssets({ '/': '<!doctype html>', '/robots.txt': 'User-agent: *' }),
    keepText: true,
  }),
}

// The preflight goes through the Worker's OPTIONS short-circuit, which never
// reaches a handler, so it is fetched directly rather than through call().
{
  const res = await worker.fetch(
    new Request('https://geocoach.example/api/scope-geo?country=BR', { method: 'OPTIONS' }),
    { DB: makeDB({}) },
    ctx,
  )
  out.optionsPreflight = {
    status: res.status,
    cors: {
      origin: res.headers.get('Access-Control-Allow-Origin'),
      methods: res.headers.get('Access-Control-Allow-Methods'),
      headers: res.headers.get('Access-Control-Allow-Headers'),
    },
  }
}

// Geometry is far too big to ship back through stdout, so it is measured in
// the child and only the measurements travel.
for (const key of ['country', 'countryPlain', 'region', 'unmatchedRegion', 'canada', 'windowed', 'windowElsewhere'])
  if (out[key].body && out[key].body.geojson) {
    out[key].geometry = ringStats(out[key].body.geojson)
    out[key].featureCount = out[key].body.geojson.features.length
    delete out[key].body.geojson
  }

out.sample = { panoId: sample.panoId, country: sample.country, metaName: sample.metaName }
out.sampleName = sampleName
out.ladderHead = ladderHead
out.playedNames = dueNames.slice(0, 4)
out.spentNames = dueNames.slice(0, 2)
out.mixedDueNames = dueNames.slice(0, 6)
out.mixedHeldNames = dueNames.slice(6, 10)
out.ladderMetaTotal = ladderMetaTotal
// Only the previewed metas' locations travel — the whole map is a few hundred
// entries of coordinates nothing asserts on.
out.firstLocation = Object.fromEntries(ladderHead.map((n) => [n, firstLocation[n]]))
process.stdout.write(JSON.stringify(out))
`

let R = null
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'geocoach-worker-'))
  writeFileSync(join(dir, 'loader.mjs'), LOADER)
  writeFileSync(join(dir, 'run.mjs'), RUNNER)
  const out = execFileSync(process.execPath, ['--import', join(dir, 'loader.mjs'), join(dir, 'run.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  R = JSON.parse(out)
}, 120_000)

/* -------------------------------------------------------------------------
 * The overlay routes.
 * ---------------------------------------------------------------------- */

describe('GET /api/scope-geo', () => {
  it('answers a country-only query with that country outline', () => {
    expect(R.country.status).toBe(200)
    expect(R.country.body.ok).toBe(true)
    expect(R.country.body.kind).toBe('country')
    expect(R.country.body.country).toBe('BR')
    expect(R.country.body.label).toBe('Brazil')
    expect(R.country.featureCount).toBe(1)
    expect(R.country.geometry.points).toBeGreaterThan(100)
  })

  it('carries the framing fields the client steers the camera with', () => {
    const { bbox, frame } = R.country.body
    for (const box of [bbox, frame]) {
      expect(box.n).toBeGreaterThan(box.s)
      expect(box.e).toBeGreaterThan(box.w)
    }
    // Brazil, give or take a degree of coastline.
    expect(bbox.n).toBeGreaterThan(4)
    expect(bbox.s).toBeLessThan(-32)
  })

  it('dissolves a multi-region scope into one outline', () => {
    expect(R.region.status).toBe(200)
    expect(R.region.body.kind).toBe('region')
    // One feature, not three: the whole point of the merged pack is that the
    // borders between Paraná, Santa Catarina and Rio Grande do Sul are not
    // drawn down the middle of the highlight.
    expect(R.region.featureCount).toBe(1)
    expect(R.region.body.label).toContain('Brazil')
    expect(R.region.body.names.length).toBe(1)
    // And it is a genuinely smaller shape than the country it sits in.
    expect(R.region.geometry.points).toBeLessThan(R.country.geometry.points)
  })

  it('falls back to the country outline when no region matches', () => {
    // A partial or empty region match draws a border the meta does not have,
    // which teaches the wrong thing. Vague beats wrong.
    expect(R.unmatchedRegion.status).toBe(200)
    expect(R.unmatchedRegion.body.kind).toBe('country')
    expect(R.unmatchedRegion.body.label).toBe('Spain')
  })

  it('reports an unknown country as a 404 with no geometry', () => {
    expect(R.unknownCountry.status).toBe(404)
    expect(R.unknownCountry.body.ok).toBe(false)
    expect(R.unknownCountry.body.kind).toBe('none')
    expect(R.unknownCountry.body.geojson).toBeUndefined()
    expect(R.unknownCountry.body.error).toContain('ZZ')
    // A miss must not be cached: a country that gains a boundary in the next
    // pack build should draw the moment that build ships.
    expect(R.unknownCountry.cacheControl).toBe('no-store')
  })

  it('rejects a malformed country outright', () => {
    for (const r of [R.malformed, R.missingCountry]) {
      expect(r.status).toBe(400)
      expect(r.body.ok).toBe(false)
      expect(r.body.error).toContain('alpha-2')
    }
  })

  it('allows the GeoGuessr origin, since the userscript calls it cross-origin', () => {
    expect(R.country.cors.origin).toBe('*')
    expect(R.optionsPreflight.status).toBe(204)
    expect(R.optionsPreflight.cors.origin).toBe('*')
    expect(R.optionsPreflight.cors.methods).toContain('GET')
    expect(R.optionsPreflight.cors.headers).toContain('Authorization')
  })

  it('never compresses the body itself, however the client asks', () => {
    // The Worker used to gzip these and set Content-Encoding, and Cloudflare
    // then gzipped the result again under that one header. The browser decoded
    // once, got gzip bytes labelled JSON, and every region overlay silently
    // stopped drawing unless the LAN server was awake to answer instead.
    // Compression belongs to the edge; this asserts the Worker has stopped
    // competing with it, by the header and by the bytes.
    for (const r of [R.country, R.countryPlain]) {
      expect(r.encoding).toBe(null)
      expect(r.gzipMagic).toBe(false)
    }
    // Asking for gzip must not change the answer, only how the edge ships it.
    expect(R.country.geometry).toEqual(R.countryPlain.geometry)
    expect(R.country.bytes).toBe(R.countryPlain.bytes)
    // Still varies by it, because the edge's own encoding does.
    expect(R.country.vary).toBe('Accept-Encoding')
  })

  it('caches a hit at the edge for a day', () => {
    expect(R.country.cacheControl).toContain('public')
    expect(R.country.cacheControl).toContain('max-age=86400')
    expect(R.country.cacheControl).toContain('s-maxage=86400')
  })

  it('keeps the worst case under the point budget with every ring closed', () => {
    // Canada is the shape that forced the budget: 258,842 points and 4.6MB
    // straight off the pack, which is not a bandwidth problem so much as a
    // frame-rate one.
    expect(R.canada.status).toBe(200)
    expect(R.canada.body.sourcePoints).toBeGreaterThan(200_000)
    expect(R.canada.body.points).toBeLessThanOrEqual(R.canada.body.budget)
    expect(R.canada.geometry.points).toBe(R.canada.body.points)
    // A torn or unclosed outline is a bug this repo has hit before; thinning
    // must never be the thing that reopens a ring.
    expect(R.canada.geometry.open).toBe(0)
    // Decimation drops the smallest rings first, so what must survive is the
    // mainland — dropping it in favour of Arctic islands would be worse than
    // sending nothing.
    expect(R.canada.geometry.widest).toBeGreaterThan(50)
    expect(R.canada.body.tol).toBeGreaterThan(0)
  })

  it('leaves a small shape at full detail', () => {
    // Brazil fits the budget whole, so nothing above LOD 0 should have run and
    // the ladder should report the rung it was asked for.
    expect(R.country.body.points).toBeLessThanOrEqual(R.country.body.budget)
    expect(R.country.body.lod).toBe(0)
    expect(R.country.geometry.open).toBe(0)
  })

  it('honours a window, and ignores one that misses the shape', () => {
    // A box over São Paulo state is a few hundred kilometres of Brazil.
    expect(R.windowed.status).toBe(200)
    expect(R.windowed.body.clip).toEqual({ w: -48, s: -24, e: -46, n: -22 })
    expect(R.windowed.geometry.points).toBeLessThan(R.country.geometry.points)
    // The camera is still framed on the whole scope, not on the window.
    expect(R.windowed.body.bbox).toEqual(R.country.body.bbox)
    // A window on the wrong continent — a guess placed in Germany — has
    // nothing to draw, but the shape itself is fine, so the whole of it comes
    // back and the client frames on that.
    expect(R.windowElsewhere.status).toBe(200)
    expect(R.windowElsewhere.body.clip).toBe(null)
    expect(R.windowElsewhere.geometry.points).toBe(R.country.geometry.points)
  })
})

describe('GET /api/scope-for-pano', () => {
  it('resolves a catalog pano to the scope its card will carry', () => {
    expect(R.panoHit.status).toBe(200)
    expect(R.panoHit.body.ok).toBe(true)
    // An ISO code, because that is the key the client stores an outline under —
    // the catalog knows the country only by name.
    expect(R.panoHit.body.scope.country).toMatch(/^[A-Z]{2}$/)
  })

  it('is mute about a pano it has never indexed', () => {
    expect(R.panoMiss.status).toBe(200)
    expect(R.panoMiss.body).toEqual({ ok: false })
    expect(R.panoMiss.cacheControl).toBe('no-store')
  })
})

/* -------------------------------------------------------------------------
 * The just-in-time deck.
 * ---------------------------------------------------------------------- */

describe('GET /deck', () => {
  it('still needs a token', () => {
    expect(R.deckNoToken.status).toBe(401)
  })

  it('publishes a handful rather than the whole ladder', () => {
    // The bag this replaced was 121 metas × 4 locations = 484, drawn from
    // uniformly at random.
    expect(R.deckDefault.body.customCoordinates.length).toBe(10)
    expect(R.deckDefault.body.ranking.length).toBe(10)
  })

  it('respects ?n=', () => {
    expect(R.deckEight.body.customCoordinates.length).toBe(8)
    expect(R.deckEight.body.ranking.length).toBe(8)
    // And clamps a silly one rather than trying to publish it.
    expect(R.deckHuge.body.customCoordinates.length).toBeLessThanOrEqual(50)
  })

  it('honours the five-location floor when asked for fewer', () => {
    // Below five GeoGuessr either refuses the map or serves the same location
    // twice, so a request for three is topped up from the next metas down the
    // queue rather than published as three.
    expect(R.deckSmall.body.customCoordinates.length).toBe(5)
    expect(R.deckSmall.body.ranking.length).toBe(5)
  })

  it('publishes one location per meta, in priority order', () => {
    const names = R.deckDefault.body.ranking.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    const priorities = R.deckDefault.body.ranking.map((r) => r.priority)
    for (let i = 1; i < priorities.length; i++)
      expect(priorities[i], names[i] + ' after ' + names[i - 1]).toBeGreaterThanOrEqual(priorities[i - 1])
  })

  it('never publishes the same panorama twice', () => {
    const panos = R.deckDefault.body.customCoordinates.map((l) => l.panoId)
    expect(new Set(panos).size).toBe(panos.length)
  })

  it('returns the ranking that decided the map', () => {
    const { ranking, stats, customCoordinates } = R.deckDefault.body
    expect(ranking.length).toBe(customCoordinates.length)
    for (const [i, entry] of ranking.entries()) {
      expect(entry.name).toBeTruthy()
      expect(['new', 'due', 'future']).toContain(entry.kind)
      expect(typeof entry.priority).toBe('number')
      // The ranking is positional: entry i is why location i is on the map.
      expect(entry.panoId).toBe(customCoordinates[i].panoId)
    }
    expect(stats.total).toBeGreaterThanOrEqual(ranking.length)
    expect(typeof stats.newAvailable).toBe('number')
    expect(typeof stats.unlockedTiers).toBe('number')
  })

  it('keeps the fields the userscript already reads', () => {
    const body = R.deckDefault.body
    expect(body.trainerMapId).toBe('aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(typeof body.summary.due).toBe('number')
    expect(typeof body.summary.introduced).toBe('number')
    expect(body.description).toContain('due')
    for (const loc of body.customCoordinates) {
      expect(typeof loc.lat).toBe('number')
      expect(typeof loc.lng).toBe('number')
    }
  })

  it('remembers what it published, with the not-yet-due metas marked as padding', () => {
    const last = R.deckDefault.saved.lastDeck
    expect(last.metas).toEqual(R.deckDefault.body.ranking.map((r) => r.name))
    const future = R.deckDefault.body.ranking.filter((r) => r.kind === 'future').map((r) => r.name)
    expect(last.padding).toEqual(future)
  })

  it('gives a brand-new account a full first day of new material', () => {
    // Nothing due and nothing spent, so the whole daily allowance is available
    // on the first deck: ten distinct metas, one location each. This used to
    // be five locations of a single meta, back when the deck introduced one
    // new meta at a time and the five-location floor had to pad the map out
    // with more panoramas of that one clue.
    expect(R.deckFresh.body.customCoordinates.length).toBe(10)
    const names = R.deckFresh.body.ranking.map((r) => r.name)
    expect(new Set(names).size).toBe(10)
    for (const entry of R.deckFresh.body.ranking) expect(entry.kind).toBe('new')
    expect(R.deckFresh.body.summary.newAllowance).toBe(10)
    expect(R.deckFresh.body.summary.doneForToday).toBe(false)
    const panos = R.deckFresh.body.customCoordinates.map((l) => l.panoId)
    expect(new Set(panos).size).toBe(panos.length)
  })

  it('introduces no more new metas than the player configured', () => {
    // dailyNew: 3 on an account with nothing due. Three metas is the whole
    // queue, so the map is topped up to the five-location floor from second
    // panoramas of those same three — never from a fourth meta.
    const names = R.deckThreeNew.body.ranking.map((r) => r.name)
    expect(new Set(names).size).toBe(3)
    for (const entry of R.deckThreeNew.body.ranking) expect(entry.kind).toBe('new')
    expect(R.deckThreeNew.body.summary.newAllowance).toBe(3)
    // Five locations off three metas: summary counts published locations, so
    // the two the floor added are repeats of metas already in the deck rather
    // than a fourth meta slipping past the allowance.
    expect(R.deckThreeNew.body.customCoordinates.length).toBe(5)
    expect(R.deckThreeNew.body.stats.new).toBe(3)
  })

  it('clears the backlog before introducing anything', () => {
    // Twelve metas due against a ten-location deck: every slot is review and
    // not one new meta gets in, however much allowance the day still has.
    // That is the throttle working — a backlog is unpaid-for introductions.
    for (const entry of R.deckDefault.body.ranking) expect(entry.kind).toBe('due')
    expect(R.deckDefault.body.summary.due).toBe(10)
    expect(R.deckDefault.body.summary.introduced).toBe(0)
    expect(R.deckDefault.body.summary.newAllowance).toBe(10)
    expect(R.deckDefault.body.summary.doneForToday).toBe(false)
    expect(R.deckDefault.body.description).toContain('10 due, 0 new')
  })

  it('says so when the day is finished', () => {
    // Nothing owed and the allowance spent an hour ago, so everything the deck
    // can still publish is filler. "0 due, 0 new" is true and reads like a
    // broken deck; the description says the thing the player needs to know.
    const body = R.deckAllDone.body
    expect(body.summary.doneForToday).toBe(true)
    expect(body.summary.newAllowance).toBe(0)
    expect(body.summary.introduced).toBe(0)
    expect(body.description).toContain('all done for today')
    expect(body.description).not.toContain('due,')
    for (const entry of body.ranking) expect(entry.kind).toBe('future')
  })
})

/* -------------------------------------------------------------------------
 * The status widget, and the one knob behind it.
 * ---------------------------------------------------------------------- */

describe('GET /status', () => {
  it('reports the day alongside the deck counts', () => {
    expect(R.status.status).toBe(200)
    expect(R.status.body.due).toBe(12)
    // No configured value, so the scheduler's own default stands.
    expect(R.status.body.dailyNew).toBe(10)
    expect(R.status.body.newAllowance).toBe(10)
    expect(R.status.body.doneForToday).toBe(false)
    expect(R.status.body.trainerMapId).toBe('aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('agrees with the deck about a finished day', () => {
    // Same state, same account: the widget and the map must never disagree
    // about whether there is work left, so both work it out the same way.
    expect(R.statusAllDone.body.dailyNew).toBe(2)
    expect(R.statusAllDone.body.due).toBe(0)
    expect(R.statusAllDone.body.newAllowance).toBe(0)
    expect(R.statusAllDone.body.doneForToday).toBe(true)
    expect(R.deckAllDone.body.summary.doneForToday).toBe(true)
  })
})

describe('POST /round reports the day', () => {
  it('counts one more review cleared and one fewer owed', () => {
    // Two cleared before the round, four owed including this one.
    const day = R.roundReview.body.day
    expect(R.roundReview.body.card.metaName).toBe(R.sampleName)
    expect(day.reviewsDone).toBe(3)
    expect(day.reviewsDue).toBe(3)
    // The review half moved; the new half did not.
    expect(day.newIntroduced).toBe(2)
    expect(day.dailyNew).toBe(10)
    expect(day.newAllowance).toBe(8)
    expect(day.doneForToday).toBe(false)
  })

  it('keeps each half a total that can be filled', () => {
    // The whole reason both counts ride home together: done plus remaining is
    // the day's load, and a bar drawn against it can only ever fill.
    const day = R.roundReview.body.day
    expect(day.reviewsDone + day.reviewsDue).toBe(6)
    expect(day.newIntroduced + day.newAllowance).toBe(day.dailyNew)
  })

  it('spends allowance rather than review on a first sighting', () => {
    // A meta met for the first time is an introduction, never a review — the
    // card it just wrote is stamped inside today's window at both ends, and
    // counting it twice would fill both bars off one round.
    const day = R.roundFirstSight.body.day
    expect(R.roundFirstSight.body.card.firstSight).toBe(true)
    expect(day.newIntroduced).toBe(1)
    expect(day.newAllowance).toBe(9)
    expect(day.reviewsDone).toBe(0)
    expect(day.doneForToday).toBe(false)
  })

  it('names the moment the day is finished', () => {
    // The last thing owed, answered, against an allowance already spent.
    const day = R.roundFinishes.body.day
    expect(day.reviewsDone).toBe(1)
    expect(day.reviewsDue).toBe(0)
    expect(day.newIntroduced).toBe(2)
    expect(day.dailyNew).toBe(2)
    expect(day.newAllowance).toBe(0)
    expect(day.doneForToday).toBe(true)
  })

  it('reports the day on a round that gets no card', () => {
    // Duels are graded like anything else and never get a clue card. A day
    // readout that travelled inside the card would stall on exactly the rounds
    // a duel session is made of.
    expect(R.roundDuel.body.card).toBe(null)
    expect(R.roundDuel.body.day).toEqual({
      reviewsDone: 2,
      reviewsDue: 4,
      newIntroduced: 2,
      dailyNew: 10,
      newAllowance: 8,
      doneForToday: false,
    })
  })

  it('says the same thing /status says about the same day', () => {
    // One helper, three routes. The player reads the card between rounds and
    // the widget while playing, so a second copy of this arithmetic would not
    // be a duplicate — it would be a contradiction they watch happen.
    const day = R.roundDuel.body.day
    const status = R.statusMidDay.body
    expect({
      reviewsDone: status.reviewsDone,
      reviewsDue: status.reviewsDue,
      newIntroduced: status.newIntroduced,
      dailyNew: status.dailyNew,
      newAllowance: status.newAllowance,
      doneForToday: status.doneForToday,
    }).toEqual(day)
    expect(status.due).toBe(day.reviewsDue)
  })
})

describe('POST /config', () => {
  it('needs a token like every other write', () => {
    expect(R.configNoToken.status).toBe(401)
  })

  it('stores the allowance and echoes the row it stored', () => {
    expect(R.configSet.status).toBe(200)
    expect(R.configSet.body.ok).toBe(true)
    expect(R.configSet.body.config.dailyNew).toBe(3)
    expect(R.configSet.savedConfig.dailyNew).toBe(3)
    // A patch, not a replacement: the map id the userscript registered has to
    // survive a settings write.
    expect(R.configSet.savedConfig.trainerMapId).toBe('aaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('takes zero as an answer, and a number that arrived as text', () => {
    // Zero is "review only today", which is a setting; if it were read as
    // absent the default would quietly reintroduce ten metas a day.
    expect(R.configZero.status).toBe(200)
    expect(R.configZero.savedConfig.dailyNew).toBe(0)
    // Off an <input>, everything is a string.
    expect(R.configString.savedConfig.dailyNew).toBe(7)
    expect(R.configMax.savedConfig.dailyNew).toBe(100)
  })

  it('refuses what it cannot store exactly, rather than defaulting', () => {
    // A read can fall back to the default and still serve a deck. A write
    // cannot: storing 10 for someone who asked for 1000 is a setting that
    // lies about itself every time it is read back.
    for (const [i, r] of R.configRejected.entries()) {
      expect(r.status, 'rejected[' + i + ']').toBe(400)
      expect(r.body.ok).toBe(false)
      expect(r.body.error).toContain('dailyNew')
      // And nothing was written on the way to saying no.
      expect(r.savedConfig.dailyNew).toBeUndefined()
    }
    expect(R.configNoBody.status).toBe(400)
  })
})

/* -------------------------------------------------------------------------
 * The dashboard.
 * ---------------------------------------------------------------------- */

/** The preview's names alone, for the assertions that are about order and
 * membership rather than about the picture beside each one. */
const names = (upNext) => upNext.map((m) => m.name)

describe('GET /api/dashboard', () => {
  it('refuses without a token', () => {
    expect(R.dashNoToken.status).toBe(401)
  })

  it('answers a fresh account without a played round', () => {
    expect(R.dashFresh.status).toBe(200)
    expect(R.dashFresh.body.ok).toBe(true)
    expect(R.dashFresh.body.progress.held).toBe(0)
    expect(R.dashFresh.body.progress.total).toBeGreaterThan(0)
    // One point, taken now: an empty history still has a today.
    expect(R.dashFresh.body.progress.series).toHaveLength(1)
  })

  it('counts the clues currently held, out of every clue there is', () => {
    const p = R.dashHistory.body.progress
    expect(R.dashHistory.status).toBe(200)
    expect(p.held).toBe(4)
    expect(p.total).toBe(R.dashHistory.body.deck.total)
    expect(p.held).toBeLessThanOrEqual(p.total)
  })

  it('replays the line from nothing rather than back-projecting today', () => {
    const series = R.dashHistory.body.progress.series
    // The regression this exists for: evaluating today's cards at past dates
    // credits the player with clues they had not yet seen, so the line opens
    // near its maximum and sags. Replayed properly it opens at zero.
    expect(series.length).toBeGreaterThan(2)
    expect(series[0].held).toBe(0)
    expect(series[series.length - 1].held).toBe(4)
    expect(series[series.length - 1].t).toBe(R.dashHistory.body.generatedAt)
    // Time only moves forward, and the count never exceeds the catalog.
    for (let i = 1; i < series.length; i += 1)
      expect(new Date(series[i].t).getTime()).toBeGreaterThan(new Date(series[i - 1].t).getTime())
    for (const point of series) expect(point.held).toBeLessThanOrEqual(R.dashHistory.body.progress.total)
  })

  it('carries duel cost per country, and names a region only past the sample gate', () => {
    const rows = Object.fromEntries(R.dashDuels.body.countries.map((c) => [c.code, c]))
    expect(rows.RU).toMatchObject({ duels: 6, duelLost: 21000, worstRegion: null })
    expect(rows.BR.duelLost).toBe(9000)
    expect(rows.BR.worstRegion).toEqual({ name: 'Minas Gerais', n: 5, lost: 9000 })
    // Two rounds in Antioquia is an anecdote, not an insight.
    expect(rows.CO.worstRegion).toBe(null)
  })

  it('deals new clues from the countries duels bleed points in', () => {
    const next = R.dashDuels.body.day.upNext.map((m) => m.name)
    // Russia outweighs Brazil outweighs Colombia; two clues per country per
    // day, then the ladder's own order resumes for everyone unweighted.
    expect(next.slice(0, 6).map((n) => n.split(':')[0])).toEqual([
      'Russia',
      'Russia',
      'Brazil',
      'Brazil',
      'Colombia',
      'Colombia',
    ])
  })

  it('reports the day beside the deck, not only the deck', () => {
    // Nothing due and nothing introduced in the last 24h, so the whole default
    // allowance is still there to spend and the day is not over.
    const day = R.dashHistory.body.day
    expect(day.dailyNew).toBe(10)
    expect(day.newAllowance).toBe(10)
    expect(day.doneForToday).toBe(false)
    expect(R.dashHistory.body.deck.due).toBe(0)
  })

  it('names a finished day the same way /status does', () => {
    const day = R.dashAllDone.body.day
    expect(R.dashAllDone.status).toBe(200)
    expect(day.dailyNew).toBe(2)
    expect(day.newAllowance).toBe(0)
    expect(day.doneForToday).toBe(true)
    // The regression this guards: the console and the map reading the same
    // account and disagreeing about whether there is any work left. Same
    // arithmetic, so the same three numbers — compared field by field because
    // the console also carries a preview list that /status has no use for.
    expect({ dailyNew: day.dailyNew, newAllowance: day.newAllowance, doneForToday: day.doneForToday }).toEqual({
      dailyNew: R.statusAllDone.body.dailyNew,
      newAllowance: R.statusAllDone.body.newAllowance,
      doneForToday: R.statusAllDone.body.doneForToday,
    })
    // And a finished day is still a day with clues left to meet — the deck is
    // not exhausted, the allowance is.
    expect(R.dashAllDone.body.deck.unseen).toBeGreaterThan(0)
  })

  it('names the clues the day is about to introduce, in ladder order', () => {
    // A fresh account has met nothing, so the preview is simply the head of the
    // ladder — and it is the ladder's order, not the alphabet or a shuffle.
    expect(names(R.dashFresh.body.day.upNext)).toEqual(R.ladderHead.slice(0, 10))
  })

  it('leaves out the clues already met and keeps the rest in order', () => {
    const expected = R.ladderHead.filter((n) => !R.playedNames.includes(n)).slice(0, 10)
    expect(names(R.dashHistory.body.day.upNext)).toEqual(expected)
    for (const name of R.playedNames) expect(names(R.dashHistory.body.day.upNext)).not.toContain(name)
  })

  it('names no more than the day has left to give', () => {
    // Five a day, two met an hour ago: three named, and the three the ladder
    // would actually reach next rather than any three.
    const day = R.dashPartDay.body.day
    expect(day.dailyNew).toBe(5)
    expect(day.newAllowance).toBe(3)
    expect(day.doneForToday).toBe(false)
    expect(names(day.upNext)).toEqual(R.ladderHead.filter((n) => !R.spentNames.includes(n)).slice(0, 3))
  })

  it('carries the camera that shows each clue, not only its name', () => {
    // Naming a clue is not showing one. Each entry carries the first catalog
    // location that teaches it — the pano and the yaw the page needs to build
    // a Street View thumbnail — and "first" is catalog order, so the same clue
    // shows the same picture on every load.
    for (const entry of R.dashFresh.body.day.upNext) {
      const loc = R.firstLocation[entry.name]
      expect(loc, entry.name).toBeTruthy()
      expect(entry, entry.name).toEqual({
        name: entry.name,
        panoId: loc.panoId,
        heading: loc.heading,
        pitch: loc.pitch,
        lat: loc.lat,
        lng: loc.lng,
      })
      expect(typeof entry.panoId, entry.name).toBe('string')
      expect(typeof entry.heading, entry.name).toBe('number')
    }
  })

  it('names nothing once the allowance is spent', () => {
    // The whole point of the preview is that it is the allowance said in
    // names: no allowance, no names, even with a ladder full of unmet clues.
    expect(R.dashAllDone.body.day.newAllowance).toBe(0)
    expect(R.dashAllDone.body.day.upNext).toEqual([])
    expect(R.dashAllDone.body.deck.unseen).toBeGreaterThan(0)
  })

  it('never names more clues than the day or the deck can supply', () => {
    // The list and the count are two readings of one number, so they cannot
    // drift: as many names as the allowance, unless the ladder runs out first.
    // A clue with no catalog location still occupies its place in the list —
    // dropping it would shorten the list below the count printed beside it.
    for (const key of ['dashFresh', 'dashHistory', 'dashMixed', 'dashPartDay', 'dashAllDone']) {
      const { day, deck } = R[key].body
      expect(day.upNext.length, key).toBe(Math.min(day.newAllowance, deck.unseen))
      expect(new Set(names(day.upNext)).size, key).toBe(day.upNext.length)
    }
  })

  it('carries the three totals a console reads without doing arithmetic', () => {
    // Six clues owed, four met and holding, everything else unseen.
    const { deck } = R.dashMixed.body
    expect(R.dashMixed.status).toBe(200)
    // (a) distinct metas tracked — one per card in the table, never one per
    // location, which is the over-count /deck had to be taught to avoid.
    expect(deck.introduced).toBe(R.mixedDueNames.length + R.mixedHeldNames.length)
    expect(deck.introduced).toBe(new Set([...R.mixedDueNames, ...R.mixedHeldNames]).size)
    // (b) the universe the deck can ever draw from: every distinct meta on the
    // unlocked ladder, counted off the catalog files themselves.
    expect(deck.ladderTotal).toBe(R.ladderMetaTotal)
    expect(deck.ladderTotal).toBe(deck.introduced + deck.unseen)
    // (c) reviews owed at this instant — the six that are due, not the four
    // that are not due for a month.
    expect(deck.due).toBe(R.mixedDueNames.length)
  })

  it('agrees with the deck the map would actually deal', () => {
    // The number that matters most is the one two endpoints can disagree
    // about: reviews owed. /status walks the same ladder off the same due
    // test, so a console promising eight reviews over a map dealing six would
    // be this assertion failing.
    expect(R.dashAllDone.body.deck.due).toBe(R.statusAllDone.body.due)
    expect(R.dashAllDone.body.deck.unseen).toBe(R.statusAllDone.body.unseen)
    expect(R.dashAllDone.body.deck.ladderTotal).toBe(R.ladderMetaTotal)
    // A finished day owes nothing, and a ladder full of unmet clues is still
    // smaller than the ladder itself.
    expect(R.dashAllDone.body.deck.due).toBe(0)
    expect(R.dashAllDone.body.deck.unseen).toBeLessThan(R.ladderMetaTotal)
  })
})

/* -------------------------------------------------------------------------
 * The install link, and the pages around it.
 * ---------------------------------------------------------------------- */

describe('GET /geocoach.user.js', () => {
  it('serves the loader as a script Tampermonkey will offer to install', () => {
    expect(R.loader.status).toBe(200)
    expect(R.loader.contentType).toMatch(/^application\/javascript/)
    expect(R.loader.text.startsWith('// ==UserScript==')).toBe(true)
    // Templated per caller, so it must never be cached anywhere.
    expect(R.loader.cacheControl).toBe('no-store')
  })

  it('takes the token from the query string, which is how the link is clicked', () => {
    // The install link is followed by a browser navigation; there is no place
    // to put an Authorization header on one.
    expect(R.loaderByQuery.status).toBe(200)
    expect(R.loaderByQuery.text).toBe(R.loader.text)
  })

  it('bakes in the serving origin and the caller\'s own token', () => {
    // JSON.stringify does the substitution, so the placeholder's single
    // quotes come back double.
    expect(R.loader.text).toContain('const CLOUD_URL = "https://geocoach.example"')
    expect(R.loader.text).toContain('const CLOUD_TOKEN = ' + JSON.stringify(TOKEN))
    expect(R.loader.text).toContain('// @connect      geocoach.example')
  })

  it('points its update check at the host that served it, not at a laptop', () => {
    // The committed source aims @updateURL and @downloadURL at
    // http://127.0.0.1:5177 — right for the machine this was written on, and a
    // dead address on every other machine, which left a stranger's install
    // unable to ever pick up a new loader.
    expect(R.loader.text).not.toContain('127.0.0.1:5177/geocoach.user.js')
    for (const tag of ['@updateURL', '@downloadURL'])
      expect(R.loader.text).toMatch(
        new RegExp(tag + '\\s+https://geocoach\\.example/geocoach\\.user\\.js\\?token=' + TOKEN),
      )
    // The body it pulls on every page load still tries the local server first;
    // only the metadata URLs move.
    expect(R.loader.text).toContain("const LOCAL = 'http://127.0.0.1:5177'")
  })

  it('serves the body the loader asks for on the same terms', () => {
    expect(R.body.status).toBe(200)
    expect(R.body.contentType).toMatch(/^application\/javascript/)
    expect(R.body.text).toContain('const CLOUD_URL = "https://geocoach.example"')
  })

  it('answers a stale install link in words, not in JSON', () => {
    // This 401 is read by a person in a Tampermonkey pane, having clicked a
    // link that expired. {"ok":false,"error":"missing or unknown token"} told
    // them nothing they could act on.
    expect(R.loaderStaleToken.status).toBe(401)
    expect(R.loaderStaleToken.contentType).toMatch(/^text\/plain/)
    expect(R.loaderStaleToken.text).toContain('/start')
  })
})

describe('the static site', () => {
  it('hands a client route the shell, so a hard refresh works', () => {
    expect(R.page.status).toBe(200)
    expect(R.page.text).toContain('GeoCoach')
    // A trailing slash is the same page — links come back from chat clients
    // wearing one.
    expect(R.pageSlash.status).toBe(200)
    expect(R.pageRoot.status).toBe(200)
  })

  it('serves a real file rather than the shell', () => {
    expect(R.asset.status).toBe(200)
    expect(R.asset.text).toBe('User-agent: *')
  })

  it('answers an unknown path 404, with the shell to render it', () => {
    // The body still has to be the app: the client router draws its own
    // not-found page. Only the status was wrong, and a 200 on every mistyped
    // URL is what makes a link checker report a site with nothing broken.
    expect(R.pageUnknown.status).toBe(404)
    expect(R.pageUnknown.text).toContain('GeoCoach')
  })
})
