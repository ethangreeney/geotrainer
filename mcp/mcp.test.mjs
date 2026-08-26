import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Actionable, token } from './src/config.mjs'
import * as cloud from './src/cloud.mjs'
import { Sphere, encodeJpeg, renderView } from './src/imagery.mjs'
import { distil, flat } from './src/guides.mjs'
import { aliases, confusions, forMeta, profileText, rate, right, separators } from './src/coach.mjs'
import { factsTable } from './src/clues.mjs'
import { compass16, compassDeg } from './src/tiles.mjs'
import { sectorFor } from './src/views.mjs'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------ the empty states */

describe('the not-set-up cases', () => {
  it('names the place to get a token when there is none', () => {
    vi.stubEnv('GEOCOACH_TOKEN', '')
    vi.stubEnv('GEOCOACH_CONFIG', '/nowhere/config.json') // not on the author's own laptop
    expect(() => token()).toThrow(Actionable)
    expect(() => token()).toThrow(/geofsrs\.pages\.dev/)
    expect(() => token()).toThrow(/GEOCOACH_TOKEN/)
  })

  it('reads the token from the environment, trimmed', () => {
    vi.stubEnv('GEOCOACH_TOKEN', '  abc123  ')
    expect(token()).toBe('abc123')
  })

  // The point of the file is that the secret never has to be pasted into an MCP
  // config or a command line, where it would outlive the setup in a dotfile
  // backup and show up in every ps listing of the running server.
  it('reads the token from a file when one is named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gc-token-'))
    const file = join(dir, 'token')
    await writeFile(file, 'from-a-file\n')
    vi.stubEnv('GEOCOACH_TOKEN', '')
    vi.stubEnv('GEOCOACH_TOKEN_FILE', file)
    expect(token()).toBe('from-a-file')
  })

  it('says which file it could not read rather than falling through', () => {
    vi.stubEnv('GEOCOACH_TOKEN', '')
    vi.stubEnv('GEOCOACH_TOKEN_FILE', '/nowhere/token')
    expect(() => token()).toThrow(/nowhere\/token/)
  })

  // A missing token used to surface as "network error": token() throws from
  // inside the same try that wraps fetch, and the catch relabelled it.
  it('does not disguise a missing token as a network failure', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', '')
    vi.stubEnv('GEOCOACH_CONFIG', '/nowhere/config.json')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should never be called') }))
    await expect(cloud.history()).rejects.toThrow(/Sign in at|No GeoCoach token/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reads a rejected token as a token problem, with the fix', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'wrong')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await expect(cloud.history()).rejects.toThrow(/rejected the token/)
    await expect(cloud.history()).rejects.toThrow(/geofsrs\.pages\.dev/)
  })

  it('tells an account with no rounds how to capture one', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'ok')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rounds: [] })))
    await expect(cloud.recent(1)).rejects.toThrow(/no rounds/i)
    await expect(cloud.recent(1)).rejects.toThrow(/userscript/)
  })

  it('sends the token as a bearer and never in the URL', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'secret-token')
    const spy = vi.fn(async () => Response.json({ rounds: [{ id: 'a' }] }))
    vi.stubGlobal('fetch', spy)
    await cloud.history()
    const [url, init] = spy.mock.calls[0]
    expect(url).not.toContain('secret-token')
    expect(init.headers.Authorization).toBe('Bearer secret-token')
  })
})

/* ------------------------------------------------------------- round selection */

describe('resolve', () => {
  const rounds = [{ id: 'newest' }, { id: 'second' }, { id: 'third' }]

  it('takes a bare index as "nth most recent"', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'ok')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rounds })))
    expect((await cloud.resolve()).id).toBe('newest')
    expect((await cloud.resolve('3')).id).toBe('third')
  })

  it('takes anything else as a round id', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'ok')
    const spy = vi.fn(async (url) =>
      Response.json({ rounds: url.includes('id=') ? [{ id: '1786754873405_r1' }] : rounds }),
    )
    vi.stubGlobal('fetch', spy)
    expect((await cloud.resolve('1786754873405_r1')).id).toBe('1786754873405_r1')
    expect(spy.mock.calls[0][0]).toContain('id=1786754873405_r1')
  })

  it('says how many rounds there are rather than returning undefined', async () => {
    vi.stubEnv('GEOCOACH_TOKEN', 'ok')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rounds: [{ id: 'only' }] })))
    await expect(cloud.resolve('9')).rejects.toThrow(/Only 1 round/)
  })
})

