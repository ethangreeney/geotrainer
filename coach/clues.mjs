/**
 * Cross-country clue lookup over the offline Plonk It snapshot.
 *
 *   node coach/clues.mjs                       # the tags, with clue counts
 *   node coach/clues.mjs bollard               # every bollard on earth
 *   node coach/clues.mjs bollard white black   # ...that are white and black
 *   node coach/clues.mjs --find "cyrillic"     # free text across every clue
 *   node coach/clues.mjs --country HR          # one country, every clue
 *
 * coach/brief.mjs answers "what separates these two countries" because it knows
 * which two the round involved. This answers the other question — "what else
 * could this have been?" — by slicing all 140 guides along one clue type at a
 * time, which is small enough to read in full (every bollard is ~9k tokens).
 */
import { flat, guide, guides } from './plonkit.mjs'

const args = process.argv.slice(2)
const all = await guides()

const show = (bs, note) => {
  const byCountry = new Map()
  for (const b of bs) {
    if (!byCountry.has(b.title)) byCountry.set(b.title, [])
    byCountry.get(b.title).push(b)
  }
  console.log(`${bs.length} clues across ${byCountry.size} countries${note ? ` — ${note}` : ''}\n`)
  for (const [country, list] of [...byCountry].sort())
    for (const b of list) console.log(`${country} · ${b.text}`)
}

if (args[0] === '--country') {
  const g = await guide(args[1]?.toUpperCase(), args[1])
  if (!g) {
    console.error(`No guide for ${args[1]}`)
    process.exit(1)
  }
  console.log(`# ${g.title} — coach/plonkit/${g.slug}.md\n`)
  let step = ''
  for (const b of g.blocks) {
    if (b.step !== step) console.log(`\n## ${(step = b.step)}\n`)
    console.log(`· ${b.text}${b.tags.length ? `  [${b.tags.join(', ')}]` : ''}`)
  }
  process.exit(0)
}

const free = args[0] === '--find'
const tag = free ? null : args[0]?.toLowerCase()
const terms = (free ? args.slice(1) : args.slice(1)).map(flat).filter(Boolean)

if (!tag && !free) {
  const counts = new Map()
  for (const g of all)
    for (const b of g.blocks) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  console.log('tag              clues   (node coach/clues.mjs <tag> [words…])\n')
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(`${t.padEnd(16)} ${String(n).padStart(5)}`)
  process.exit(0)
}

const pool = all.flatMap((g) => g.blocks).filter((b) => free || b.tags.includes(tag))
if (!free && !pool.length) {
  console.error(`No tag "${tag}". Run with no arguments to see the tags.`)
  process.exit(1)
}
const hits = pool.filter((b) => terms.every((t) => flat(b.text).includes(t)))
show(hits, terms.length ? `matching ${terms.map((t) => `"${t}"`).join(' + ')}` : null)
