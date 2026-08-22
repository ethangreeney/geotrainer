/**
 * GeoCoach brief — everything needed to coach one round, in one command.
 *
 *   node coach/brief.mjs            # the round you just finished
 *   node coach/brief.mjs 3          # the 3rd-most-recent round
 *   node coach/brief.mjs <roundId>  # a specific round
 *   node coach/brief.mjs --list 15  # recent rounds, one line each
 *   node coach/brief.mjs --profile  # standing form: hit rate, confusions, worst countries
 *   node coach/brief.mjs --quiz [n] # a past miss, imagery only — guess before the reveal
 *
 * Rounds played on the gaming PC go straight to the cloud, so they arrive here
 * as metadata with no imagery. This pulls the dossier down, rebuilds the
 * panorama from Google's public tile CDN, samples the terrain at both ends of
 * the guess, and picks the Plonk It clues that actually separate the country
 * from the one that was guessed — so a coaching session is one Bash call plus
 * a look at the picture.
 *
 * Makes no LLM API calls. The coach is the Claude Code session reading this.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compass16, panoHeading } from './meta.mjs'
import { saveTiles } from './pano.mjs'
import { flat, guide } from './plonkit.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

const cfg = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'))
const CLOUD = cfg.cloud
if (!CLOUD?.url || !CLOUD?.token) {
  console.error('coach/config.json has no cloud credentials; nothing to pull.')
  process.exit(1)
}

const api = async (path) => {
  const res = await fetch(CLOUD.url + path, {
    headers: { Authorization: 'Bearer ' + CLOUD.token },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

/** The one dossier for a round id. Older servers have no id lookup, so fall
 *  back to scanning the recent window. */
async function dossier(id) {
  const one = await api(`/api/rounds?id=${encodeURIComponent(id)}`).catch(() => null)
  if (one?.rounds?.length) return one.rounds[0]
  const { rounds } = await api('/api/rounds?limit=50')
  return rounds.find((x) => x.id === id) ?? null
}

/* ---------------------------------------------------------------- helpers */

/* Everything prints at the end, so sections can be built out of order. */
const L = []
const rule = (t) => L.push('', `-- ${t} ` + '-'.repeat(Math.max(2, 76 - t.length)))

const km = (n) => (n == null ? '?' : n >= 100 ? String(Math.round(n)) : n.toFixed(1))
const place = (p) => [p?.locality, p?.region, p?.name].filter(Boolean).join(', ') || 'unknown'

const bearing = (a, b) => {
  const [y1, x1, y2, x2] = [a.lat, a.lng, b.lat, b.lng].map((d) => (d * Math.PI) / 180)
  const deg =
    (Math.atan2(
      Math.sin(x2 - x1) * Math.cos(y2),
      Math.cos(y1) * Math.sin(y2) - Math.sin(y1) * Math.cos(y2) * Math.cos(x2 - x1),
    ) *
      180) /
    Math.PI
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg + 360) % 360) / 45) % 8]
}

/** Elevation across ~2 km around a point: the number behind "this looked hilly".
 *  Open-Meteo, free, no key. Silent on failure — it is a nicety, not the point. */
async function terrain(pt) {
  if (!pt?.lat) return null
  const d = 0.01
  const ring = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]
  try {
    const lat = ring.map(([a]) => (pt.lat + a).toFixed(4)).join(',')
    const lng = ring.map(([, b]) => (pt.lng + b).toFixed(4)).join(',')
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const e = (await res.json()).elevation
    if (!Array.isArray(e) || !e.length) return null
    const relief = Math.round(Math.max(...e) - Math.min(...e))
    const shape = relief < 25 ? 'flat' : relief < 80 ? 'rolling' : relief < 250 ? 'hilly' : 'steep'
    return `${Math.round(e[0])} m elevation, ${relief} m of relief within 2 km — ${shape}`
  } catch {
    return null
  }
}

/** Clues matching the meta the map intended. Searches the prose and the
 *  reference-image filenames, which often name their subject more plainly than
 *  the prose does ("Quebec pole stickers" -> Quebec_yellow_sticker.png). */
