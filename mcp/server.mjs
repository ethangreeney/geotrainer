#!/usr/bin/env node
/**
 * GeoCoach MCP server — the coaching half of GeoTrainer, as tools.
 *
 * The scheduler decides what to practise; this is the other half, the one that
 * reads a round's actual imagery back to the player and explains the miss. It
 * used to exist only as CLI scripts on one laptop. Here it is four tools any
 * MCP client can call, and the pictures travel as image content rather than as
 * file paths — a path is useless to a client on another machine, and it is the
 * whole difference between a product and a script.
 *
 * The server makes no LLM API calls and holds no API key. The intelligence is
 * the connected client's; this supplies the tools and the data. Its only
 * credential is the user's own GeoCoach token, read from GEOCOACH_TOKEN.
 *
 * stdout is the JSON-RPC channel — anything logged there corrupts the stream,
 * so every diagnostic in this process goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Actionable } from './src/config.mjs'
import * as cloud from './src/cloud.mjs'
import * as clues from './src/clues.mjs'
import { dossierText, profileText } from './src/coach.mjs'
import { status as guideStatus, warm } from './src/guides.mjs'
import { fourViews, look } from './src/views.mjs'

const text = (s) => ({ type: 'text', text: s })

/**
 * A clue answer, plus a note when the guide cache is still filling.
 *
 * The library takes about five minutes to download the first time a machine
 * runs this. Waiting for it would strand the call past every client's timeout,
 * so a partial corpus is answered from instead — but silently passing a partial
 * corpus off as all 140 guides would turn "not downloaded yet" into "no such
 * clue", which is a wrong answer rather than a slow one.
 */
async function clueText(body) {
  const { ready, have, total } = await guideStatus()
  return {
    content: [
      text(
        ready
          ? body
          : `${body}\n\n(Clue library still downloading — ${have} of ${total} guides, so this is ` +
              'incomplete. Ask again in a minute for the rest.)',
      ),
    ],
  }
}
const image = (buf) => ({ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType: 'image/jpeg' })

/**
 * Every tool goes through this. A missing token, a rejected token, an account
 * with no rounds and a guide snapshot that will not build are all ordinary
 * states of the world, not bugs — they come back as the sentence that tells the
 * user what to do next. Anything else is a real fault and says so plainly,
 * because a stack trace in a chat window helps nobody.
 */
const guard = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    if (err instanceof Actionable) return { content: [text(err.message)], isError: true }
    console.error('[geocoach]', err?.stack ?? err)
    return { content: [text(`GeoCoach hit an unexpected error: ${err?.message ?? err}`)], isError: true }
  }
}

const server = new McpServer(
  { name: 'geocoach', version: '0.1.0', title: 'GeoCoach' },
  {
    instructions:
      'GeoCoach coaches the GeoGuessr rounds this user has actually played. Start a coaching ' +
      'session with geocoach_round_dossier — it returns the round as four photographs plus where ' +
      'it really was, where they clicked, and the clue the location was chosen for. Read the ' +
      'images before the text. Use geocoach_look to read a sign, a plate or road markings up ' +
      'close, geocoach_clues to ask what else a location could have been, and geocoach_profile ' +
      'to see standing form before choosing what to work on. Coach only clues that transfer to ' +
      'other rounds; never reveal a location the user is still being asked to guess.',
  },
)

