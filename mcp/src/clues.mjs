/**
 * Cross-country clue lookup — the "what else could this have been?" half.
 *
 * The dossier answers "what separates these two countries" because it knows
 * which two the round involved. This answers the open version by slicing all
 * ~140 guides along one clue type at a time, which is small enough to read in
 * full, and by putting two countries side by side on demand.
 *
 * --facts is the structured layer, and it exists because prose search cannot
 * answer "which countries drive left": the guides phrase it a hundred ways, and
 * Greece's "solid white double middle lines" is invisible to a search for
 * "double white". Those four axes are stated flat instead.
 */
import { Actionable } from './config.mjs'
import { aliases, glance, separators } from './coach.mjs'
import { countryFacts, flat, guideFor, guides, missing } from './guides.mjs'

const FACTS = ['drives', 'lines', 'script', 'tell']

const byCountryLines = (blocks, note) => {
  const grouped = new Map()
  for (const b of blocks) {
    if (!grouped.has(b.title)) grouped.set(b.title, [])
    grouped.get(b.title).push(b)
  }
  const out = [`${blocks.length} clues across ${grouped.size} countries${note ? ` — ${note}` : ''}`, '']
  for (const [country, list] of [...grouped].sort())
    for (const b of list) out.push(`${country} · ${b.text}`)
  return out.join('\n')
}

/** Every block in every guide, each carrying the country it came from. */
async function pool() {
  const all = await guides()
  return all.flatMap((g) => g.blocks.map((b) => ({ ...b, title: g.title, slug: g.slug, code: g.code })))
}

/** The tag list, with counts — the menu for every other query here. */
export async function tags() {
  const counts = new Map()
  for (const b of await pool()) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  const rows = [...counts].sort((a, b) => b[1] - a[1])
  return [
    `${rows.length} clue types across the Plonk It guides.`,
    '',
    ...rows.map(([t, n]) => `${t.padEnd(16)} ${String(n).padStart(5)}`),
  ].join('\n')
}

/** One clue type across every country, optionally narrowed by words. */
export async function byTag(tag, words = []) {
  const t = String(tag).toLowerCase()
  const all = await pool()
  const hit = all.filter((b) => b.tags.includes(t))
  if (!hit.length)
    throw new Actionable(
      `No clue type "${tag}". Call geocoach_clues with no arguments to see the ${
        new Set(all.flatMap((b) => b.tags)).size
      } that exist.`,
    )
  const terms = words.map(flat).filter(Boolean)
  return byCountryLines(
    hit.filter((b) => terms.every((w) => flat(b.text).includes(w))),
    terms.length ? `matching ${terms.map((w) => `"${w}"`).join(' + ')}` : null,
  )
}

/** Free text across every clue in every guide. */
export async function find(words) {
  const terms = words.map(flat).filter(Boolean)
  if (!terms.length) throw new Actionable('geocoach_clues needs something to search for.')
  return byCountryLines(
    (await pool()).filter((b) => terms.every((w) => flat(b.text).includes(w))),
    `matching ${terms.map((w) => `"${w}"`).join(' + ')}`,
  )
}

/** One country's whole guide, step by step. */
export async function country(which) {
  const g = await guideFor(which, which)
  if (!g) throw await missing(which)
  const facts = await countryFacts()
  const out = [`# ${g.title} (${g.code || g.slug}) — plonkit.net/${g.slug}`]
  const at = glance(facts[(g.code || '').toUpperCase()])
  if (at) out.push(at)
  let step = ''
  for (const b of g.blocks) {
    if (b.step !== step) out.push('', `## ${(step = b.step)}`, '')
    out.push(`· ${b.text}${b.tags.length ? `  [${b.tags.join(', ')}]` : ''}`)
  }
  return out.join('\n')
}

/**
 * What separates A from B: every clue in either guide that names the other,
 * with both countries' facts rows above it. This is the shape of the question a
 * player actually has after a miss.
 */
export async function differential(a, b) {
  const [ga, gb] = await Promise.all([guideFor(a, a), guideFor(b, b)])
  for (const [want, got] of [[a, ga], [b, gb]])
    if (!got) throw await missing(want)
  const facts = await countryFacts()
  const out = [`${ga.title} vs ${gb.title}`, '']
  for (const g of [ga, gb]) {
    const f = facts[(g.code || '').toUpperCase()]
    out.push(`${g.title}: ${f ? glance(f).replace(/^at a glance: /, '') : '(no facts row)'}`)
  }
  const sharp = separators(ga, ga.title, gb, gb.title)
  out.push('', `-- WHAT SEPARATES THEM (${sharp.length} clues name the other country)`, '')
  if (!sharp.length)
    out.push(
      'Neither guide mentions the other, which usually means they are not a common confusion.',
      `Compare their Step 1 clues instead: geocoach_clues(country: "${ga.code || ga.slug}").`,
    )
  for (const [blk, who] of sharp) out.push(`[${who}] ${blk.text}`)

  // A shared alias means one guide names the other in passing; a shared tag
  // means they can be told apart on that clue type, which is the useful axis.
  const shared = [...new Set(ga.blocks.flatMap((x) => x.tags))].filter((t) =>
    gb.blocks.some((x) => x.tags.includes(t)),
  )
  if (shared.length)
    out.push('', `Both guides cover: ${shared.sort().join(', ')} — ask for any of these by name.`)
  return out.join('\n')
}

/** The facts table: named rows side by side, or every row matching a filter. */
export async function factsTable({ countries = [], filters = {} } = {}) {
  const all = Object.entries(await countryFacts())
  if (!all.length)
    throw new Actionable('The country-facts table is missing from this install.')
  if (countries.length) {
    const out = []
    for (const want of countries) {
      const hit = all.find(([c, f]) => c === want.toUpperCase() || flat(f.name) === flat(want))
      if (!hit)
        throw new Actionable(
          `No facts for "${want}". Keys are ISO alpha-2 (MY, GR, PT-AZ) or the country name.`,
        )
      out.push(`${hit[0]}  ${hit[1].name}`)
      for (const k of FACTS) out.push(`  ${k.padEnd(6)}  ${hit[1][k] ?? ''}`)
      out.push('')
    }
    return out.join('\n')
  }
  const active = Object.entries(filters).filter(([, v]) => v)
  const bad = active.find(([k]) => !FACTS.includes(k))
  if (bad) throw new Actionable(`No facts field "${bad[0]}". Try ${FACTS.join(', ')}.`)
  const rows = all
    .filter(([, f]) => active.every(([k, v]) => flat(f[k] ?? '').includes(flat(v))))
    .map(([code, f]) => [`${code} ${f.name}`, ...FACTS.map((k) => f[k] ?? '')])
  const width = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? []
  const note = active.map(([k, v]) => `${k} ~ "${v}"`).join(' + ')
  return [
    `${rows.length} countries${note ? ` — ${note}` : ''}`,
    '',
    ...rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i]))).join(' | ')),
  ].join('\n')
}

export { aliases }
