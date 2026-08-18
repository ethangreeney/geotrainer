import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAP_COUNTRIES } from '../src/data/worldMap'

/* ------------------------------------------------------------------ types */
interface Round {
  id: string
  ts: string
  answer: { code: string; name: string; region?: string; lat: number; lng: number }
  guess: { code: string; name: string; lat: number; lng: number } | null
  correct: boolean
  distanceKm: number | null
  metaName: string | null
  score: number | null
  thumb?: string | null
  demo?: boolean
}
interface Card {
  name: string
  state: number
  due: string
  scheduledDays: number
  reps: number
  lapses: number
  retrievability: number
  mastered: boolean
}
interface Data {
  now: string
  trainerMapId: string
  summary: { due: number; learning: number; unseen: number; unlockedTiers: number; nextDue: string | null }
  lastDeck: { ts: string; metas: string[]; padding: string[] } | null
  cards: Card[]
  tiers: { name: string; tier: number; metas: number; seen: number; learned: number }[]
  rounds: Round[]
  confusions: Record<string, number>
  countries: Record<string, { seen: number; correctCountry: number }>
  metaSample: string[]
}

/* ---------------------------------------------------------------- format */
const num = (n: number) => n.toLocaleString('en-US')
const pct = (x: number, d = 0) => (x * 100).toFixed(d) + '%'
const nameOf = (() => {
  let dn: Intl.DisplayNames | null = null
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    dn = null
  }
  const fromMap = new Map(MAP_COUNTRIES.map((c) => [c.id, c.name]))
  return (code: string, fallback?: string) => {
    if (code === '??' || !code) return 'unplaced pin'
    let n: string | undefined
    try {
      n = dn?.of(code)
    } catch {
      n = undefined
    }
    return n && n !== code ? n : fromMap.get(code) ?? fallback ?? code
  }
})()
/** ISO long forms ("Netherlands (Kingdom of the)") are unreadable in a column. */
const cname = (c: { code: string; name: string }) => nameOf(c.code, c.name)

/** "in 4h 12m" / "2d 3h ago" — compact, monospace-friendly. */
function rel(ms: number) {
  const past = ms < 0
  let s = Math.abs(ms) / 1000
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  return past ? `${body} ago` : `in ${body}`
}
const clock = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

/* -------------------------------------------------------------- palettes */
/* Every value below came out of the data-viz palette validator run against
 * the panel surface #1e1340 in dark mode. See styles/theme.css for the report.
 *
 * The map asks one question — where are you losing rounds? — so it is a
 * SEQUENTIAL magnitude ramp, not a diverging one: a single amber hue, dim
 * where a country is held and hot where it is slipping. One hue means the
 * ramp survives colour-blindness on its lightness alone, and it keeps amber
 * meaning the same thing here as it does on the in-game card. */
const TROUBLE = ['#5e492e', '#7f5b2b', '#a26e22', '#c68206', '#e69812', '#ffb135']
const ORDINAL = ['#425c2b', '#557e2d', '#69a22b', '#86c547']
const S1 = '#68a51f' /* the held/volume series */
const S2 = '#c67f00' /* the due/overdue series */
const SURFACE = '#22164a' /* the 2px ring that separates overlapping marks */

/** Country accuracy -> trouble step. Dimmest = you always call it right. */
function accClass(acc: number) {
  if (acc >= 0.95) return 0
  if (acc >= 0.85) return 1
  if (acc >= 0.7) return 2
  if (acc >= 0.55) return 3
  if (acc >= 0.35) return 4
  return 5
}

/* ------------------------------------------------------- miller projection */
/* The amCharts worldHigh frame these paths come from: 1009x651, ~85.6N..84.9S. */
const millerY = (lat: number) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * ((lat * Math.PI) / 180)))
const MY0 = millerY(85.6)
const MY1 = millerY(-84.9)
const projX = (lng: number) => ((lng + 180) / 360) * 1009
const projY = (lat: number) => ((millerY(Math.max(-84, Math.min(84, lat))) - MY0) / (MY1 - MY0)) * 651
const MAP_VIEW = { x: 0, y: 32, w: 1009, h: 478 }

/* ----------------------------------------------------------------- hooks */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

type Tip = { show: (node: ReactNode, ev: { clientX: number; clientY: number }) => void; hide: () => void }
function useTip(): [ReactNode, Tip] {
  const [tip, setTip] = useState<{ node: ReactNode; x: number; y: number } | null>(null)
  const api: Tip = {
    show: (node, ev) => setTip({ node, x: ev.clientX, y: ev.clientY }),
    hide: () => setTip(null),
  }
  const node = (
    <div
      className={'tip' + (tip ? ' on' : '')}
      style={
        tip
          ? { left: Math.min(tip.x + 14, innerWidth - 280), top: Math.min(tip.y + 16, innerHeight - 150) }
          : { left: -9999, top: -9999 }
      }
    >
      {tip?.node}
    </div>
  )
  return [node, api]
}

/* ------------------------------------------------------------ primitives */
function Panel({
  title,
  note,
  cls,
  flush,
  children,
}: {
  title: string
  note?: ReactNode
  cls?: string
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className={'panel ' + (cls ?? '')}>
      <header>
        <h2>{title}</h2>
        {note !== undefined && <div className="note">{note}</div>}
      </header>
      <div className={'body' + (flush ? ' flush' : '')}>{children}</div>
    </section>
  )
}

function TipRows({ head, rows }: { head: string; rows: [string, ReactNode][] }) {
  return (
    <>
      <div className="h">{head}</div>
      {rows.map(([k, v]) => (
        <div className="r" key={k}>
          <span>{k}</span>
          <b style={{ fontWeight: 500 }}>{v}</b>
        </div>
      ))}
    </>
  )
}

