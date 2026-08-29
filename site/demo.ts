/* ==========================================================================
   A dashboard's worth of plausible data, for looking at the dashboard.

   The signed-in console cannot be opened without an account, which makes the
   one page with the most layout in it the one page nobody can look at while
   building it. This stands in for the network read when the address bar says
   `?demo=…`, and only ever in a dev build — `import.meta.env.DEV` is a compile
   -time constant, so the whole module falls out of a production bundle with
   the branch that reads it.

   The pano ids are real, pulled from coach/catalog, so the Street View
   thumbnails actually load and the photo rail can be judged on photographs
   rather than on grey boxes.

   Variants, so the states that are hard to reach on a live account can still
   be looked at:
     ?demo=1        a played-in account, mid-day
     ?demo=done     the same account with the day's work finished
     ?demo=new      signed up, nothing logged yet
     ?demo=nopano   a clue the catalogs have no location for
   ========================================================================== */
import type { CountryStat, DashboardData, HeldPoint, RoundStat, UpNextMeta } from './api'

/** The same recipe api.ts documents, used here to stand in for meta card art. */
const shot = (panoId: string, heading: number, w = 320, h = 240) =>
  `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?cb_client=maps_sv.tactile.gps&w=${w}&h=${h}` +
  `&panoid=${panoId}&yaw=${heading}&pitch=0`

const NOW = Date.now()
const DAY = 86_400_000

const UP_NEXT: UpNextMeta[] = [
  { name: 'Japan: Low cam', panoId: '5DQrgtSxBe7LK5RDgdRZgQ', heading: 309.95, pitch: 0, lat: 39.22553, lng: 140.90416 },
  { name: 'Chile: All yellow lines', panoId: '0SEQrcp3JG3kPcPbK8s97A', heading: 208.41, pitch: 0, lat: -38.6451, lng: -71.00345 },
  { name: 'Iceland: Bollards', panoId: '4y9s2wlHJQkcYyPnRYxQHQ', heading: 270.28, pitch: 0, lat: 65.52068, lng: -23.4034 },
  { name: 'Turkey: Stop signs', panoId: 'AJMlS6vKB-aZmcjqEWpsQQ', heading: 341.85, pitch: 0, lat: 37.69314, lng: 29.19756 },
]

/* Six more, so the ten-a-day account has a full hand and the rail can be seen
   overflowing rather than only fitting. */
const MORE_NEXT: UpNextMeta[] = [
  { name: 'Norway: Long outer lines', panoId: '51K9piipQI-0B0OpGZjANw', heading: 153.54, pitch: 0, lat: 61.43533, lng: 11.343814 },
  { name: 'Kenya: Follow car', panoId: '0jQyohG4CVsoRe4rhBgMYQ', heading: 84.98, pitch: 0, lat: -0.022288, lng: 40.17511 },
  { name: 'Ecuador: Bollard', panoId: '68Jut1vWaxGX5COeAQk10A', heading: 183.97, pitch: 0, lat: -1.418391, lng: -78.873634 },
  { name: 'Bolivia: Curvy poles', panoId: '1e-XMpRmihur_hNol5bWSQ', heading: 41.91, pitch: 0, lat: -17.480824, lng: -63.123016 },
  { name: 'Ghana: Unique car', panoId: '0Xqstdgc5W5Lv7gD1-iVvQ', heading: 21.76, pitch: 0, lat: 9.457896, lng: -2.4283435 },
  { name: 'Vietnam: Bollards', panoId: '14rstvSmhZsbIVeGAgfdJA', heading: 215.87, pitch: 0, lat: 10.131148, lng: 105.16753 },
]