/* ------------------------------------------------------------- the guide text */

const PAGE = {
  slug: 'senegal',
  title: 'Senegal',
  code: 'SN',
  steps: [
    {
      text: ['Senegal is in West Africa and its coverage is mostly Generation 3 and 4.'],
      items: [
        {
          kind: 'tip',
          tags: ['license plates', 'important_', ''],
          data: {
            text: ['Senegal is the only African country to use fully blue licence plates.'],
            image: { imageUrl: '/images/Senegal_blue_plate.png' },
          },
        },
        { kind: 'tip', tags: ['pole'], data: { text: ['Too short.'] } },
        { kind: 'centeredImageWithCaption', text: 'White kilometre markers with a red top carry the road number.', image: { imageUrl: '/images/Senegal_km.png' } },
        { kind: 'gallery', data: { images: [] } },
      ],
    },
  ],
}

describe('distil', () => {
  const g = distil(PAGE)

  it('keeps clues and drops page furniture', () => {
    expect(g.blocks.map((b) => b.text)).toEqual([
      'Senegal is in West Africa and its coverage is mostly Generation 3 and 4.',
      'Senegal is the only African country to use fully blue licence plates.',
      'White kilometre markers with a red top carry the road number.',
    ])
  })

  it('normalises Plonk It\'s tags, trailing underscores and blanks included', () => {
    expect(g.blocks[1].tags).toEqual(['license plates', 'important'])
  })

  // The filenames often name the subject more plainly than the prose does, so
  // they are kept and searched: Quebec_yellow_sticker.png says "sticker" where
  // the sentence around it never does.
  it('keeps the cited image filenames', () => {
    expect(g.blocks[1].images).toEqual(['Senegal_blue_plate.png'])
    expect(g.blocks[2].images).toEqual(['Senegal_km.png'])
  })

  it('carries the identity a lookup needs', () => {
    expect([g.slug, g.title, g.code]).toEqual(['senegal', 'Senegal', 'SN'])
    expect(g.blocks.every((b) => b.step === 'Step 1')).toBe(true)
  })

  it('strips markdown links and bold out of the prose', () => {
    const [b] = distil({
      steps: [{ text: ['See the **[infographic](https://example.com/x)** for European guardrails here.'] }],
    }).blocks
    expect(b.text).toBe('See the infographic for European guardrails here.')
  })
})

it('flat folds accents and case, so Quebec finds Québec', () => {
  expect(flat('Québec')).toBe('quebec')
  expect(flat('ÅLAND')).toBe('aland')
})

/* ------------------------------------------------------------------- coaching */

const round = (country, guessCountry, ts, correct = false) => ({ id: ts, country, guessCountry, ts, correct })

