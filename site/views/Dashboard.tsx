import { useEffect, useMemo, useState } from 'react'
import Globe from '../GlobeLazy'
import type { CountryTint } from '../Globe'
import { Link, Wordmark, navigate } from '../router'
import { ApiError, clearToken, fetchDashboard, getToken, type DashboardData } from '../api'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function ago(ts: string) {
  const d = Date.now() - new Date(ts).getTime()
  if (!Number.isFinite(d)) return ''
  if (d < 2 * MIN) return 'just now'
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** When the next card comes back around, said the way a person would say it. */
function whenNext(ts: string | null) {
  if (!ts) return null
  const d = new Date(ts).getTime() - Date.now()
  if (!Number.isFinite(d)) return null
  if (d <= 0) return 'any moment now'
  if (d < HOUR) {
    const m = Math.max(1, Math.round(d / MIN))
    return `in ${m} minute${m === 1 ? '' : 's'}`
  }
  if (d < DAY) {
    const h = Math.max(1, Math.round(d / HOUR))
    return `in about ${h} hour${h === 1 ? '' : 's'}`
  }
  if (d < 2 * DAY) return 'tomorrow'
  if (d < 7 * DAY) return `in ${Math.round(d / DAY)} days`
  return `on ${new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric' })}`
}

/** The geocoder hands back names like "Philippines (the)". Nobody says that. */
const clean = (n: string) => n.replace(/\s*\(the\)$/i, '')

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!getToken()) {
      navigate('/start')
      return
    }
    fetchDashboard()
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken()
          navigate('/start')
          return
        }
        setError(e instanceof Error ? e.message : 'Could not load your dashboard.')
      })
  }, [])

  /* Every country you have played leans one way or the other on the globe. */
  const tint = useMemo(() => {
    const t: CountryTint = {}
    for (const c of data?.countries ?? []) {
      if (c.rounds >= 1) t[c.code] = c.correct / c.rounds >= 0.5 ? 'good' : 'bad'
    }
    return t
  }, [data])

  const recent = useMemo(
    () => [...(data?.rounds ?? [])].sort((a, b) => +new Date(b.ts) - +new Date(a.ts)).slice(0, 12),
    [data],
  )

  const signOut = () => {
    clearToken()
    navigate('/')
  }

  if (error) {
    return (
      <div className="shell">
        <div className="dashHead">
          <Wordmark />
        </div>
        <p className="loading">{error}</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="shell">
        <div className="dashHead">
          <Wordmark />
        </div>
        <p className="loading">Reading your deck…</p>
      </div>
    )
  }

  const { deck, metas, totals } = data
  const empty = totals.rounds === 0
  const pct = totals.correctPct === null ? null : Math.round(totals.correctPct)
  const next = whenNext(deck.nextDue)

  /* the rest of the numbers, told as a sentence rather than a wall of tiles */
  const met =
    `You have met ${deck.introduced} of ${deck.total} clues across ${totals.rounds.toLocaleString()} rounds` +
    (pct !== null ? `, and you name the right country ${pct}% of the time.` : '.')
  const bits: string[] = []
  if (metas.total > 0) bits.push(`${metas.solid} of ${metas.total} are holding solid`)
  if (deck.learning > 0) bits.push(`${deck.learning} ${deck.learning === 1 ? 'is' : 'are'} still bedding in`)
  const holding = bits.length > 0 ? bits.join(', ') + '.' : ''

  return (
    <div className="shell">
      <div className="dashHead">
        <Wordmark />
        <div className="who">
          <b>{data.name}</b>
          <button className="quiet" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="dashHero">
        <div className="globeWrap">
          <Globe tint={tint} />
          {!empty && <p className="globeNote">Green where you hold it. Amber where it slips.</p>}
        </div>

        {empty ? (
          <div className="emptyState">
            <p>No rounds yet.</p>
            <p className="lede">Play a game with the userscript running and this fills in.</p>
            <Link to="/start" className="btn">
              Finish setup <span className="arr">→</span>
            </Link>
          </div>
        ) : (
          <div className="story">
            {deck.due > 0 ? (
              <>
                <h1 className="storyHead">
                  <span className="due">{deck.due}</span> {deck.due === 1 ? 'clue is' : 'clues are'} ready for review.
                </h1>
                <p>They come back to you in your next rounds, so the thing to do now is play.</p>
              </>
            ) : (
              <>
                <h1 className="storyHead">Nothing is due right now.</h1>
                <p>
                  {next
                    ? `Your next review lands ${next}. Play anyway and new clues join the deck.`
                    : 'Play a few rounds and new clues will join the deck.'}
                </p>
              </>
            )}

            <p className="small">
              {met} {holding}
            </p>
          </div>
        )}
      </div>

      {!empty && (
        <div className="cols">
          <div className="col">
            <h2>Slipping</h2>
            {metas.weakest.length === 0 && <p className="empty">Nothing is slipping right now.</p>}
            {metas.weakest.map((m) => (
              <div className="slipRow" key={m.metaName}>
                <span className="nm">{m.metaName}</span>
                <span className="sc">
                  {m.correct}/{m.seen}
                </span>
                {m.lapses > 0 && (
                  <span className="lp">
                    forgotten {m.lapses} {m.lapses === 1 ? 'time' : 'times'}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="col">
            <h2>Recent rounds</h2>
            {recent.map((r) => (
              <div className="roundRow" key={r.id}>
                <i className={r.correct ? 'ok' : 'no'} />
                <span className="place">
                  {r.country ? clean(r.country) : 'Unknown'}
                  {!r.correct && r.guessCountry && <s> read as {clean(r.guessCountry)}</s>}
                </span>
                <span className="when">{ago(r.ts)}</span>
                {r.metaName && <span className="meta">{r.metaName}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <footer>
        <Link to="/">GeoCoach</Link>
        <span>Updated {ago(data.generatedAt)}</span>
      </footer>
    </div>
  )
}
