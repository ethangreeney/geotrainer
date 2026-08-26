/**
 * The clue library must never make a tool call wait for its first download.
 *
 * That download is ~5 minutes (Plonk It serves ~25 guide pages a minute and no
 * pacing beats that), and a tool call silent for five minutes is indistinguish-
 * able from a hung server — clients give up first. So these tests run with
 * fetch stubbed to a promise that never settles: an implementation that waits
 * on the build deadlocks here instead of quietly shipping.
 *
 * GEOCOACH_HOME is set before the import so the cache is a temp dir, never the
 * developer's real one.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'geocoach-guides-'))
process.env.GEOCOACH_HOME = HOME
mkdirSync(join(HOME, 'guides'), { recursive: true })

const cache = (state) => writeFileSync(join(HOME, 'guides', 'guides.json'), JSON.stringify(state))
const fake = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    slug: `country-${from + i}`,
    title: `Country ${from + i}`,
    code: '',
    blocks: [{ step: 'Step 1', text: `A clue about country ${from + i}, long enough to survive.`, images: [], tags: ['bollard'] }],
  }))

let guides
beforeAll(async () => {
  globalThis.fetch = () => new Promise(() => {}) // never settles: a build that is awaited hangs
  guides = await import('./src/guides.mjs')
})

describe('a cold clue library', () => {
  it('reports how far along it is instead of blocking', async () => {
    cache({ guides: [], pending: fake(140).map((g) => g.slug) })
    await expect(guides.guides()).rejects.toThrow(/still downloading — 0 guides/)
    expect(await guides.status()).toMatchObject({ ready: false, have: 0, total: 140 })
  })

  it('says a country is not downloaded yet rather than not covered', async () => {
    const err = await guides.missing('Croatia')
    expect(err.message).toMatch(/still downloading/)
    expect(err.message).not.toMatch(/^No Plonk It guide/)
  })
})

describe('a partly built clue library', () => {
  it('answers from what has arrived', async () => {
    cache({ guides: fake(25), pending: fake(115, 25).map((g) => g.slug) })
    expect(await guides.guides()).toHaveLength(25)
    expect(await guides.status()).toMatchObject({ ready: false, have: 25, total: 140 })
  })

  it('does not memoise the partial set, so the next call sees more', async () => {
    cache({ guides: fake(40), pending: fake(100, 40).map((g) => g.slug) })
    expect(await guides.guides()).toHaveLength(40)
  })
})

describe('a finished clue library', () => {
  it('is ready, and a country it lacks is simply not covered', async () => {
    cache({ guides: fake(140), pending: [], built: '2026-01-01T00:00:00.000Z' })
    expect(await guides.guides()).toHaveLength(140)
    expect(await guides.status()).toMatchObject({ ready: true, have: 140 })
    expect((await guides.missing('Croatia')).message).toMatch(/^No Plonk It guide/)
  })
})
