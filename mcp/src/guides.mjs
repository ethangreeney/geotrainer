/**
 * The Plonk It country guides, as text, cached lazily on first use.
 *
 * coach/plonkit/ is a 324 MB snapshot — but 318 MB of that is reference PNGs
 * and only 2.1 MB is prose (632 KB gzipped). The prose is the part a language
 * model can actually use, so this keeps only that: every clue's text, its topic
 * tags, the Step it sits under, and the filenames of the images it cites, which
 * often name their subject more plainly than the prose does.
 *
 * It is fetched rather than bundled for two reasons. It is Plonk It's content,
 * not ours, and shipping it inside an npm package would be a rehost; and a
 * cache that builds itself on first run beats a package a stranger waits to
 * download. Guide pages ship their content as JSON in a __PRELOADED_DATA__
 * script, which is exactly what the site's own API points scrapers at:
 * /api/guides/<slug> answers 403 with "please do so from the guide pages
 * directly, by parsing the content of the script with id '__PRELOADED_DATA__'".
 *
 * It is fetched SERIALLY and slowly, and that is not laziness. Ten pages in
 * parallel gets nine 200s and then 429s for the rest of the run — a first
 * attempt at concurrency 4 silently lost 50 of 140 guides that way. Measured,
 * the site's budget is about 25 pages a minute: short bursts at 250 ms pass
 * cleanly, but a full 140-guide run settles to exactly 25 per 60 s however it
 * is paced. So there is no speed to win here, only 429s to avoid, and the gap
 * below is set to spend that budget evenly. The whole library is ~5 minutes and
 * ~1.5 MB, once per machine, and the server starts it in the background at boot
 * so those minutes overlap with the user opening a client. Round dossiers and
 * the profile do not wait for it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Actionable, GUIDES, PKG } from './config.mjs'

const SITE = 'https://www.plonkit.net'
// Cloudflare passes ordinary browser user agents; the default node UA gets a 403.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const GAP = 2400 // ms between page fetches — the site's ~25/min budget, spent evenly
const THROTTLED = 15000 // ms to stand down for after a 429
const FLUSH = 10 // write the cache every N guides, so a killed build is not lost

const cacheFile = () => join(GUIDES, 'guides.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Accent- and case-insensitive, so 'Quebec' finds 'Québec'. */
export const flat = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

async function get(url) {
  for (const wait of [0, 2000, THROTTLED, THROTTLED * 2]) {
    if (wait) await sleep(wait)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (res.ok) return res.text()
      if (res.status !== 429 && res.status < 500) return null // a 404 will not improve
    } catch {
      // network hiccup: fall through to the next backoff
    }
  }
  return null
}

/** One line of guide prose, with the markdown stripped back out of it. */
const clean = (s) =>
  String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A guide page's preloaded JSON, reduced to clue blocks.
 *
 * A block is one clue: its prose, the images it cites, the Step it sits under,
 * and Plonk It's own topic tags — and it is the tags that make the corpus
 * queryable across countries rather than one guide at a time. Anything under 40
 * characters is page furniture, not a clue.
 */
export function distil(guide) {
  const blocks = []
  const name = (url) => (url?.startsWith('/images/') ? url.split('/').pop() : null)
  const push = (step, text, images = [], tags = []) => {
    const t = clean(text)
    if (t.length > 40) blocks.push({ step, text: t, images, tags })
  }
  ;(guide.steps ?? []).forEach((step, i) => {
    const label = `Step ${i + 1}`
    for (const para of step.text ?? []) push(label, para)
    for (const item of step.items ?? []) {
      if (item.kind === 'tip') {
        const { image, text } = item.data ?? {}
        push(
          label,
          (text ?? []).join(' '),
          [name(image?.imageUrl)].filter(Boolean),
          (item.tags ?? [])
            .map((t) => String(t).trim().replace(/_+$/, '').toLowerCase())
            .filter(Boolean),
        )
      } else if (['text', 'centeredText', 'notes'].includes(item.kind)) {
        push(label, (Array.isArray(item.text) ? item.text : [item.text]).filter(Boolean).join(' '))
      } else if (item.kind === 'centeredImageWithCaption') {
        push(label, item.text, [name(item.image?.imageUrl)].filter(Boolean))
      }
    }
  })
  return { slug: guide.slug, title: guide.title, code: guide.code || '', blocks }
}