server.registerTool(
  'geocoach_round_dossier',
  {
    title: 'Round dossier',
    description:
      'Everything needed to coach one GeoGuessr round the user played: four rectilinear views of ' +
      'the panorama as actual images (front, right, back, left — front is the way the camera car ' +
      'faced), the true location and its terrain, where the user clicked and how far off that ' +
      'was, their record on both countries, the clue the location was chosen to teach, and the ' +
      'Plonk It clues that separate the true country from the guessed one. Defaults to the round ' +
      'just played. Imagery is rebuilt from Google\'s public tile CDN on first use and cached, so ' +
      'the first call on a new round takes a few seconds longer.',
    inputSchema: {
      round: z
        .string()
        .optional()
        .describe(
          'Which round: omit for the most recent, "3" for the third-most-recent, or a round id ' +
            'like "1786754873405_r1".',
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async ({ round }) => {
    const r = await cloud.resolve(round)
    const [{ views, note }, past] = await Promise.all([
      fourViews(r),
      cloud.history().catch(() => [r]),
    ])
    return {
      content: [text(await dossierText(r, past, views, note)), ...views.map((v) => image(v.jpeg))],
    }
  }),
)

server.registerTool(
  'geocoach_look',
  {
    title: 'Aimed close-up',
    description:
      'A close-up of one bearing in a round\'s panorama — the telephoto to the dossier\'s four ' +
      'wide views. Use it to read a road sign, a licence plate, a bollard, lane markings or a ' +
      'utility pole that the wide view leaves too small. Yaw 0 is the way the camera car faced ' +
      'and grows clockwise; a 16-wind compass name ("N", "SSW") aims by the world instead. A ' +
      'field of view below 45 degrees fetches sharper zoom-5 imagery for that sector alone, which ' +
      'is the setting for reading text.',
    inputSchema: {
      round: z.string().describe('Round id, or "1" for the most recent — as for geocoach_round_dossier.'),
      yaw: z
        .string()
        .describe(
          'Where to look: degrees clockwise from the way the camera car faced ("0", "287"), or a ' +
            '16-wind compass point ("N", "ENE", "SSW").',
        ),
      pitch: z.number().min(-90).max(90).optional().describe('Degrees up (positive) or down. Default -5.'),
      fov: z
        .number()
        .min(1)
        .max(170)
        .optional()
        .describe('Field of view in degrees. Default 60; use 20-35 to read text, 100 for context.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async ({ round, yaw, pitch, fov }) => {
    const r = await cloud.resolve(round)
    const shot = await look(r, yaw, pitch ?? -5, fov ?? 60)
    return { content: [text(shot.text), image(shot.jpeg)] }
  }),
)

server.registerTool(
  'geocoach_clues',
  {
    title: 'Clue lookup and country differential',
    description:
      'The Plonk It country guides, sliced. With `versus` and `country`, what separates two ' +
      'countries — every clue in either guide that names the other, plus both facts rows. With ' +
      '`country` alone, that country\'s whole guide. With `clue_type`, one kind of clue across ' +
      'every country on earth ("bollard", "pole", "sign"). With `search`, free text across every ' +
      'clue. With `facts`, the structured table — driving side, road-line colours, script and ' +
      'killer tell — which is the only way to answer questions like "who drives left". With no ' +
      'arguments, the list of clue types. The guide text caches itself on the first run of the ' +
      'server (about five minutes in the background, 1.5 MB, no images); a call made before it ' +
      'finishes answers from what has arrived and says how much is still missing.',
    inputSchema: {
      country: z.string().optional().describe('ISO alpha-2 code or country name, e.g. "HR" or "Croatia".'),
      versus: z
        .string()
        .optional()
        .describe('A second country: with `country`, returns what separates the two.'),
      clue_type: z.string().optional().describe('One clue type across all countries, e.g. "bollard".'),
      search: z.string().optional().describe('Free text across every clue in every guide.'),
      facts: z
        .string()
        .optional()
        .describe(
          'The country-facts table. "" or "all" for every row; a country list ("MY KH GR") for ' +
            'those rows side by side; or filters ("drives=left lines=yellow").',
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async ({ country, versus, clue_type, search, facts }) => {
    if (facts !== undefined) {
      const parts = facts.split(/\s+/).filter((p) => p && p.toLowerCase() !== 'all')
      const filters = Object.fromEntries(
        parts.filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')).toLowerCase(), p.slice(p.indexOf('=') + 1)]),
      )
      const names = parts.filter((p) => !p.includes('='))
      return { content: [text(await clues.factsTable({ countries: names, filters }))] } // facts ship with the package
    }
    if (country && versus) return clueText(await clues.differential(country, versus))
    if (country) return clueText(await clues.country(country))
    if (clue_type) return clueText(await clues.byTag(clue_type, search ? search.split(/\s+/) : []))
    if (search) return clueText(await clues.find(search.split(/\s+/)))
    return clueText(await clues.tags())
  }),
)

server.registerTool(
  'geocoach_profile',
  {
    title: 'Standing form',
    description:
      'The user\'s record: country hit rate over 7 days, 30 days and all time; the confusions ' +
      'they repeat, stated directionally (calling Malaysia Cambodia is a different mistake from ' +
      'calling Cambodia Malaysia, and only one of them is theirs); and their worst countries. ' +
      'Read this before choosing what to work on in a coaching session.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async () => ({ content: [text(profileText(await cloud.history()))] })),
)

// The Plonk It clue library takes about five minutes to cache the first time a
// machine runs this — Plonk It serves ~25 guide pages a minute and there is no
// way to spend that budget faster. Starting it at boot means those minutes
// overlap with the user opening a client and asking for their first round,
// rather than landing inside a tool call. It never throws; a failed warm-up
// just means the first clue query builds it itself.
warm()

await server.connect(new StdioServerTransport())
