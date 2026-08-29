import { useEffect, useMemo, useState } from 'react'
import { Foot, Link, Mast, navigate } from '../router'
import {
  ApiError,
  clearToken,
  fetchDashboard,
  getToken,
  setDailyNew,
  type CountryStat,
  type DashboardData,
  type HeldPoint,
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

/** The geocoder hands back names like "Philippines (the)". Nobody says that. */
const clean = (n: string) => n.replace(/\s*\(the\)$/i, '')

/** Meta keys arrive as "Cambodia: Pole" — the country is an overline, not a title. */
function splitMeta(name: string) {
  const i = name.indexOf(': ')
  return i < 0 ? { country: null, clue: name } : { country: name.slice(0, i), clue: name.slice(i + 2) }
}

/* ==========================================================================
   Figures. All hand-drawn SVG on theme.css's validated ramps: the diverging
   amber<->blue scale for "how right am I here", the lime ordinal ramp for
   anything that is just a quantity.
   ========================================================================== */

/** Accuracy buckets, cold (wrong) to warm (right), around the 50% midpoint. */
const DV = ['var(--d1)', 'var(--d2)', 'var(--d3)', 'var(--d4)', 'var(--d5)', 'var(--d6)', 'var(--d7)']
const bucket = (acc: number) =>
  acc < 0.2 ? 0 : acc < 0.35 ? 1 : acc < 0.45 ? 2 : acc < 0.55 ? 3 : acc < 0.7 ? 4 : acc < 0.85 ? 5 : 6

/**
 * Ticks a person would actually draw: 0, then round steps up to the cap.
 *
 * The old chart labelled 0 / half / top, which on a 370-clue deck printed
 * "185" as the middle gridline. Nobody reads a chart in halves of 370.
 */
function niceStep(span: number) {
  const raw = Math.max(span / 4, 1)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
}

function ticksTo(top: number) {
  const step = niceStep(top)
  const out: number[] = []
  for (let v = 0; v <= top + 1e-6; v += step) out.push(v)
  return out
}

/**
 * The top of the y-axis: zero to one round step above the highest reading,
 * never past the size of the deck.
 *
 * Scaling to the whole 370-clue deck instead put the line in the bottom third
 * with two thirds of the box empty, which flattened the only thing the chart
 * is for. The count of clues still sits in the headline directly above, so
 * nothing is lost by not repeating the denominator here.
 */
function ceilingFor(series: HeldPoint[], total: number) {
  const peak = Math.max(...series.map((p) => p.held), 1)
  const step = niceStep(peak)
  return Math.min(Math.max(total, 1), Math.ceil((peak + step * 0.35) / step) * step)
}

const day = (t: string) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })

/**
 * The headline number, plotted. One quantity over time, so: an area, one hue —
 * the top step of theme.css's validated lime ordinal ramp — and no legend,
 * because the heading above it already names the only series there is.
 *
 * A brand-new account has one reading. A single point joined to nothing used to
 * be hidden entirely (the section was gated at two points), which meant the
 * chart appeared out of nowhere on the second day; now one point draws as one
 * point, on a full axis, with its value beside it.
 */