const WEAKEST = [
  { metaName: 'Cambodia: House on stilts', seen: 9, correct: 2, lapses: 5, pano: '01fvRiPIz8Nzw3Fb2rpYtw', head: 81.35 },
  { metaName: 'Russia: Black sock sign post', seen: 7, correct: 2, lapses: 4, pano: '04kN4e3qQ7GcYghiv8u00w', head: 359.04 },
  { metaName: 'Peru: Concrete blocks', seen: 11, correct: 4, lapses: 4, pano: '90sh3R19FExlu78PIgxhGA', head: 157.37 },
  { metaName: 'Nigeria: Police follow car', seen: 6, correct: 2, lapses: 3, pano: 'c91CYyzSzpP3BN-yC5_DIw', head: 329.21 },
  { metaName: 'Indonesia: Nusa pole', seen: 12, correct: 6, lapses: 3, pano: '4y0Oz8N1P-8ERGVCZfzvVQ', head: 301.79 },
  { metaName: 'Mongolia: Unique car', seen: 8, correct: 4, lapses: 2, pano: '3jY81kSZFnX2ZatFBPuqgQ', head: 329.2 },
].map(({ pano, head, ...m }) => ({ ...m, image: shot(pano, head) }))

/* Duel losses are heaviest where play is frequent AND accuracy is poor —
   Russia's 38 rounds at 55% cost more than Cambodia's 12 at 25% — and only
   Brazil and Russia have pooled enough rounds in one region to name it. */
const COUNTRIES: CountryStat[] = [
  { code: 'BR', name: 'Brazil', rounds: 61, correct: 47, duels: 26, duelLost: 64882, worstRegion: { name: 'Minas Gerais', n: 6, lost: 14200 } },
  { code: 'US', name: 'United States', rounds: 54, correct: 44, duels: 18, duelLost: 22400, worstRegion: null },
  { code: 'JP', name: 'Japan', rounds: 41, correct: 37, duels: 9, duelLost: 6100, worstRegion: null },
  { code: 'RU', name: 'Russia', rounds: 38, correct: 21, duels: 14, duelLost: 38900, worstRegion: { name: 'Krasnoyarsk Krai', n: 5, lost: 11800 } },
  { code: 'ZA', name: 'South Africa', rounds: 33, correct: 19, duels: 7, duelLost: 12300, worstRegion: null },
  { code: 'FR', name: 'France', rounds: 29, correct: 22, duels: 5, duelLost: 4100, worstRegion: null },
  { code: 'ID', name: 'Indonesia', rounds: 26, correct: 11, duels: 6, duelLost: 15800, worstRegion: null },
  { code: 'PL', name: 'Poland', rounds: 24, correct: 13, duels: 3, duelLost: 5900, worstRegion: null },
  { code: 'MX', name: 'Mexico', rounds: 22, correct: 14, duels: 4, duelLost: 7300, worstRegion: null },
  { code: 'TR', name: 'Turkey', rounds: 19, correct: 8, duels: 2, duelLost: 4800, worstRegion: null },
  { code: 'PE', name: 'Peru', rounds: 17, correct: 6, duels: 2, duelLost: 6200, worstRegion: null },
  { code: 'KH', name: 'Cambodia', rounds: 12, correct: 3, duels: 1, duelLost: 3400, worstRegion: null },
]

/* One reading a day for a fortnight, climbing the way a real one does — up
   most days, flat on the two nobody played. */
const SERIES: HeldPoint[] = [38, 41, 41, 46, 50, 53, 53, 57, 59, 62, 64, 66, 69, 71].map((held, i, a) => ({
  t: new Date(NOW - (a.length - 1 - i) * DAY).toISOString(),
  held,
}))

/* A round log that looks played rather than generated: the misses cluster in
   the countries the weak clues come from, and the scores follow. */
