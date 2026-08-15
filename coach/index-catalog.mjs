/**
 * One-time catalog builder: LM's location lists carry no meta tags, but the
 * keyless per-pano endpoint does. This walks every location of a source map
 * and caches {location + metaName + country} to coach/catalog/<mapId>.json,
 * so deck composition never needs the network again.
 *
 * Run: node coach/index-catalog.mjs <geoguessrMapId> <name> <tier>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const [mapId, name, tier] = process.argv.slice(2)
if (!mapId) {
  console.error('usage: node coach/index-catalog.mjs <mapId> <name> <tier>')
  process.exit(1)
}

const { lmApiToken } = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'))

const res = await fetch(`https://learnablemeta.com/api/userscript/map/${mapId}/locations`, {
  headers: { Authorization: `Bearer ${lmApiToken}` },
})
if (!res.ok) {
  console.error(`locations fetch failed: ${res.status}`)
  process.exit(1)
}
const { customCoordinates } = await res.json()
console.log(`[index] ${name}: ${customCoordinates.length} locations to tag`)

// Resume support: re-running skips already-tagged panos.
const outPath = join(ROOT, 'catalog', `${mapId}.json`)
let tagged = {}
try {
  const prior = JSON.parse(await readFile(outPath, 'utf8'))
  for (const l of prior.locations) if (l.metaName) tagged[l.panoId] = l
} catch {}

const queue = customCoordinates.filter((l) => !tagged[l.panoId])
let done = 0
let failed = 0

// Gentle on their API: 6 in flight, tiny delay between waves.
const CONCURRENCY = 6
async function worker() {
  while (queue.length > 0) {
    const loc = queue.shift()
    try {
      const params = new URLSearchParams({
        panoId: loc.panoId,
        mapId,
        userscriptVersion: '1.0.0',
        source: 'map',
      })
      const r = await fetch(`https://learnablemeta.com/api/userscript/location?${params}`, {
        signal: AbortSignal.timeout(10000),
      })
      if (r.ok) {
        const meta = await r.json()
        tagged[loc.panoId] = { ...loc, metaName: meta.metaName ?? null, country: meta.country ?? null }
      } else {
        failed++
        tagged[loc.panoId] = { ...loc, metaName: null, country: null }
      }
    } catch {
      failed++
      queue.push(loc) // transient: retry at the back
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    done++
    if (done % 250 === 0) {
      console.log(`[index] ${done} tagged, ${queue.length} left`)
      await save()
    }
    await new Promise((r) => setTimeout(r, 60))
  }
}

async function save() {
  await mkdir(join(ROOT, 'catalog'), { recursive: true })
  const locations = Object.values(tagged)
  const metas = {}
  for (const l of locations) if (l.metaName) (metas[l.metaName] ??= 0), metas[l.metaName]++
  await writeFile(
    outPath,
    JSON.stringify({ mapId, name, tier: Number(tier ?? 1), indexedAt: new Date().toISOString(), locations }, null, 1),
  )
  return Object.keys(metas).length
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
const metaCount = await save()
console.log(`[index] ${name} complete: ${Object.keys(tagged).length} locations, ${metaCount} metas, ${failed} lookup failures`)