function Climb({ series, total }: { series: HeldPoint[]; total: number }) {
  const [box, W] = useWidth()
  const [at, setAt] = useState<number | null>(null)
  const x0 = 44
  const y0 = 10
  const h = 168
  /* The right gutter is the end label's, so the current value never sits on
     top of the line that produced it. */
  const gutter = 62
  const H = y0 + h + 26
  const w = Math.max(60, W - x0 - gutter)
  const top = ceilingFor(series, total)
  const lone = series.length < 2
  const last = series[series.length - 1]
  /* A single reading sits at the START of the axis, not the end: the empty
     half of the box is the days that have not happened yet, and the one date
     label has to be under the one point that carries it. */
  const sx = (i: number) => (lone ? x0 : x0 + (i / (series.length - 1)) * w)
  const sy = (v: number) => y0 + h - (Math.min(v, top) / top) * h
  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i)} ${sy(p.held)}`).join(' ')

  const pick = (e: React.PointerEvent<SVGRectElement>) => {
    if (lone) return setAt(0)
    const x = e.nativeEvent.offsetX
    const i = Math.round(((x - x0) / w) * (series.length - 1))
    setAt(Math.min(series.length - 1, Math.max(0, i)))
  }
  const shown = at === null ? null : series[at]

  return (
    <div className="fig" ref={box}>
      {W > 0 && (
        <svg
          className="chart"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Clues held at ninety per cent recall, ${day(series[0].t)} to ${day(last.t)}: ${
            series[0].held
          } rising to ${last.held} of ${total}.`}
        >
          {ticksTo(top).map((t) => (
            <g key={t}>
              <line className="gridline" x1={x0} x2={x0 + w} y1={sy(t)} y2={sy(t)} />
              <text className="tick" x={x0 - 9} y={sy(t) + 3.5} textAnchor="end">
                {t.toLocaleString()}
              </text>
            </g>
          ))}

          {/* A wash under the line, not a block. A flat 12% fill on this plane
              came out as a grey slab with a hard top edge that competed with
              the line bounding it; fading it to nothing at the baseline keeps
              the same ~10% of ink and lets it read as an amount. */}
          {!lone && (
            <>
              <defs>
                <linearGradient id="climbWash" x1="0" y1={y0} x2="0" y2={y0 + h} gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="var(--o4)" stopOpacity={0.24} />
                  <stop offset="100%" stopColor="var(--o4)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <path
                d={`${line} L${sx(series.length - 1)} ${y0 + h} L${x0} ${y0 + h} Z`}
                fill="url(#climbWash)"
              />
              <path d={line} fill="none" stroke="var(--o4)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          )}

          {shown && !lone && (
            <>
              <line className="crosshair" x1={sx(at!)} x2={sx(at!)} y1={y0} y2={y0 + h} />
              <circle cx={sx(at!)} cy={sy(shown.held)} r={4} fill="var(--o4)" stroke="var(--plane)" strokeWidth={2} />
            </>
          )}

          {/* The end marker wears a ring in the surface colour so it stays a
              disc where it crosses the axis or the gridline behind it. */}
          <circle cx={sx(series.length - 1)} cy={sy(last.held)} r={4.5} fill="var(--o4)"
            stroke="var(--plane)" strokeWidth={2} />
          <text className="endLabel" x={sx(series.length - 1) + 11} y={sy(last.held) + 4}>
            {last.held.toLocaleString()}
          </text>

          <line className="axis" x1={x0} x2={x0 + w} y1={y0 + h} y2={y0 + h} />
          <text className="tick" x={x0} y={y0 + h + 17}>
            {day(series[0].t)}
          </text>
          {!lone && (
            <text className="tick" x={x0 + w} y={y0 + h + 17} textAnchor="end">
              {day(last.t)}
            </text>
          )}

          <rect className="hit" x={x0} y={y0} width={w} height={h}
            onPointerMove={pick} onPointerLeave={() => setAt(null)} />
        </svg>
      )}

      {shown && (
        <div
          className="figTip"
          style={{ left: Math.min(Math.max(sx(at!), 62), Math.max(W - 62, 62)), top: sy(shown.held) - 14 }}
        >
          <span className="h">{day(shown.t)}</span>
          <span className="v">{shown.held.toLocaleString()} held</span>
        </div>
      )}

      {/* The figure is a picture; this is the same numbers as text, for anyone
          who cannot hover one. */}
      <table className="sr">
        <caption>Clues held at 90% recall, by date</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Clues held</th>
          </tr>
        </thead>
        <tbody>
          {series.map((p) => (
            <tr key={p.t}>
              <td>{day(p.t)}</td>
              <td>{p.held.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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

/** One clue worth another look: thumbnail, name, hit rate so far. */
function Work({ m }: { m: WeakMeta }) {
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

/**
 * The one setting there is: how many never-seen clues a day may introduce.
 *
 * It sits under the deck table rather than anywhere near the hero because it
 * is a number a person changes about twice ever — once when ten a day turns
 * out to be more than an evening, once when it turns out to be less. So: a
 * row, not a page.
 *
 * The value shown after a write is the one the Worker echoes back, not the one
 * that was typed. A refused write must not leave the box displaying a setting
 * nobody has stored — and the Worker's refusal is already a sentence written
 * for a person, so it is printed as it arrived rather than translated.
 */
function NewPerDay({ initial }: { initial: number }) {
  const [value, setValue] = useState(String(initial))
  const [saved, setSaved] = useState(initial)
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [err, setErr] = useState<string | null>(null)

  const commit = async () => {
    const n = Number(value.trim())
    /* A box left empty or half-typed is not a request to change anything, and
       neither is retyping the number already stored. Both put back what is
       stored rather than spending a round trip to be told so. */
    if (state === 'saving' || value.trim() === '' || !Number.isFinite(n) || n === saved) {
      setValue(String(saved))
      return
    }
    setState('saving')
    setErr(null)
    try {
      const { config } = await setDailyNew(n)
      setSaved(config.dailyNew)
      setValue(String(config.dailyNew))
      setState('saved')
    } catch (e) {
      /* Left as typed on purpose: the message says what is wrong with this
         number, and it is easier to fix a number you can still see. */
      setErr(e instanceof Error ? e.message : 'Could not save that.')
      setState('idle')
    }
  }

  return (
    <div className="knob">
      <div className="knobRow">
        <label className="knobName" htmlFor="dailyNew">
          New clues per day
        </label>
        <input
          id="dailyNew"
          className="field knobIn"
          type="number"
          min={0}
          max={100}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={state === 'saving'}
          onChange={(e) => {
            setValue(e.target.value)
            setState('idle')
            setErr(null)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="knobState" role="status">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? `Saved · ${saved}` : ''}
        </span>
      </div>
      <p className="knobSay">
        Every new clue costs about ten reviews later on, which is why the default is 10. Set it to 0 to review what
        you have and meet nothing new.
      </p>
      {err && <p className="err">{err}</p>}
    </div>
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

  /* Signing out of a passwordless account is not signing out — it is throwing
     the account away, because the link in localStorage is the only credential
     that exists and nothing else can reissue it. One unguarded click sat
     between a player and every round they had ever graded. So the control asks
     first, and it asks with the link on screen and a copy button next to it:
     the answer to "are you sure" is only useful if you can act on it. */
  const [leaving, setLeaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const signin = `${window.location.origin}/app?token=${getToken() ?? ''}`

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(signin)
      setCopied(true)
    } catch {
      /* clipboard refused: the link is on screen to select by hand */
    }
  }

  const signOut = () => {
    clearToken()
    navigate('/')
  }

  /* A dashboard is one network round trip behind a blank page, and on a slow
     connection the blank page was all there was. This is the shape of the
     answer, held while the answer is still in flight, so nothing jumps when it
     lands. */
  if (!data && !error) {
    return (
      <>
        <Mast />
        <div className="shell">
          <p className="sr" role="status">
            Loading your dashboard…
          </p>
          <div className="skelHold" aria-hidden>
            <div className="skel t" />
            <div className="skel t" style={{ width: '58%' }} />
            <div className="skel bar" />
            <div className="skel p" style={{ width: '76%' }} />
            <div className="skel key" />
          </div>
        </div>
      </>
    )
  }

  /* api.ts has already turned the status code into a sentence a person can act
     on, so the job here is only to make it look like a state and not like a
     crash — and to offer the retry, because most of these are transient. */
  if (!data) {
    return (
      <>
        <Mast />
        <div className="shell">
          <div className="panel blown" role="alert">
            <h1>That didn’t load.</h1>
            <p>{error}</p>
            <button className="btn" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        </div>
      </>
    )
  }

  const { deck, metas, totals } = data
  const empty = totals.rounds === 0
  const pct = totals.correctPct === null ? null : Math.round(totals.correctPct)
  const next = whenNext(deck.nextDue)
  const log = recent.slice(0, 16)
  const seenShare = deck.total > 0 ? (deck.introduced / deck.total) * 100 : 0

  /* TEMPORARY. The Worker learned to send progress{} after this view learned to
     draw it; until that ships, stand in the count of clues holding solid, which
     is the nearest thing the old payload carries. Delete this line — not the
     code around it — once /api/dashboard always answers with progress. */
  const progress = data.progress ?? { held: metas.solid, total: deck.total, series: [] as HeldPoint[] }
  const held = Math.min(progress.held, progress.total)
  const heldShare = progress.total > 0 ? (held / progress.total) * 100 : 0

  /* What today still asks for, which the deck on its own cannot say: "nothing
     due" is equally true of a day with ten unmet clues still allowed and of a
     day that is genuinely finished. `day` is the thing that tells those apart.
     A Worker too old to send it leaves this line exactly as it has always
     read — the one unforgivable move here is calling a day done on no
     evidence, and then watching the map hand over another deck. */
  const day = data.day
  /* And which clues that "new left today" is a count of. It is the same
     allowance said in names instead of a number, so a day that is over — or a
     Worker too old to send the list — shows nothing rather than a heading over
     an empty box. */
  const newToday = day && !day.doneForToday ? (day.upNext ?? []) : []
  const upNext = day
    ? `${deck.due.toLocaleString()} due · ${day.newAllowance.toLocaleString()} new left today${
        next ? ` · next one back ${next}` : ''
      }`
    : deck.due > 0
      ? `${deck.due.toLocaleString()} due now${next ? ` · next one back ${next}` : ''}`
      : next
        ? `Nothing due · next one back ${next}`
        : 'Nothing due yet'

  return (
    <>
      <Mast>
        <span className="who">{data.name}</span>
        <button className="quiet" onClick={() => setLeaving(true)}>
          Sign out
        </button>
      </Mast>

      <div className="shell">
        {leaving && (
          <section className="panel leave">
            <h2>This link is the whole of your account.</h2>
            <p>
              There is no password to reset and no email to recover from, so signing out on the only browser that
              holds this link ends the account behind it. Save it first.
            </p>
            <div className="linkbox">
              <code>{signin}</code>
              <button onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="leaveCta">
              <button className="btn" onClick={() => setLeaving(false)}>
                Stay signed in
              </button>
              <button className="quiet" onClick={signOut}>
                Sign out anyway
              </button>
            </div>
          </section>
        )}
        {empty ? (
          /* The first screen everyone who signs up sees, and it has to read as
             a starting line rather than as a scoreline of nought. Same hero as
             the played-in console — same number, same rail, same sentence —
             because it is the same measure, only at the start of it. */
          <section className="hold">
            <p className="kicker">Starting line</p>
            <h1>
              <b>0</b> of {deck.total.toLocaleString()} clues held at 90%
            </h1>
            <div
              className="holdBar at0"
              role="img"
              aria-label={`None of the ${deck.total} clues in your deck are held yet`}
            >
              <i style={{ width: '0%' }} />
            </div>
            <p className="say">
              Every clue in the deck starts here. One round played with the userscript running moves this number, and
              it keeps moving on its own after that.
            </p>

            <div className="holdCta">
              <Link to="/start" className="btn big">
                Finish setup <span className="arr">→</span>
              </Link>
              <span className="hint">Two minutes, and only once.</span>
            </div>

            <ol className="beats">
              <li>
                <span className="no">01</span>
                <span>
                  <b>Play GeoGuessr as usual.</b> The userscript captures each round as it ends. Nothing to press, no
                  second app to keep open.
                </span>
              </li>
              <li>
                <span className="no">02</span>
                <span>
                  <b>Your pin is the grade.</b> Clues you called right get pushed months out; the ones you missed come
                  back within days.
                </span>
              </li>
              <li>
                <span className="no">03</span>
                <span>
                  <b>The map rebuilds itself.</b> Your trainer map is republished after every game, so the next round is
                  already the one you needed.
                </span>
              </li>
            </ol>
          </section>
        ) : (
          <>
            {/* The whole page in one figure: how much of the world you can
                actually call right now. Everything else is behind Details. */}
            <section className="hold">
              <h1>
                <b>{held.toLocaleString()}</b> of {progress.total.toLocaleString()} clues held at 90%
              </h1>
              <div className="holdBar" role="img"
                aria-label={`${held} of ${progress.total} clues held at ninety per cent recall`}>
                <i style={{ width: `${heldShare}%` }} />
              </div>
              <p className="say">
                Clues you would get right if they came up this minute. It falls again when you stop playing.
              </p>

              <a className="btn big" href="https://www.geoguessr.com/" target="_blank" rel="noreferrer">
                Play a round <span className="arr">→</span>
              </a>

              <p className="upNext">
                {day?.doneForToday ? (
                  <>
                    <span className="dayDone">✓ Done for today</span>
                    {next && ` · next one back ${next}`}
                  </>
                ) : (
                  upNext
                )}
              </p>

              {/* What today will actually teach, named. Quiet on purpose: it
                  sits under the one line that gets you into a game, and it is
                  an overview of the day rather than a second headline. */}
              {newToday.length > 0 && (
                <div className="nx">
                  <p className="nxHead">New today · {newToday.length}</p>
                  <ul className="nxList">
                    {newToday.map((meta) => {
                      const { country, clue } = splitMeta(meta.name)
                      return (
                        <li key={meta.name}>
                          <span className="nxWhat">{clue}</span>
                          {country && <span className="nxWhere">{country}</span>}
                        </li>
                      )
                    })}
                  </ul>
                  {/* The honest caveat: new clues queue behind what is owed, so
                      a heavy review day meets fewer of these than are listed. */}
                  <p className="nxSay">New clues come after the day's due reviews, as room allows.</p>
                </div>
              )}
            </section>

            {progress.series.length >= 1 && (
              <section className="climb">
                <h2>Held at 90%, over time</h2>
                <Climb series={progress.series} total={progress.total} />
                {progress.series.length === 1 && (
                  <p className="hint">One reading so far. The line joins up once you have played on a second day.</p>
                )}
              </section>
            )}

            {/* Everything the console used to open with, one click away. */}
            <details className="more">
              <summary>Details</summary>

              <div className="grid">
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
                      {/* The rate the last row of that table empties at, and
                          the only number on this page you set rather than
                          earn. It belongs under the deck it governs; an older
                          Worker sends no `day`, and with no stored value to
                          show the honest thing is no control at all. */}
                      {day && <NewPerDay initial={day.dailyNew} />}
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
                      <h2>Rounds</h2>
                      <span className="note">
                        <b>{totals.rounds.toLocaleString()}</b> played
                      </span>
                    </header>
                    <div className="body">
                      <div className="tbl dk">
                        <div className="r">
                          <span className="nm">Country called right</span>
                          <span className="meter">
                            <i style={{ width: `${pct ?? 0}%` }} />
                          </span>
                          <span className="num rt">{pct === null ? '—' : `${pct}%`}</span>
                        </div>
                        <div className="r">
                          <span className="nm">Countries played</span>
                          <span />
                          <span className="num rt">{byRounds.length}</span>
                        </div>
                      </div>
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
                        <span className="rt">Distance</span>
                        <span className="rt">When</span>
                      </div>
                      {log.map((r) => (
                        <div className="r" key={r.id}>
                          {/* A glyph, not a coloured disc. Right and wrong used
                              to be carried by hue alone, with the words shut
                              inside a title attribute only a mouse could reach. */}
                          <span className={'mk ' + (r.correct ? 'ok' : 'no')}>
                            <span aria-hidden>{r.correct ? '✓' : '✕'}</span>
                            <span className="sr">
                              {r.correct ? 'Country called right' : 'Country called wrong'}
                            </span>
                          </span>
                          <span className="place">
                            {r.country ? clean(r.country) : 'Unknown'}
                            {!r.correct && r.guessCountry && <s> — read as {clean(r.guessCountry)}</s>}
                          </span>
                          <span className="clue">{r.metaName ?? '—'}</span>
                          <span className="num rt">
                            {r.distanceKm === null ? '—' : `${Math.round(r.distanceKm).toLocaleString()} km`}
                          </span>
                          <span className="num rt">{ago(r.ts)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Last thing on the page on purpose. A clue the deck has not
                    got into you yet is a thing to practise, not a scoreline. */}
                {metas.weakest.length > 0 && (
                  <div className="panel c12">
                    <header>
                      <h2>Worth another look</h2>
                      <span className="note">clues the deck will bring back first</span>
                    </header>
                    <div className="body flush">
                      <div className="wks">
                        {metas.weakest.slice(0, 6).map((m) => (
                          <Work key={m.metaName} m={m} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </details>
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