const LOG: Array<[string, string | null, string | null, number, number]> = [
  ['Brazil', null, 'Brazil: Road marker', 4881, 42],
  ['Japan', null, 'Japan: Low cam', 4930, 31],
  ['Cambodia', 'Thailand', 'Cambodia: House on stilts', 3204, 611],
  ['France', null, 'France: Bollard', 4762, 88],
  ['Indonesia', 'Malaysia', 'Indonesia: Nusa pole', 2871, 934],
  ['United States', null, 'United States: Route shields', 4655, 121],
  ['Peru', 'Bolivia', 'Peru: Concrete blocks', 3488, 466],
  ['Poland', null, 'Poland: Town signs', 4801, 74],
  ['Russia', 'Kazakhstan', 'Russia: Black sock sign post', 2996, 812],
  ['South Africa', null, 'South Africa: Yellow Outer Lines', 4712, 103],
  ['Mexico', null, 'Mexico: Boojum trees', 4404, 208],
  ['Turkey', 'Greece', 'Turkey: Stop signs', 3611, 384],
  ['Brazil', null, 'Brazil: Bollard', 4918, 36],
  ['Nigeria', 'Ghana', 'Nigeria: Police follow car', 3105, 588],
  ['Japan', null, 'Japan: Blue signs', 4877, 47],
  ['France', null, 'France: Road lines', 4690, 112],
  ['Mongolia', 'Kyrgyzstan', 'Mongolia: Unique car', 2740, 1104],
  ['United States', null, 'United States: Pole tags', 4520, 168],
  ['Poland', 'Czechia', 'Poland: Bollard', 3392, 297],
  ['Russia', null, 'Russia: Rusty pole', 4611, 133],
  ['Indonesia', null, 'Indonesia: Red roofs', 4344, 224],
  ['South Africa', 'Namibia', 'South Africa: Follow car', 3268, 508],
  ['Brazil', null, 'Brazil: Green plates', 4952, 21],
  ['Japan', null, 'Japan: Snow poles', 4788, 66],
]

const ROUNDS: RoundStat[] = LOG.map(([country, guess, metaName, score, distanceKm], i) => ({
  id: `demo-${i}`,
  ts: new Date(NOW - i * 5.5 * 3_600_000).toISOString(),
  from: null,
  to: [0, 0],
  correct: guess === null,
  country,
  guessCountry: guess ?? country,
  metaName,
  score,
  distanceKm,
}))

const PLAYED: DashboardData = {
  name: 'Ethan',
  generatedAt: new Date(NOW - 4 * 60_000).toISOString(),
  progress: { held: 71, total: 370, series: SERIES },
  deck: {
    due: 6,
    learning: 14,
    unseen: 250,
    introduced: 120,
    total: 384,
    ladderTotal: 370,
    nextDue: new Date(NOW + 3.2 * 3_600_000).toISOString(),
  },
  day: { dailyNew: 10, newAllowance: 4, doneForToday: false, upNext: UP_NEXT },
  metas: { solid: 71, holding: 31, shaky: 18, total: 120, weakest: WEAKEST },
  countries: COUNTRIES,
  totals: { rounds: 605, correctPct: 58.6 },
  rounds: ROUNDS,
}

/** The payload for `?demo=<variant>`, or null when this is not a demo load. */
export function demoData(): DashboardData | null {
  if (!import.meta.env.DEV) return null
  const v = new URLSearchParams(location.search).get('demo')
  if (!v) return null

  if (v === 'done')
    return {
      ...PLAYED,
      deck: { ...PLAYED.deck, due: 0, nextDue: new Date(NOW + 14 * 3_600_000).toISOString() },
      day: { dailyNew: 10, newAllowance: 0, doneForToday: true, upNext: [] },
    }

  if (v === 'nopano')
    return {
      ...PLAYED,
      day: {
        ...PLAYED.day!,
        upNext: [UP_NEXT[0], { ...UP_NEXT[1], panoId: null, heading: null }, UP_NEXT[2], UP_NEXT[3]],
      },
    }

  if (v === 'new')
    return {
      name: 'Ethan',
      generatedAt: new Date(NOW).toISOString(),
      progress: { held: 0, total: 370, series: [] },
      deck: { due: 0, learning: 0, unseen: 370, introduced: 0, total: 370, ladderTotal: 370, nextDue: null },
      day: { dailyNew: 10, newAllowance: 10, doneForToday: false, upNext: [...UP_NEXT, ...MORE_NEXT] },
      metas: { solid: 0, holding: 0, shaky: 0, total: 0, weakest: [] },
      countries: [],
      totals: { rounds: 0, correctPct: null },
      rounds: [],
    }

  return PLAYED
}