function forMeta(g, metaName) {
  if (!g || !metaName) return []
  const term = metaName.includes(':') ? metaName.slice(metaName.indexOf(':') + 1) : metaName
  const words = [...new Set(flat(term).match(/[a-z]{3,}/g) ?? [])]
    .filter((w) => !['the', 'and', 'for', 'with', 'sign', 'signs'].includes(w))
    .map((w) => w.replace(/s$/, ''))
  if (!words.length) return []
  return g.blocks
    .map((b) => ({
      ...b,
      score: words.filter((w) =>
        flat(`${b.text} ${b.images.join(' ').replace(/[_/-]/g, ' ')}`).includes(w),
      ).length,
    }))
    .filter((b) => b.score >= Math.min(2, words.length))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

/** The names a guide is likely to call another country by. */
const aliases = (g, name) => {
  const out = new Set([g?.title, name?.replace(/ \(the\)$/, '')].filter(Boolean))
  for (const n of [...out]) {
    if (n.startsWith('United States')) out.add('the US').add('the U.S.')
    if (n.startsWith('United Kingdom')) out.add('the UK')
    const short = n.replace(/^(the )?(Republic|Kingdom) of /i, '')
    if (short !== n) out.add(short)
  }
  return [...out]
}

/* ------------------------------------------------- the record, in numbers */

/** Right at country level. The dashboard's own `correct` is stricter than the
 *  country — it fails a 250 km miss inside Japan — so read the names instead. */
const right = (x) =>
  x.country && x.guessCountry ? x.country === x.guessCountry : Boolean(x.correct)

const rate = (rs) => {
  const n = rs.filter(right).length
  return `${n}/${rs.length}` + (rs.length ? ` (${Math.round((100 * n) / rs.length)}%)` : '')
}

/** Direction-specific confusions: calling Malaysia Cambodia is not the same
 *  mistake as calling Cambodia Malaysia, and only one of them is yours.
 *  A round that timed out has no guess country and confuses nothing. */
function confusions(rounds) {
  const m = new Map()
  for (const x of rounds) {
    if (right(x) || !x.country || !x.guessCountry || x.guessCountry === 'unknown') continue
    const k = `${x.country} -> ${x.guessCountry}`
    const e = m.get(k) ?? { country: x.country, guess: x.guessCountry, n: 0, last: '' }
    e.n++
    if (x.ts > e.last) e.last = x.ts
    m.set(k, e)
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))
}

const plain = (n) => n.replace(/ \(the\)$/, '')
const said = (c) => `${plain(c.country)} '${plain(c.guess)}'`

/* ------------------------------------------------------------------ views */

const VIEWS = ['front', 'right', 'back', 'left']

/** Rectilinear views off the stitched pano. A nicety — if render.py, numpy or
 *  Pillow is missing the brief carries on with the equirect alone. */
async function makeViews(dir) {
  if (!existsSync(join(dir, 'pano_full.jpg')) || existsSync(join(dir, 'view_front.jpg'))) return
  await new Promise((done) =>
    execFile('python3', [join(ROOT, 'render.py'), 'views', dir], () => done()),
  )
}

/** The pano's compass heading, cached in the round dir so a second brief on the
 *  same round costs no round trip. Null when Google won't say. */
async function heading(dir, panoId) {
  const file = join(dir, 'meta.json')
  if (existsSync(file))
    return readFile(file, 'utf8').then((s) => JSON.parse(s).heading ?? null).catch(() => null)
  const deg = await panoHeading(panoId)
  if (deg != null) await writeFile(file, JSON.stringify({ heading: deg }))
  return deg
}

/** Where the pictures are and what each one is for. Shared with the quiz,
 *  which prints imagery and nothing else — the compass included, since a player
 *  in game has it too and it names no place. */
async function imagery(dir, id, panoId) {
  const out = []
  const deg = await heading(dir, panoId)
  const views = VIEWS.map((v, i) => [
    join(dir, `view_${v}.jpg`),
    deg == null ? '' : `  (faces ${compass16(deg + i * 90)})`,
  ]).filter(([p]) => existsSync(p))
  if (views.length) {
    out.push(...views.map(([p, faces]) => p + faces))
    out.push(
      '  the round in photograph geometry — 100° each, front = the way the camera car\n' +
        '  faced. Start here: these are what a player actually sees.',
    )
  }
  if (deg != null)
    out.push(
      `compass: front = ${compass16(deg)} (${Math.round(deg)}°) — ` +
        `north is ${Math.round((360 - deg) % 360)}° of yaw`,
    )
  out.push(join(dir, 'pano.jpg'))
  out.push('  360° equirectangular overview — the whole round in one image.')
  const grid = (await readdir(dir)).map((f) => f.match(/^pano_(\d+)_(\d+)\.jpg$/)).filter(Boolean)
  if (grid.length) {
    const rows = Math.max(...grid.map((m) => Number(m[1]))) + 1
    const cols = Math.max(...grid.map((m) => Number(m[2]))) + 1
    out.push(join(dir, 'pano_<row>_<col>.jpg'))
    out.push(
      `  ${rows}×${cols} grid of native 512px tiles, for reading detail the overview loses. ` +
        `A thing sitting\n  at fraction x across pano.jpg is in col round(x × ${cols - 1}); ` +
        `the horizon runs through rows ${Math.floor(rows / 2) - 1}–${Math.floor(rows / 2)}.`,
    )
  }
  out.push(
    `aimed close-up: node coach/look.mjs ${id} <yaw> [pitch] [fov]` +
      '  (fov<45 fetches sharper zoom-5 imagery)',
  )
  return out
}