function Spark({ values, color = S1, w = 62, h = 16 }: { values: number[]; color?: string; w?: number; h?: number }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const x = (i: number) => (i / (values.length - 1)) * (w - 2) + 1
  const y = (v: number) => h - 1 - ((v - min) / (max - min || 1)) * (h - 2)
  const d = values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('')
  return (
    <svg width={w} height={h} className="chart" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/* ============================================================ derivations */
interface MetaStat {
  seen: number
  correct: number
  streak: number
  last: string | null
}

function useDerived(data: Data | null, scopeDays: number) {
  return useMemo(() => {
    if (!data) return null
    const now = new Date(data.now).getTime()
    const cutoff = scopeDays === 0 ? 0 : now - scopeDays * 864e5
    const all = data.rounds
    const rounds = all.filter((r) => +new Date(r.ts) >= cutoff)

    /* per-country, from rounds so the scope filter is honest */
    const countries = new Map<string, { seen: number; correct: number }>()
    const confusions = new Map<string, number>()
    for (const r of rounds) {
      const c = countries.get(r.answer.code) ?? { seen: 0, correct: 0 }
      c.seen++
      if (r.correct) c.correct++
      countries.set(r.answer.code, c)
      if (!r.correct) {
        const key = `${r.answer.code}>${r.guess?.code ?? '??'}`
        confusions.set(key, (confusions.get(key) ?? 0) + 1)
      }
    }

    /* per-meta lifetime stats (deck state is not time-scoped, so neither is this) */
    const metaStats = new Map<string, MetaStat>()
    for (const r of all) {
      if (!r.metaName) continue
      const m = metaStats.get(r.metaName) ?? { seen: 0, correct: 0, streak: 0, last: null }
      m.seen++
      if (r.correct) m.correct++
      m.streak = r.correct ? m.streak + 1 : 0
      m.last = r.ts
      metaStats.set(r.metaName, m)
    }

    /* retention by exposure count: how often the nth sighting of a meta lands */
    const seenSoFar = new Map<string, number>()
    const expBuckets = Array.from({ length: 6 }, () => ({ n: 0, correct: 0 }))
    for (const r of all) {
      if (!r.metaName) continue
      const k = (seenSoFar.get(r.metaName) ?? 0) + 1
      seenSoFar.set(r.metaName, k)
      const b = expBuckets[Math.min(k, 6) - 1]
      b.n++
      if (r.correct) b.correct++
    }

    /* due forecast from live card state */
    const overdue: Card[] = []
    const forecast = Array.from({ length: 14 }, () => 0)
    for (const c of data.cards) {
      const off = Math.floor((+new Date(c.due) - now) / 864e5)
      if (+new Date(c.due) <= now) overdue.push(c)
      else if (off < 14) forecast[Math.max(0, off)]++
    }

    /* deck composition — ordered states, so an ordinal ramp */
    const mastered = data.cards.filter((c) => c.mastered).length
    const learning = data.cards.filter((c) => c.state === 1 || c.state === 3).length
    const review = data.cards.length - mastered - learning
    const unseen = data.summary.unseen
    const composition = [
      { k: 'unseen', n: unseen, c: ORDINAL[0] },
      { k: 'learning', n: learning, c: ORDINAL[1] },
      { k: 'review', n: review, c: ORDINAL[2] },
      { k: 'mastered', n: mastered, c: ORDINAL[3] },
    ]

    /* capture volume: hourly while the window is short, daily once it is not */
    const stamps = rounds.map((r) => +new Date(r.ts))
    const first = stamps.length ? Math.min(...stamps) : now
    const last = stamps.length ? Math.max(...stamps) : now
    const hourly = (last - first) / 36e5 <= 132
    const step = hourly ? 36e5 : 864e5
    const start = Math.floor(first / step) * step
    const bins = Math.max(1, Math.min(140, Math.round((last - start) / step) + 1))
    const volume = Array.from({ length: bins }, (_, i) => ({ t: start + i * step, n: 0, correct: 0 }))
    for (const r of rounds) {
      const i = Math.floor((+new Date(r.ts) - start) / step)
      if (i >= 0 && i < bins) {
        volume[i].n++
        if (r.correct) volume[i].correct++
      }
    }

    /* rolling accuracy over round index */
    const win = Math.max(10, Math.min(30, Math.round(rounds.length / 12)))
    const roll: number[] = []
    for (let i = 0; i < rounds.length; i++) {
      const from = Math.max(0, i - win + 1)
      let hit = 0
      for (let j = from; j <= i; j++) if (rounds[j].correct) hit++
      roll.push(hit / (i - from + 1))
    }

    /* score histogram, 500-point bins */
    const scoreBins = Array.from({ length: 10 }, () => 0)
    const scores: number[] = []
    for (const r of rounds) {
      if (r.score == null) continue
      scores.push(r.score)
      scoreBins[Math.min(9, Math.floor(r.score / 500))]++
    }
    const dists = rounds.map((r) => r.distanceKm).filter((d): d is number => d != null).sort((a, b) => a - b)
    const median = dists.length ? dists[Math.floor(dists.length / 2)] : null
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null
    const hits = rounds.filter((r) => r.correct).length

    /* current run of correct country calls */
    let streak = 0
    for (let i = all.length - 1; i >= 0; i--) {
      if (!all[i].correct) break
      streak++
    }

    return {
      now,
      rounds,
      all,
      countries,
      confusions,
      metaStats,
      expBuckets,
      overdue,
      forecast,
      composition,
      volume,
      hourly,
      step,
      roll,
      win,
      scoreBins,
      median,
      avgScore,
      hits,
      streak,
      accuracy: rounds.length ? hits / rounds.length : null,
      mastered,
    }
  }, [data, scopeDays])
}
type Derived = NonNullable<ReturnType<typeof useDerived>>

/* ================================================================= panels */

function WorldMap({ d, tip }: { d: Derived; tip: Tip }) {
  const [showVectors, setShowVectors] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const misses = useMemo(
    () =>
      d.rounds
        .filter((r) => !r.correct && r.guess && Math.abs(r.guess.lng - r.answer.lng) < 175)
        .slice(-30)
        .map((r) => ({
          x1: projX(r.guess!.lng),
          y1: projY(r.guess!.lat),
          x2: projX(r.answer.lng),
          y2: projY(r.answer.lat),
          id: r.id,
        })),
    [d.rounds],
  )
  const covered = d.countries.size
  return (
    <Panel
      title="World — country accuracy"
      cls="c8"
      note={
        <>
          <b>{covered}</b> countries seen ·{' '}
          <button
            className="linkbtn"
            style={{ padding: '3px 7px', marginLeft: 4, verticalAlign: 'middle' }}
            onClick={() => setShowVectors((v) => !v)}
          >
            {showVectors ? 'hide' : 'show'} miss vectors
          </button>
        </>
      }
    >
      <div className="mapwrap" style={{ minHeight: 300 }}>
        <svg viewBox={`${MAP_VIEW.x} ${MAP_VIEW.y} ${MAP_VIEW.w} ${MAP_VIEW.h}`} preserveAspectRatio="xMidYMid meet">
          <g>
            {MAP_COUNTRIES.map((c) => {
              const v = d.countries.get(c.id)
              const acc = v ? v.correct / v.seen : null
              const fill = acc == null ? 'var(--nodata)' : TROUBLE[accClass(acc)]
              const op = v ? 0.6 + 0.4 * Math.min(1, v.seen / 6) : 1
              const node = (
                <TipRows
                  head={c.name}
                  rows={
                    v
                      ? [
                          ['rounds', num(v.seen)],
                          ['right country', `${v.correct} · ${pct(v.correct / v.seen)}`],
                          ['rounds lost', num(v.seen - v.correct)],
                        ]
                      : [['rounds', 'never played']]
                  }
                />
              )
              return (
                <path
                  key={c.id}
                  className={'cn' + (hover === c.id ? ' hit' : '')}
                  d={c.d}
                  fill={fill}
                  fillOpacity={op}
                  onPointerEnter={(ev) => {
                    setHover(c.id)
                    tip.show(node, ev)
                  }}
                  onPointerMove={(ev) => tip.show(node, ev)}
                  onPointerLeave={() => {
                    setHover(null)
                    tip.hide()
                  }}
                />
              )
            })}
          </g>
          {showVectors && (
            <g>
              {misses.map((m) => (
                <g key={m.id}>
                  <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} stroke={S2} strokeWidth={0.9} opacity={0.6} />
                  <circle cx={m.x2} cy={m.y2} r={1.9} fill={S2} />
                </g>
              ))}
            </g>
          )}
        </svg>
      </div>
      <div className="mapscale">
        <span className="cap">held</span>
        <div className="ramp">
          {TROUBLE.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </div>
        <span className="cap">slipping</span>
        <span className="cap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--nodata)' }} /> never played
        </span>
        <span className="cap" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 13, height: 2, background: S2 }} /> last 30 misses, guess → truth
        </span>
        <span className="cap" style={{ marginLeft: 'auto' }}>fill opacity ∝ rounds played</span>
      </div>
    </Panel>
  )
}

