import { useEffect, useMemo, useRef, useState } from 'react'
import Globe from '../GlobeLazy'
import type { CountryTint } from '../Globe'
import { Foot, Link, Mast, navigate } from '../router'
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

/** Every round has a real fix behind it, so set it as one: 41.1496° N 8.6109° W */
function fix([lat, lng]: [number, number]) {
  const d = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`
  return `${d(lat, 'N', 'S')}  ${d(lng, 'E', 'W')}`
}

/** The geocoder hands back names like "Philippines (the)". Nobody says that. */
const clean = (n: string) => n.replace(/\s*\(the\)$/i, '')

/** Meta keys arrive as "Cambodia: Pole" — the country is an overline, not a title. */
function splitMeta(name: string) {
  const i = name.indexOf(': ')
  return i < 0 ? { country: null, clue: name } : { country: name.slice(0, i), clue: name.slice(i + 2) }
}

/** One slipping clue, plated and numbered: its picture, its name, its hit rate. */
function CluePlate({ m, n }: { m: WeakMeta; n: number }) {
  const { country, clue } = splitMeta(m.metaName)
  const rate = m.seen > 0 ? Math.round((m.correct / m.seen) * 100) : 0
  const plate = String(n).padStart(2, '0')
  const inner = (
    <>
      <div className="shot">
        <span className="pl">Pl. {plate}</span>
        {m.image ? (
          <img src={m.image} alt={clue} loading="lazy" decoding="async" />
        ) : (
          <span className="noShot">No picture</span>
        )}
      </div>
      <div className="body">
        {country && <span className="where">{country}</span>}
        <span className="what">{clue}</span>
        <span className="tally">
          {m.correct}/{m.seen} right
          {m.lapses > 0 && <em> · {m.lapses} forgotten</em>}
        </span>
        <span className="bar" aria-hidden>
          <span style={{ width: `${rate}%` }} />
        </span>
      </div>
    </>
  )
  return m.image ? (
    <a className="clue" href={m.image} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <div className="clue is-blank">{inner}</div>
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
      <div className="sheetHead">
        <span className="no">01</span>
        <h2>Slipping</h2>
        <span className="lead" />
        <span className="meta">
          {metas.length} {metas.length === 1 ? 'clue' : 'clues'}
        </span>
        <div className="pager">
          <button aria-label="Scroll left" disabled={edge.start} onClick={() => step(-1)}>
            ←
          </button>
          <button aria-label="Scroll right" disabled={edge.end} onClick={() => step(1)}>
            →
          </button>
        </div>
      </div>
      <p className="sheetNote">The clues you keep getting wrong. Click one to see the picture full size.</p>
      <div className={`rail${edge.start ? ' at-start' : ''}${edge.end ? ' at-end' : ''}`} ref={rail}>
        {metas.map((m, i) => (
          <CluePlate key={m.metaName} m={m} n={i + 1} />
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

  if (error || !data) {
    return (
      <>
        <Mast />
        <div className="shell">
          <p className="loading">{error ?? 'Reading your deck…'}</p>
        </div>
      </>
    )
  }

  const { deck, metas, totals } = data
  const empty = totals.rounds === 0
  const pct = totals.correctPct === null ? null : Math.round(totals.correctPct)
  const next = whenNext(deck.nextDue)
  const last = recent[0] ?? null

  return (
    <>
      <Mast>
        <span className="who">{data.name}</span>
        <button className="quiet" onClick={signOut}>
          Sign out
        </button>
      </Mast>

      <div className="shell">
        <div className="strip">
          <span>
            Deck <b>{deck.introduced.toLocaleString()}</b> / {deck.total.toLocaleString()} clues
          </span>
          {last && (
            <>
              <span className="sep">/</span>
              <span>
                Last fix <b>{fix(last.to)}</b> · {ago(last.ts)}
              </span>
            </>
          )}
        </div>

        <div className="dashHero">
          <figure className="plate">
            <Globe tint={tint} />
            <figcaption className="plateCap">
              <span className="tag">Fig. 1 — Countries played</span>
              {!empty && (
                <span className="legend">
                  <span>
                    <i className="h" />
                    <span className="tag">Hold</span>
                  </span>
                  <span>
                    <i className="s" />
                    <span className="tag">Slip</span>
                  </span>
                </span>
              )}
            </figcaption>
          </figure>

          {empty ? (
            <div className="emptyState">
              <span className="tag b">No data yet</span>
              <h1>No rounds captured.</h1>
              <p className="lede">Play a game with the userscript running and this sheet fills in.</p>
              <Link to="/start" className="btn">
                Finish setup <span className="arr">→</span>
              </Link>
            </div>
          ) : (
            <div className="story">
              <h1>
                <span className={'storyNum' + (deck.due === 0 ? ' zero' : '')}>{deck.due}</span>
                <span className="storyHead">
                  {deck.due === 1 ? 'clue is ready for review.' : 'clues are ready for review.'}
                </span>
              </h1>
              <p>
                {deck.due > 0
                  ? 'They come back to you in your next rounds, so the thing to do now is play.'
                  : next
                    ? `Your next review lands ${next}. Play anyway and new clues join the deck.`
                    : 'Play a few rounds and new clues will join the deck.'}
              </p>

              <dl className="readout">
                <div>
                  <dt>Rounds played</dt>
                  <dd>{totals.rounds.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Country called right</dt>
                  <dd>{pct === null ? '—' : `${pct}%`}</dd>
                </div>
                <div>
                  <dt>Holding solid</dt>
                  <dd className="hold">
                    {metas.solid.toLocaleString()} <small>/ {metas.total.toLocaleString()}</small>
                  </dd>
                </div>
                <div>
                  <dt>Bedding in</dt>
                  <dd>{deck.learning.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        {!empty && (
          <>
            <section className="dashSec">
              {metas.weakest.length === 0 ? (
                <>
                  <div className="sheetHead">
                    <span className="no">01</span>
                    <h2>Slipping</h2>
                    <span className="lead" />
                    <span className="meta">0 clues</span>
                  </div>
                  <p className="empty">Nothing is slipping right now.</p>
                </>
              ) : (
                <SlipStrip metas={metas.weakest} />
              )}
            </section>

            <section className="dashSec">
              <div className="sheetHead">
                <span className="no">02</span>
                <h2>Round log</h2>
                <span className="lead" />
                <span className="meta">Last {recent.length}</span>
              </div>
              <p className="sheetNote">Where you landed, and what you read it as.</p>

              <div className="log">
                <div className="logRow head" aria-hidden>
                  <span>No.</span>
                  <span>Location</span>
                  <span>Fix</span>
                  <span>Clue</span>
                  <span>When</span>
                </div>
                {recent.map((r, i) => (
                  <div className="logRow" key={r.id}>
                    <span className="n">
                      <i className={r.correct ? 'ok' : 'no'} />
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="place">
                      {r.country ? clean(r.country) : 'Unknown'}
                      {!r.correct && r.guessCountry && <s> — read as {clean(r.guessCountry)}</s>}
                    </span>
                    <span className="fix">{fix(r.to)}</span>
                    <span className="cluecol">{r.metaName ?? '—'}</span>
                    <span className="when">{ago(r.ts)}</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>

      <Foot>
        <Link to="/">GeoCoach</Link>
        <span>Sheet updated {ago(data.generatedAt)}</span>
      </Foot>
    </>
  )
}
