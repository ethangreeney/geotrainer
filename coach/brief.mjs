/**
 * GeoCoach brief — everything needed to coach one round, in one command.
 *
 *   node coach/brief.mjs            # the round you just finished
 *   node coach/brief.mjs 3          # the 3rd-most-recent round
 *   node coach/brief.mjs <roundId>  # a specific round
 *   node coach/brief.mjs --list 15  # recent rounds, one line each
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
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/* ---------------------------------------------------------------- helpers */

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

const target = args[0] ?? '1'
const nth = /^\d{1,2}$/.test(target) ? Number(target) : null
const { rounds } = await api(`/api/rounds?limit=${nth ?? 50}`)
const r = nth ? rounds[nth - 1] : rounds.find((x) => x.id === target)
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

/* Their own record on both countries, and how this pair has gone before. */
const past = (await api('/api/dashboard').catch(() => ({}))).rounds ?? []
const seen = past.filter((x) => x.id !== r.id)
const record = (name) => {
  const s = seen.filter((x) => x.country === name)
  return s.length ? `${s.filter((x) => x.correct).length}/${s.length}` : 'first time'
}
const pairs = seen.filter(
  (x) =>
    (x.country === r.answer?.name && x.guessCountry === r.guess?.name) ||
    (x.country === r.guess?.name && x.guessCountry === r.answer?.name),
)

/* ------------------------------------------------------------------ print */

const L = []
const rule = (t) => L.push('', `-- ${t} ` + '-'.repeat(Math.max(2, 76 - t.length)))
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

for (const g of [aG, missed ? gG : null]) {
  if (!g) continue
  const step1 = g.blocks.filter((b) => b.step === 'Step 1')
  const cap = missed ? 10 : 18
  rule(`${g.title.toUpperCase()} — HOW TO SPOT IT`)
  step1.slice(0, cap).forEach((b) => clue(b))
  if (step1.length > cap)
    L.push(`… ${step1.length - cap} more, plus regional clues, in coach/plonkit/${g.slug}.md`)
}

rule('IMAGERY')
if (!existsSync(pano))
  L.push(`no tiles for panoId ${r.panoId ?? '(none recorded)'} — imagery unavailable`)
else {
  const grid = (await readdir(dir))
    .map((f) => f.match(/^pano_(\d+)_(\d+)\.jpg$/))
    .filter(Boolean)
  const rows = Math.max(...grid.map((m) => Number(m[1]))) + 1
  const cols = Math.max(...grid.map((m) => Number(m[2]))) + 1
  L.push(pano)
  L.push('  360° equirectangular overview — the whole round in one image. Start here.')
  L.push(join(dir, 'pano_<row>_<col>.jpg'))
  L.push(
    `  ${rows}×${cols} grid of native 512px tiles, for reading detail the overview loses. ` +
      `A thing sitting\n  at fraction x across pano.jpg is in col round(x × ${cols - 1}); ` +
      `the horizon runs through rows ${Math.floor(rows / 2) - 1}–${Math.floor(rows / 2)}.`,
  )
}

L.push('', 'Wider question ("what else could this have been?"): node coach/clues.mjs')
console.log(L.join('\n'))