/* ------------------------------------------------------------------- main */

const args = process.argv.slice(2)

if (args[0] === '--list') {
  const { rounds } = await api(`/api/rounds?limit=${Math.min(50, Number(args[1]) || 15)}`)
  for (const [i, x] of rounds.entries())
    console.log(
      `${String(i + 1).padStart(2)}  ${x.ts.slice(0, 16).replace('T', ' ')}  ${x.id}  ` +
        `${(x.answer?.name ?? '?').slice(0, 21).padEnd(22)}` +
        `${x.correctCountry ? '   ' : '-> '}${(x.guess?.name ?? '?').slice(0, 21).padEnd(22)}` +
        `${km(x.distanceKm).padStart(6)} km ${String(x.score ?? '').padStart(5)}  ${x.metaName ?? ''}`,
    )
  process.exit(0)
}

if (args[0] === '--profile') {
  const all = (await api('/api/dashboard')).rounds ?? []
  const since = (days) => {
    const t = new Date(Date.now() - days * 864e5).toISOString()
    return all.filter((x) => x.ts >= t)
  }
  L.push(
    `GEOCOACH PROFILE   ${all.length} rounds` +
      (all.length ? `   ${all.at(-1).ts.slice(0, 10)} → ${all[0].ts.slice(0, 10)}` : ''),
  )

  rule('COUNTRY HIT RATE')
  for (const [label, rs] of [
    ['last 7 days', since(7)],
    ['last 30 days', since(30)],
    ['all time', all],
  ])
    L.push(`${label.padEnd(14)}${rs.length ? rate(rs) : '—'}`)

  const conf = confusions(all).filter((c) => c.n >= 2)
  rule('STANDING CONFUSIONS')
  if (!conf.length) L.push('none repeated — no country has fooled you the same way twice')
  for (const c of conf.slice(0, 10))
    L.push(`you call ${said(c).padEnd(44)}${String(c.n).padStart(3)}×   last ${c.last.slice(0, 10)}`)

  const byCountry = new Map()
  for (const x of all) {
    if (!x.country) continue
    byCountry.set(x.country, [...(byCountry.get(x.country) ?? []), x])
  }
  const worst = [...byCountry]
    .filter(([, rs]) => rs.length >= 3)
    .map(([name, rs]) => [name, rs, rs.filter(right).length / rs.length])
    .sort((a, b) => a[2] - b[2] || b[1].length - a[1].length)
  rule('WORST COUNTRIES (3+ rounds)')
  if (!worst.length) L.push('no country played three times yet')
  for (const [name, rs] of worst.slice(0, 5)) L.push(`${name.padEnd(30)}${rate(rs)}`)

  L.push('', 'One of these, prediction-first: node coach/brief.mjs --quiz')
  console.log(L.join('\n'))
  process.exit(0)
}

