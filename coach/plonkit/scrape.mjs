/**
 * Snapshots the Plonk It country guides into offline markdown + images.
 *
 * Each guide page ships its full content as JSON in a <script id="__PRELOADED_DATA__">
 * tag — the site's own guides API points scrapers at exactly this ("please do so
 * from the guide pages directly, by parsing the content of the script with id
 * '__PRELOADED_DATA__'"). We fetch the slug list from /api/guides, parse that
 * script per guide, and write:
 *
 *   coach/plonkit/<slug>.md        readable guide, local image paths inline
 *   coach/plonkit/img/<slug>/      images at the site's own 900px/q80 resize
 *   coach/plonkit/raw/<slug>.json  the parsed guide object, for re-rendering
 *   coach/plonkit/INDEX.md         title/code/slug lookup table
 *
 * Usage: node coach/plonkit/scrape.mjs [slug ...]   (no args = every guide)
 * Re-runs are cheap: markdown is rewritten, existing images are skipped.
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SITE = 'https://www.plonkit.net'
// Cloudflare passes ordinary browser user agents; the default node UA gets a 403.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const IMG_WIDTH = 900
const IMG_QUALITY = 80
const PAGE_DELAY_MS = 250
const IMG_CONCURRENCY = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, as = 'text') {
  for (const backoff of [0, 1000, 5000, 15000]) {
    if (backoff) await sleep(backoff)
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) continue
      return as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : await res.text()
    } catch {
      // network hiccup: fall through to the next backoff
    }
  }
  throw new Error(`gave up on ${url}`)
}

function extractGuide(html) {
  const m = html.match(/<script[^>]*id="__PRELOADED_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no __PRELOADED_DATA__ script in page')
  const parsed = JSON.parse(m[1])
  const guide = parsed?.data?.public
  if (!guide?.steps) throw new Error('preloaded data has no guide steps')
  return guide
}

/** /images/foo/bar.png -> the site's resizer URL for it. */
const resizeUrl = (imageUrl) =>
  `${SITE}/images/resize/${IMG_WIDTH}/${IMG_QUALITY}${imageUrl.replace(/^\/images/, '')}`

const localImageName = (imageUrl) => imageUrl.split('/').pop()

/**
 * Collects every image an item references and returns the markdown for it.
 * Unknown kinds render as a visible placeholder so nothing vanishes silently.
 */
