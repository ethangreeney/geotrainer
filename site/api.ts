const TOKEN_KEY = 'geocoach_token'

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export const setToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch {
    /* private mode */
  }
}
export const clearToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* private mode */
  }
}

/* True when this page load began with a ?token= in the address bar — someone
   arriving on their saved account link rather than on a device that already
   remembers them. Only the difference between those two matters: if the token
   turns out to be dead, one of them needs telling that their link is the thing
   that failed, and the other does not. */
let cameFromLink = false
export const arrivedByLink = () => cameFromLink

/* A 401 on a token we were actually holding means that token is dead — but the
   page that finds out is often not the page that has to explain it. The
   dashboard discovers it, clears the token and sends the person to /start,
   which by then has no token left and so nothing to tell it that anything went
   wrong: a saved account link that had gone stale landed you on "Pick a name
   and play" with no word that your link was the thing that failed.

   sessionStorage carries the news across that navigation and no further — a
   new tab tomorrow should not inherit yesterday's apology. */
const DEAD_KEY = 'geocoach_dead_token'

/** Why the token went away, for whichever page ends up doing the explaining:
 * `link` if this page load began on a saved account link, `device` if the
 * token had simply been sitting in this browser. */
export type DeadTokenCause = 'link' | 'device'

function markTokenDead() {
  try {
    sessionStorage.setItem(DEAD_KEY, cameFromLink ? 'link' : 'device')
  } catch {
    /* private mode */
  }
}

/** Read the reason once and forget it, so it explains exactly one screen. */
export function takeDeadToken(): DeadTokenCause | null {
  try {
    const v = sessionStorage.getItem(DEAD_KEY)
    sessionStorage.removeItem(DEAD_KEY)
    return v === 'link' || v === 'device' ? v : null
  } catch {
    return null
  }
}

/** Pull ?token= out of the URL into storage, then scrub it from the address bar. */
export function captureTokenFromUrl() {
  const url = new URL(location.href)
  const t = url.searchParams.get('token')
  if (!t) return
  cameFromLink = true
  setToken(t)
  url.searchParams.delete('token')
  history.replaceState({}, '', url.pathname + url.search + url.hash)
}

/** A token, however it was handed over — bare, or buried in a pasted link.
 * People paste the whole URL far more often than they isolate the token, and
 * both of the links we hand out carry it as ?token=. */
export function readToken(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const inUrl = raw.match(/[?&]token=([^&#\s]+)/)
  const candidate = inUrl ? decodeURIComponent(inUrl[1]) : raw
  // Tokens are 16 random bytes in hex. Anything else is a typo or the wrong
  // thing entirely, and saying so beats a 401 three screens later.
  return /^[0-9a-f]{32}$/i.test(candidate) ? candidate.toLowerCase() : null
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers = new Headers(init.headers)
  if (auth) {
    const token = getToken()
    if (!token) throw new ApiError(401, 'No account on this device.')
    headers.set('Authorization', `Bearer ${token}`)
  }
  if (init.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    /* fetch only rejects when the request never got an answer at all. Left
       alone it surfaces as "Failed to fetch" (or "Load failed" on Safari) in
       the middle of the signup form, which reads like the site is broken
       rather than like the network is. 0 marks it as "never reached". */
    throw new ApiError(0, 'Could not reach GeoCoach. Check your connection and try again.')
  }
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || body?.ok === false) {
    // Only an authenticated call can prove a token dead; an unauthenticated
    // 401 says nothing about whatever is in storage.
    if (res.status === 401 && auth) markTokenDead()
    /* A 5xx is the Worker or D1 falling over, and its raw text is a stack
       trace. Nobody outside this repo can act on that, so it becomes one
       sentence that says whose fault it is and what to do. */
    if (res.status >= 500)
      throw new ApiError(res.status, 'GeoCoach is having trouble right now. Try again in a minute.')
    throw new ApiError(res.status, body?.error || `Request failed (${res.status}).`)
  }
  return body as T
}

/* ---------------------------------------------------------------- shapes */
export interface PublicStats {
  users: number
  rounds: number
  metasTracked: number
}
export interface Me {
  name: string
  createdAt: string
  trainerMapId: string | null
}
export interface WeakMeta {
  metaName: string
  seen: number
  correct: number
  lapses: number
  /** The clue's picture from its Learnable Meta card, when one exists. */
  image: string | null
}
export interface CountryStat {
  code: string
  name: string
  rounds: number
  correct: number
}
export interface RoundStat {
  id: string
  ts: string
  from: [number, number] | null
  to: [number, number]
  correct: boolean
  country: string | null
  guessCountry: string | null
  metaName: string | null
  score: number | null
  distanceKm: number | null
}
/** One reading of "clues held at 90%", for the climb chart. */
export interface HeldPoint {
  t: string
  held: number
}
export interface DashboardData {
  name: string
  generatedAt: string
  /* The headline figure, and the only one the dashboard leads with: how many
     clues FSRS currently puts at a 90%-or-better chance of recall. It is a live
     reading, not a high-water mark, so it falls when you stop playing.

     Optional because the Worker learned to send it after the site learned to
     draw it; Dashboard.tsx falls back to counting solid clues until it lands. */
  progress?: { held: number; total: number; series: HeldPoint[] }
  deck: { due: number; learning: number; unseen: number; introduced: number; total: number; nextDue: string | null }
  /* The day rather than the deck: the allowance, what is left of it, and
     whether anything is owed at all. Optional for the same reason progress is —
     the site and the Worker deploy separately, and a console that announced a
     finished day off a payload that never carried one would be lying in the
     one direction that matters. Absent means "say nothing about today". */
  /* `upNext` is the same reasoning one level down: the meta names the day's
     remaining allowance would introduce next, in ladder order. Optional on its
     own account, not just `day`'s — a Worker old enough to send the three
     numbers but not the list is a real deploy state, and naming clues the
     scheduler has not chosen would be an invention. Empty when the allowance
     is spent or the ladder has nothing left unseen. */
  day?: { dailyNew: number; newAllowance: number; doneForToday: boolean; upNext?: string[] }
  metas: { solid: number; holding: number; shaky: number; total: number; weakest: WeakMeta[] }
  countries: CountryStat[]
  totals: { rounds: number; correctPct: number | null }
  rounds: RoundStat[]
}

/* ------------------------------------------------------------- endpoints */
export const fetchStats = () => request<{ ok: true } & PublicStats>('/api/stats')
export const fetchMe = () => request<{ ok: true } & Me>('/me', {}, true)
export const fetchDashboard = () => request<{ ok: true } & DashboardData>('/api/dashboard', {}, true)
/** The one setting there is: how many never-seen clues a day may introduce.
 * The Worker refuses anything it cannot store exactly and says so in a sentence,
 * so a rejection is worth showing verbatim rather than translating. */
export const setDailyNew = (n: number) =>
  request<{ ok: true; config: { dailyNew: number } }>(
    '/config',
    { method: 'POST', body: JSON.stringify({ dailyNew: n }) },
    true,
  )
export const signup = (name: string) =>
  request<{ ok: true; token: string; name: string }>('/signup', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

/* Two links, and they are not the same link — which the setup page used to get
   wrong, showing the install URL under the words "this link is your account".
   It is not: opening it hands Tampermonkey a script. The link that signs a
   person back in is the second one, and it is the only thing standing between
   them and losing an account that has no password to reset. */
export const installUrl = (token: string) => `${location.origin}/geocoach.user.js?token=${encodeURIComponent(token)}`
export const accountUrl = (token: string) => `${location.origin}/app?token=${encodeURIComponent(token)}`
