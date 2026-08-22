/**
 * Cross-country clue lookup over the offline Plonk It snapshot.
 *
 *   node coach/clues.mjs                       # the tags, with clue counts
 *   node coach/clues.mjs bollard               # every bollard on earth
 *   node coach/clues.mjs bollard white black   # ...that are white and black
 *   node coach/clues.mjs --find "cyrillic"     # free text across every clue
 *   node coach/clues.mjs --country HR          # one country, every clue
 *   node coach/clues.mjs --facts               # the country-facts table
 *   node coach/clues.mjs --facts MY KH GR      # those rows, side by side
 *   node coach/clues.mjs --facts drives=left   # every field is filterable
 *
 * coach/brief.mjs answers "what separates these two countries" because it knows
 * which two the round involved. This answers the other question — "what else
 * could this have been?" — by slicing all 140 guides along one clue type at a
 * time, which is small enough to read in full (every bollard is ~9k tokens).
 *
 * --facts is the structured half. Prose search can't answer "which countries
 * drive left" or "who paints yellow outer lines", because the guides phrase it
 * a hundred ways — Greece says "solid white double middle lines", so --find
 * "double white" misses it. coach/facts.json states those four axes flat.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flat, guide, guides } from './plonkit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FACTS = ['drives', 'lines', 'script', 'tell']

const args = process.argv.slice(2)

if (args[0] === '--facts') {
  const facts = Object.entries(JSON.parse(await readFile(join(HERE, 'facts.json'), 'utf8')))
  const rest = args.slice(1)
  const named = rest.filter((a) => !a.includes('='))
  const filters = rest
    .filter((a) => a.includes('='))
    .map((a) => [a.slice(0, a.indexOf('=')).toLowerCase(), flat(a.slice(a.indexOf('=') + 1))])

  const unknown = filters.find(([k]) => k !== 'name' && !FACTS.includes(k))
  if (unknown) {
    console.error(`No facts field "${unknown[0]}". Try name, ${FACTS.join(', ')}.`)
    process.exit(1)
  }

  // Named countries print as records — the shape you can actually read side by side.
  if (named.length) {
    for (const want of named) {
      const hit = facts.find(([c, f]) => c === want.toUpperCase() || flat(f.name) === flat(want))
      if (!hit) {
        console.error(`No facts for "${want}". Keys are ISO alpha-2 (MY, GR, PT-AZ) or the name.`)
        process.exit(1)
      }
      console.log(`${hit[0]}  ${hit[1].name}`)
      for (const k of FACTS) console.log(`  ${k.padEnd(6)}  ${hit[1][k]}`)
      console.log('')
    }
    process.exit(0)
  }

  const rows = facts
    .filter(([, f]) => filters.every(([k, v]) => flat(f[k] ?? '').includes(v)))
    .map(([code, f]) => [`${code} ${f.name}`, ...FACTS.map((k) => f[k] ?? '')])
  const width = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? []
  const note = filters.map(([k, v]) => `${k} ~ "${v}"`).join(' + ')
  console.log(`${rows.length} countries${note ? ` — ${note}` : ''}\n`)
  for (const r of rows)
    console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i]))).join(' | '))
  process.exit(0)
}

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
  console.log('\nAlso --find <words…>, --country <code>, and the country-facts table:')
  console.log('  --facts | --facts MY KH GR | --facts drives=left lines=yellow')
  process.exit(0)
}

const pool = all.flatMap((g) => g.blocks).filter((b) => free || b.tags.includes(tag))
if (!free && !pool.length) {
  console.error(`No tag "${tag}". Run with no arguments to see the tags.`)
  process.exit(1)
}
const hits = pool.filter((b) => terms.every((t) => flat(b.text).includes(t)))
show(hits, terms.length ? `matching ${terms.map((t) => `"${t}"`).join(' + ')}` : null)