if (args[0] === '--quiz') {
  const all = (await api('/api/dashboard')).rounds ?? []
  const quizzedPath = join(ROOT, '.quizzed.json')
  const quizzed = await readFile(quizzedPath, 'utf8').then(JSON.parse).catch(() => [])
  const repeated = new Set(
    confusions(all).filter((c) => c.n >= 2).map((c) => `${c.country} -> ${c.guess}`),
  )
  const pool = all
    .slice(0, 100)
    .filter((x) => !right(x) && x.country && !quizzed.includes(x.id))
    // a mistake you keep making is worth three of one you made once
    .map((x) => ({ x, w: repeated.has(`${x.country} -> ${x.guessCountry}`) ? 3 : 1 }))
  if (!pool.length) {
    console.log(
      'Every miss in your last 100 rounds has been quizzed already.\n' +
        'Delete coach/.quizzed.json to run the deck again.',
    )
    process.exit(0)
  }

  // seeded, a tiny LCG so a test repeats itself; unseeded, just a random pick
  const seed = args[1] === undefined ? null : Number(args[1])
  let s = ((seed ?? 1) >>> 0) || 1
  const rand =
    seed !== null && Number.isFinite(seed)
      ? () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
      : Math.random
  let t = rand() * pool.reduce((a, p) => a + p.w, 0)
  const chosen = (pool.find((p) => (t -= p.w) < 0) ?? pool.at(-1)).x

  const q = await dossier(chosen.id)
  if (!q) {
    console.error(`Round ${chosen.id} is no longer fetchable.`)
    process.exit(1)
  }
  const qdir = join(ROOT, 'rounds', q.id)
  await mkdir(qdir, { recursive: true })
  await writeFile(join(qdir, 'dossier.json'), JSON.stringify(q, null, 1))
  await writeFile(quizzedPath, JSON.stringify([...quizzed, q.id], null, 1))
  if (!existsSync(join(qdir, 'pano.jpg')) && q.panoId) await saveTiles(q.panoId, qdir)
  await makeViews(qdir)

  /* Nothing below may name the place: no country, no coordinates, no meta.
   * The answer sits in dossier.json for the coach, not for the player. */
  L.push(`QUIZ ROUND ${q.id}   ${q.ts.slice(0, 10)}   ${q.mode ?? '?'}`)
  L.push('')
  if (existsSync(join(qdir, 'pano.jpg'))) L.push(...(await imagery(qdir, q.id, q.panoId)))
  else L.push('no imagery survives for this round — run --quiz again for another')
  L.push(
    '',
    'COACH: reveal nothing yet — not the country, not the region, not a hint.',
    'Ask for two things, read from these images alone: a country, and the reasoning',
    'that got there. Once both are stated, run',
    `  node coach/brief.mjs ${q.id}`,
    'for the full brief, and coach the gap between that reasoning and the real clues.',
  )
  console.log(L.join('\n'))
  process.exit(0)
}

const target = args[0] ?? '1'
const nth = /^\d{1,2}$/.test(target) ? Number(target) : null
const r = nth ? (await api(`/api/rounds?limit=${nth}`)).rounds[nth - 1] : await dossier(target)
if (!r) {
  console.error(`No such round: ${target}`)
  process.exit(1)
}

const dir = join(ROOT, 'rounds', r.id)
const pano = join(dir, 'pano.jpg')
await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'dossier.json'), JSON.stringify(r, null, 1))

const missed = Boolean(r.guess?.code) && r.guess.code !== r.answer?.code

/* Tiles, terrain and guides in parallel — the tiles are the slow part. */
const [, hiGround, loGround, aG, gG] = await Promise.all([
  existsSync(pano) || !r.panoId ? Promise.resolve([]) : saveTiles(r.panoId, dir),
  terrain(r.answer),
  terrain(r.guess),
  guide(r.answer?.code, r.answer?.name),
  missed ? guide(r.guess.code, r.guess.name) : Promise.resolve(null),
])

await makeViews(dir)

/* Their own record on both countries, and how this pair has gone before. */
const past = (await api('/api/dashboard').catch(() => ({}))).rounds ?? []
const seen = past.filter((x) => x.id !== r.id)
const record = (name) => {
  const s = seen.filter((x) => x.country === name)
  return s.length ? `${s.filter(right).length}/${s.length}` : 'first time'
}
/* Country cheat-sheet, if it has been generated. */
const facts = await readFile(join(ROOT, 'facts.json'), 'utf8').then(JSON.parse).catch(() => ({}))

const pairs = seen.filter(
  (x) =>
    (x.country === r.answer?.name && x.guessCountry === r.guess?.name) ||
    (x.country === r.guess?.name && x.guessCountry === r.answer?.name),
)

/* ------------------------------------------------------------------ print */

const clue = (b, tag) =>
  L.push(
    `· ${tag ? `[${tag}] ` : ''}${b.text}` +
      (b.images.length ? `\n    ref: coach/plonkit/${b.images[0]}` : ''),
  )

L.push(
  `ROUND ${r.id}   ${r.ts.replace('T', ' ').slice(0, 16)}Z   ${r.mode ?? '?'} r${r.roundNumber ?? '?'}`,
)
L.push(
  `${r.correctCountry ? 'RIGHT COUNTRY' : 'WRONG COUNTRY'}   ${km(r.distanceKm)} km off   ${r.score ?? '?'} pts` +
    (r.guess ? `   (you clicked ${bearing(r.answer, r.guess)} of the true spot)` : ''),
)

