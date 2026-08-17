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

/** Pull ?token= out of the URL into storage, then scrub it from the address bar. */
export function captureTokenFromUrl() {
  const url = new URL(location.href)
  const t = url.searchParams.get('token')
  if (!t) return
  setToken(t)
  url.searchParams.delete('token')
  history.replaceState({}, '', url.pathname + url.search + url.hash)
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
  const res = await fetch(path, { ...init, headers })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || body?.ok === false) {
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
export interface DashboardData {
  name: string
  generatedAt: string
  deck: { due: number; learning: number; unseen: number; introduced: number; total: number; nextDue: string | null }
  metas: { solid: number; holding: number; shaky: number; total: number; weakest: WeakMeta[] }
  countries: CountryStat[]
  totals: { rounds: number; correctPct: number | null }
  rounds: RoundStat[]
}

/* ------------------------------------------------------------- endpoints */
export const fetchStats = () => request<{ ok: true } & PublicStats>('/api/stats')
export const fetchMe = () => request<{ ok: true } & Me>('/me', {}, true)
export const fetchDashboard = () => request<{ ok: true } & DashboardData>('/api/dashboard', {}, true)
export const signup = (name: string) =>
  request<{ ok: true; token: string; name: string }>('/signup', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

export const installUrl = (token: string) => `${location.origin}/geocoach.user.js?token=${encodeURIComponent(token)}`
