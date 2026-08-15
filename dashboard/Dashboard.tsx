import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, MotionConfig, useReducedMotion, useScroll, useTransform } from 'motion/react'
import Lenis from 'lenis'
import Globe, { type GlobeRound } from './Globe'

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
  thumb?: string
  demo?: boolean
}
interface Data {
  now: string
  trainerMapId: string
  summary: { due: number; learning: number; unseen: number; unlockedTiers: number; nextDue: string | null }
  cards: { name: string; retrievability: number; mastered: boolean }[]
  tiers: { name: string; tier: number; metas: number; seen: number; learned: number }[]
  rounds: Round[]
  confusions: Record<string, number>
  countries: Record<string, { seen: number; correctCountry: number }>
  metaSample: string[]
}

const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

const STATIC = typeof location !== 'undefined' && location.search.includes('static')

/* --------------------------------------------------------------- helpers */
const ease = [0.2, 0, 0, 1] as const

function Rise({ children, delay = 0, ...rest }: React.ComponentProps<typeof motion.div> & { delay?: number }) {
  return (
    <motion.div
      initial={STATIC ? false : { opacity: 0, y: 30 }}
      whileInView={STATIC ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -12% 0px' }}
      transition={{ duration: 0.9, ease, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

function SecHead({ num, title, sub }: { num: string; title: React.ReactNode; sub?: string }) {
  return (
    <>
      <div className="secHead">
        <Rise className="secNum">{num}</Rise>
        <Rise delay={0.08}>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </Rise>
      </div>
    </>
  )
}

function useTooltip() {
  const [tip, setTip] = useState<{ html: string; x: number; y: number } | null>(null)
  const node = (
    <div
      className={'tooltip' + (tip ? ' on' : '')}
      style={tip ? { left: Math.min(tip.x + 14, innerWidth - 260), top: tip.y + 16 } : undefined}
      dangerouslySetInnerHTML={{ __html: tip?.html ?? '' }}
    />
  )
  return { node, setTip }
}

/* ---------------------------------------------------------------- charts */
function ForgettingCurve({ setTip }: { setTip: (t: any) => void }) {
  const W = 560, H = 300, m = { l: 44, r: 16, t: 16, b: 34 }
  const days = 30
  const stages = [{ at: 0, s: 1.2 }, { at: 3, s: 4.5 }, { at: 10, s: 16 }]
  const R = (t: number, s: number) => Math.pow(1 + t / (9 * s), -1)
  const x = (d: number) => m.l + (d / days) * (W - m.l - m.r)
  const y = (p: number) => m.t + (1 - p) * (H - m.t - m.b)
  const [cursor, setCursor] = useState<number | null>(null)
  const segs = stages.map((stg, i) => {
    const end = i + 1 < stages.length ? stages[i + 1].at : days
    let d = ''
    for (let t = stg.at; t <= end + 0.001; t += 0.12) d += (d ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(R(t - stg.at, stg.s)).toFixed(1)
    return d
  })
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      onPointerMove={(ev) => {
        const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
        const t = Math.max(0, Math.min(days, (((ev.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r) * days))
        const stg = [...stages].reverse().find((s) => t >= s.at)!
        setCursor(t)
        setTip({ html: `day ${t.toFixed(1)} · <b>${Math.round(R(t - stg.at, stg.s) * 100)}%</b> recall<br><span class="t2">review lands when this nears 90%</span>`, x: ev.clientX, y: ev.clientY })
      }}
      onPointerLeave={() => { setCursor(null); setTip(null) }}
    >
      {[0.25, 0.5, 0.75].map((p) => <line key={p} className="gridline" x1={m.l} x2={W - m.r} y1={y(p)} y2={y(p)} />)}
      <line className="axis" x1={m.l} x2={W - m.r} y1={y(0)} y2={y(0)} />
      {[0, 0.5, 1].map((p) => <text key={p} className="ticklab" x={m.l - 8} y={y(p) + 3.5} textAnchor="end">{p * 100}%</text>)}
      {[0, 10, 20, 30].map((d) => <text key={d} className="ticklab" x={x(d)} y={H - 12} textAnchor="middle">day {d}</text>)}
      {segs.map((d, i) => (
        <motion.path
          key={i} className="accline" d={d}
          initial={STATIC ? false : { pathLength: 0 }} whileInView={STATIC ? undefined : { pathLength: 1 }}
          viewport={{ once: true, margin: '0px 0px -18% 0px' }}
          transition={{ duration: 1.1, delay: 0.25 + i * 0.3, ease: 'easeInOut' }}
        />
      ))}
      {stages.slice(1).map((stg) => (
        <g key={stg.at}>
          <circle className="dot-marker" cx={x(stg.at)} cy={y(1)} r={4.5} />
          <text className="chartlab" x={x(stg.at)} y={y(1) - 10} textAnchor="middle">review</text>
        </g>
      ))}
      {cursor !== null && <line className="axis" x1={x(cursor)} x2={x(cursor)} y1={m.t} y2={y(0)} strokeDasharray="3 3" />}
    </svg>
  )
}

function VolumeChart({ rounds, setTip }: { rounds: Round[]; setTip: (t: any) => void }) {
  const W = 500, H = 240, m = { l: 34, r: 10, t: 14, b: 30 }
  const { slots, byDay } = useMemo(() => {
    const byDay = new Map<string, number>()
    for (const r of rounds) byDay.set(r.ts.slice(0, 10), (byDay.get(r.ts.slice(0, 10)) ?? 0) + 1)
    const slots: string[] = []
    for (let i = 6; i >= 0; i--) slots.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10))
    for (const k of [...byDay.keys()].sort()) if (!slots.includes(k)) slots.unshift(k)
    return { slots, byDay }
  }, [rounds])
  const max = Math.max(4, ...slots.map((k) => byDay.get(k) ?? 0))
  const bw = (W - m.l - m.r) / slots.length
  const y = (v: number) => m.t + (1 - v / max) * (H - m.t - m.b)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} onPointerLeave={() => setTip(null)}>
      <line className="axis" x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
      {[0, Math.ceil(max / 2), max].map((v) => <text key={v} className="ticklab" x={m.l - 7} y={y(v) + 3.5} textAnchor="end">{v}</text>)}
      {slots.map((k, i) => {
        const v = byDay.get(k) ?? 0
        const bx = m.l + i * bw + bw * 0.18, w = bw * 0.64
        const bh = Math.max(v ? 3 : 0, (H - m.t - m.b) * (v / max))
        return (
          <g key={k}>
            <motion.rect
              className="bar-day" x={bx} width={w} rx={3.5}
              initial={STATIC ? false : { y: H - m.b, height: 0 }}
              whileInView={STATIC ? undefined : { y: H - m.b - bh, height: bh }}
              viewport={{ once: true, margin: '0px 0px -15% 0px' }}
              transition={{ duration: 0.7, delay: i * 0.035, ease }}
              onPointerMove={(ev) => setTip({ html: `${k} · <b>${v} rounds</b>`, x: ev.clientX, y: ev.clientY })}
            />
            {(i % Math.ceil(slots.length / 7) === 0 || i === slots.length - 1) && (
              <text className="ticklab" x={bx + w / 2} y={H - 10} textAnchor="middle">{k.slice(5).replace('-', '/')}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function AccuracyChart({ rounds, setTip }: { rounds: Round[]; setTip: (t: any) => void }) {
  const W = 500, H = 240, m = { l: 40, r: 12, t: 14, b: 30 }
  const pts = useMemo(() => {
    const out: { i: number; v: number }[] = []
    let n = 0, h = 0
    rounds.forEach((r, i) => { n++; if (r.correct) h++; out.push({ i, v: h / n }) })
    return out
  }, [rounds])
  const x = (i: number) => m.l + (pts.length === 1 ? 0.5 : i / (pts.length - 1)) * (W - m.l - m.r)
  const y = (v: number) => m.t + (1 - v) * (H - m.t - m.b)
  let d = ''
  pts.forEach((p, i) => (d += (i ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.v).toFixed(1)))
  const last = pts[pts.length - 1]
  return (
    <svg
      className="chart" viewBox={`0 0 ${W} ${H}`}
      onPointerMove={(ev) => {
        if (!pts.length) return
        const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
        const i = Math.round((((ev.clientX - r.left) / r.width) * W - m.l) / (W - m.l - m.r) * (pts.length - 1))
        const p = pts[Math.max(0, Math.min(pts.length - 1, i))]
        const rd = rounds[p.i]
        setTip({ html: `round ${p.i + 1} · <b>${Math.round(p.v * 100)}%</b> cumulative<br><span class="t2">${rd.answer.name}${rd.correct ? ' ✓' : rd.guess ? ' — guessed ' + rd.guess.name : ' — timed out'}</span>`, x: ev.clientX, y: ev.clientY })
      }}
      onPointerLeave={() => setTip(null)}
    >
      <line className="axis" x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line className="gridline" x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />
          <text className="ticklab" x={m.l - 7} y={y(v) + 3.5} textAnchor="end">{v * 100}%</text>
        </g>
      ))}
      {pts.length === 0 && <text className="chartlab" x={W / 2} y={H / 2} textAnchor="middle">No rounds yet</text>}
      {pts.length > 0 && (
        <>
          <path className="accarea" d={`${d}L${x(last.i)} ${y(0)}L${x(0)} ${y(0)}Z`} />
          <motion.path
            className="accline" d={d}
            initial={STATIC ? false : { pathLength: 0 }} whileInView={STATIC ? undefined : { pathLength: 1 }}
            viewport={{ once: true, margin: '0px 0px -15% 0px' }}
            transition={{ duration: 1.3, ease: 'easeInOut' }}
          />
          <circle className="dot-marker" cx={x(last.i)} cy={y(last.v)} r={4.5} />
          <text className="chartlab" x={x(last.i) - 8} y={y(last.v) - 10} textAnchor="end">{Math.round(last.v * 100)}%</text>
        </>
      )}
      <text className="ticklab" x={m.l} y={H - 10}>round 1</text>
      <text className="ticklab" x={W - m.r} y={H - 10} textAnchor="end">round {Math.max(1, pts.length)}</text>
    </svg>
  )
}

/* ------------------------------------------------------------- dashboard */
export default function Dashboard() {
  const [demo, setDemo] = useState(() => location.search.includes('demo'))
  const isStatic = useMemo(() => location.search.includes('static'), [])
  const [data, setData] = useState<Data | null>(null)
  const [offline, setOffline] = useState(false)
  const [dossier, setDossier] = useState<any | null>(null)
  const { node: tipNode, setTip } = useTooltip()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    fetch('/api/dashboard' + (demo ? '?demo=1' : ''))
      .then((r) => r.json())
      .then(setData)
      .catch(() => setOffline(true))
  }, [demo])

  useEffect(() => {
    if (reduced || STATIC) return
    const lenis = new Lenis({ duration: 1.1, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)) })
    let raf: number
    const loop = (t: number) => { lenis.raf(t); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); lenis.destroy() }
  }, [reduced])

  useEffect(() => {
    const dlg = dialogRef.current
    if (dossier && dlg && !dlg.open) dlg.showModal()
    if (!dossier && dlg?.open) dlg.close()
  }, [dossier])

  const footRef = useRef<HTMLElement>(null)
  const { scrollYProgress: footProg } = useScroll({ target: footRef, offset: ['start end', 'end end'] })
  const footY = useTransform(footProg, [0, 1], ['34%', '0%'])

  const globeRounds: GlobeRound[] = useMemo(
    () => (data?.rounds ?? [])
      .filter((r) => r.guess)
      .map((r) => ({ from: [r.guess!.lat, r.guess!.lng], to: [r.answer.lat, r.answer.lng], correct: r.correct })),
    [data],
  )
  const countryTint = useMemo(() => {
    const tint: Record<string, 'good' | 'bad'> = {}
    for (const [cc, v] of Object.entries(data?.countries ?? {})) {
      if (v.seen >= 1) tint[cc] = v.correctCountry / v.seen >= 0.5 ? 'good' : 'bad'
    }
    return tint
  }, [data])

  if (offline)
    return (
      <div style={{ display: 'grid', placeContent: 'center', minHeight: '100vh', textAlign: 'center' }}>
        <h1 style={{ fontSize: 44 }}>Coach server is <em>offline.</em></h1>
        <p className="sub" style={{ margin: '16px auto 0' }}>Start it with <code>node coach/server.mjs</code> and reload.</p>
      </div>
    )
  if (!data) return null

  const rounds = data.rounds
  const learned = data.cards.filter((c) => c.mastered).length
  const totalMetas = data.tiers.reduce((a, t) => a + t.metas, 0)
  const accuracy = rounds.length ? Math.round((rounds.filter((r) => r.correct).length / rounds.length) * 100) : null
  const lastRound = rounds[rounds.length - 1]
  const daysAgo = lastRound ? (Date.now() - +new Date(lastRound.ts)) / 864e5 : Infinity
  const dueSoon = [...data.cards].sort((a, b) => a.retrievability - b.retrievability).slice(0, 8)
  const inReview = Math.max(0, data.cards.length - data.summary.learning - learned)
  const states: [string, number, string][] = [
    ['unseen', data.summary.unseen, 'var(--ramp-1)'],
    ['learning', data.summary.learning, 'var(--ramp-2)'],
    ['in review', inReview, 'var(--ramp-3)'],
    ['mastered · 7d+', learned, 'var(--ramp-4)'],
  ]
  const conf = Object.entries(data.confusions).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const confMax = conf[0]?.[1] ?? 1
  const hard = Object.entries(data.countries)
    .filter(([, v]) => v.seen >= 2)
    .map(([cc, v]) => ({ cc, seen: v.seen, rate: v.correctCountry / v.seen }))
    .sort((a, b) => a.rate - b.rate || b.seen - a.seen)
    .slice(0, 6)
  const recent = [...rounds].reverse().slice(0, 12)
  const heroWords = ['A', 'trainer', 'that', 'knows']
  const heroWordsEm = ['what', "you're", 'about', 'to', 'forget.']

  return (
    <MotionConfig reducedMotion={isStatic ? 'always' : 'user'} transition={isStatic ? { duration: 0 } : undefined}>
      <div className="grain" aria-hidden />
      <nav className="bar">
        <a className="brand" href="#top">
          <svg viewBox="0 0 20 20" aria-hidden><path d="M10 1.9c-3.2 0-5.7 2.5-5.7 5.6 0 3.9 4.1 6.5 5.7 9.9 1.6-3.4 5.7-6 5.7-9.9 0-3.1-2.5-5.6-5.7-5.6Z" /><circle className="dot" cx="10" cy="7.3" r="2" /></svg>
          GeoCoach
        </a>
        {[['#system', 'System'], ['#science', 'Science'], ['#now', 'Now'], ['#progress', 'Progress'], ['#dossiers', 'Dossiers']].map(([h, l]) => (
          <a key={h} className="lnk" href={h}>{l}</a>
        ))}
        <button className={'demo' + (demo ? ' on' : '')} onClick={() => setDemo(!demo)} title="Preview with three weeks of synthetic play">
          {demo ? 'Demo data' : 'Demo'}
        </button>
        <div className={'live' + (offline ? ' down' : '')}><i /><span>live</span></div>
      </nav>

      {/* ------------------------------------------------------------ hero */}
      <header className="hero" id="top">
        <div className="globeWrap">
          <Globe rounds={globeRounds} countryTint={countryTint} still={isStatic} />
        </div>
        <div className="wrap">
          <div className="kick">
            <motion.span className="rule" initial={STATIC ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.7, delay: 0.2, ease }} />
            <motion.span initial={STATIC ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.4 }}>
              Spaced repetition · GeoGuessr
            </motion.span>
          </div>
          <h1 aria-label="A trainer that knows what you're about to forget.">
            {heroWords.map((w, i) => (
              <span className="mask" key={w}>
                <motion.span
                  style={{ display: 'inline-block' }}
                  initial={STATIC ? false : { y: '115%', rotate: 4 }} animate={{ y: 0, rotate: 0 }}
                  transition={{ duration: 1.1, delay: 0.25 + i * 0.06, ease }}
                >{w}</motion.span>
              </span>
            )).flatMap((el, i) => [el, ' '])}
            <br />
            <em>
              {heroWordsEm.map((w, i) => (
                <span className="mask" key={w}>
                  <motion.span
                    style={{ display: 'inline-block' }}
                    initial={STATIC ? false : { y: '115%', rotate: 4 }} animate={{ y: 0, rotate: 0 }}
                    transition={{ duration: 1.1, delay: 0.5 + i * 0.06, ease }}
                  >{w}</motion.span>
                </span>
              )).flatMap((el) => [el, ' '])}
            </em>
          </h1>
          <motion.p className="lede" initial={STATIC ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 0.95, ease }}>
            GeoGuessr deals random rounds and grades them with a number. GeoCoach captures every
            round, grades it into a real memory model, and quietly rewrites your practice map —
            the next game tests exactly what's fading.
          </motion.p>
          <motion.div className="heroCta" initial={STATIC ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 1.1, ease }}>
            <a className="cta" href={`https://www.geoguessr.com/maps/${data.trainerMapId}`} target="_blank" rel="noreferrer">
              Open the trainer map <span className="arr">→</span>
            </a>
            <a className="ghost" href="#system">See how it works</a>
          </motion.div>
          <div className="heroStats">
            {[
              { n: data.summary.due, l: 'due right now', amber: data.summary.due > 0 },
              { n: data.summary.learning, l: 'learning' },
              { n: `${learned}`, l: `of ${totalMetas} mastered` },
              { n: rounds.length, l: 'rounds captured' },
              { n: accuracy === null ? '—' : accuracy + '%', l: 'country accuracy' },
            ].map((s, i) => (
              <motion.div
                className={'hstat' + (s.amber ? ' amber' : '')} key={s.l}
                initial={STATIC ? false : { opacity: 0, y: 26 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 1.25 + i * 0.08, ease }}
              >
                <b>{s.n}</b><span>{s.l}</span>
              </motion.div>
            ))}
          </div>
          <motion.div className="statusChips" initial={STATIC ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 1.6 }}>
            <span className="chip ok"><i />bridge · 5177</span>
            <span className={'chip ' + (daysAgo < 7 ? 'ok' : 'no')}><i />userscript · {daysAgo < 7 ? 'active' : 'reinstall'}</span>
            <span className={'chip ' + (data.tiers.length >= 4 ? 'ok' : 'no')}><i />catalogs · {data.tiers.length}/4</span>
            <span className="chip ok click" onClick={() => open(`https://www.geoguessr.com/maps/${data.trainerMapId}`)}><i />trainer map ↗</span>
          </motion.div>
        </div>
        <div className="legend">
          <div className="lg"><i style={{ background: 'var(--amber-bright)' }} /> arc · a miss, guess → truth</div>
          <div className="lg"><i style={{ background: 'var(--green-bright)' }} /> arc · a correct recall</div>
          <div className="lg"><u style={{ background: 'var(--amber-bright)' }} /> country that keeps slipping</div>
          <div className="lg"><u style={{ background: 'var(--green-bright)' }} /> country that holds</div>
        </div>
      </header>

      {/* ---------------------------------------------------------- ribbon */}
      {data.metaSample.length > 0 && (
        <div className="ribbon" aria-hidden>
          <motion.div
            className="track"
            animate={reduced || STATIC ? undefined : { x: ['0%', '-50%'] }}
            transition={{ duration: 70, repeat: Infinity, ease: 'linear' }}
          >
            {[...data.metaSample, ...data.metaSample].map((m, i) => (
              <span key={i}>{m}<i> · </i></span>
            ))}
          </motion.div>
        </div>
      )}

      {/* ------------------------------------------------------------ today */}
      <section id="now">
        <div className="wrap">
          <SecHead
            num="01"
            title={<>What the scheduler <em>is thinking.</em></>}
            sub={
              data.summary.due > 0
                ? `${data.summary.due} ${data.summary.due === 1 ? 'memory has' : 'memories have'} slipped past the edge — the next rebuild leads with the weakest.`
                : data.summary.nextDue
                  ? `Nothing due. The next memory reaches its edge ${new Date(data.summary.nextDue).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}; until then, new metas flow in.`
                  : 'No cards yet — play one game on the trainer map and this page comes alive.'
            }
          />
          <Rise className="nowPanel">
            <div className="nowLeft">
              <h4>Weakest memories first</h4>
              <p className="hint">Live recall probability — the deck builder reads this list top-down.</p>
              {dueSoon.length === 0 && <p className="insEmpty">No graded cards yet.</p>}
              {dueSoon.map((c) => (
                <div className="dueRow" key={c.name}>
                  <span>{c.name}</span>
                  <div className="meter">
                    <motion.i
                      initial={STATIC ? false : { width: 0 }} whileInView={STATIC ? undefined : { width: Math.round(c.retrievability * 100) + '%' }}
                      viewport={{ once: true }} transition={{ duration: 0.9, ease }}
                      style={{ display: 'block' }}
                    />
                  </div>
                  <span className="pct">{Math.round(c.retrievability * 100)}%</span>
                </div>
              ))}
            </div>
            <div className="nowRight">
              <h4>The ladder</h4>
              <div className="stateBar">
                {states.map(([k, n, c]) => (
                  <motion.div
                    key={k} style={{ background: c }} title={`${k}: ${n}`}
                    initial={STATIC ? false : { flexGrow: 0.001 }} whileInView={STATIC ? undefined : { flexGrow: Math.max(n, 0.001) }}
                    viewport={{ once: true }} transition={{ duration: 1, ease }}
                  />
                ))}
              </div>
              <div className="stateLegend">
                {states.map(([k, n, c]) => (
                  <div className="lg" key={k}><i style={{ background: c }} />{k}<b>{n}</b></div>
                ))}
              </div>
              <div className="tierMini">
                {data.tiers.map((t, i) => {
                  const locked = i + 1 > data.summary.unlockedTiers
                  const pct = t.metas ? (t.learned / t.metas) * 100 : 0
                  const label = t.name.replace('A Learnable Meta World - ', '').replace('A Learnable Meta World', 'The World')
                  return (
                    <div className={'tierRow' + (locked ? ' locked' : '')} key={t.name}>
                      <b>{label}</b>
                      <div className="bar">
                        <motion.i
                          initial={STATIC ? false : { width: 0 }} whileInView={STATIC ? undefined : { width: pct + '%' }}
                          viewport={{ once: true }} transition={{ duration: 1.1, ease }}
                          style={{ display: 'block' }}
                        />
                      </div>
                      <span className="n2">{locked ? 'locked' : `${t.learned}/${t.metas}`}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </Rise>
        </div>
      </section>

      {/* ------------------------------------------------------------- loop */}
      <section id="system">
        <div className="wrap">
          <SecHead
            num="02"
            title={<>One loop, run at the <em>edge of forgetting.</em></>}
            sub="Memory decays along a curve. Recall something just before it slips and the curve flattens — each retrieval buys exponentially more time. The whole system exists to time that moment."
          />
          <div className="sciGrid">
            <Rise className="sysRows" style={{ marginTop: 0, borderTop: 'none' }}>
              {[
                { n: 'i', h: 'Play', p: 'A normal game on your trainer map. The instant a round ends, a userscript ships the result — true location, panorama, your pin — to a server on your machine.' },
                { n: 'ii', h: 'Grade & debrief', p: 'FSRS grades the recall: a miss returns in minutes, a cold hit earns days. The round is archived as a dossier — imagery, intended meta, both countries\' clues — for Claude to coach from.' },
                { n: 'iii', h: 'Rebuild', p: 'The map republishes itself for the next game: weakest memories first, five new metas, mastered ones resting. Four map tiers unlock as the model watches you actually retain each one.' },
              ].map((r) => (
                <div className="sysRow" key={r.n}>
                  <span className="n">{r.n}</span>
                  <h3>{r.h}</h3>
                  <p>{r.p}</p>
                </div>
              ))}
            </Rise>
            <Rise className="panel" delay={0.1}>
              <h4>The forgetting curve, interrupted</h4>
              <p className="hint">One meta, three reviews. Hover to read recall probability.</p>
              <ForgettingCurve setTip={setTip} />
            </Rise>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- progress + leaks */}
      <section id="progress">
        <div className="wrap">
          <SecHead num="03" title={<>The record, and <em>where points leak.</em></>} />
          <div className="charts2">
            <Rise className="panel"><h4>Rounds played</h4><p className="hint">per day, every map</p><VolumeChart rounds={rounds} setTip={setTip} /></Rise>
            <Rise className="panel" delay={0.1}><h4>Country accuracy</h4><p className="hint">cumulative share with the right country</p><AccuracyChart rounds={rounds} setTip={setTip} /></Rise>
          </div>
          <div className="insGrid">
            <Rise className="insCol">
              <h4>Countries you confuse</h4>
              {conf.length === 0 && <p className="insEmpty">Nothing yet — misses will chart here.</p>}
              {conf.map(([pair, n]) => {
                const [a, b] = pair.split('>')
                return (
                  <div className="insRow" key={pair}>
                    <span className="lbl">{countryName(a)} <span className="as">read as</span> {countryName(b)}</span>
                    <div className="bar">
                      <motion.i initial={STATIC ? false : { width: 0 }} whileInView={STATIC ? undefined : { width: (n / confMax) * 100 + '%' }} viewport={{ once: true }} transition={{ duration: 0.9, ease }} style={{ display: 'block' }} />
                    </div>
                    <b>×{n}</b>
                  </div>
                )
              })}
            </Rise>
            <Rise className="insCol" delay={0.1}>
              <h4>Hardest countries so far</h4>
              {hard.length === 0 && <p className="insEmpty">Play a few rounds first.</p>}
              {hard.map((h) => (
                <div className="insRow" key={h.cc}>
                  <span className="lbl">{countryName(h.cc)}</span>
                  <div className="bar">
                    <motion.i initial={STATIC ? false : { width: 0 }} whileInView={STATIC ? undefined : { width: (1 - h.rate) * 100 + '%' }} viewport={{ once: true }} transition={{ duration: 0.9, ease }} style={{ display: 'block' }} />
                  </div>
                  <b>{Math.round(h.rate * 100)}% of {h.seen}</b>
                </div>
              ))}
            </Rise>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- dossiers */}
      <section id="dossiers">
        <div className="wrap">
          <SecHead
            num="04"
            title={<>Every round, <em>kept.</em></>}
            sub="Open one to see what the coach sees — the location's own imagery, the intended lesson, and the material behind the debrief."
          />
          <Rise>
            <div className="dossStrip">
              <motion.div
                className="dossTrack"
                drag={recent.length > 3 ? 'x' : false}
                dragConstraints={{ left: -(recent.length * 318 - Math.min(innerWidth - 80, 1060)), right: 0 }}
                dragElastic={0.06}
              >
                {recent.length === 0 && <p className="insEmpty">No dossiers yet — play a round with the userscript installed.</p>}
                {recent.map((r) => (
                  <motion.button
                    className="doss" key={r.id + r.ts}
                    initial={STATIC ? false : { opacity: 0, y: 40 }} whileInView={STATIC ? undefined : { opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: '0px 0px -10% 0px' }}
                    transition={{ duration: 0.8, ease }}
                    onClick={() => {
                      if (r.demo) setDossier({ demo: true, round: r })
                      else fetch(`/rounds/${r.id}/dossier.json`).then((x) => x.json()).then(setDossier).catch(() => {})
                    }}
                  >
                    <div className="thumb">
                      <img loading="lazy" src={`/rounds/${r.thumb ?? r.id}/pano_0_1.jpg`} onError={(e) => ((e.target as HTMLElement).style.display = 'none')} alt="" />
                      <span className={'badge ' + (r.correct ? 'hit' : 'miss')}>{r.correct ? 'Correct' : r.guess ? 'Missed' : 'Timed out'}</span>
                    </div>
                    <div className="body">
                      <div className="vs">{r.answer.name}{r.guess && !r.correct && <><span className="arrow">←</span>{r.guess.name}</>}</div>
                      {r.metaName && <span className="metaChip">{r.metaName}</span>}
                      <div className="when">
                        {new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        {r.distanceKm ? ` · ${r.distanceKm.toLocaleString()} km` : ''}
                      </div>
                    </div>
                  </motion.button>
                ))}
              </motion.div>
            </div>
            {recent.length > 3 && <p className="dragHint">drag to browse · {recent.length} recent rounds</p>}
          </Rise>
          <Rise>
            <details className="internals">
              <summary>Under the hood — where everything lives</summary>
              <div className="filemap">
                <pre style={{ font: 'inherit', margin: 0 }}>{''}<b>GeoTrainer/coach/</b>{'\n'}
├─ <b>server.mjs</b>        <span className="c">the bridge — run with</span> <span className="g">node coach/server.mjs</span> <span className="c">· this page is it (port 5177)</span>{'\n'}
├─ <b>geocoach.user.js</b>  <span className="c">the userscript — install & update from</span> <span className="g">http://127.0.0.1:5177/geocoach.user.js</span>{'\n'}
├─ <b>scheduler.mjs</b>     <span className="c">FSRS grading · deck composition · tier ladder (88 tests)</span>{'\n'}
├─ <b>state.json</b>        <span className="c">your memory model — every card, round and confusion</span>{'\n'}
├─ <b>config.json</b>       <span className="c">trainer map id + Learnable Meta token</span>{'\n'}
├─ <b>catalog/</b>          <span className="c">meta-tagged location pools, all four ladder maps</span>{'\n'}
└─ <b>rounds/</b>           <span className="c">one dossier per round — imagery + debrief JSON</span></pre>
              </div>
            </details>
          </Rise>
        </div>
      </section>

      <footer ref={footRef}>
        <motion.span className="mark" style={{ y: reduced ? 0 : footY }}>GeoCoach</motion.span>
        <p className="fine">
          Built for one player. Imagery © Google Street View · meta curation © the Learnable Meta community · clue text © Plonk It.
          <br />Coaching runs in your Claude Code session — say "watch my game" and just play.
        </p>
      </footer>

      {tipNode}
      <dialog ref={dialogRef} onClick={(e) => e.target === dialogRef.current && setDossier(null)} onClose={() => setDossier(null)}>
        {dossier && !dossier.demo && (
          <div className="dbody">
            <button className="dclose" onClick={() => setDossier(null)} aria-label="Close">✕</button>
            <h3>{dossier.answer.name}{dossier.answer.region ? `, ${dossier.answer.region}` : ''}</h3>
            <p className="drow">
              {dossier.correctCountry ? 'Correct country' : dossier.guess ? `Guessed ${dossier.guess.name} — ${(dossier.distanceKm || 0).toLocaleString()} km off` : 'Timed out'}
              {dossier.metaName && <> · meta: <b>{dossier.metaName}</b></>} · score {dossier.score ?? '—'}
            </p>
            {dossier.tiles?.length ? (
              <div className="tiles">{dossier.tiles.map((t: string) => <img key={t} loading="lazy" src={`/rounds/${dossier.id}/${t}`} alt="" />)}</div>
            ) : (
              <p className="drow">No tile imagery for this panorama — the coach opens street view directly.</p>
            )}
            {dossier.lm?.note && (
              <div className="lesson"><h5>The intended lesson</h5><p>{String(dossier.lm.note).replace(/<[^>]+>/g, ' ').trim()}</p></div>
            )}
            <p className="drow" style={{ marginTop: 14 }}>
              Packed for the coach: {(dossier.plonkit?.answer || []).length} Plonk It clues for {dossier.answer.name}
              {dossier.plonkit?.guessed?.length ? `, ${dossier.plonkit.guessed.length} for ${dossier.guess.name}` : ''}.
            </p>
          </div>
        )}
        {dossier?.demo && (
          <div className="dbody">
            <button className="dclose" onClick={() => setDossier(null)} aria-label="Close">✕</button>
            <h3>{dossier.round.answer.name}</h3>
            <p className="drow">
              {dossier.round.correct ? 'Correct country' : dossier.round.guess ? `Guessed ${dossier.round.guess.name} — ${(dossier.round.distanceKm || 0).toLocaleString()} km off` : 'Timed out'}
              {dossier.round.metaName && <> · meta: <b>{dossier.round.metaName}</b></>}
            </p>
            {dossier.round.thumb && (
              <div className="tiles">{[0, 1, 2, 3].map((i) => <img key={i} loading="lazy" src={`/rounds/${dossier.round.thumb}/pano_0_${i}.jpg`} alt="" />)}</div>
            )}
            <p className="drow">Demo round — dossiers for real rounds carry the location's full imagery, the Learnable Meta lesson, and both countries' Plonk It clue sets.</p>
          </div>
        )}
      </dialog>
    </MotionConfig>
  )
}