/* Standing form, so one round is read against the shape of the rest. */
const last50 = past.slice(0, 50)
const standing = confusions(past).filter((c) => c.n >= 2).slice(0, 3)
rule('YOUR PATTERNS')
const hits = last50.filter(right).length
L.push(
  `country right in ${hits}/${last50.length} of your last ${last50.length} rounds` +
    (last50.length ? ` (${Math.round((100 * hits) / last50.length)}%)` : ''),
)
if (standing.length)
  L.push('you call ' + standing.map((c) => `${said(c)} ${c.n}x`).join(' - '))

rule('WHERE IT WAS')
L.push(`${place(r.answer)}   ${r.answer?.lat?.toFixed(5)}, ${r.answer?.lng?.toFixed(5)}`)
if (hiGround) L.push(hiGround)
L.push(`your record on ${r.answer?.name}: ${record(r.answer?.name)}`)

rule('WHERE YOU CLICKED')
if (!r.guess) L.push('no guess recorded')
else {
  L.push(`${place(r.guess)}   ${r.guess.lat.toFixed(5)}, ${r.guess.lng.toFixed(5)}`)
  if (loGround) L.push(loGround)
  if (missed) L.push(`your record on ${r.guess.name}: ${record(r.guess.name)}`)
}
if (pairs.length)
  L.push(
    `this pair has come up ${pairs.length}× before: ` +
      pairs.slice(0, 5).map((x) => `${x.ts.slice(0, 10)} ${km(x.distanceKm)} km`).join(', '),
  )

const metaBlocks = forMeta(aG, r.metaName)
rule(r.metaName ? `THE INTENDED CLUE — ${r.metaName}` : 'THE INTENDED CLUE')
if (!r.metaName) L.push('none: this map has no single intended clue for the round')
else if (!metaBlocks.length) L.push('(no matching Plonk It entry — the meta is Learnable Meta’s own)')
metaBlocks.forEach((b) => clue(b, b.step))
if (r.lm?.note) L.push(`note: ${r.lm.note.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)

/* The clues that actually decide between these two countries: any clue in
 * either guide that names the other one. Everything else is background. */
if (missed && aG && gG) {
  const hits = (g, other) => g.blocks.filter((b) => other.some((n) => b.text.includes(n)))
  const sharp = [
    ...hits(aG, aliases(gG, r.guess?.name)).map((b) => [b, aG.title]),
    ...hits(gG, aliases(aG, r.answer?.name)).map((b) => [b, gG.title]),
  ]
  rule(`${aG.title.toUpperCase()} vs ${gG.title.toUpperCase()} — WHAT SEPARATES THEM`)
  if (!sharp.length) L.push('(neither guide mentions the other — see the clues below)')
  sharp.slice(0, 14).forEach(([b, who]) => clue(b, who))
  if (sharp.length > 14)
    L.push(`… ${sharp.length - 14} more in coach/plonkit/${aG.slug}.md and ${gG.slug}.md`)
}

for (const [g, side] of [
  [aG, r.answer],
  [missed ? gG : null, r.guess],
]) {
  if (!g) continue
  const step1 = g.blocks.filter((b) => b.step === 'Step 1')
  const cap = missed ? 10 : 18
  rule(`${g.title.toUpperCase()} — HOW TO SPOT IT`)
  const f = facts[side?.code?.toUpperCase()]
  if (f)
    L.push(
      'at a glance: ' +
        [
          f.drives && `drives on the ${f.drives}`,
          f.lines && `lines: ${f.lines}`,
          f.script && `script: ${f.script}`,
          f.tell && `tell: ${f.tell}`,
        ]
          .filter(Boolean)
          .join(' · '),
    )
  step1.slice(0, cap).forEach((b) => clue(b))
  if (step1.length > cap)
    L.push(`… ${step1.length - cap} more, plus regional clues, in coach/plonkit/${g.slug}.md`)
}

rule('IMAGERY')
if (!existsSync(pano))
  L.push(`no tiles for panoId ${r.panoId ?? '(none recorded)'} — imagery unavailable`)
else L.push(...(await imagery(dir, r.id, r.panoId)))

L.push('', 'Wider question ("what else could this have been?"): node coach/clues.mjs')
console.log(L.join('\n'))
