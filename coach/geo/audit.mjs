/**
 * Checks the boundary layer against the two things it actually has to serve:
 * every scope in `coach/scope-regions.json`, and every country the rounds on
 * disk have actually been played in.
 *
 * Run: node coach/geo/audit.mjs [--quiet]
 *
 * It reads only built output, so it answers the question the test suite cannot:
 * not "is the code right" but "does this build cover the deck". A name that
 * resolves to nothing is invisible from the browser — the overlay silently
 * falls back to the whole country — so it has to be visible here. Exits
 * non-zero when a scope resolves to no shape at all, or when a country that has
 * come up in a real round has no slice; a scope that resolved but left a
 * spelling unmatched is reported and forgiven, since the shape drawn is still
 * the right one.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countryCode, countryShape, geoReady, regionShapes } from './resolve.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const COACH = join(HERE, '..')
const quiet = process.argv.includes('--quiet')

if (!geoReady()) {
  console.error('no slices built — run: node coach/geo/build.mjs')
  process.exit(2)
}

const scope = JSON.parse(readFileSync(join(COACH, 'scope-regions.json'), 'utf8'))
const problems = []
const notes = []
let full = 0
let partial = 0
let none = 0
let noCountry = 0

for (const [key, names] of Object.entries(scope)) {
  if (key.startsWith('_') || !Array.isArray(names)) continue
  const country = key.split(':')[0].trim()
  const code = countryCode(country)
  if (!code) {
    noCountry++
    problems.push(`NO COUNTRY  ${country}  <- ${key}`)
    continue
  }
  const { matched, missing } = regionShapes(code, names)
  if (!matched.length) {
    none++
    problems.push(`NONE     [${code}] ${key}\n         want: ${names.join(', ')}`)
  } else if (missing.length) {
    partial++
    notes.push(
      `PARTIAL  [${code}] ${key}\n         drew: ${matched.map((f) => f.name).join(', ')}` +
        `\n         no shape for: ${missing.join(', ')}`
    )
  } else full++
}

/* The other direction: Natural Earth's country file does not carry every place
   GeoGuessr will name. A gap only shows up as a round with no overlay, which
   nobody reports, so check the rounds already on disk. */
const ROUNDS = join(COACH, 'rounds')
const played = new Map()
if (existsSync(ROUNDS)) {
  for (const id of readdirSync(ROUNDS)) {
    const f = join(ROUNDS, id, 'dossier.json')
    if (!existsSync(f)) continue
    try {
      const { answer } = JSON.parse(readFileSync(f, 'utf8'))
      if (answer?.code && answer.code !== '??') played.set(answer.code, (played.get(answer.code) ?? 0) + 1)
    } catch {
      // a half-written dossier is the capture's problem, not the geometry's
    }
  }
}
const uncovered = [...played].filter(([code]) => !countryShape(code)).sort((a, b) => b[1] - a[1])
for (const [code, n] of uncovered) {
  const rounds = `played ${n} round${n === 1 ? '' : 's'}`
  // A country with subdivisions but no outline is a build fault: build.mjs is
  // supposed to dissolve the one into the other. A country Natural Earth does
  // not carry at either level is a gap in the source, and no amount of building
  // will close it — say so and move on.
  if (existsSync(join(HERE, 'admin1', code + '.json')))
    problems.push(`NO SHAPE for ${code} — ${rounds}, yet its subdivisions are on file: the dissolve should have covered it`)
  else notes.push(`ABSENT   ${code} — ${rounds}, and Natural Earth carries no boundary for it at any level`)
}

console.log(`scopes: full ${full} | partial ${partial} | none ${none} | unknown country ${noCountry}`)
console.log(`rounds: ${played.size} countries played, ${played.size - uncovered.length} with a boundary on file`)
if (notes.length && !quiet) console.log('\n' + notes.join('\n'))
if (problems.length) {
  console.error('\n' + problems.join('\n'))
  process.exit(1)
}