function extract(html, slug) {
  const m = html?.match(/<script[^>]*id="__PRELOADED_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  const guide = m && JSON.parse(m[1])?.data?.public
  return guide?.steps ? distil({ ...guide, slug }) : null
}

const read = () => readFile(cacheFile(), 'utf8').then(JSON.parse).catch(() => null)

const write = (state) =>
  mkdir(GUIDES, { recursive: true }).then(() => writeFile(cacheFile(), JSON.stringify(state)))

/**
 * Fill the cache, resuming whatever a previous run finished. `pending` is the
 * part of the slug list still unfetched; an interrupted build leaves it on disk
 * and the next one picks up there rather than starting the five minutes again.
 */
export async function build(onProgress = () => {}) {
  const state = (await read()) ?? { guides: [], pending: null }
  if (!state.pending?.length) {
    const index = JSON.parse((await get(`${SITE}/api/guides`)) ?? 'null')
    const slugs = (index?.data ?? []).map((g) => g.slug)
    if (!slugs.length)
      throw new Actionable(
        'Plonk It would not list its guides, so the clue library cannot be built.\n' +
          'The clue tools need it; round dossiers and the profile work without it. Try again shortly.',
      )
    const have = new Set(state.guides.map((g) => g.slug))
    state.pending = slugs.filter((s) => !have.has(s))
  }
  const total = state.guides.length + state.pending.length

  while (state.pending.length) {
    const slug = state.pending[0]
    const guide = extract(await get(`${SITE}/${slug}`), slug)
    // A guide that will not parse is dropped rather than retried forever; one
    // missing country is not worth losing the other 139.
    if (guide) state.guides.push(guide)
    state.pending.shift()
    onProgress(state.guides.length, total)
    if (state.guides.length % FLUSH === 0) await write(state)
    if (state.pending.length) await sleep(GAP)
  }
  state.guides.sort((a, b) => a.slug.localeCompare(b.slug))
  state.built = new Date().toISOString()
  await write(state)
  return state.guides
}

let running = null
let memo = null

/** Kick the cache off in the background, so the ~5 minutes overlaps with the
 *  user reading their first round rather than blocking on it. Never throws:
 *  a failed warm-up just means the first clue call builds it itself. */
export function warm() {
  if (running) return running
  running = (async () => {
    const disk = await read()
    if (disk?.guides?.length && !disk.pending?.length) return (memo = disk.guides)
    const at = Date.now()
    const out = await build((n, t) => {
      if (n % 25 === 0) console.error(`[geocoach] clue library ${n}/${t} (${((Date.now() - at) / 1000) | 0}s)`)
    })
    console.error(`[geocoach] clue library ready: ${out.length} guides`)
    return (memo = out)
  })().catch((err) => {
    console.error('[geocoach] clue library warm-up failed:', err.message)
    running = null
    return null
  })
  return running
}

/**
 * Every guide available right now. This NEVER waits for the first build.
 *
 * The build is ~5 minutes, and a tool call that sits silent for five minutes is
 * indistinguishable from a broken server — most clients give up long before it
 * returns. So a partial library is served as soon as it is worth reading, and a
 * cold one reports how far along it is instead of hanging. Callers ask status()
 * to say so in the answer.
 */
const PARTIAL_OK = 20 // guides — below this the cross-country slices read as gaps, not answers

export async function guides() {
  if (memo) return memo
  warm() // deliberately not awaited: make sure it is running, then answer with what exists
  const disk = await read()
  if (disk?.guides?.length && !disk.pending?.length) return (memo = disk.guides)
  // Not memoised: the build is still filling it, and the next call should see more.
  if (disk?.guides?.length >= PARTIAL_OK) return disk.guides
  const have = disk?.guides?.length ?? 0
  throw new Actionable(
    `The Plonk It clue library is still downloading — ${have} guides so far.\n` +
      'It takes about five minutes on the first run of a machine, once, and it is running now.\n' +
      'Round dossiers and the profile do not need it and work already. Ask again in a minute.',
  )
}

/** How far the first build has got, for callers that want to caveat an answer. */
export async function status() {
  if (memo) return { ready: true, have: memo.length, total: memo.length }
  const disk = await read()
  const have = disk?.guides?.length ?? 0
  const pending = disk?.pending?.length ?? 0
  return { ready: !!have && !pending, have, total: have + pending }
}

/** The message for a country the library does not have — which, while the
 *  library is still filling, is a different fact from the country not existing. */
export async function missing(which) {
  const { ready, have, total } = await status()
  return new Actionable(
    ready
      ? `No Plonk It guide for "${which}". Use an ISO alpha-2 code (HR, MY) or the country name.`
      : `No guide for "${which}" yet — the clue library is still downloading (${have} of ${total}).\n` +
          'Either the name is wrong (use an ISO alpha-2 code like HR, or the country name), or ' +
          'that guide has not arrived yet. Ask again in a minute.',
  )
}

/** Whatever is cached right now, without waiting. Null while it is still cold —
 *  a dossier is worth returning with its imagery and its numbers even when the
 *  clue library has not finished its first build. */
export async function guidesIfReady() {
  if (memo) return memo
  const disk = await read()
  return disk?.guides?.length && !disk.pending?.length ? (memo = disk.guides) : null
}

const match = (all, code, name) => {
  const want = flat(String(name ?? '').replace(/ \(the\)$/, ''))
  return (
    all.find((g) => g.code && g.code.toUpperCase() === String(code ?? '').toUpperCase()) ??
    all.find((g) => flat(g.title) === want || g.slug === want.replace(/\s+/g, '-')) ??
    null
  )
}

/** ISO code or country name -> one guide, or null. */
export async function guideFor(code, name) {
  if (!code && !name) return null
  return match(await guides(), code, name)
}

/** The same, but never waits on a cold cache. */
export async function guideIfReady(code, name) {
  const all = await guidesIfReady()
  return all && (code || name) ? match(all, code, name) : null
}

/** The country-facts table: driving side, line colours, script, killer tell.
 *  Prose search cannot answer "who paints yellow outer lines" — Greece says
 *  "solid white double middle lines" and no phrasing catches every guide — so
 *  these four axes are stated flat. The repo's copy wins when there is one, so
 *  an edit to coach/facts.json shows up here without a re-copy. */
let facts = null
export async function countryFacts() {
  if (facts) return facts
  for (const p of [join(PKG, '..', 'coach', 'facts.json'), join(PKG, 'data', 'facts.json')]) {
    const hit = await readFile(p, 'utf8').then(JSON.parse).catch(() => null)
    if (hit) return (facts = hit)
  }
  return (facts = {})
}
