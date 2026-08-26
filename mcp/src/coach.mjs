/**
 * The coaching text: what a round was, how the player's record reads, and which
 * clues actually separate the country from the one they guessed.
 *
 * This is coach/brief.mjs's analysis, unchanged in substance — the same country
 * -level grading, the same direction-specific confusions, the same "any clue in
 * either guide that names the other country" rule for the differential. What
 * changed is the output: the CLI prints paths and tells a human to open them,
 * while here the imagery travels with the text as MCP image blocks, so the
 * words never have to describe a picture the reader cannot see.
 */
import { compass16 } from './tiles.mjs'
import { countryFacts, flat, guideIfReady, guidesIfReady } from './guides.mjs'

export const km = (n) => (n == null ? '?' : n >= 100 ? String(Math.round(n)) : n.toFixed(1))
export const place = (p) => [p?.locality, p?.region, p?.name].filter(Boolean).join(', ') || 'unknown'
const plain = (n) => String(n ?? '').replace(/ \(the\)$/, '')

export function bearing(a, b) {
  if (!a?.lat || !b?.lat) return null
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

/**
 * Right at country level. The dashboard's own `correct` is stricter than the
 * country — it fails a 250 km miss inside Japan — and country is the unit
 * coaching works in, so read the names instead where they exist.
 */
export const right = (x) =>
  x.country && x.guessCountry ? x.country === x.guessCountry : Boolean(x.correct)

export const rate = (rs) => {
  const n = rs.filter(right).length
  return `${n}/${rs.length}` + (rs.length ? ` (${Math.round((100 * n) / rs.length)}%)` : '')
}

/**
 * Direction-specific confusions: calling Malaysia Cambodia is not the same
 * mistake as calling Cambodia Malaysia, and only one of them is yours.
 * A round that timed out has no guess country and confuses nothing.
 */
export function confusions(rounds) {
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

const said = (c) => `${plain(c.country)} '${plain(c.guess)}'`

/**
 * Elevation across ~2 km around a point: the number behind "this looked hilly".
 * Open-Meteo, free, no key. Silent on failure — it is a nicety, not the point,
 * and it is the only network call here that is not Google's or the user's own.
 */
export async function terrain(pt) {
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
export function forMeta(g, metaName) {
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
export function aliases(g, name) {
  const out = new Set([g?.title, plain(name)].filter(Boolean))
  for (const n of [...out]) {
    if (n.startsWith('United States')) out.add('the US').add('the U.S.')
    if (n.startsWith('United Kingdom')) out.add('the UK')
    const short = n.replace(/^(the )?(Republic|Kingdom) of /i, '')
    if (short !== n) out.add(short)
  }
  return [...out]
}

/** The clues that actually decide between two countries: any clue in either
 *  guide that names the other one. Everything else is background. */
export function separators(a, aName, b, bName) {
  if (!a || !b) return []
  const hits = (g, other) => g.blocks.filter((x) => other.some((n) => x.text.includes(n)))
  return [
    ...hits(a, aliases(b, bName)).map((x) => [x, a.title]),
    ...hits(b, aliases(a, aName)).map((x) => [x, b.title]),
  ]
}

export const glance = (f) =>
  f &&
  'at a glance: ' +
    [
      f.drives && `drives on the ${f.drives}`,
      f.lines && `lines: ${f.lines}`,
      f.script && `script: ${f.script}`,
      f.tell && `tell: ${f.tell}`,
    ]
      .filter(Boolean)
      .join(' · ')

/* -------------------------------------------------------------- the round */

const L = () => {
  const lines = []
  return {
    lines,
    push: (...s) => lines.push(...s),
    rule: (t) => lines.push('', `-- ${t} ` + '-'.repeat(Math.max(2, 76 - t.length))),
    text: () => lines.join('\n'),
  }
}

const clue = (out, b, tag) => out.push(`· ${tag ? `[${tag}] ` : ''}${b.text}`)

/**
 * The dossier as prose. `past` is the player's other rounds; `views` names the
 * images travelling alongside, so the text can point at them by name.
 */
export async function dossierText(r, past, views, note) {
  const out = L()
  const missed = Boolean(r.guess?.code) && r.guess.code !== r.answer?.code
  const facts = await countryFacts()
  // The clue library takes about five minutes to cache on the very first run
  // (Plonk It allows ~25 pages a minute; see guides.mjs).
  // A dossier is worth having without it — the imagery, the location and the
  // player's record are all local — so it is read only if it is already there,
  // and its absence is stated rather than waited out.
  const [aG, gG, hi, lo] = await Promise.all([
    guideIfReady(r.answer?.code, r.answer?.name).catch(() => null),
    missed ? guideIfReady(r.guess.code, r.guess.name).catch(() => null) : null,
    terrain(r.answer),
    terrain(r.guess),
  ])
  const cold = !(await guidesIfReady())
  const seen = past.filter((x) => x.id !== r.id)
  const record = (name) => {
    const s = seen.filter((x) => x.country === name)
    return s.length ? `${s.filter(right).length}/${s.length}` : 'first time'
  }

  out.push(
    `ROUND ${r.id}   ${String(r.ts).replace('T', ' ').slice(0, 16)}Z   ${r.mode ?? '?'} r${r.roundNumber ?? '?'}`,
  )
  const dir = bearing(r.answer, r.guess)
  out.push(
    `${r.correctCountry ? 'RIGHT COUNTRY' : 'WRONG COUNTRY'}   ${km(r.distanceKm)} km off   ` +
      `${r.score ?? '?'} pts` + (dir ? `   (you clicked ${dir} of the true spot)` : ''),
  )

  const last50 = seen.slice(0, 50)
  const standing = confusions(seen).filter((c) => c.n >= 2).slice(0, 3)
  out.rule('YOUR PATTERNS')
  out.push(
    last50.length
      ? `country right in ${rate(last50)} of your last ${last50.length} rounds`
      : 'no other rounds yet — this is the first',
  )
  if (standing.length) out.push('you call ' + standing.map((c) => `${said(c)} ${c.n}x`).join(' - '))

  out.rule('WHERE IT WAS')
  out.push(`${place(r.answer)}   ${r.answer?.lat?.toFixed(5)}, ${r.answer?.lng?.toFixed(5)}`)
  if (hi) out.push(hi)
  out.push(`your record on ${r.answer?.name}: ${record(r.answer?.name)}`)

  out.rule('WHERE YOU CLICKED')
  if (!r.guess) out.push('no guess recorded')
  else {
    out.push(`${place(r.guess)}   ${r.guess.lat.toFixed(5)}, ${r.guess.lng.toFixed(5)}`)
    if (lo) out.push(lo)
    if (missed) out.push(`your record on ${r.guess.name}: ${record(r.guess.name)}`)
  }
  const pairs = seen.filter(
    (x) =>
      (x.country === r.answer?.name && x.guessCountry === r.guess?.name) ||
      (x.country === r.guess?.name && x.guessCountry === r.answer?.name),
  )
  if (pairs.length)
    out.push(
      `this pair has come up ${pairs.length}× before: ` +
        pairs.slice(0, 5).map((x) => `${x.ts.slice(0, 10)} ${km(x.distanceKm)} km`).join(', '),
    )

  const metaBlocks = forMeta(aG, r.metaName)
  out.rule(r.metaName ? `THE INTENDED CLUE — ${r.metaName}` : 'THE INTENDED CLUE')
  if (!r.metaName) out.push('none: this map has no single intended clue for the round')
  else if (!aG && !cold)
    out.push(`(Plonk It has no guide for ${r.answer?.name ?? 'this country'})`)
  else if (!metaBlocks.length && !cold)
    out.push('(no matching Plonk It entry — the meta is Learnable Meta’s own)')
  metaBlocks.forEach((b) => clue(out, b, b.step))
  if (r.lm?.note) out.push(`note: ${r.lm.note.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`)

  if (missed && aG && gG) {
    const sharp = separators(aG, r.answer?.name, gG, r.guess?.name)
    out.rule(`${aG.title.toUpperCase()} vs ${gG.title.toUpperCase()} — WHAT SEPARATES THEM`)
    if (!sharp.length) out.push('(neither guide mentions the other — see the clues below)')
    sharp.slice(0, 14).forEach(([b, who]) => clue(out, b, who))
    if (sharp.length > 14)
      out.push(`… ${sharp.length - 14} more via geocoach_clues(country: "${aG.code || aG.slug}")`)
  }

  for (const [g, side] of [[aG, r.answer], [missed ? gG : null, r.guess]]) {
    if (!g) continue
    const step1 = g.blocks.filter((b) => b.step === 'Step 1')
    const cap = missed ? 10 : 18
    out.rule(`${g.title.toUpperCase()} — HOW TO SPOT IT`)
    const at = glance(facts[side?.code?.toUpperCase()])
    if (at) out.push(at)
    step1.slice(0, cap).forEach((b) => clue(out, b))
    if (step1.length > cap)
      out.push(`… ${step1.length - cap} more via geocoach_clues(country: "${g.code || g.slug}")`)
  }

  out.rule('IMAGERY')
  if (note) out.push(note)
  if (!views.length) out.push('no imagery: see the note above')
  else {
    out.push(
      views.map((v) => v.label).join(', ') +
        ' — attached below, in that order. 100° each, photograph geometry;',
      'front is the way the camera car faced. These are what a player actually sees.',
    )
    out.push(
      `close-up: geocoach_look(round: "${r.id}", yaw: <0-359 or a compass point>, fov: <degrees>)` +
        ' — fov below 45 fetches sharper zoom-5 imagery for that sector alone.',
    )
  }
  out.push(
    '',
    cold
      ? 'The Plonk It clue library is still caching (first run, about five minutes), so the clue\n' +
        'sections above are missing. Everything else here is complete. Ask again shortly, or\n' +
        'call geocoach_clues — it will wait for the cache and then answer.'
      : 'Wider question ("what else could this have been?"): geocoach_clues.',
  )
  return out.text()
}

/* ------------------------------------------------------------ the profile */

export function profileText(all) {
  const out = L()
  const since = (days) => {
    const t = new Date(Date.now() - days * 864e5).toISOString()
    return all.filter((x) => x.ts >= t)
  }
  out.push(
    `GEOCOACH PROFILE   ${all.length} rounds` +
      (all.length ? `   ${all.at(-1).ts.slice(0, 10)} → ${all[0].ts.slice(0, 10)}` : ''),
  )

  out.rule('COUNTRY HIT RATE')
  for (const [label, rs] of [
    ['last 7 days', since(7)],
    ['last 30 days', since(30)],
    ['all time', all],
  ])
    out.push(`${label.padEnd(14)}${rs.length ? rate(rs) : '—'}`)

  const conf = confusions(all).filter((c) => c.n >= 2)
  out.rule('STANDING CONFUSIONS')
  if (!conf.length) out.push('none repeated — no country has fooled you the same way twice')
  for (const c of conf.slice(0, 10))
    out.push(`you call ${said(c).padEnd(44)}${String(c.n).padStart(3)}×   last ${c.last.slice(0, 10)}`)

  const byCountry = new Map()
  for (const x of all) {
    if (!x.country) continue
    byCountry.set(x.country, [...(byCountry.get(x.country) ?? []), x])
  }
  const worst = [...byCountry]
    .filter(([, rs]) => rs.length >= 3)
    .map(([name, rs]) => [name, rs, rs.filter(right).length / rs.length])
    .sort((a, b) => a[2] - b[2] || b[1].length - a[1].length)
  out.rule('WORST COUNTRIES (3+ rounds)')
  if (!worst.length) out.push('no country played three times yet')
  for (const [name, rs] of worst.slice(0, 5)) out.push(`${name.padEnd(30)}${rate(rs)}`)

  const recentMiss = all.find((x) => !right(x) && x.country)
  out.push(
    '',
    recentMiss
      ? `Work one of these: geocoach_round_dossier(round: "${recentMiss.id}") replays the most recent miss.`
      : 'No misses on record to work from.',
  )
  return out.text()
}

/** Which way a view faces, given the pano's compass heading. */
export const facing = (deg, i) => (deg == null ? '' : ` (faces ${compass16(deg + i * 90)})`)
