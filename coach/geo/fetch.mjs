/**
 * Downloads the two Natural Earth sources the boundary slices are built from.
 *
 *   node coach/geo/fetch.mjs [--force]
 *   node coach/geo/build.mjs
 *
 * They are 52 MB together, so they are gitignored like the slices; this script
 * is what makes a fresh clone reproducible. Natural Earth is public domain and
 * the GeoJSON conversions are served straight off the project's own repository,
 * so there is no key, no account and no rate limit to respect — the only reason
 * to think about the network here is that 52 MB over a bad connection is worth
 * resuming rather than restarting, hence the retries and the skip-if-present.
 *
 * Pinned to a tag rather than master: an unannounced upstream reshuffle should
 * not quietly change which shape a round highlights. Moving to a newer release
 * is a one-line edit and a rebuild.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'src')
const RELEASE = 'v5.1.2'
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${RELEASE}/geojson`
const FILES = ['ne_10m_admin_0_countries.geojson', 'ne_10m_admin_1_states_provinces.geojson']
const force = process.argv.includes('--force')

const mb = (bytes) => (bytes / 1e6).toFixed(1) + ' MB'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sizeOf = async (path) => {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function download(name) {
  const path = join(SRC, name)
  const have = await sizeOf(path)
  if (have && !force) {
    console.log(`${name}: have it (${mb(have)}) — pass --force to replace`)
    return
  }
  // Written aside and moved into place, so an interrupted download can never
  // leave a truncated file that parses as far as it goes and then throws in
  // the middle of a build.
  const tmp = path + '.part'
  for (const backoff of [0, 2000, 10000]) {
    if (backoff) await sleep(backoff)
    try {
      const res = await fetch(`${BASE}/${name}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      await rename(tmp, path)
      console.log(`${name}: ${mb(await sizeOf(path))}`)
      return
    } catch (err) {
      await unlink(tmp).catch(() => {})
      console.warn(`${name}: ${err.message}`)
    }
  }
  throw new Error(`could not fetch ${name} from ${BASE}`)
}

await mkdir(SRC, { recursive: true })
for (const name of FILES) await download(name)
console.log('now run: node coach/geo/build.mjs')
