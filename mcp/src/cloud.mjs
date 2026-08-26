/**
 * The GeoCoach cloud, which is where the rounds actually are.
 *
 * Rounds are captured by the userscript straight into the Worker — often from a
 * different machine than the one coaching them. So there is no local database
 * to install and no import step: this server authenticates as the user and
 * reads /api/rounds and /api/dashboard, exactly as coach/brief.mjs does.
 *
 * The token is never logged. A 401 is not a network error and must not read
 * like one — it means the token is wrong, and the fix is a URL, so say that.
 */
import { Actionable, CLOUD_URL, token } from './config.mjs'

async function api(path) {
  // Read the token before the try: it throws its own "here is where to get one"
  // message, and a catch meant for sockets would have relabelled that as a
  // network error — which is exactly what it did until this was pulled out.
  const auth = 'Bearer ' + token()
  let res
  try {
    res = await fetch(CLOUD_URL + path, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    throw new Actionable(
      `Could not reach GeoCoach at ${CLOUD_URL} (${err.name === 'TimeoutError' ? 'timed out' : 'network error'}).\n` +
        'Check the connection, or set GEOCOACH_URL if you run your own Worker.',
    )
  }
  if (res.status === 401 || res.status === 403)
    throw new Actionable(
      'GeoCoach rejected the token (401). Sign in at https://geofsrs.pages.dev, copy the\n' +
        'token from the dashboard, and set it as GEOCOACH_TOKEN for this server.',
    )
  if (!res.ok) throw new Actionable(`GeoCoach returned ${res.status} for ${path}.`)
  return res.json()
}

const NO_ROUNDS =
  'No rounds in this GeoCoach account yet — there is nothing to coach.\n\n' +
  'Install the userscript from https://geofsrs.pages.dev (it needs Tampermonkey),\n' +
  'play a round of GeoGuessr, and it will be captured automatically. Come back then.'

/** The newest `limit` dossiers, newest first. */
export async function recent(limit = 1) {
  const { rounds } = await api(`/api/rounds?limit=${Math.min(50, Math.max(1, limit))}`)
  if (!rounds?.length) throw new Actionable(NO_ROUNDS)
  return rounds
}

/** One dossier by id. Older Workers have no id lookup, so fall back to a scan. */
export async function byId(id) {
  const one = await api(`/api/rounds?id=${encodeURIComponent(id)}`).catch(() => null)
  if (one?.rounds?.length) return one.rounds[0]
  const { rounds } = await api('/api/rounds?limit=50')
  const hit = rounds.find((x) => x.id === id)
  if (!hit)
    throw new Actionable(
      `No round "${id}" in this account, and it is not in the last 50 either.\n` +
        'Use geocoach_round_dossier with no argument for the most recent round, or an index like 3.',
    )
  return hit
}

/** Round index (1 = most recent), or a round id. */
export async function resolve(round) {
  const want = String(round ?? '1').trim()
  if (!/^\d{1,2}$/.test(want)) return byId(want)
  const n = Number(want)
  const rounds = await recent(n)
  if (!rounds[n - 1])
    throw new Actionable(`Only ${rounds.length} round(s) in this account — there is no round ${n}.`)
  return rounds[n - 1]
}

/** The dashboard's trimmed projection of every round: the whole record. */
export async function history() {
  const rounds = (await api('/api/dashboard')).rounds ?? []
  if (!rounds.length) throw new Actionable(NO_ROUNDS)
  return rounds
}
