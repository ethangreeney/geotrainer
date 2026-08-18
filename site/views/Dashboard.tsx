import { useEffect, useMemo, useState } from 'react'
import { Foot, Link, Mast, navigate } from '../router'
import {
  ApiError,
  clearToken,
  fetchDashboard,
  getToken,
  type CountryStat,
  type DashboardData,
  type RoundStat,
  type WeakMeta,
} from '../api'
import { useWidth } from '../measure'

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
  const d = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`
  return `${d(lat, 'N', 'S')} ${d(lng, 'E', 'W')}`
}

/** The geocoder hands back names like "Philippines (the)". Nobody says that. */
const clean = (n: string) => n.replace(/\s*\(the\)$/i, '')

/** Meta keys arrive as "Cambodia: Pole" — the country is an overline, not a title. */
function splitMeta(name: string) {
  const i = name.indexOf(': ')
  return i < 0 ? { country: null, clue: name } : { country: name.slice(0, i), clue: name.slice(i + 2) }
}

/* ==========================================================================
   Figures. Both are hand-drawn SVG on theme.css's validated ramps: the
   diverging amber<->blue scale for "how right am I here", the lime ordinal
   ramp for anything that is just a quantity.
   ========================================================================== */

/** Accuracy buckets, cold (wrong) to warm (right), around the 50% midpoint. */
const DV = ['var(--d1)', 'var(--d2)', 'var(--d3)', 'var(--d4)', 'var(--d5)', 'var(--d6)', 'var(--d7)']
const bucket = (acc: number) =>
  acc < 0.2 ? 0 : acc < 0.35 ? 1 : acc < 0.45 ? 2 : acc < 0.55 ? 3 : acc < 0.7 ? 4 : acc < 0.85 ? 5 : 6

function Countries({ rows }: { rows: CountryStat[] }) {
  const [box, W] = useWidth()
  const top = rows.slice(0, 12)
  const max = Math.max(...top.map((c) => c.rounds), 1)
  const rowH = 27
  const x0 = 104
  const w = Math.max(60, W - x0 - 72) // the right gutter holds "41 · 90%"
  const h = top.length * rowH + 10
  return (
    <>
      <div className="fig" ref={box}>
        {W > 0 && (
      <svg className="chart" width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img"
        aria-label="Rounds played per country, shaded by how often you called the country right">
        <line className="axis" x1={x0} x2={x0} y1={2} y2={h - 8} />
        {top.map((c, i) => {
          const y = i * rowH + 2
          const acc = c.rounds ? c.correct / c.rounds : 0
          const bw = Math.max(2, (c.rounds / max) * w)
          return (
            <g key={c.code}>
              <text className="lbl" x={x0 - 8} y={y + 17} textAnchor="end">
                {clean(c.name).length > 15 ? clean(c.name).slice(0, 14) + '…' : clean(c.name)}
              </text>
              <rect x={x0} y={y + 5} width={bw} height={16} rx={2} fill={DV[bucket(acc)]} />
              <text className="tick" x={x0 + bw + 7} y={y + 17.5}>
                {c.rounds} · {Math.round(acc * 100)}%
              </text>
            </g>
          )
        })}
      </svg>
        )}
      </div>
      <div className="ramp">
        <span className="tag">Called it wrong</span>
        <span className="sw" aria-hidden>
          {DV.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </span>
        <span className="tag">Called it right</span>
      </div>
    </>
  )
}

function Scores({ rounds }: { rounds: RoundStat[] }) {
  const [box, W] = useWidth()
  const pts = rounds.filter((r) => r.score !== null).slice(0, 24).reverse()
  if (pts.length < 3) return <p className="empty">Not enough scored rounds yet.</p>
  const x0 = 30
  const y0 = 6
  /* The plot stops short of the frame so the mean can be labelled in a gutter
     instead of on top of the bars it is describing. */
  const w = Math.max(60, W - x0 - 76)
  const h = 150
  const H = h + 32
  const band = w / pts.length
  const mean = pts.reduce((a, r) => a + (r.score ?? 0), 0) / pts.length
  const sy = (v: number) => (v / 5000) * h
  return (
    <>
      <div className="fig" ref={box}>
        {W > 0 && (
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="Score for each of your most recent rounds, with the mean marked">
        {[0, 2500, 5000].map((t) => (
          <g key={t}>
            <line className="gridline" x1={x0} x2={x0 + w} y1={y0 + h - sy(t)} y2={y0 + h - sy(t)} />
            <text className="tick" x={x0 - 6} y={y0 + h - sy(t) + 3.5} textAnchor="end">
              {t / 1000}k
            </text>
          </g>
        ))}
        {pts.map((r, i) => {
          const v = r.score ?? 0
          return (
            <rect
              key={r.id}
              x={x0 + i * band + band * 0.2}
              y={y0 + h - sy(v)}
              width={band * 0.6}
              height={Math.max(1, sy(v))}
              rx={1.5}
              fill={r.correct ? 'var(--o4)' : 'var(--o1)'}
            />
          )
        })}
        <line
          className="axis"
          x1={x0}
          x2={x0 + w}
          y1={y0 + h - sy(mean)}
          y2={y0 + h - sy(mean)}
          strokeDasharray="3 3"
        />
        <text className="tick" x={x0 + w + 7} y={y0 + h - sy(mean) + 3.5}>
          mean {Math.round(mean).toLocaleString()}
        </text>
        <line className="axis" x1={x0} x2={x0 + w} y1={y0 + h} y2={y0 + h} />
        <text className="tick" x={x0} y={y0 + h + 16}>
          oldest
        </text>
        <text className="tick" x={x0 + w} y={y0 + h + 16} textAnchor="end">
          latest
        </text>
      </svg>
        )}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--o4)' }} /> Country called right
        </span>
        <span>
          <i style={{ background: 'var(--o1)' }} /> Called wrong
        </span>
      </div>
    </>
  )
}

/** One slipping clue as a log row: thumbnail, name, hit rate, lapses. */
function Slip({ m }: { m: WeakMeta }) {
  const { country, clue } = splitMeta(m.metaName)
  const pct = m.seen > 0 ? Math.round((m.correct / m.seen) * 100) : 0
  const inner = (
    <>
      {/* A clue with no stored photo gets a quiet empty slot, not the words
          "no photo" six times down the panel. */}
      <span className={'shot' + (m.image ? '' : ' none')} aria-hidden>
        {m.image && <img src={m.image} alt="" loading="lazy" decoding="async" />}
      </span>
      <span className="nm">
        {country && <span className="where">{country}</span>}
        <span className="what">{clue}</span>
      </span>
      <span className="rt">
        <span className="pc mono">{pct}%</span>
        <span className="meter warm">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="tally">
          {m.correct}/{m.seen}
          {m.lapses > 0 && ` · ${m.lapses} lapsed`}
        </span>
      </span>
    </>
  )
  return m.image ? (
    <a className="wk" href={m.image} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <div className="wk">{inner}</div>
  )
}

/* ========================================================================== */
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

  const recent = useMemo(
    () => [...(data?.rounds ?? [])].sort((a, b) => +new Date(b.ts) - +new Date(a.ts)),
    [data],
  )
  const byRounds = useMemo(
    () => [...(data?.countries ?? [])].sort((a, b) => b.rounds - a.rounds),
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
  const log = recent.slice(0, 16)
  const seenShare = deck.total > 0 ? (deck.introduced / deck.total) * 100 : 0

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
          <span className="sep">/</span>
          <span>Read {ago(data.generatedAt)}</span>
        </div>

        {empty ? (
          <div className="panel cta" style={{ marginTop: 26 }}>
            <div>
              <h3>No rounds captured yet.</h3>
              <p>Play one game with the userscript running and this console fills in.</p>
            </div>
            <Link to="/start" className="btn">
              Finish setup <span className="arr">→</span>
            </Link>
          </div>
        ) : (
          <>
            <div className="dashHead">
              <div>
                <h1>
                  {deck.due === 0
                    ? 'Nothing is due right now.'
                    : `${deck.due} clue${deck.due === 1 ? '' : 's'} ${deck.due === 1 ? 'is' : 'are'} ready for review.`}
                </h1>
                <p className="say">
                  {deck.due > 0
                    ? 'They come back as locations in your next rounds, so the thing to do now is play.'
                    : next
                      ? `Your next review lands ${next}. Play anyway and new clues join the deck.`
                      : 'Play a few rounds and new clues will join the deck.'}
                </p>
              </div>
              <a className="btn" href="https://www.geoguessr.com/" target="_blank" rel="noreferrer">
                Play a round <span className="arr">→</span>
              </a>
            </div>

            <div className="grid">
              <div className="panel c12">
                <div className="body flush">
                  <div className="kpis">
                    <div className={'kpi' + (deck.due > 0 ? ' hot' : '')}>
                      <div className="k">Due now</div>
                      <div className="v">{deck.due.toLocaleString()}</div>
                      <div className="sub">{next ? `next ${next}` : 'nothing queued'}</div>
                    </div>
                    <div className="kpi">
                      <div className="k">Rounds played</div>
                      <div className="v">{totals.rounds.toLocaleString()}</div>
                      <div className="sub">{last ? ago(last.ts) : '—'}</div>
                    </div>
                    <div className="kpi">
                      <div className="k">Country right</div>
                      <div className="v">{pct === null ? '—' : `${pct}%`}</div>
                      <div className="sub">{byRounds.length} countries</div>
                    </div>
                    <div className="kpi cool">
                      <div className="k">Holding solid</div>
                      <div className="v">
                        {metas.solid.toLocaleString()} <u>/ {metas.total.toLocaleString()}</u>
                      </div>
                      <div className="sub">clues you keep calling</div>
                    </div>
                    <div className="kpi">
                      <div className="k">Bedding in</div>
                      <div className="v">{deck.learning.toLocaleString()}</div>
                      <div className="sub">still short intervals</div>
                    </div>
                    <div className="kpi">
                      <div className="k">Not yet seen</div>
                      <div className="v">{deck.unseen.toLocaleString()}</div>
                      <div className="sub">waiting in the deck</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Two stacked columns rather than two rows of pairs: a short panel
                  no longer has to stretch to a tall neighbour's height. */}
              <div className="col c5">
              <div className="panel">
                <header>
                  <h2>Deck</h2>
                  <span className="note">
                    <b>{deck.introduced.toLocaleString()}</b> of {deck.total.toLocaleString()} introduced
                  </span>
                </header>
                <div className="body">
                  <div className="stack" aria-hidden>
                    <i style={{ width: `${seenShare}%`, background: 'var(--o3)' }} />
                    <i style={{ width: `${100 - seenShare}%`, background: 'var(--nodata)' }} />
                  </div>
                  <div className="legend">
                    <span>
                      <i style={{ background: 'var(--o3)' }} /> Introduced
                    </span>
                    <span>
                      <i style={{ background: 'var(--nodata)' }} /> Not yet seen
                    </span>
                  </div>
                  <div className="tbl dk" style={{ marginTop: 12 }}>
                    {[
                      { k: 'Due now', v: deck.due, of: deck.introduced, warm: true },
                      { k: 'Bedding in', v: deck.learning, of: deck.introduced, warm: true },
                      { k: 'Holding solid', v: metas.solid, of: metas.total, warm: false },
                      { k: 'Shaky', v: metas.shaky, of: metas.total, warm: true },
                      { k: 'Not yet seen', v: deck.unseen, of: deck.total, warm: false },
                    ].map((r) => (
                      <div className="r" key={r.k}>
                        <span className="nm">{r.k}</span>
                        <span className={'meter' + (r.warm ? ' warm' : '')}>
                          <i style={{ width: `${r.of > 0 ? Math.min(100, (r.v / r.of) * 100) : 0}%` }} />
                        </span>
                        <span className="num rt">{r.v.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <p className="hint" style={{ marginTop: 12 }}>
                    {next ? `Next clue comes back ${next}.` : 'Nothing scheduled yet.'}
                  </p>
                </div>
              </div>

              <div className="panel">
                <header>
                  <h2>Where you play</h2>
                  <span className="note">rounds, shaded by hit rate</span>
                </header>
                <div className="body">
                  {byRounds.length === 0 ? <p className="empty">No countries yet.</p> : <Countries rows={byRounds} />}
                </div>
              </div>
              </div>

              <div className="col c7">
              <div className="panel">
                <header>
                  <h2>Slipping</h2>
                  <span className="note">
                    weakest <b>{Math.min(metas.weakest.length, 6)}</b> of {metas.total.toLocaleString()}
                  </span>
                </header>
                <div className="body flush">
                  {metas.weakest.length === 0 ? (
                    <p className="empty">Nothing is slipping right now.</p>
                  ) : (
                    <div className="wks">
                      {metas.weakest.slice(0, 6).map((m) => (
                        <Slip key={m.metaName} m={m} />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="panel">
                <header>
                  <h2>Recent scores</h2>
                  <span className="note">last {Math.min(recent.length, 24)} rounds</span>
                </header>
                <div className="body">
                  <Scores rounds={recent} />
                </div>
              </div>
              </div>

              <div className="panel c12">
                <header>
                  <h2>Round log</h2>
                  <span className="note">last {log.length}</span>
                </header>
                <div className="body flush">
                  <div className="log">
                    <div className="r head" aria-hidden>
                      <span />
                      <span>Location</span>
                      <span>Clue</span>
                      <span>Fix</span>
                      <span className="rt">Distance</span>
                      <span className="rt">When</span>
                    </div>
                    {log.map((r) => (
                      <div className="r" key={r.id}>
                        <span
                          className={'dot ' + (r.correct ? 'ok' : 'no')}
                          title={r.correct ? 'Country called right' : 'Country called wrong'}
                        />
                        <span className="place">
                          {r.country ? clean(r.country) : 'Unknown'}
                          {!r.correct && r.guessCountry && <s> — read as {clean(r.guessCountry)}</s>}
                        </span>
                        <span className="clue">{r.metaName ?? '—'}</span>
                        <span className="num">{fix(r.to)}</span>
                        <span className="num rt">
                          {r.distanceKm === null ? '—' : `${Math.round(r.distanceKm).toLocaleString()} km`}
                        </span>
                        <span className="num rt">{ago(r.ts)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <Foot>
        <Link to="/">GeoCoach</Link>
        <span>Console read {ago(data.generatedAt)}</span>
      </Foot>
    </>
  )
}