function renderItem(item, slug, images, unknownKinds) {
  const lines = []
  const pushImage = (imageUrl) => {
    if (!imageUrl || !imageUrl.startsWith('/images/')) return null
    images.add(imageUrl)
    return `img/${slug}/${localImageName(imageUrl)}`
  }

  if (item.kind === 'divider' || item.kind === 'subsection') {
    lines.push(`### ${item.title || '—'}`)
  } else if (item.kind === 'centeredImage') {
    const local = pushImage(item.imageUrl)
    if (local) lines.push(`![](${local})`)
  } else if (item.kind === 'centeredImageWithCaption') {
    const local = pushImage(item.image?.imageUrl)
    if (local) lines.push(`![](${local})`)
    if (item.text) lines.push(`_${item.text}_`)
  } else if (item.kind === 'centeredText' || item.kind === 'notes' || item.kind === 'text') {
    const text = Array.isArray(item.text) ? item.text : [item.text]
    for (const para of text) if (para) lines.push(para)
  } else if (item.kind === 'centeredVideoWithCaption') {
    // videos stay remote: note what it shows and where it lives
    if (item.text) lines.push(`_Video: ${item.text}_ (<${SITE}${item.video?.videoSrc ?? ''}>)`)
  } else if (item.kind === 'navButtons') {
    // in-page navigation chrome, nothing to keep
  } else if (item.kind === 'tip') {
    const { image, text } = item.data ?? {}
    for (const para of text ?? []) lines.push(para)
    const local = pushImage(image?.imageUrl)
    if (local) lines.push(`![](${local})`)
    const link = image?.imageLink
    if (link && /^https?:\/\//.test(link)) lines.push(`Example: <${link}>`)
    if (item.tags?.length) lines.push(`_tags: ${item.tags.join(', ')}_`)
  } else {
    unknownKinds.add(item.kind)
    lines.push(`<!-- unrendered item kind: ${item.kind} -->`)
  }
  return lines
}

function renderGuide(guide, images, unknownKinds) {
  const out = []
  out.push(`# ${guide.title} (${guide.code || guide.slug})`)
  out.push('')
  out.push(`> Offline snapshot of ${SITE}/${guide.slug} (guide updated ${(guide.updatedAt || '').slice(0, 10)}).`)
  out.push(`> Full-res originals: ${SITE}/images/<slug>/<file> — local copies are ${IMG_WIDTH}px.`)
  for (const note of guide.headerNotes ?? []) {
    out.push(`> ${typeof note === 'string' ? note : JSON.stringify(note)}`)
  }
  guide.steps.forEach((step, i) => {
    out.push('')
    out.push(`## Step ${i + 1} — ${step.title}`)
    for (const para of step.text ?? []) {
      out.push('')
      out.push(para)
    }
    for (const item of step.items ?? []) {
      const lines = renderItem(item, guide.slug, images, unknownKinds)
      if (lines.length) out.push('', ...lines)
    }
  })
  out.push('')
  return out.join('\n')
}

async function exists(path) {
  const s = await stat(path).catch(() => null)
  return Boolean(s && s.size > 0)
}

async function downloadImages(images, slug, counters) {
  const dir = join(ROOT, 'img', slug)
  await mkdir(dir, { recursive: true })
  const queue = [...images]
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const dest = join(dir, localImageName(url))
      if (await exists(dest)) {
        counters.skipped += 1
        continue
      }
      try {
        await writeFile(dest, await get(resizeUrl(url), 'bytes'))
        counters.downloaded += 1
      } catch {
        counters.failed.push(url)
      }
      await sleep(100)
    }
  }
  await Promise.all(Array.from({ length: IMG_CONCURRENCY }, worker))
}

async function main() {
  const wanted = process.argv.slice(2)
  const index = JSON.parse(await get(`${SITE}/api/guides`))
  const all = index.data.map((g) => g.slug)
  const slugs = wanted.length ? wanted : all
  console.log(`snapshotting ${slugs.length} of ${all.length} guides`)

  await mkdir(join(ROOT, 'raw'), { recursive: true })
  const unknownKinds = new Set()
  const failedPages = []
  const counters = { downloaded: 0, skipped: 0, failed: [] }
  const done = []

  for (const slug of slugs) {
    try {
      const guide = extractGuide(await get(`${SITE}/${slug}`))
      const images = new Set()
      const md = renderGuide(guide, images, unknownKinds)
      await writeFile(join(ROOT, 'raw', `${slug}.json`), JSON.stringify(guide, null, 1))
      await writeFile(join(ROOT, `${slug}.md`), md)
      await downloadImages(images, slug, counters)
      done.push(guide)
      console.log(`${slug}: ${images.size} images (${done.length}/${slugs.length})`)
    } catch (err) {
      failedPages.push(slug)
      console.error(`${slug}: FAILED — ${err.message}`)
    }
    await sleep(PAGE_DELAY_MS)
  }

  // Only rewrite the index on a full run, so partial re-scrapes can't shrink it.
  if (!wanted.length) {
    const rows = done
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((g) => `| ${g.title} | ${g.code || ''} | [${g.slug}.md](${g.slug}.md) |`)
    await writeFile(
      join(ROOT, 'INDEX.md'),
      [
        '# Plonk It offline snapshot',
        '',
        `Scraped from ${SITE} — regenerate with \`node coach/plonkit/scrape.mjs\`.`,
        '',
        '| Country | Code | Guide |',
        '|---|---|---|',
        ...rows,
        '',
      ].join('\n'),
    )
  }

  console.log(
    `done: ${done.length} guides, images ${counters.downloaded} new / ${counters.skipped} kept, ` +
      `${counters.failed.length} image failures, ${failedPages.length} page failures`,
  )
  if (unknownKinds.size) console.log('unrendered item kinds:', [...unknownKinds].join(', '))
  if (failedPages.length) console.log('failed pages:', failedPages.join(', '))
  if (counters.failed.length) console.log('failed images:', counters.failed.slice(0, 20).join(', '))
}

await main()