describe('grading and confusions', () => {
  it('grades at country level, not at the dashboard\'s stricter distance', () => {
    expect(right({ country: 'Japan', guessCountry: 'Japan', correct: false })).toBe(true)
    expect(right({ country: 'Japan', guessCountry: 'Korea', correct: true })).toBe(false)
    expect(right({ correct: true })).toBe(true) // no names recorded: fall back
  })

  it('rates a set as n/total plus a percentage', () => {
    expect(rate([round('a', 'a', '1'), round('a', 'b', '2')])).toBe('1/2 (50%)')
    expect(rate([])).toBe('0/0')
  })

  // Calling Malaysia Cambodia is not the same mistake as calling Cambodia
  // Malaysia, and only one of them is yours.
  it('keeps confusions directional', () => {
    const out = confusions([
      round('Malaysia', 'Cambodia', '2026-01-01'),
      round('Malaysia', 'Cambodia', '2026-01-02'),
      round('Cambodia', 'Malaysia', '2026-01-03'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ country: 'Malaysia', guess: 'Cambodia', n: 2, last: '2026-01-02' })
  })

  it('ignores rounds that were right or never guessed', () => {
    expect(
      confusions([
        round('Japan', 'Japan', '1'),
        round('Japan', 'unknown', '2'),
        { country: 'Japan', ts: '3' },
      ]),
    ).toEqual([])
  })
})

describe('profileText', () => {
  const history = [
    round('Poland', 'Romania', new Date().toISOString()),
    round('Poland', 'Romania', new Date(Date.now() - 2 * 864e5).toISOString()),
    round('Poland', 'Poland', new Date(Date.now() - 3 * 864e5).toISOString()),
    round('Senegal', 'Senegal', new Date(Date.now() - 200 * 864e5).toISOString()),
  ]
  const out = profileText(history)

  it('reports the standing rate and the repeated confusion', () => {
    expect(out).toContain('all time      2/4 (50%)')
    expect(out).toMatch(/you call Poland 'Romania'\s+2×/)
  })

  it('windows by date', () => {
    expect(out).toMatch(/last 7 days\s+1\/3/)
  })

  it('points at the most recent miss by id', () => {
    expect(out).toContain(`geocoach_round_dossier(round: "${history[0].id}")`)
  })

  it('says so plainly when there is nothing repeated yet', () => {
    expect(profileText([round('Japan', 'Japan', '2026-01-01')])).toContain('none repeated')
  })
})

describe('the differential', () => {
  const hr = { title: 'Croatia', blocks: [{ text: 'Croatia uses B-type guardrails, unlike Slovenia.', tags: ['guardrail'], images: [] }] }
  const si = { title: 'Slovenia', blocks: [{ text: 'Slovene has Č, Š and Ž only.', tags: ['language'], images: [] }] }

  it('is every clue in either guide that names the other country', () => {
    const out = separators(hr, 'Croatia', si, 'Slovenia')
    expect(out).toHaveLength(1)
    expect(out[0][1]).toBe('Croatia')
  })

  it('knows the names a guide is likely to use', () => {
    expect(aliases({ title: 'United States of America' }, 'United States of America (the)')).toContain('the US')
    expect(aliases({ title: 'Bahamas' }, 'Bahamas (the)')).toEqual(['Bahamas'])
  })
})

// The map's intended meta is a phrase like "Senegal: French infrastructure";
// matching it needs the reference-image filenames as well as the prose.
it('forMeta finds the clue a map was teaching', () => {
  const g = {
    blocks: [
      { text: 'Senegal uses French infrastructure such as bollards and poles.', images: [], tags: [] },
      { text: 'Yellow-orange taxis with black fenders are common.', images: [], tags: [] },
      { text: 'These stickers are seen on poles.', images: ['Quebec_yellow_sticker.png'], tags: [] },
    ],
  }
  expect(forMeta(g, 'Senegal: French infrastructure')[0].text).toMatch(/French infrastructure/)
  expect(forMeta(g, 'Quebec yellow stickers')[0].images).toEqual(['Quebec_yellow_sticker.png'])
  expect(forMeta(g, '')).toEqual([])
})

/* ---------------------------------------------------------------- facts table */

describe('factsTable', () => {
  it('puts named countries side by side', async () => {
    const out = await factsTable({ countries: ['MY', 'Cambodia'] })
    expect(out).toMatch(/MY\s+Malaysia/)
    expect(out).toMatch(/KH\s+Cambodia/)
    expect(out).toMatch(/drives\s+left/)
  })

  // Prose search cannot answer "who drives left" — the guides phrase it a
  // hundred ways — which is the whole reason this table exists.
  it('filters on the axes prose search cannot reach', async () => {
    const out = await factsTable({ filters: { drives: 'left' } })
    expect(out).toContain('Australia')
    expect(out).not.toContain('Cambodia')
  })

  it('says what the keys are when one is wrong', async () => {
    await expect(factsTable({ countries: ['Atlantis'] })).rejects.toThrow(/ISO alpha-2/)
    await expect(factsTable({ filters: { colour: 'blue' } })).rejects.toThrow(/drives, lines, script, tell/)
  })
})

/* ------------------------------------------------------------------- the aim */

describe('compass', () => {
  it('rounds a bearing to the nearest of the sixteen winds', () => {
    expect(compass16(0)).toBe('N')
    expect(compass16(73)).toBe('ENE')
    expect(compass16(-10)).toBe('N')
    expect(compass16(370)).toBe('N')
  })

  it('reads a wind back as degrees, and refuses anything else', () => {
    expect(compassDeg('ssw')).toBe(202.5)
    expect(compassDeg('287')).toBe(null)
    expect(compassDeg(null)).toBe(null)
  })
})

describe('sectorFor', () => {
  const grid = { cols: 32, rows: 16 }

  it('covers more than fov/2 of yaw, because the corners reach further than the axis', () => {
    const flat = sectorFor(grid, 0, 0, 30)
    const down = sectorFor(grid, 0, -45, 30)
    expect(down.cols).toBeGreaterThan(flat.cols)
  })

  it('wraps across the seam rather than running off the grid', () => {
    const s = sectorFor(grid, 358, 0, 30)
    expect(s.x0).toBeGreaterThanOrEqual(0)
    expect(s.x0).toBeLessThan(grid.cols)
    expect(s.aim[0]).toBeLessThan(grid.cols)
  })

  // Looking at the pole, every column is in shot; without this the sector was a
  // narrow slice of a sphere the frame actually wrapped all the way round.
  it('takes the whole ring when the frame contains the pole', () => {
    expect(sectorFor(grid, 0, -89, 120).cols).toBe(grid.cols)
  })

  it('keeps rows inside the grid', () => {
    const s = sectorFor(grid, 0, -85, 40)
    expect(s.y0).toBeGreaterThanOrEqual(0)
    expect(s.y0 + s.rows).toBeLessThanOrEqual(grid.rows + 1)
  })
})

/* --------------------------------------------------------------- the renderer */

describe('the panorama renderer', () => {
  const solid = (r, g, b) => {
    const px = new Uint8Array(512 * 512 * 4)
    for (let i = 0; i < px.length; i += 4) [px[i], px[i + 1], px[i + 2], px[i + 3]] = [r, g, b, 255]
    return encodeJpeg({ data: px, width: 512, height: 512 }, 90)
  }

  const sphere = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geocoach-'))
    await writeFile(join(dir, 'pano_0_0.jpg'), solid(220, 20, 20)) // west half, red
    await writeFile(join(dir, 'pano_0_1.jpg'), solid(20, 20, 220)) // east half, blue
    return new Sphere(dir, 2)
  }

  const middle = (img) => {
    const i = ((img.height >> 1) * img.width + (img.width >> 1)) * 4
    return [img.data[i], img.data[i + 1], img.data[i + 2]]
  }

  it('reads the sphere\'s size off the column count, not the file count', () => {
    const s = new Sphere('/nowhere', 16)
    expect([s.width, s.height, s.rows]).toEqual([8192, 4096, 8])
  })

  it('aims yaw 0 at the way the camera car faced, and grows clockwise', async () => {
    const s = await sphere()
    expect(middle(await renderView(s, { yaw: 90, pitch: 0, fov: 40, w: 64, h: 48 }))[2]).toBeGreaterThan(150)
    expect(middle(await renderView(s, { yaw: -90, pitch: 0, fov: 40, w: 64, h: 48 }))[0]).toBeGreaterThan(150)
  })

  it('wraps the seam instead of clamping to it', async () => {
    const s = await sphere()
    const a = middle(await renderView(s, { yaw: 270, pitch: 0, fov: 40, w: 64, h: 48 }))
    const b = middle(await renderView(s, { yaw: -90, pitch: 0, fov: 40, w: 64, h: 48 }))
    expect(a).toEqual(b)
  })

  it('renders the size it was asked for, and encodes as a real JPEG', async () => {
    const img = await renderView(await sphere(), { yaw: 0, pitch: -5, fov: 60, w: 96, h: 72 })
    expect([img.width, img.height, img.data.length]).toEqual([96, 72, 96 * 72 * 4])
    const jpg = encodeJpeg(img, 87)
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]) // SOI
    expect(jpg.length).toBeGreaterThan(500)
  })

  // A tile that is missing or truncated is a hole in the sphere, not a crash:
  // Google drops zoom-5 detail away from the horizon all the time.
  it('fills missing tiles rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geocoach-'))
    await writeFile(join(dir, 'pano_0_0.jpg'), Buffer.from('not a jpeg'))
    const img = await renderView(new Sphere(dir, 2), { yaw: 0, pitch: 0, fov: 60, w: 32, h: 24 })
    expect(middle(img)).toEqual([24, 24, 24])
  })
})
