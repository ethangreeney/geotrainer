import { useEffect, useMemo, useRef, useState } from 'react'
import { Foot, Link, Mast, navigate } from '../router'
import {
  ApiError,
  clearToken,
  fetchDashboard,
  getToken,
  setDailyNew,
  setPins,
  type CountryStat,
  type DashboardData,
  type HeldPoint,
  type RoundStat,
  type UpNextMeta,
  type QueueMeta,
} from '../api'
import { demoData } from '../demo'
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

const n = (v: number) => v.toLocaleString()
const s = (v: number) => (v === 1 ? '' : 's')

/**
 * The camera that shows a clue, as a picture.
 *
 * Keyless and undocumented, but stable, and the only way to put the actual
 * imagery of an unseen clue on this page: the Worker cannot fetch it (the
 * endpoint 403s anything that sends no User-Agent) so it hands over the pano
 * id and the browser does the asking. Requested at twice the drawn size, since
 * the cards are small and every one of these is a texture — a pole, a line, a
 * kerb — that falls apart when it is resampled down from nothing.
 */
function thumb(panoId: string, heading: number | null, w: number, h: number) {
  const p = new URLSearchParams({
    cb_client: 'maps_sv.tactile.gps',
    w: String(w),
    h: String(h),
    panoid: panoId,
    yaw: String(heading ?? 0),
    pitch: '0',
  })
  return `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${p}`
}

/* ==========================================================================
   Figures. All hand-drawn SVG on theme.css's validated ramps: the diverging
   amber<->blue scale for "how right am I here", the lime ordinal ramp for
   anything that is just a quantity.
   ========================================================================== */

/** Accuracy buckets, cold (wrong) to warm (right), around the 50% midpoint. */
const DV = ['var(--d1)', 'var(--d2)', 'var(--d3)', 'var(--d4)', 'var(--d5)', 'var(--d6)', 'var(--d7)']
/**
 * Ticks a person would actually draw: 0, then round steps up to the cap.
 *
 * The old chart labelled 0 / half / top, which on a 370-clue deck printed
 * "185" as the middle gridline. Nobody reads a chart in halves of 370.
 */
