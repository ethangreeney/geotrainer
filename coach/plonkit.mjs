/**
 * The offline Plonk It snapshot, parsed.
 *
 * A guide is a list of blocks; a block is one clue — its prose, the reference
 * images it cites, the Step it sits under, and the topic tags Plonk It gives it
 * (bollard, pole, landscape, …). Those tags are what make the corpus queryable
 * across countries rather than one guide at a time: see coach/clues.mjs.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLONKIT = join(dirname(fileURLToPath(import.meta.url)), 'plonkit')

/** Accent- and case-insensitive, so 'Quebec' finds 'Québec'. */
export const flat = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** ISO code (or country name) -> guide filename, via the snapshot's index. */
export async function slugFor(code, name) {
  const index = await readFile(join(PLONKIT, 'INDEX.md'), 'utf8')
  const row = index
    .split('\n')
    .find((l) => l.split('|')[2]?.trim() === code || l.split('|')[1]?.trim() === name)
  return row?.match(/\(([a-z0-9-]+)\.md\)/)?.[1] ?? null
}

export function parse(md, slug) {
  const title = md.match(/^# (.+?) \(/)?.[1] ?? slug
  let step = ''
  const blocks = []
  for (const raw of md.split(/\n\s*\n/)) {
    const head = raw.match(/^## (Step \d)/m)
    if (head) step = head[1]
    const images = [...raw.matchAll(/!\[\]\((img\/[^)]+)\)/g)].map((m) => m[1])
    const tags = (raw.match(/^_tags: *(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((t) => t.trim().replace(/_+$/, '').toLowerCase())
      .filter(Boolean)
    const text = raw
      .split('\n')
      .filter((l) => !/^(!\[|Example:|_tags:|>|#)/.test(l.trim()))
      .join(' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 40) blocks.push({ text, images, tags, step, slug, title })
  }
  return { slug, title, blocks }
}

export async function guide(code, name) {
  try {
    const slug = await slugFor(code, name)
    if (!slug) return null
    return parse(await readFile(join(PLONKIT, `${slug}.md`), 'utf8'), slug)
  } catch {
    return null
  }
}

/** Every guide in the snapshot. */
export async function guides() {
  const files = (await readdir(PLONKIT)).filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
  return Promise.all(
    files.sort().map(async (f) => parse(await readFile(join(PLONKIT, f), 'utf8'), f.slice(0, -3))),
  )
}