function Forecast({ d, tip }: { d: Derived; tip: Tip }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 122
  const m = { l: 26, r: 8, t: 10, b: 18 }
  const bars = [{ label: 'now', n: d.overdue.length, hot: true }, ...d.forecast.map((n, i) => ({ label: '+' + (i + 1), n, hot: false }))]
  const max = Math.max(1, ...bars.map((b) => b.n))
  const bw = w ? (w - m.l - m.r) / bars.length : 0
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b)
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i)
  return (
    <Panel title="Due forecast" note={<><b>{num(d.overdue.length)}</b> waiting · 14d ahead</>}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && (
          <svg className="chart" width={w} height={H} onPointerLeave={tip.hide}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="gridline" x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
                <text className="tick" x={m.l - 6} y={y(v) + 3.5} textAnchor="end">
                  {v}
                </text>
              </g>
            ))}
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
            {bars.map((b, i) => {
              const h = b.n ? Math.max(2, (H - m.t - m.b) * (b.n / max)) : 0
              return (
                <g key={b.label}>
                  <rect
                    x={m.l + i * bw + 1}
                    y={y(0) - h}
                    width={Math.max(1, bw - 2)}
                    height={h}
                    rx={2}
                    fill={b.hot ? S2 : S1}
                  />
                  <rect
                    x={m.l + i * bw}
                    y={m.t}
                    width={bw}
                    height={H - m.t - m.b}
                    fill="transparent"
                    onPointerMove={(ev) =>
                      tip.show(
                        <TipRows
                          head={b.hot ? 'due now' : `in ${b.label.slice(1)} day${b.label === '+1' ? '' : 's'}`}
                          rows={[['cards', num(b.n)]]}
                        />,
                        ev,
                      )
                    }
                  />
                  {(i === 0 || (i + 1) % 3 === 0) && (
                    <text className="tick" x={m.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">
                      {b.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: S2 }} />
          overdue / due now
        </span>
        <span>
          <i style={{ background: S1 }} />
          scheduled
        </span>
      </div>
    </Panel>
  )
}

function Deck({ d, data }: { d: Derived; data: Data }) {
  const total = d.composition.reduce((a, c) => a + c.n, 0)
  return (
    <Panel title="Deck composition" note={<><b>{num(total)}</b> metas in the unlocked ladder</>}>
      <div style={{ display: 'flex', height: 26, gap: 2, marginBottom: 10 }}>
        {d.composition.map((c) => (
          <div
            key={c.k}
            style={{ background: c.c, flexGrow: Math.max(c.n, 0.001), borderRadius: 2, minWidth: c.n ? 3 : 0 }}
            title={`${c.k}: ${c.n}`}
          />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 14px' }}>
        {d.composition.map((c) => (
          <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
            <i style={{ width: 9, height: 9, borderRadius: 2, background: c.c, flex: 'none' }} />
            <span className="dim">{c.k}</span>
            <b className="mono" style={{ marginLeft: 'auto', fontWeight: 500 }}>
              {num(c.n)}
            </b>
            <span className="faint mono" style={{ width: 34, textAlign: 'right' }}>
              {pct(c.n / (total || 1))}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, borderTop: '1px solid var(--rule)', paddingTop: 8 }}>
        {data.tiers.map((t, i) => {
          const locked = i + 1 > data.summary.unlockedTiers
          const label = t.name.replace('A Learnable Meta World - ', '').replace('A Learnable Meta World', 'The World')
          return (
            <div
              key={t.name}
              style={{
                display: 'grid',
                gridTemplateColumns: '84px 1fr 62px',
                gap: 10,
                alignItems: 'center',
                padding: '4px 0',
                opacity: locked ? 0.42 : 1,
              }}
            >
              <span style={{ fontSize: 11 }} className="dim">
                {label}
              </span>
              <div className="meter">
                <i style={{ width: pct(t.metas ? t.learned / t.metas : 0) }} />
              </div>
              <span className="mono faint" style={{ fontSize: 10.5, textAlign: 'right' }}>
                {locked ? 'locked' : `${t.learned}/${t.metas}`}
              </span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function Retention({ d, tip }: { d: Derived; tip: Tip }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150
  const m = { l: 30, r: 14, t: 12, b: 30 }
  const pts = d.expBuckets.map((b, i) => ({ i, n: b.n, v: b.n ? b.correct / b.n : 0 }))
  const live = pts.filter((p) => p.n > 0)
  const x = (i: number) => m.l + (i / 5) * (w - m.l - m.r)
  const y = (v: number) => m.t + (1 - v) * (H - m.t - m.b)
  const path = live.map((p, i) => (i ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join('')
  const lastPt = live[live.length - 1]
  return (
    <Panel title="Retention by exposure" cls="c3" note={<>nth sighting of a meta</>}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && (
          <svg className="chart" width={w} height={H} onPointerLeave={tip.hide}>
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line className="gridline" x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
                <text className="tick" x={m.l - 6} y={y(v) + 3.5} textAnchor="end">
                  {v * 100}
                </text>
              </g>
            ))}
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
            {live.length > 1 && (
              <path
                d={`${path}L${x(lastPt.i)} ${y(0)}L${x(live[0].i)} ${y(0)}Z`}
                fill={S1}
                fillOpacity={0.1}
                stroke="none"
              />
            )}
            <path d={path} fill="none" stroke={S1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {live.map((p) => (
              <g key={p.i}>
                <circle cx={x(p.i)} cy={y(p.v)} r={4} fill={S1} stroke={SURFACE} strokeWidth={2} />
                <rect
                  x={x(p.i) - (w - m.l - m.r) / 12}
                  y={m.t}
                  width={(w - m.l - m.r) / 6}
                  height={H - m.t - m.b}
                  fill="transparent"
                  onPointerMove={(ev) =>
                    tip.show(
                      <TipRows
                        head={p.i === 5 ? 'sighting 6+' : `sighting ${p.i + 1}`}
                        rows={[
                          ['right country', pct(p.v, 1)],
                          ['rounds', num(p.n)],
                        ]}
                      />,
                      ev,
                    )
                  }
                />
              </g>
            ))}
            {lastPt && (
              <text className="lbl" x={x(lastPt.i)} y={y(lastPt.v) - 10} textAnchor="end">
                {pct(lastPt.v)}
              </text>
            )}
            {pts.map((p) => (
              <g key={p.i}>
                <text className="tick" x={x(p.i)} y={H - 16} textAnchor="middle">
                  {p.i === 5 ? '6+' : p.i + 1}
                </text>
                <text className="tick" x={x(p.i)} y={H - 5} textAnchor="middle" opacity={0.65}>
                  {p.n || '–'}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <div className="legend">
        <span>% right country · rounds sampled below each tick</span>
      </div>
    </Panel>
  )
}

function Form({ d, tip }: { d: Derived; tip: Tip }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150
  const m = { l: 30, r: 14, t: 12, b: 30 }
  const pts = d.roll
  const x = (i: number) => m.l + (pts.length < 2 ? 0.5 : i / (pts.length - 1)) * (w - m.l - m.r)
  const y = (v: number) => m.t + (1 - v) * (H - m.t - m.b)
  const path = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('')
  const mean = d.accuracy ?? 0
  return (
    <Panel title="Form" cls="c3" note={<><b>{d.win}</b>-round rolling window</>}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && pts.length > 1 && (
          <svg
            className="chart"
            width={w}
            height={H}
            onPointerLeave={tip.hide}
            onPointerMove={(ev) => {
              const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
              const i = Math.round(((ev.clientX - r.left - m.l) / (w - m.l - m.r)) * (pts.length - 1))
              const k = Math.max(0, Math.min(pts.length - 1, i))
              const rd = d.rounds[k]
              tip.show(
                <TipRows
                  head={`round ${k + 1} of ${pts.length}`}
                  rows={[
                    ['rolling accuracy', pct(pts[k], 1)],
                    ['location', cname(rd.answer)],
                    ['result', rd.correct ? 'right country' : rd.guess ? `called ${cname(rd.guess)}` : 'timed out'],
                  ]}
                />,
                ev,
              )
            }}
          >
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line className="gridline" x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
                <text className="tick" x={m.l - 6} y={y(v) + 3.5} textAnchor="end">
                  {v * 100}
                </text>
              </g>
            ))}
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(mean)} y2={y(mean)} stroke="var(--ink-3)" />
            <text className="tick" x={w - m.r} y={y(mean) - 5} textAnchor="end">
              mean {pct(mean)}
            </text>
            <path d={path} fill="none" stroke={S1} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r={4} fill={S1} stroke={SURFACE} strokeWidth={2} />
            <text className="tick" x={m.l} y={H - 8}>
              round 1
            </text>
            <text className="tick" x={w - m.r} y={H - 8} textAnchor="end">
              {num(pts.length)}
            </text>
          </svg>
        )}
      </div>
      <div className="legend">
        <span>share of the last {d.win} rounds with the right country</span>
      </div>
    </Panel>
  )
}

function Volume({ d, tip }: { d: Derived; tip: Tip }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150
  const m = { l: 30, r: 14, t: 12, b: 30 }
  const max = Math.max(1, ...d.volume.map((v) => v.n))
  const bw = w ? (w - m.l - m.r) / d.volume.length : 0
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b)
  const fmt = (t: number) =>
    d.hourly
      ? new Date(t).toLocaleString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
  const every = Math.max(1, Math.round(d.volume.length / 5))
  return (
    <Panel title="Capture volume" cls="c3" note={<>rounds per {d.hourly ? 'hour' : 'day'}</>}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && (
          <svg className="chart" width={w} height={H} onPointerLeave={tip.hide}>
            {[0, Math.round(max / 2), max]
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((v) => (
                <g key={v}>
                  <line className="gridline" x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
                  <text className="tick" x={m.l - 6} y={y(v) + 3.5} textAnchor="end">
                    {v}
                  </text>
                </g>
              ))}
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
            {d.volume.map((v, i) => {
              const h = v.n ? Math.max(2, (H - m.t - m.b) * (v.n / max)) : 0
              return (
                <g key={v.t}>
                  <rect x={m.l + i * bw + (bw > 4 ? 1 : 0.25)} y={y(0) - h} width={Math.max(0.8, bw - (bw > 4 ? 2 : 0.5))} height={h} rx={bw > 6 ? 2 : 0} fill={S1} />
                  <rect
                    x={m.l + i * bw}
                    y={m.t}
                    width={bw}
                    height={H - m.t - m.b}
                    fill="transparent"
                    onPointerMove={(ev) =>
                      tip.show(
                        <TipRows
                          head={
                            d.hourly
                              ? new Date(v.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', hour12: false }) + ':00'
                              : new Date(v.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
                          }
                          rows={[
                            ['rounds', num(v.n)],
                            ['right country', v.n ? `${v.correct} · ${pct(v.correct / v.n)}` : '–'],
                          ]}
                        />,
                        ev,
                      )
                    }
                  />
                </g>
              )
            })}
            {d.volume.map((v, i) =>
              i % every === 0 ? (
                <text className="tick" key={'t' + v.t} x={m.l + i * bw + bw / 2} y={H - 8} textAnchor="middle">
                  {fmt(v.t)}
                </text>
              ) : null,
            )}
          </svg>
        )}
      </div>
      <div className="legend">
        <span>{num(d.rounds.length)} rounds captured in scope</span>
      </div>
    </Panel>
  )
}

function Scores({ d, tip }: { d: Derived; tip: Tip }) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150
  const m = { l: 30, r: 14, t: 12, b: 30 }
  const max = Math.max(1, ...d.scoreBins)
  const bw = w ? (w - m.l - m.r) / 10 : 0
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b)
  return (
    <Panel title="Score distribution" cls="c3" note={<>avg <b>{d.avgScore ? num(d.avgScore) : '–'}</b> / 5000</>}>
      <div ref={ref} style={{ width: '100%' }}>
        {w > 0 && (
          <svg className="chart" width={w} height={H} onPointerLeave={tip.hide}>
            {[0, Math.round(max / 2), max]
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((v) => (
                <g key={v}>
                  <line className="gridline" x1={m.l} x2={w - m.r} y1={y(v)} y2={y(v)} />
                  <text className="tick" x={m.l - 6} y={y(v) + 3.5} textAnchor="end">
                    {v}
                  </text>
                </g>
              ))}
            <line className="axis" x1={m.l} x2={w - m.r} y1={y(0)} y2={y(0)} />
            {d.scoreBins.map((n, i) => {
              const h = n ? Math.max(2, (H - m.t - m.b) * (n / max)) : 0
              return (
                <g key={i}>
                  <rect x={m.l + i * bw + 1} y={y(0) - h} width={Math.max(1, bw - 2)} height={h} rx={2} fill={S1} />
                  <rect
                    x={m.l + i * bw}
                    y={m.t}
                    width={bw}
                    height={H - m.t - m.b}
                    fill="transparent"
                    onPointerMove={(ev) =>
                      tip.show(
                        <TipRows
                          head={`${i * 500}–${i * 500 + 499} pts`}
                          rows={[
                            ['rounds', num(n)],
                            ['share', pct(n / Math.max(1, d.rounds.length), 1)],
                          ]}
                        />,
                        ev,
                      )
                    }
                  />
                </g>
              )
            })}
            {[0, 2, 4, 6, 8, 10].map((i) => (
              <text className="tick" key={i} x={m.l + i * bw} y={H - 8} textAnchor="middle">
                {i ? i / 2 + 'k' : '0'}
              </text>
            ))}
          </svg>
        )}
      </div>
      <div className="legend">
        <span>median miss {d.median != null ? num(d.median) + ' km' : '–'}</span>
      </div>
    </Panel>
  )
}

type SortKey = 'name' | 'seen' | 'hit' | 'streak' | 'lapses' | 'stab' | 'r' | 'due'

function MetaTable({ d, data }: { d: Derived; data: Data }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'seen', dir: -1 })
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const inDeck = new Set(data.lastDeck?.metas ?? [])
    const list = data.cards.map((c) => {
      const s = d.metaStats.get(c.name)
      return {
        c,
        seen: s?.seen ?? 0,
        hit: s && s.seen ? s.correct / s.seen : null,
        streak: s?.streak ?? 0,
        due: +new Date(c.due),
        inDeck: inDeck.has(c.name),
      }
    })
    const term = q.trim().toLowerCase()
    const filtered = term ? list.filter((r) => r.c.name.toLowerCase().includes(term)) : list
    const key = (r: (typeof list)[number]) =>
      sort.k === 'name'
        ? r.c.name.toLowerCase()
        : sort.k === 'seen'
          ? r.seen
          : sort.k === 'hit'
            ? (r.hit ?? -1)
            : sort.k === 'streak'
              ? r.streak
              : sort.k === 'lapses'
                ? r.c.lapses
                : sort.k === 'stab'
                  ? r.c.scheduledDays
                  : sort.k === 'r'
                    ? r.c.retrievability
                    : r.due
    return [...filtered].sort((a, b) => {
      const ka = key(a) as any
      const kb = key(b) as any
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sort.dir
    })
  }, [data.cards, data.lastDeck, d.metaStats, sort, q])

  const th = (k: SortKey, label: string, right = false) => (
    <th
      className={'s' + (right ? ' r' : '') + (sort.k === k ? ' on' : '')}
      onClick={() => setSort((s) => ({ k, dir: s.k === k ? ((-s.dir) as 1 | -1) : k === 'name' ? 1 : -1 }))}
    >
      {label}
      {sort.k === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <Panel
      title="Meta mastery"
      cls="c8"
      flush
      note={
        <input
          className="filter"
          placeholder="filter metas…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      }
    >
      <div className="scroll" style={{ flex: '1 1 auto', minHeight: 0, maxHeight: 430 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th
        className={'s' + (sort.k === 'name' ? ' on' : '')}
        style={{ width: '100%' }}
        onClick={() => setSort((s) => ({ k: 'name', dir: s.k === 'name' ? ((-s.dir) as 1 | -1) : 1 }))}
      >
        Meta{sort.k === 'name' ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </th>
              {th('seen', 'Seen', true)}
              {th('hit', 'Hit', true)}
              {th('streak', 'Run', true)}
              {th('lapses', 'Lapse', true)}
              {th('stab', 'Interval', true)}
              {th('r', 'Recall', true)}
              {th('due', 'Next due', true)}
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const overdue = r.due <= d.now
              return (
                <tr key={r.c.name}>
                  <td className="name" title={r.c.name}>
                    {r.inDeck && (
                      <span
                        title="in the current deck"
                        style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 1, background: S2, marginRight: 7, verticalAlign: 'middle' }}
                      />
                    )}
                    {r.c.name}
                  </td>
                  <td className="num r">{r.seen || '–'}</td>
                  <td className="num r">{r.hit == null ? '–' : pct(r.hit)}</td>
                  <td className="num r">{r.streak || '–'}</td>
                  <td className="num r" style={{ color: r.c.lapses ? 'var(--amber)' : undefined }}>
                    {r.c.lapses || '–'}
                  </td>
                  <td className="num r">{r.c.scheduledDays}d</td>
                  <td className="r" style={{ width: 96 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
                      <div className={'meter' + (r.c.retrievability < 0.9 ? ' warm' : '')} style={{ width: 40 }}>
                        <i style={{ width: pct(r.c.retrievability) }} />
                      </div>
                      <span className="mono" style={{ fontSize: 11, width: 30 }}>
                        {pct(r.c.retrievability)}
                      </span>
                    </div>
                  </td>
                  <td className="num r" style={{ color: overdue ? 'var(--amber)' : undefined }}>
                    {overdue ? 'due' : rel(r.due - d.now).replace('in ', '')}
                  </td>
                  <td>
                    <span
                      className={
                        'state ' + (r.c.mastered ? 'mastered' : r.c.state === 1 || r.c.state === 3 ? 'learn' : '')
                      }
                    >
                      {r.c.mastered ? 'MASTERED' : r.c.state === 3 ? 'RELEARN' : r.c.state === 1 ? 'LEARNING' : 'REVIEW'}
                    </span>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  no metas match "{q}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Confusions({ d }: { d: Derived }) {
  const rows = [...d.confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
  const max = rows[0]?.[1] ?? 1
  return (
    <Panel title="Confusion pairs" note={<><b>{num(d.confusions.size)}</b> distinct</>}>
      {rows.length === 0 && <div className="empty">no misses in scope</div>}
      {rows.map(([pair, n]) => {
        const [a, b] = pair.split('>')
        return (
          <div key={pair} className="rowbar" style={{ gridTemplateColumns: '1fr 62px 22px' }}>
            <div style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span className="cc">{a}</span> {nameOf(a)} <span className="faint">→</span>{' '}
              <span className="cc">{b}</span> {nameOf(b)}
            </div>
            <div className="meter warm">
              <i style={{ width: pct(n / max) }} />
            </div>
            <span className="mono faint" style={{ fontSize: 11, textAlign: 'right' }}>
              {n}
            </span>
          </div>
        )
      })}
    </Panel>
  )
}

function Countries({ d }: { d: Derived }) {
  const rows = useMemo(
    () =>
      [...d.countries.entries()]
        .map(([cc, v]) => ({ cc, ...v, leak: v.seen - v.correct, acc: v.correct / v.seen }))
        .sort((a, b) => b.leak - a.leak || b.seen - a.seen),
    [d.countries],
  )
  return (
    <Panel title="Where points leak" cls="grow" flush note={<>by rounds lost</>}>
      <div className="scroll" style={{ flex: '1 1 0', minHeight: 120 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Country</th>
              <th className="r">Lost</th>
              <th className="r">Seen</th>
              <th className="r" style={{ width: 96 }}>
                Accuracy
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cc}>
                <td className="name">
                  <span className="cc">{r.cc}</span> {nameOf(r.cc)}
                </td>
                <td className="num r" style={{ color: r.leak ? 'var(--amber)' : undefined }}>
                  {r.leak || '–'}
                </td>
                <td className="num r faint">{r.seen}</td>
                <td className="r">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end' }}>
                    <div className="meter" style={{ width: 38 }}>
                      <i style={{ width: pct(r.acc), background: TROUBLE[accClass(r.acc)] }} />
                    </div>
                    <span className="mono" style={{ fontSize: 11, width: 30 }}>
                      {pct(r.acc)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  no rounds in scope
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function RecentRounds({ d, onOpen }: { d: Derived; onOpen: (r: Round) => void }) {
  const rows = [...d.rounds].reverse().slice(0, 60)
  return (
    <Panel
      title="Round log"
      cls="c12"
      flush
      note={<>newest first · click a row for the dossier</>}
    >
      <div className="scroll" style={{ maxHeight: 336 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 54 }} />
              <th style={{ width: 108 }}>Time</th>
              <th style={{ width: 78 }}>Result</th>
              <th style={{ width: '30%' }}>Location</th>
              <th style={{ width: '18%' }}>Called</th>
              <th style={{ width: '30%' }}>Meta tested</th>
              <th className="r" style={{ width: 92 }}>
                Distance
              </th>
              <th className="r" style={{ width: 130 }}>
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id + r.ts} className="click" onClick={() => onOpen(r)}>
                <td style={{ padding: '3px 10px' }}>
                  {r.thumb ? (
                    <img className="thumb" loading="lazy" src={r.thumb} alt="" />
                  ) : (
                    <span className="thumb gone" />
                  )}
                </td>
                <td className="num faint">{clock(r.ts)}</td>
                <td>
                  <span className={'chip ' + (r.correct ? 'hit' : 'miss')}>
                    <i />
                    {r.correct ? 'hit' : r.guess ? 'miss' : 'no pin'}
                  </span>
                </td>
                <td className="name">
                  {cname(r.answer)}
                  {r.answer.region && <span className="faint"> · {r.answer.region}</span>}
                </td>
                <td className="name faint">{r.correct ? '—' : r.guess ? cname(r.guess) : 'timed out'}</td>
                <td className="name dim">{r.metaName ?? <span className="faint">ungraded</span>}</td>
                <td className="num r">{r.distanceKm != null ? num(r.distanceKm) + ' km' : '–'}</td>
                <td className="r">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                    <div className="meter" style={{ width: 56 }}>
                      <i style={{ width: pct((r.score ?? 0) / 5000) }} />
                    </div>
                    <span className="mono" style={{ fontSize: 11.5, width: 38 }}>
                      {r.score != null ? num(r.score) : '–'}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  no rounds captured in this window
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/* ============================================================== dashboard */
export default function Dashboard() {
  const [demo, setDemo] = useState(() => location.search.includes('demo'))
  const [scope, setScope] = useState(0) // days; 0 = all
  const [data, setData] = useState<Data | null>(null)
  const [offline, setOffline] = useState(false)
  const [dossier, setDossier] = useState<any | null>(null)
  const [tipNode, tip] = useTip()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const d = useDerived(data, scope)

  useEffect(() => {
    let live = true
    fetch('/api/dashboard' + (demo ? '?demo=1' : ''))
      .then((r) => r.json())
      .then((j) => live && setData(j))
      .catch(() => live && setOffline(true))
    return () => {
      live = false
    }
  }, [demo])

  useEffect(() => {
    const dlg = dialogRef.current
    if (dossier && dlg && !dlg.open) dlg.showModal()
    if (!dossier && dlg?.open) dlg.close()
  }, [dossier])

  const openDossier = (r: Round) => {
    fetch(`/rounds/${r.id}/dossier.json`)
      .then((x) => x.json())
      .then((j) => setDossier({ ...j, _round: r }))
      .catch(() => setDossier({ _round: r, _missing: true }))
  }

  if (offline)
    return (
      <div className="boot">
        <h1>Bridge offline</h1>
        <p>
          start it with <span style={{ color: 'var(--lime)' }}>node coach/server.mjs</span> and reload
        </p>
      </div>
    )
  if (!data || !d)
    return (
      <div className="boot">
        <h1>GeoCoach</h1>
        <p>reading state…</p>
      </div>
    )

  const lastRound = d.all[d.all.length - 1]
  const nextDue = data.summary.nextDue ? +new Date(data.summary.nextDue) : null
  const totalMetas = data.cards.length + data.summary.unseen
  const volSpark = d.volume.slice(-24).map((v) => v.n)
  const accSpark = d.roll.slice(-40)

  return (
    <>
      <div className="bloom" aria-hidden />
      <div className="topbar">
        <div className="brand">
          <i />
          GeoCoach<s>bridge 5177</s>
        </div>
        <div className="sep" />
        <div className={'stat' + (data.summary.due > 0 ? ' warn' : '')}>
          due <b>{num(data.summary.due)}</b>
        </div>
        <div className="stat">
          deck <b>{num(data.cards.length)}</b>
        </div>
        <div className="stat">
          last capture <b>{lastRound ? rel(+new Date(lastRound.ts) - d.now) : '—'}</b>
        </div>
        <div className="stat">
          catalogs <b>{data.tiers.length}/4</b>
        </div>
        <div className="right">
          <div className="seg">
            {([[7, '7D'], [30, '30D'], [0, 'ALL']] as const).map(([v, l]) => (
              <button key={l} className={scope === v ? 'on' : ''} onClick={() => setScope(v)}>
                {l}
              </button>
            ))}
          </div>
          <div className="seg warm">
            <button className={demo ? 'on' : ''} onClick={() => setDemo((x) => !x)} title="Preview with synthetic play">
              DEMO
            </button>
          </div>
          <a
            className="linkbtn"
            href={`https://www.geoguessr.com/maps/${data.trainerMapId}`}
            target="_blank"
            rel="noreferrer"
          >
            Trainer map ↗
          </a>
        </div>
      </div>

      <div className="app">
        <div className="grid">
          <div className="rail">
            <div className={'kpi' + (data.summary.due > 0 ? ' hot' : '')}>
              <div className="k">Due now</div>
              <div className="v">{num(data.summary.due)}</div>
              <div className="sub">{pct(data.summary.due / Math.max(1, data.cards.length))} of the deck</div>
            </div>
            <div className="kpi">
              <div className="k">Next card ripens</div>
              <div className="v">
                {nextDue && nextDue > d.now ? rel(nextDue - d.now).replace('in ', '') : 'now'}
              </div>
              <div className="sub">{nextDue ? clock(data.summary.nextDue!) : 'nothing scheduled'}</div>
            </div>
            <div className="kpi cool">
              <div className="k">Mastered</div>
              <div className="v">
                {num(d.mastered)}
                <u>/ {num(totalMetas)} metas</u>
              </div>
              <div className="sub">7d+ interval held</div>
            </div>
            <div className="kpi">
              <div className="k">In flight</div>
              <div className="v">{num(data.cards.length - d.mastered)}</div>
              <div className="sub">learning + review</div>
            </div>
            <div className="kpi">
              <div className="k">Rounds captured</div>
              <div className="v">{num(d.rounds.length)}</div>
              <div className="sub">
                <Spark values={volSpark} />
                {scope ? `last ${scope}d` : 'all time'}
              </div>
            </div>
            <div className="kpi cool">
              <div className="k">Country accuracy</div>
              <div className="v">{d.accuracy == null ? '–' : pct(d.accuracy, 1)}</div>
              <div className="sub">
                <Spark values={accSpark} />
                {num(d.hits)} of {num(d.rounds.length)}
              </div>
            </div>
            <div className="kpi">
              <div className="k">Median miss</div>
              <div className="v">
                {d.median != null ? num(d.median) : '–'}
                <u>km</u>
              </div>
              <div className="sub">avg score {d.avgScore ? num(d.avgScore) : '–'}</div>
            </div>
            <div className="kpi">
              <div className="k">Current run</div>
              <div className="v">{num(d.streak)}</div>
              <div className="sub">consecutive right countries</div>
            </div>
          </div>

          <WorldMap d={d} tip={tip} />
          <div className="c4 stack">
            <Forecast d={d} tip={tip} />
            <Deck d={d} data={data} />
          </div>

          <Retention d={d} tip={tip} />
          <Form d={d} tip={tip} />
          <Volume d={d} tip={tip} />
          <Scores d={d} tip={tip} />

          <MetaTable d={d} data={data} />
          <div className="c4 stack">
            <Confusions d={d} />
            <Countries d={d} />
          </div>

          <RecentRounds d={d} onOpen={openDossier} />
        </div>

        <div className="foot">
          <span>
            state <b>coach/state.json</b>
          </span>
          <span>
            deck rebuilt <b>{data.lastDeck ? rel(+new Date(data.lastDeck.ts) - d.now) : '—'}</b>
            {data.lastDeck ? ` · ${data.lastDeck.metas.length} metas` : ''}
          </span>
          <span>
            dossiers <b>{num(d.all.length)}</b> archived
          </span>
          <span>
            scheduler <b>FSRS</b> · mastery at 7d interval
          </span>
          <span style={{ marginLeft: 'auto' }}>
            imagery © Google Street View · metas © Learnable Meta · clues © Plonk It
          </span>
        </div>
      </div>

      {tipNode}

      <dialog ref={dialogRef} onClick={(e) => e.target === dialogRef.current && setDossier(null)} onClose={() => setDossier(null)}>
        {dossier && (
          <div className="dbody">
            <div className="dhead">
              <h3>
                {cname(dossier._round.answer)}
                {dossier._round.answer.region ? `, ${dossier._round.answer.region}` : ''}
              </h3>
              <span className="m">{clock(dossier._round.ts)}</span>
              <span className={'chip ' + (dossier._round.correct ? 'hit' : 'miss')}>
                <i />
                {dossier._round.correct ? 'hit' : 'miss'}
              </span>
              <button className="dclose" onClick={() => setDossier(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="dpano">
              <img
                loading="lazy"
                src={`/rounds/${dossier._round.id}/pano.jpg`}
                alt=""
                onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')}
              />
            </div>
            <div className="dmeta">
              <div className="kv">
                <b>Meta tested</b>
                <span>
                  {dossier.lm?.metaName ?? dossier._round.metaName ?? 'not identified — this round graded no card'}
                  {dossier.lm?.country ? <span className="faint"> · {dossier.lm.country}</span> : null}
                </span>
              </div>
              {dossier.lm?.note && (
                <div className="lesson">
                  <p>{String(dossier.lm.note).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</p>
                  {dossier.lm.images?.[0] && <img src={dossier.lm.images[0]} alt="" loading="lazy" />}
                </div>
              )}
              <div className="kv">
                <b>Call</b>
                <span>
                  {dossier._round.correct ? 'right country' : `called ${dossier._round.guess ? cname(dossier._round.guess) : 'nothing'}`}
                  {dossier.guess?.region && !dossier._round.correct ? ` (${dossier.guess.region})` : ''}
                  {dossier._round.distanceKm != null ? ` · ${num(dossier._round.distanceKm)} km off` : ''} · score{' '}
                  {dossier._round.score != null ? num(dossier._round.score) : '–'}
                  {dossier.correctScope === false && dossier._round.correct ? ' · right country, wrong region' : ''}
                </span>
              </div>
              <div className="kv">
                <b>Location</b>
                <span>
                  {[dossier.answer?.locality, dossier.answer?.region, cname(dossier._round.answer)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {dossier.history?.thisCountry && (
                <div className="kv">
                  <b>Track record here</b>
                  <span>
                    {dossier.history.thisCountry.correctCountry} of {dossier.history.thisCountry.seen} rounds called
                    correctly before this one
                  </span>
                </div>
              )}
              {dossier.plonkit?.answer?.length ? (
                <div className="kv">
                  <b>Plonk It clues</b>
                  <span>
                    {dossier.plonkit.answer.length} cached for {cname(dossier._round.answer)}
                    {dossier.plonkit.guessed?.length
                      ? `, ${dossier.plonkit.guessed.length} for ${dossier._round.guess ? cname(dossier._round.guess) : '?'}`
                      : ''}{' '}
                    — ask Claude about round <span className="mono">{dossier._round.id}</span>
                  </span>
                </div>
              ) : null}
            {dossier._missing && (
                <div className="kv">
                  <b>Dossier</b>
                  <span>no archived dossier on disk for this round</span>
                </div>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  )
}
