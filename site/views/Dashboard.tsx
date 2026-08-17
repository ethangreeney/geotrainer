import { useEffect, useMemo, useRef, useState } from 'react'
import Globe from '../GlobeLazy'
import type { CountryTint } from '../Globe'
import { Link, Wordmark, navigate } from '../router'
import { ApiError, clearToken, fetchDashboard, getToken, type DashboardData, type WeakMeta } from '../api'

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

/** Meta keys arrive as "Cambodia: Pole" — the country is an overline, not a title. */
function splitMeta(name: string) {
  const i = name.indexOf(': ')
  return i < 0 ? { country: null, clue: name } : { country: name.slice(0, i), clue: name.slice(i + 2) }
}

/** One slipping clue: its picture, its name, and how badly it is going. */
function SlipCard({ m }: { m: WeakMeta }) {
  const { country, clue } = splitMeta(m.metaName)
  const inner = (
    <>
      <div className="shot">
        {m.image ? (
          <img src={m.image} alt={clue} loading="lazy" decoding="async" />
        ) : (
          <span className="noShot">No picture for this one</span>
        )}
      </div>
      {country && <span className="where">{country}</span>}
      <span className="clue">{clue}</span>
      <span className="tally">
        {m.correct} of {m.seen} right
        {m.lapses > 0 && (
          <em>
            {' '}
            · forgotten {m.lapses} {m.lapses === 1 ? 'time' : 'times'}
          </em>
        )}
      </span>
    </>
  )
  return m.image ? (
    <a className="slipCard" href={m.image} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <div className="slipCard is-blank">{inner}</div>
  )
}

/** A rail you can drag, wheel or step through — the arrows fade out at the ends. */
function SlipStrip({ metas }: { metas: WeakMeta[] }) {
  const rail = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: true })

  useEffect(() => {
    const el = rail.current
    if (!el) return
    const read = () =>
      setEdge({
        start: el.scrollLeft < 8,
        end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8,
      })
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [metas])

  const step = (dir: 1 | -1) => {
    const el = rail.current
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' })
  }

  return (
    <>
      <div className="secHead">
        <div>
          <h2>Slipping</h2>
          <p className="secNote">The clues you keep misreading. Open one to see it full size.</p>
        </div>
        <div className="stepper">
          <button aria-label="Scroll left" disabled={edge.start} onClick={() => step(-1)}>
            ←
          </button>
          <button aria-label="Scroll right" disabled={edge.end} onClick={() => step(1)}>
            →
          </button>
        </div>
      </div>
      <div
        className={`slipRail${edge.start ? ' at-start' : ''}${edge.end ? ' at-end' : ''}`}
        ref={rail}
      >
        {metas.map((m) => (
          <SlipCard key={m.metaName} m={m} />
        ))}
      </div>
    </>
  )
}

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
        <>
          <section className="dashSec">
            {metas.weakest.length === 0 ? (
              <>
                <div className="secHead">
                  <div>
                    <h2>Slipping</h2>
                  </div>
                </div>
                <p className="empty">Nothing is slipping right now.</p>
              </>
            ) : (
              <SlipStrip metas={metas.weakest} />
            )}
          </section>

          <section className="dashSec">
            <div className="secHead">
              <div>
                <h2>Recent rounds</h2>
                <p className="secNote">Where you landed, and what you read it as.</p>
              </div>
            </div>
            <div className="roundList">
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
          </section>
        </>
      )}

      <footer>
        <Link to="/">GeoCoach</Link>
        <span>Updated {ago(data.generatedAt)}</span>
      </footer>
    </div>
  )
}