function niceStep(span: number) {
  const raw = Math.max(span / 4, 1)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag
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
  const y0 = 12
  /* A fortnight of a slow-moving count: the shape is the subject, so the box
     is a band rather than a square. Taller than this and the half of it under
     the line is just empty floor. */
  const h = 168
  /* The right gutter is the end label's, so the current value never sits on
     top of the line that produced it. */
  const gutter = 62
  const H = y0 + h + 28
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
          {/* A floor for the wash to sit on. Without it the fill fades into the
              page itself and a fortnight of climbing reads as a grey smudge. */}
          <rect className="plot" x={x0} y={y0} width={w} height={h} rx={8} />

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
                  <stop offset="0%" stopColor="var(--lime)" stopOpacity={0.5} />
                  <stop offset="60%" stopColor="var(--lime)" stopOpacity={0.13} />
                  <stop offset="100%" stopColor="var(--lime)" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <path
                d={`${line} L${sx(series.length - 1)} ${y0 + h} L${x0} ${y0 + h} Z`}
                fill="url(#climbWash)"
              />
              <path d={line} fill="none" stroke="var(--lime)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          )}

          {shown && !lone && (
            <>
              <line className="crosshair" x1={sx(at!)} x2={sx(at!)} y1={y0} y2={y0 + h} />
              <circle cx={sx(at!)} cy={sy(shown.held)} r={4} fill="var(--lime)" stroke="var(--plane)" strokeWidth={2} />
            </>
          )}

          {/* The end marker wears a ring in the surface colour so it stays a
              disc where it crosses the axis or the gridline behind it. */}
          <circle cx={sx(series.length - 1)} cy={sy(last.held)} r={4.5} fill="var(--lime)"
            stroke="var(--plane)" strokeWidth={2} />
          <text className="endLabel" x={sx(series.length - 1) + 11} y={sy(last.held) + 4}>
            {last.held.toLocaleString()}
          </text>

          <line className="axis" x1={x0} x2={x0 + w} y1={y0 + h} y2={y0 + h} />
          <text className="tick" x={x0} y={y0 + h + 18}>
            {day(series[0].t)}
          </text>
          {!lone && (
            <text className="tick" x={x0 + w} y={y0 + h + 18} textAnchor="end">
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

/* Where ranked duels actually bleed points, country by country. The deck's
   new-clue order is built from exactly these numbers, so this list is the
   dealing order's explanation: the top row is why tomorrow's clues come from
   where they do. A region is only ever named here when the Worker judged the
   sample big enough to mean something — a "worst region" seen twice would
   flip with every game and teach nothing. */
function Duels({ rows }: { rows: CountryStat[] }) {
  const [box, W] = useWidth()
  const max = Math.max(...rows.map((c) => c.duelLost ?? 0), 1)
  const x0 = 112
  const w = Math.max(60, W - x0 - 76) // the right gutter holds "21k pts"
  const k = (v: number) => (v >= 9950 ? `${(v / 1000).toFixed(v >= 99500 ? 0 : 1)}k` : n(v))
  /* A named region earns its row a second, muted line under the bar — set
     there, at full row width, because no gutter in a half-column panel is
     wide enough for "38.9k pts · mostly Krasnoyarsk Krai" beside a near-max
     bar without the name sailing past the panel edge. */
  const rowH = (c: CountryStat) => (c.worstRegion ? 45 : 29)
  const ys = rows.reduce<number[]>((a, _c, i) => (a.push(i ? a[i - 1] + rowH(rows[i - 1])! : 2), a), [])
  const h = ys[rows.length - 1]! + rowH(rows[rows.length - 1]!) + 8
  return (
    <div className="fig" ref={box}>
      {W > 0 && (
        <svg className="chart" width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img"
          aria-label="Points lost in ranked duels, per country">
          <line className="axis" x1={x0} x2={x0} y1={2} y2={h - 8} />
          {rows.map((c, i) => {
            const y = ys[i]!
            const lost = c.duelLost ?? 0
            const bw = Math.max(2, (lost / max) * w)
            return (
              <g key={c.code}>
                <text className="lbl" x={x0 - 10} y={y + 18} textAnchor="end">
                  {clean(c.name).length > 15 ? clean(c.name).slice(0, 14) + '\u2026' : clean(c.name)}
                </text>
                <rect x={x0} y={y + 5} width={bw} height={17} rx={2.5} fill={DV[1]} />
                <text className="tick" x={x0 + bw + 8} y={y + 18}>
                  {k(lost)} pts
                </text>
                {c.worstRegion && (
                  <text className="sub" x={x0} y={y + 36}>
                    mostly {clean(c.worstRegion.name)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

function Scores({ rounds }: { rounds: RoundStat[] }) {
  const [box, W] = useWidth()
  const pts = rounds.filter((r) => r.score !== null).slice(0, 24).reverse()
  if (pts.length < 3) return <p className="empty">Not enough scored rounds yet.</p>
  const x0 = 32
  const y0 = 8
  /* The plot stops short of the frame so the mean can be labelled in a gutter
     instead of on top of the bars it is describing. */
  const w = Math.max(60, W - x0 - 82)
  const h = 186
  const H = h + 34
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
            <text className="tick" x={x0 - 7} y={y0 + h - sy(t) + 3.5} textAnchor="end">
              {t / 1000}k
            </text>
          </g>
        ))}
        {pts.map((r, i) => {
          const v = r.score ?? 0
          return (
            <rect
              key={r.id}
              x={x0 + i * band + band * 0.18}
              y={y0 + h - sy(v)}
              width={band * 0.64}
              height={Math.max(1, sy(v))}
              rx={2}
              fill={r.correct ? 'var(--o4)' : 'var(--d2)'}
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
        <text className="tick" x={x0 + w + 8} y={y0 + h - sy(mean) + 3.5}>
          mean {Math.round(mean).toLocaleString()}
        </text>
        <line className="axis" x1={x0} x2={x0 + w} y1={y0 + h} y2={y0 + h} />
        <text className="tick" x={x0} y={y0 + h + 17}>
          oldest
        </text>
        <text className="tick" x={x0 + w} y={y0 + h + 17} textAnchor="end">
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
          <i style={{ background: 'var(--d2)' }} /> Called wrong
        </span>
      </div>
    </>
  )
}

/** One card from the head of the queue: thumbnail, name, and the scheduler's
 * current odds you would still call it right — the number the queue is
 * actually ordered by. */
function Work({ m }: { m: QueueMeta }) {
  const { country, clue } = splitMeta(m.metaName)
  const pct = Math.round(m.recall * 100)
  const inner = (
    <>
      {/* A clue with no stored photo gets a quiet empty slot, not the words
          "no photo" six times down the panel. */}
      <span className={'shot' + (m.image ? '' : ' none')} aria-hidden>
        {m.image && <img src={m.image} alt="" loading="lazy" decoding="async" />}
      </span>
      <span className="nm">
        <span className="what">{clue}</span>
        {country && <span className="where">{country}</span>}
      </span>
      <span className="rt">
        <span className="pc mono">{pct}%</span>
        <span className={'meter' + (m.dueNow ? ' warm' : '')}>
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="seen">{m.dueNow ? 'owed now' : `back ${whenNext(m.due)}`}</span>
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
 * The rest of the queue, in a dialog rather than a fold: 300 rows unrolled
 * inline made the page a corridor, so the list scrolls inside its own frame
 * and the page stays the length it was.
 *
 * Deliberately not the deal order the head above uses — the head answers
 * "what will the map hand me next", which follows due dates, and a card
 * learned this morning is due back tonight at 99.7% while an older one sags
 * at 92% until tomorrow. Read as a single long list that ordering looks
 * wrong. This one answers the other question — "how well am I holding all of
 * it" — so it sorts by the model's odds and lets the dates fall where they
 * fall. The percentages go quiet at 100 so the handful of clues actually
 * sagging are the ones the eye lands on.
 *
 * The sort runs on the same rounded number the rows print, not the raw odds
 * underneath: sorted raw, a 91.4% "back tomorrow" sits above a 90.6% "back in
 * 13 hours" and the list reads as shuffled, because both print as 91. Ties on
 * the printed number break by who returns first, so within a percent the
 * dates run forward too and the whole list reads ordered — which it is.
 *
 * Hovering a row floats the clue's photograph beside the dialog, when the
 * Worker had one cached. The <img> src is only set for the hovered row, so
 * opening the list never downloads three hundred pictures.
 */
function WholeQueue({ queue }: { queue: QueueMeta[] }) {
  const dlg = useRef<HTMLDialogElement>(null)
  const [peek, setPeek] = useState<{ image: string; y: number } | null>(null)
  const rows = [...queue].sort(
    (a, b) =>
      Math.round(a.recall * 100) - Math.round(b.recall * 100) ||
      +new Date(a.due) - +new Date(b.due),
  )
  const peekAt = (m: QueueMeta, el: HTMLElement) => {
    const frame = dlg.current?.getBoundingClientRect()
    // No picture, or no room beside the dialog for one — nothing to float.
    if (!m.image || !frame || window.innerWidth - frame.right < 260) {
      setPeek(null)
      return
    }
    const row = el.getBoundingClientRect()
    const y = Math.min(Math.max(row.top + row.height / 2, 110), window.innerHeight - 110)
    setPeek({ image: m.image, y })
  }
  return (
    <>
      <button className="qopen" onClick={() => dlg.current?.showModal()}>
        Every clue in the deck
        <span className="moreNote">{rows.length} tracked</span>
        <span className="arr mono" aria-hidden>
          →
        </span>
      </button>
      {/* Clicking the backdrop is clicking the dialog element itself; a click
          on anything inside it lands on a child instead. */}
      <dialog
        className="qdlg"
        ref={dlg}
        aria-label="Every clue in the deck"
        onClick={(e) => e.target === dlg.current && dlg.current.close()}
      >
        <header className="qhead">
          <div>
            <h2>Every clue in the deck</h2>
            <span className="note">{rows.length} tracked — least likely still known on top</span>
          </div>
          <button className="qx mono" onClick={() => dlg.current?.close()} aria-label="Close">
            ×
          </button>
        </header>
        <div className="qall scroll" onMouseLeave={() => setPeek(null)}>
          {rows.map((m) => {
            const { country, clue } = splitMeta(m.metaName)
            const pct = Math.round(m.recall * 100)
            return (
              <div
                className="q"
                key={m.metaName}
                onMouseEnter={(e) => peekAt(m, e.currentTarget)}
              >
                <span className="nm">
                  {clue}
                  {country && <span className="where"> · {country}</span>}
                </span>
                <span className={'pc mono' + (m.dueNow || pct < 100 ? ' live' : '')}>{pct}%</span>
                <span className="when">{m.dueNow ? 'owed now' : `back ${whenNext(m.due)}`}</span>
              </div>
            )
          })}
        </div>
        {peek && (
          <div className="qpeek" style={{ top: peek.y }} aria-hidden>
            <img src={peek.image} alt="" />
          </div>
        )}
      </dialog>
    </>
  )
}

/**
 * The one setting there is — how many never-seen clues a day may introduce —
 * sitting in the header of the very section it controls. It used to live in
 * its own "Pace" panel a screenful away, which meant changing 10 to 20 changed
 * a number over there and, apparently, nothing over here: the cards it governs
 * did not move until the next full page load. Now the input and its
 * consequence share a heading, and a successful save re-reads the dashboard
 * (`onSaved`), so the hand below re-deals itself the moment the allowance
 * changes.
 *
 * The value shown after a write is the one the Worker echoes back, not the one
 * that was typed. A refused write must not leave the box displaying a setting
 * nobody has stored — and the Worker's refusal is already a sentence written
 * for a person, so it is reported as it arrived (`onTrouble`) rather than
 * translated. In a demo build there is no Worker to ask, so the number simply
 * pretends to save.
 */
function Pace({
  initial,
  demo,
  onSaved,
  onTrouble,
}: {
  initial: number
  demo: boolean
  onSaved: () => Promise<unknown>
  onTrouble: (msg: string | null) => void
}) {
  const [value, setValue] = useState(String(initial))
  const [saved, setSaved] = useState(initial)
  const [saving, setSaving] = useState(false)

  const commit = async () => {
    const num = Number(value.trim())
    /* A box left empty or half-typed is not a request to change anything, and
       neither is retyping the number already stored. Both put back what is
       stored rather than spending a round trip to be told so. */
    if (saving || value.trim() === '' || !Number.isFinite(num) || num === saved) {
      setValue(String(saved))
      return
    }
    if (demo) {
      setSaved(num)
      return
    }
    setSaving(true)
    onTrouble(null)
    try {
      const { config } = await setDailyNew(num)
      setSaved(config.dailyNew)
      setValue(String(config.dailyNew))
      await onSaved()
    } catch (e) {
      /* Left as typed on purpose: the message says what is wrong with this
         number, and it is easier to fix a number you can still see. */
      onTrouble(e instanceof Error ? e.message : 'Could not save that.')
    }
    setSaving(false)
  }

  return (
    <label className="pace" htmlFor="dailyNew" title="Every new clue costs about ten reviews later on. 0 meets nothing new.">
      <input
        id="dailyNew"
        className="field paceIn"
        type="number"
        min={0}
        max={100}
        step={1}
        inputMode="numeric"
        value={value}
        disabled={saving}
        onChange={(e) => {
          setValue(e.target.value)
          onTrouble(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span>new a day</span>
    </label>
  )
}

/* ==========================================================================
   Today.
   ========================================================================== */

/**
 * A count drawn as things rather than as a digit — one mark per card.
 *
 * The digit is already directly above, in display type; this is the shape of
 * the number, which is the part a person reads without reading. `total` is the
 * budget where there is one (the day's new-clue allowance draws its spent half
 * as unlit marks) and equal to `lit` where there is not.
 */
function Pips({ lit, total, warm }: { lit: number; total: number; warm?: boolean }) {
  const cap = 22
  const shown = Math.min(total, cap)
  const over = total - shown
  return (
    <span className={'pips' + (warm ? ' warm' : '')} aria-hidden>
      {Array.from({ length: shown }, (_, i) => (
        <i key={i} className={i < lit ? 'on' : ''} />
      ))}
      {over > 0 && <b>+{n(over)}</b>}
    </span>
  )
}

/** One of the three figures the day is measured in. */
function Tally({
  name,
  value,
  of,
  viz,
  say,
}: {
  name: string
  value: number
  of?: string
  viz: React.ReactNode
  say: string
}) {
  return (
    <div className="tally">
      <p className="tallyName">{name}</p>
      <p className="tallyNum">
        <b>{n(value)}</b>
        {of && <span>{of}</span>}
      </p>
      <div className="tallyViz">{viz}</div>
      <p className="tallySay">{say}</p>
    </div>
  )
}

/**
 * The clues today is about to introduce, as the photographs they actually are.
 *
 * A meta is a thing you look at — a bollard's stripe, a pole's holes, the
 * colour of an outer line — and a list of its names is a list of words for
 * things you have not seen. So the day's allowance is dealt face-up: one card
 * per clue, in the order the ladder will hand them over, each carrying the
 * Street View frame the clue was catalogued from.
 *
 * A clue whose catalogs hold no location keeps its slot and loses its picture,
 * because the length of this row is the number printed above it and dropping a
 * card would make the two disagree.
 */
/* --------------------------------------------------------------------------
   The whole ladder, one square per clue.

   Every other figure on this page is a count of something you cannot see the
   size of. This is the size: 370 squares, lit in the order the scheduler
   thinks of them — holding, bedding in, shaky, and then the long dark tail of
   everything you have not been shown yet. It is the one picture that answers
   "how much of this is there" without a sentence.
   -------------------------------------------------------------------------- */
function Ladder({ solid, holding, shaky, total }: { solid: number; holding: number; shaky: number; total: number }) {
  const seen = solid + holding + shaky
  const unseen = Math.max(0, total - seen)
  const runs: Array<[string, number]> = [
    ['solid', solid],
    ['hold', holding],
    ['shaky', shaky],
    ['unseen', unseen],
  ]
  return (
    <figure className="ladder">
      <figcaption className="ladderCap">
        <b>{n(total)}</b> clues on the ladder
      </figcaption>
      <div
        className="ladderGrid"
        role="img"
        aria-label={`${n(total)} clues: ${n(solid)} holding at ninety per cent, ${n(holding)} bedding in, ${n(
          shaky,
        )} shaky, ${n(unseen)} not yet seen.`}
      >
        {runs.flatMap(([k, count]) =>
          Array.from({ length: count }, (_, i) => <i className={`lc ${k}`} key={`${k}${i}`} />),
        )}
      </div>
      {seen === 0 ? (
        /* An untouched ladder has nothing to bucket — four zeroes in a legend
           read as a broken page, not a fresh one. */
        <div className="ladderKey" aria-hidden>
          <span>
            <i className="lc unseen" />
            {n(unseen)} clues, none met yet
          </span>
        </div>
      ) : (
      <div className="ladderKey" aria-hidden>
        <span>
          <i className="lc solid" />
          {n(solid)} holding
        </span>
        <span>
          <i className="lc hold" />
          {n(holding)} bedding in
        </span>
        <span>
          <i className="lc shaky" />
          {n(shaky)} shaky
        </span>
        <span>
          <i className="lc unseen" />
          {n(unseen)} not yet seen
        </span>
      </div>
      )}
    </figure>
  )
}

/**
 * Google retires panoramas when it re-drives a road, and the thumbnail
 * endpoint answers a retired id with a solid black frame and a clean 200 —
 * no error ever fires, and the card just sits dark. The endpoint allows
 * cross-origin reads, which is what makes the darkness detectable: sample
 * the loaded frame on a tiny canvas, and "every pixel the same" means "no
 * imagery here any more".
 */
function isFlat(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 8
    const g = c.getContext('2d')
    if (!g) return false
    g.drawImage(img, 0, 0, 8, 8)
    const d = g.getImageData(0, 0, 8, 8).data
    let min = 255
    let max = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (v < min) min = v
      if (v > max) max = v
    }
    return max - min < 6
  } catch {
    // A tainted or refused canvas proves nothing either way.
    return false
  }
}

/**
 * Whatever camera stands at these coordinates today, by the same keyless
 * lookup the maps viewer itself uses (see coach/pano.mjs, which has made this
 * exact call from the laptop for months). One ask per retired pano, shared —
 * the grid and the card sheet both reach for the same rescue.
 */
const livePano = new Map<string, Promise<string | null>>()
function findLivePano(lat: number, lng: number, key: string): Promise<string | null> {
  const held = livePano.get(key)
  if (held) return held
  const ask = fetch(
    'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json+protobuf' },
      body: JSON.stringify([
        ['apiv3', null, null, null, 'US', null, null, null, null, null, [[0]]],
        [[null, null, lat, lng], 50],
        [
          [null, null, null, null, null, null, null, null, null, null, [null, null]],
          null, null, null, null, null, null, null, [2], null, [[[2, true, 2]]],
        ],
        [[2, 6]],
      ]),
    },
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.[1]?.[1]?.[1] ?? null)
    .catch(() => null)
  livePano.set(key, ask)
  return ask
}

/**
 * A Street View thumbnail that does not give up on the first refusal.
 *
 * The dashboard fires a dozen of these in one burst and Google occasionally
 * refuses one — not a bad pano, just a shrug under load, and the same frame
 * loads fine a second later. The old <img> had no second later: one refusal
 * was a black card for the rest of the visit. So a failed load retries twice,
 * spaced out, before conceding — and concedes into words rather than
 * darkness. The retried URL asks for one more pixel of height, because an
 * identical src would be answered from the browser's memory of the failure
 * instead of asked again.
 *
 * A load that succeeds into blackness is the other failure: the pano was
 * retired. Those are rescued by asking for the camera that stands at the
 * clue's coordinates now, keeping the catalogued heading — the road hasn't
 * moved, only the camera on it.
 */
function Shot({ m, w, h }: { m: UpNextMeta; w: number; h: number }) {
  const [tries, setTries] = useState(0)
  const [pano, setPano] = useState(m.panoId)
  useEffect(() => {
    setTries(0)
    setPano(m.panoId)
  }, [m.panoId])
  if (!pano) return <span className="dealDark">No frame catalogued</span>
  if (tries > 2) return <span className="dealDark">Street View refused this frame</span>
  return (
    <img
      src={thumb(pano, m.heading, w, h + tries)}
      alt=""
      loading="lazy"
      decoding="async"
      crossOrigin="anonymous"
      onLoad={(e) => {
        if (pano !== m.panoId || !isFlat(e.currentTarget)) return
        // "Refused" rather than "not catalogued" when the rescue also comes
        // back empty: a location was catalogued, the imagery is what's gone.
        if (m.lat == null || m.lng == null) {
          setTries(3)
          return
        }
        findLivePano(m.lat, m.lng, m.panoId!).then((live) => {
          if (live && live !== m.panoId) setPano(live)
          else setTries(3)
        })
      }}
      onError={() => setTimeout(() => setTries((t) => t + 1), 700 * (tries + 1))}
    />
  )
}

/** The deep link into the actual panorama a clue was catalogued from — the
 * "show me more" a thumbnail cannot be. Built the way Google documents for
 * Street View URLs, so it opens the pano itself, facing the clue. */
const streetView = (m: UpNextMeta) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(m.panoId ?? '')}` +
  `&heading=${m.heading ?? 0}&pitch=${m.pitch ?? 0}`

/**
 * One dealt card, held up close: the same frame at four times the pixels, and
 * the door through it — the pano itself, in Street View, where the clue can be
 * walked around instead of squinted at.
 */
function CardSheet({ m, onClose }: { m: UpNextMeta; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null)
  // The close event does not bubble, so React's delegated onClose never hears
  // it — a native listener is the only wiring that catches every way out
  // (the ×, a backdrop click, and Escape alike).
  useEffect(() => {
    const d = dlg.current
    d?.showModal()
    d?.addEventListener('close', onClose)
    return () => d?.removeEventListener('close', onClose)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { country, clue } = splitMeta(m.name)
  return (
    <dialog
      className="qdlg cdlg"
      ref={dlg}
      aria-label={m.name}
      onClick={(e) => e.target === dlg.current && dlg.current.close()}
    >
      <header className="qhead">
        <div>
          <h2>{clue}</h2>
          <span className="note">
            {country ?? 'Unplaced'}
            {m.pinned && ' · your pick'}
          </span>
        </div>
        <button className="qx mono" onClick={() => dlg.current?.close()} aria-label="Close">
          ×
        </button>
      </header>
      <div className="cshot">
        <Shot m={m} w={960} h={640} />
      </div>
      <footer className="cfoot">
        {m.panoId ? (
          <a className="btn" href={streetView(m)} target="_blank" rel="noreferrer">
            Walk around it in Street View <span className="arr">→</span>
          </a>
        ) : (
          <span className="cnone">No catalogued location to open.</span>
        )}
      </footer>
    </dialog>
  )
}

/**
 * The whole unseen shelf, open for picking.
 *
 * The scheduler already has an opinion — the list arrives in the exact order
 * it would introduce clues, worst duel countries first — so the recommendation
 * is the order itself, and the first `allowance` rows are marked as today's.
 * Picking a clue lifts it to the head of that order; the deck build reads the
 * same pins, so a pick here IS a promise about the next deck, not a request.
 *
 * Writes are whole-list and serialized through one promise chain, so mashing
 * three toggles cannot land out of order and store a stale hand. The dialog
 * closing is what re-reads the dashboard: one refresh when the picking is
 * done, not one per click.
 */
function CluePicker({
  pool,
  allowance,
  demo,
  onClose,
}: {
  pool: UpNextMeta[]
  allowance: number
  demo: boolean
  onClose: (changed: boolean) => void
}) {
  const dlg = useRef<HTMLDialogElement>(null)
  const changed = useRef(false)
  // Native close listener for the same reason as CardSheet's: close does not
  // bubble, and this one carries the "did anything change" verdict that
  // decides whether the dashboard refetches.
  useEffect(() => {
    const d = dlg.current
    const done = () => onClose(changed.current)
    d?.showModal()
    d?.addEventListener('close', done)
    return () => d?.removeEventListener('close', done)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [picked, setPicked] = useState<string[]>(pool.filter((m) => m.pinned).map((m) => m.name))
  const [q, setQ] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const chain = useRef<Promise<unknown>>(Promise.resolve())

  const toggle = (name: string) => {
    const next = picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name]
    setPicked(next)
    setErr(null)
    changed.current = true
    if (demo) return
    chain.current = chain.current.then(() =>
      setPins(next).catch((e) => setErr(e instanceof Error ? e.message : 'Could not save that pick.')),
    )
  }

  const needle = q.trim().toLowerCase()
  const rows = needle ? pool.filter((m) => m.name.toLowerCase().includes(needle)) : pool
  return (
    <dialog
      className="qdlg pkdlg"
      ref={dlg}
      aria-label="Choose new clues"
      onClick={(e) => e.target === dlg.current && dlg.current.close()}
    >
      <header className="qhead">
        <div>
          <h2>Choose new clues</h2>
          <span className="note">
            {n(pool.length)} not met yet, best first — picks jump the queue and deal next
          </span>
        </div>
        <button className="qx mono" onClick={() => dlg.current?.close()} aria-label="Close">
          ×
        </button>
      </header>
      <div className="pkFind">
        <input
          className="field"
          type="search"
          placeholder="Find a clue or a country…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {err && <p className="err">{err}</p>}
      </div>
      <div className="qall scroll">
        {rows.map((m) => {
          const { country, clue } = splitMeta(m.name)
          const on = picked.includes(m.name)
          const rank = pool.indexOf(m)
          return (
            <div className={'pk' + (on ? ' is-on' : '')} key={m.name}>
              <span className="pkShot">
                <Shot m={m} w={160} h={120} />
              </span>
              <span className="pkNm">
                <span className="pkWhat">{clue}</span>
                <span className="pkWhere">
                  {country ?? '—'}
                  {rank < allowance && <b> · up next</b>}
                </span>
              </span>
              <button className={'pkPin' + (on ? ' is-on' : '')} onClick={() => toggle(m.name)}>
                {on ? 'Picked ✓' : 'Pick'}
              </button>
            </div>
          )
        })}
        {rows.length === 0 && <p className="pkNone">Nothing on the shelf matches that.</p>}
      </div>
    </dialog>
  )
}

/**
 * The clues today is about to introduce, as the photographs they actually are.
 *
 * A meta is a thing you look at — a bollard's stripe, a pole's holes, the
 * colour of an outer line — and a list of its names is a list of words for
 * things you have not seen. So the day's allowance is dealt face-up: one card
 * per clue, in the order the ladder will hand them over, each carrying the
 * Street View frame the clue was catalogued from. A card opens on click —
 * this is the one section made of things the player has never seen, so
 * "let me look closer" is the whole point of it.
 *
 * A grid rather than the old sideways rail: the rail needed a horizontal
 * scroll that a mouse wheel does not naturally make, so on a desktop with no
 * trackpad most of the hand was effectively invisible. Cards wrap instead,
 * and everything the day will deal is on screen at once.
 *
 * A clue whose catalogs hold no location keeps its slot and loses its picture,
 * because the length of this grid is the number printed beside it and dropping
 * a card would make the two disagree.
 */
function NewToday({
  day,
  done,
  duelDriven,
  demo,
  onRefresh,
}: {
  day: NonNullable<DashboardData['day']>
  done: boolean
  duelDriven: boolean
  demo: boolean
  onRefresh: () => Promise<unknown>
}) {
  const list = done ? [] : (day.upNext ?? [])
  const pool = day.pool ?? []
  const [open, setOpen] = useState<UpNextMeta | null>(null)
  const [picking, setPicking] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  // A twenty-clue allowance is a wall of cards; the section shows the first
  // two rows and folds the rest, because "what's next" is a glance and the
  // whole hand is a choice to look.
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? list : list.slice(0, 8)

  return (
    <section className="deal">
      <div className="secHead">
        <h2>New today</h2>
        <div className="dealCtl">
          <Pace key={day.dailyNew} initial={day.dailyNew} demo={demo} onSaved={onRefresh} onTrouble={setTrouble} />
          {pool.length > 0 && (
            <button className="pkOpen" onClick={() => setPicking(true)}>
              Choose clues <span className="arr mono">→</span>
            </button>
          )}
        </div>
      </div>
      {trouble && <p className="err dealErr">{trouble}</p>}
      {done ? (
        <p className="dealDone">
          Every clue the day had room for has been introduced. The next hand is dealt tomorrow — or raise the
          number above and meet more today.
        </p>
      ) : (
        <>
          <ul className="dealGrid">
            {shown.map((m, i) => {
              const { country, clue } = splitMeta(m.name)
              return (
                <li key={m.name}>
                  <button className="dealCard" onClick={() => setOpen(m)}>
                    <span className="dealShot">
                      <Shot m={m} w={480} h={360} />
                      <span className="dealNo mono" aria-hidden>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {m.pinned && <span className="dealPick">your pick</span>}
                    </span>
                    <span className="dealTxt">
                      <span className="dealWhat">{clue}</span>
                      {country && <span className="dealWhere">{country}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {list.length > 8 && (
            <button className="dealMore" onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show fewer' : `Show all ${list.length}`}{' '}
              <span className="arr mono">{showAll ? '↑' : '↓'}</span>
            </button>
          )}
          {/* The honest caveat: new clues queue behind what is owed, so a heavy
              review day meets fewer of these than are laid out here. */}
          <p className="dealSay">
            Dealt {duelDriven ? 'where duels cost you' : 'in ladder order'}
            {pool.some((m) => m.pinned) ? ', your picks first' : ''} · new clues come after the day's due
            reviews, as room allows.
          </p>
        </>
      )}
      {open && <CardSheet m={open} onClose={() => setOpen(null)} />}
      {picking && (
        <CluePicker
          pool={pool}
          allowance={day.newAllowance}
          demo={demo}
          onClose={(changed) => {
            setPicking(false)
            if (changed && !demo) onRefresh()
          }}
        />
      )}
    </section>
  )
}

/* ========================================================================== */
export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  /* Dev only, and compiled out of a production build: the signed-in console
     cannot be opened without an account, so `?demo=…` stands a realistic
     payload in front of the network read. See demo.ts. */
  const demo = !!demoData()

  /* One read, callable again: the allowance dial and the clue picker both
     change what the Worker would deal next, and re-reading the dashboard is
     how the page shows the consequence instead of the stale hand. */
  const load = async () => {
    const fake = demoData()
    if (fake) {
      setData(fake)
      return
    }
    if (!getToken()) {
      navigate('/start')
      return
    }
    try {
      setData(await fetchDashboard())
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken()
        navigate('/start')
        return
      }
      setError(e instanceof Error ? e.message : 'Could not load your dashboard.')
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recent = useMemo(
    () => [...(data?.rounds ?? [])].sort((a, b) => +new Date(b.ts) - +new Date(a.ts)),
    [data],
  )
  const byDuelLoss = useMemo(
    () =>
      [...(data?.countries ?? [])]
        .filter((c) => (c.duelLost ?? 0) > 0)
        .sort((a, b) => (b.duelLost ?? 0) - (a.duelLost ?? 0))
        .slice(0, 6),
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
            <div className="skel kick" />
            <div className="skel t" />
            <div className="skel t" style={{ width: '46%' }} />
            <div className="skel key" />
            <div className="skelRow">
              <div className="skel col" />
              <div className="skel col" />
              <div className="skel col" />
            </div>
            <div className="skelRow cards">
              <div className="skel card" />
              <div className="skel card" />
              <div className="skel card" />
              <div className="skel card" />
            </div>
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

  /* TEMPORARY. The Worker learned to send progress{} after this view learned to
     draw it; until that ships, stand in the count of clues holding solid, which
     is the nearest thing the old payload carries. Delete this line — not the
     code around it — once /api/dashboard always answers with progress. */
  const progress = data.progress ?? { held: metas.solid, total: deck.total, series: [] as HeldPoint[] }
  const held = Math.min(progress.held, progress.total)

  /* The honest ceiling: every meta the unlocked ladder holds. `deck.total` adds
     tracked cards to unseen metas, so a clue dropped from a catalog is counted
     by the first and not the second — a denominator that drifts upward as the
     catalogs change. An older Worker sends no ladderTotal and gets the old one. */
  const ladder = deck.ladderTotal ?? deck.total
  const trackedShare = ladder > 0 ? Math.min(100, (deck.introduced / ladder) * 100) : 0

  /* What today still asks for, which the deck on its own cannot say: "nothing
     due" is equally true of a day with ten unmet clues still allowed and of a
     day that is genuinely finished. `day` is the thing that tells those apart.
     A Worker too old to send it leaves this line reading as it always has —
     the one unforgivable move here is calling a day done on no evidence, and
     then watching the map hand over another deck. */
  const dayInfo = data.day
  const done = !!dayInfo?.doneForToday
  const fresh = dayInfo && !done ? dayInfo.newAllowance : 0
  /* And which clues that count is a count of. It is the same allowance said in
     names instead of a number, so a day that is over — or a Worker too old to
     send the list — shows nothing rather than a heading over an empty box. */
  const newToday = dayInfo && !done ? (dayInfo.upNext ?? []) : []

  const reviews = (
    <>
      <b>{n(deck.due)}</b> review{s(deck.due)}
    </>
  )
  const meets = (
    <>
      <b>{n(fresh)}</b> new clue{s(fresh)}
    </>
  )
  /* One sentence, and it is the whole of the day's instruction. The numerals
     are lit because they are the part that changes between one morning and the
     next; the words around them almost never do. */
  const statement = done ? (
    <>Done for today.</>
  ) : deck.due > 0 && fresh > 0 ? (
    <>{reviews}, then {meets}.</>
  ) : deck.due > 0 ? (
    <>{reviews} to clear.</>
  ) : fresh > 0 ? (
    <>{meets} to meet.</>
  ) : (
    <>Nothing owed right now.</>
  )

  const aside = done
    ? next
      ? `Nothing scheduled until the next card comes back ${next}.`
      : 'Nothing scheduled. Extra rounds still count.'
    : deck.due > 0 && fresh > 0
      ? 'New clues come after the reviews, as room allows.'
      : deck.due > 0
        ? "Today's new clues are spent — this is the review backlog."
        : fresh > 0
          ? 'Nothing owed, so the whole session is new ground.'
          : next
            ? `The next card comes back ${next}.`
            : 'Play a round and the schedule starts filling itself in.'

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

        {/* ------------------------------------------------------------ today */}
        <section className={'today' + (done ? ' is-done' : '')}>
          <div className="todayIn">
            <div className="todayWords">
          <p className="todayKick">
            {done && <b aria-hidden>✓</b>}
            {empty ? 'Starting line' : 'Today'}
          </p>
          <h1 className="todayLine">{empty ? <>Nothing logged yet.</> : statement}</h1>
          <p className="todaySay">
            {empty
              ? 'Install the userscript and play one round. It grades itself, and this page starts keeping score of what you can actually call.'
              : aside}
          </p>
          <div className="todayCta">
            {empty ? (
              <Link to="/start" className="btn big">
                Finish setup <span className="arr">→</span>
              </Link>
            ) : (
              <a className="btn big" href="https://www.geoguessr.com/" target="_blank" rel="noreferrer">
                Play a round <span className="arr">→</span>
              </a>
            )}
            <span className="hint">
              {empty ? 'Two minutes, and only once.' : 'Your trainer map is already rebuilt and waiting.'}
            </span>
          </div>
            </div>

            <Ladder solid={metas.solid} holding={metas.holding} shaky={metas.shaky} total={ladder} />
          </div>

          <div className="tallies">
            <Tally
              name="Clues tracked"
              value={deck.introduced}
              of={`of ${n(ladder)}`}
              viz={
                <span className="rail" aria-hidden>
                  <i style={{ width: `${trackedShare}%` }} />
                </span>
              }
              say={
                deck.introduced === 0
                  ? 'The ladder is untouched.'
                  : `${Math.round(trackedShare)}% of the ladder met at least once.`
              }
            />
            <Tally
              name="Reviews due now"
              value={deck.due}
              viz={deck.due > 0 ? <Pips lit={deck.due} total={deck.due} warm /> : null}
              say={
                deck.due > 0
                  ? 'Owed at this minute, weakest first.'
                  : next
                    ? `Clear. Next one back ${next}.`
                    : 'Clear.'
              }
            />
            <Tally
              name="New clues today"
              value={fresh}
              of={dayInfo ? `of ${n(dayInfo.dailyNew)}` : undefined}
              viz={dayInfo ? <Pips lit={fresh} total={dayInfo.dailyNew} /> : null}
              say={
                !dayInfo
                  ? 'Not reported by the server yet.'
                  : done
                    ? "Today's allowance is spent."
                    : fresh > 0
                      ? `${n(dayInfo.dailyNew - fresh)} already met today.`
                      : 'The allowance is spent for today.'
              }
            />
          </div>
        </section>

        {/* ----------------------------------------------- what today teaches */}
        {dayInfo && (newToday.length > 0 || done) && (
          <NewToday day={dayInfo} done={done} duelDriven={byDuelLoss.length > 0} demo={demo} onRefresh={load} />
        )}

        {empty ? (
          /* The first screen everyone who signs up sees, and it has to read as
             a starting line rather than as a scoreline of nought. */
          <section className="sec">
            <div className="secHead">
              <h2>What happens next</h2>
              <span className="secNote">three things, and then it runs itself</span>
            </div>
            <ol className="beats">
              <li>
                <span className="no mono">01</span>
                <span>
                  <b>Play GeoGuessr as usual.</b> The userscript captures each round as it ends. Nothing to press, no
                  second app to keep open.
                </span>
              </li>
              <li>
                <span className="no mono">02</span>
                <span>
                  <b>Your pin is the grade.</b> Clues you called right get pushed months out; the ones you missed come
                  back within days.
                </span>
              </li>
              <li>
                <span className="no mono">03</span>
                <span>
                  <b>The map rebuilds itself.</b> Your trainer map is republished after every game, so the next round is
                  already the one you needed.
                </span>
              </li>
            </ol>
          </section>
        ) : (
          <>
            {/* The long measure: not what you did today, but what has stuck. */}
            {progress.series.length >= 1 && (
              <section className="sec climb">
                <div className="secHead">
                  <h2>Held at 90%</h2>
                  <span className="secNote">a live reading — it falls again when you stop playing</span>
                </div>
                <p className="secFig">
                  <b>{n(held)}</b>
                  <span>
                    of {n(progress.total)} clues you would get right if they came up this minute
                  </span>
                </p>
                <Climb series={progress.series} total={progress.total} />
                {progress.series.length === 1 && (
                  <p className="hint">One reading so far. The line joins up once you have played on a second day.</p>
                )}
              </section>
            )}

            <div className="grid">
              <div className="col c7">
                {/* The head of the review queue, in the queue's own order:
                    what the trainer map will deal next, and the model's odds
                    you still hold each one. */}
                {metas.queue.length > 0 && (
                  <div className="panel">
                    <header>
                      <h2>Coming back first</h2>
                      <span className="note">the queue's own order — least likely still known on top</span>
                    </header>
                    <div className="body flush">
                      <div className="wks">
                        {metas.queue.slice(0, 6).map((m) => (
                          <Work key={m.metaName} m={m} />
                        ))}
                      </div>
                      {metas.queue.length > 6 && <WholeQueue queue={metas.queue} />}
                    </div>
                  </div>
                )}

                <div className="panel">
                  <header>
                    <h2>Recent scores</h2>
                    <span className="note">
                      <b>{n(totals.rounds)}</b> rounds · {pct === null ? '—' : `${pct}%`} called right
                    </span>
                  </header>
                  <div className="body">
                    <Scores rounds={recent} />
                  </div>
                </div>
              </div>

              <div className="col c5">
                {/* The Deck bucket table used to live here; the ladder at the
                    top already says all of it, so the column keeps only what
                    the waffle cannot: where the points actually go. */}
                {byDuelLoss.length > 0 && (
                  <div className="panel">
                    <header>
                      <h2>Where duels cost you</h2>
                      <span className="note">new clues are dealt from the top of this list</span>
                    </header>
                    <div className="body">
                      <Duels rows={byDuelLoss} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <details className="more">
              <summary>
                Round log
                <span className="moreNote">
                  {n(log.length)} of {n(totals.rounds)} rounds · newest first
                </span>
              </summary>
              <div className="panel">
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
                          {r.distanceKm === null ? '—' : `${n(Math.round(r.distanceKm))} km`}
                        </span>
                        <span className="num rt">{ago(r.ts)}</span>
                      </div>
                    ))}
                  </div>
                </div>
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
