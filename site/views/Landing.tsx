import { useEffect, useState } from 'react'
import { Foot, Link, Mast } from '../router'
import { fetchStats, getToken, type PublicStats } from '../api'
import { useWidth } from '../measure'

/* --------------------------------------------------------------------------
   The specimen card.

   This is coach/geocoach.user.js showCard() redrawn in markup: same 380px
   width, same three bands, same badge, same four keys, same footer link. The
   clue and the note are a real Cambodian meta lifted from the offline Plonkit
   guide the card's footer opens, so nothing on this page is invented.
   -------------------------------------------------------------------------- */
const KEYS = ['Again', 'Hard', 'Good', 'Easy'] as const

function Specimen() {
  return (
    <figure className="spec">
      <div className="panel gcCard" role="img" aria-label="The GeoCoach clue card as it appears at the end of a round">
        <div className="gcHead" aria-hidden>
          <div className="gcTop">
            <b>Cambodia: Chevron</b>
            <div className="rt">
              <span className="pill slip">✗ Missed clue</span>
              <span className="gcX">✕</span>
            </div>
          </div>
          <p className="gcNote">
            Chevrons in Cambodia are black with yellow arrows. Every other country in South-East Asia reverses it —
            yellow with black arrows.
          </p>
        </div>
        <div className="gcRate" aria-hidden>
          <div className="gcRateHead">
            <span className="tag">Rate your recall</span>
            <span className="gcInfo">i</span>
          </div>
          <div className="gcKeys">
            {KEYS.map((k) => (
              <span className={'k' + (k === 'Again' ? ' on again' : '')} key={k}>
                {k}
              </span>
            ))}
          </div>
        </div>
        <div className="gcFoot" aria-hidden>
          Open Plonkit guide ↗
        </div>
      </div>
      <figcaption className="figcap">
        <b>Fig. 1</b>
        <span>Drawn to scale from the live card. Real cards also carry the clue's photograph.</span>
      </figcaption>
    </figure>
  )
}

/* --------------------------------------------------------------------------
   Two figures that show the mechanic instead of describing it. Both are hand
   drawn SVG on the validated ordinal ramp (--o1..--o4): one hue, lightness
   carrying the order, which is exactly what "shorter wait -> longer wait" is.
   -------------------------------------------------------------------------- */
const LADDER = [
  { k: 'Again', d: 0.007, s: '10 min', c: 'var(--o1)' },
  { k: 'Hard', d: 2.4, s: '2.4 days', c: 'var(--o2)' },
  { k: 'Good', d: 5.6, s: '5.6 days', c: 'var(--o3)' },
  { k: 'Easy', d: 13, s: '13 days', c: 'var(--o4)' },
]

function Ladder() {
  const [box, W] = useWidth()
  const x0 = 56
  const span = Math.max(60, W - x0 - 72) // the right gutter holds "13 days"
  const perDay = span / 14
  const H = 148
  return (
    <div className="fig" ref={box}>
      {W > 0 && (
    <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Example next interval for one clue after each of the four grades">
      {[7, 14].map((d) => (
        <line key={d} className="gridline" x1={x0 + d * perDay} x2={x0 + d * perDay} y1={4} y2={122} />
      ))}
      <line className="axis" x1={x0} x2={x0} y1={4} y2={122} />
      {LADDER.map((r, i) => {
        const y = 12 + i * 28
        const w = Math.max(3, r.d * perDay)
        return (
          <g key={r.k}>
            <text className="lbl" x={x0 - 9} y={y + 12} textAnchor="end">
              {r.k}
            </text>
            <rect x={x0} y={y} width={w} height={17} rx={3} fill={r.c} />
            <text className="tick" x={x0 + w + 8} y={y + 12}>
              {r.s}
            </text>
          </g>
        )
      })}
      {[0, 7, 14].map((d) => (
        <text key={d} className="tick" x={x0 + d * perDay} y={138} textAnchor={d === 0 ? 'start' : 'middle'}>
          {d === 0 ? '0' : `${d}d`}
        </text>
      ))}
    </svg>
      )}
    </div>
  )
}

/* An illustrative fortnight: what the deck asks of you day by day. */
const DUE = [12, 9, 14, 7, 11, 16, 6, 13, 9, 12, 8, 15, 10, 7]
const NEW = [4, 4, 3, 5, 4, 2, 5, 3, 4, 3, 5, 2, 4, 4]
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S', 'M', 'T', 'W', 'T', 'F', 'S', 'S']

function Fortnight() {
  const [box, W] = useWidth()
  const x0 = 24
  const y0 = 8
  const h = 104
  const w = Math.max(60, W - x0 - 4)
  const band = w / DUE.length
  const max = 24
  const H = 148
  const sy = (v: number) => (v / max) * h
  return (
    <>
      <div className="fig" ref={box}>
        {W > 0 && (
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label="Example fortnight of scheduled reviews and new clues, day by day">
        {[0, 12, 24].map((t) => (
          <g key={t}>
            <line className="gridline" x1={x0} x2={x0 + w} y1={y0 + h - sy(t)} y2={y0 + h - sy(t)} />
            <text className="tick" x={x0 - 6} y={y0 + h - sy(t) + 3.5} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {DUE.map((d, i) => {
          const n = NEW[i]
          const bx = x0 + i * band + band * 0.24
          const bw = band * 0.52
          return (
            <g key={i}>
              <rect x={bx} y={y0 + h - sy(d)} width={bw} height={sy(d)} rx={2} fill="var(--o4)" />
              <rect x={bx} y={y0 + h - sy(d + n)} width={bw} height={sy(n)} rx={2} fill="var(--o2)" />
              <text className="tick" x={bx + bw / 2} y={y0 + h + 16} textAnchor="middle">
                {DAYS[i]}
              </text>
            </g>
          )
        })}
        <line className="axis" x1={x0} x2={x0 + w} y1={y0 + h} y2={y0 + h} />
        <text className="tick" x={x0} y={y0 + h + 34}>
          today
        </text>
        <text className="tick" x={x0 + w} y={y0 + h + 34} textAnchor="end">
          + 14 days
        </text>
      </svg>
        )}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--o4)' }} /> Clues due back
        </span>
        <span>
          <i style={{ background: 'var(--o2)' }} /> New clues introduced
        </span>
      </div>
    </>
  )
}

/* Held vs slipping, said with the same two pills the card uses. */
const HS = [
  { m: 'Cambodia: Chevron', seen: 12, right: 5, lapses: 3 },
  { m: 'Peru: Bus shelter', seen: 9, right: 3, lapses: 2 },
  { m: 'Kenya: Road lines', seen: 15, right: 14, lapses: 0 },
  { m: 'Japan: Utility pole tag', seen: 21, right: 20, lapses: 1 },
]

function HeldSlipping() {
  return (
    <div className="tbl hs">
      <div className="r head">
        <span>Clue</span>
        <span>Hit rate</span>
        <span className="rt">Seen</span>
        <span className="rt">State</span>
      </div>
      {HS.map((r) => {
        const pct = Math.round((r.right / r.seen) * 100)
        const held = pct >= 70
        return (
          <div className="r" key={r.m}>
            <span className="nm">{r.m}</span>
            <span className="m">
              <span className={'meter' + (held ? '' : ' warm')} style={{ flex: 1 }}>
                <i style={{ width: `${pct}%` }} />
              </span>
              <span className="num">{pct}%</span>
            </span>
            <span className="num rt">
              {r.right}/{r.seen}
            </span>
            <span className="rt">
              <span className={held ? 'pill hold' : 'pill slip'}>{held ? '✓ Held' : '✗ Slipping'}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
const LOOP = [
  {
    n: '01',
    h: 'You play',
    p: 'Nothing changes about how you play. When a round ends the userscript reads the location, your guess, the distance and the clue the map was built around, and posts it to your account.',
  },
  {
    n: '02',
    h: 'The card asks one question',
    p: 'The clue you were meant to spot appears over the game in its own words, marked held or missed. One tap grades your recall; doing nothing keeps the grade GeoCoach inferred from the round.',
  },
  {
    n: '03',
    h: 'The map is rebuilt',
    p: 'FSRS turns that grade into a date. Before your next game the trainer map in your GeoGuessr profile is rewritten, leading with the clues closest to falling out of memory.',
  },
]

const NOTES = [
  {
    n: '01',
    h: 'It is a userscript',
    p: (
      <>
        Install{' '}
        <a className="inl" href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">
          Tampermonkey
        </a>
        , click your personal link once, and updates arrive from the same place.
      </>
    ),
  },
  { n: '02', h: 'Free', p: <>No charge, no email, no password.</> },
  {
    n: '03',
    h: 'Your account is a link',
    p: <>Signing up hands you a private link. Anyone holding it can read your account, so keep it to yourself.</>,
  },
  {
    n: '04',
    h: 'Scheduled by FSRS',
    p: <>Reviews are timed by the same memory model Anki uses, fed by how you grade each round.</>,
  },
  {
    n: '05',
    h: 'Guides are Plonkit',
    p: <>Every card links straight to the Plonkit page for the country, so the full write-up is one click away.</>,
  },
  {
    n: '06',
    h: 'Made by a player',
    p: <>Built for the GeoGuessr community. GeoCoach has no connection to GeoGuessr itself.</>,
  },
]

const fmt = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString())

export default function Landing() {
  const [stats, setStats] = useState<PublicStats | null>(null)
  const [hasAccount] = useState(() => !!getToken())

  useEffect(() => {
    fetchStats()
      .then((s) => setStats({ users: s.users, rounds: s.rounds, metasTracked: s.metasTracked }))
      .catch(() => setStats(null))
  }, [])

  return (
    <>
      <Mast>
        {hasAccount && (
          <Link to="/app" className="quiet">
            Dashboard →
          </Link>
        )}
        <Link to="/start" className="btn">
          Get started <span className="arr">→</span>
        </Link>
      </Mast>

      <div className="shell">
        <div className="strip">
          <span>Spaced repetition for GeoGuessr</span>
          <span className="sep">/</span>
          <span>Userscript + FSRS</span>
          <span className="sep">/</span>
          <span>Free — no email, no password</span>
        </div>

        <header className="hero">
          <div className="heroCopy">
            <h1>The clues you keep missing, dealt back to you.</h1>
            <p className="lede">
              GeoCoach reads each round the moment it ends, matches the location to the clue it was built around, and
              asks one question: did you know it? Everything after that is bookkeeping — your practice map is rewritten
              around whatever you are closest to forgetting.
            </p>
            <div className="heroCta">
              <Link to="/start" className="btn">
                Get started <span className="arr">→</span>
              </Link>
              <span className="hint">Two minutes. Tampermonkey and a name.</span>
            </div>

            <dl className="counts">
              <div>
                <dt>Players</dt>
                <dd className="mono">{fmt(stats?.users)}</dd>
              </div>
              <div>
                <dt>Rounds captured</dt>
                <dd className="mono">{fmt(stats?.rounds)}</dd>
              </div>
              <div>
                <dt>Clues tracked</dt>
                <dd className="mono">{fmt(stats?.metasTracked)}</dd>
              </div>
            </dl>
          </div>

          <Specimen />
        </header>

        <section className="sec">
          <div className="secHead">
            <span className="ix">01</span>
            <h2>What happens to a round</h2>
            <span className="lead" />
            <span className="meta">3 steps · fully automatic</span>
          </div>
          <div className="loop">
            {LOOP.map((s) => (
              <div className="beat" key={s.n}>
                <span className="ix">{s.n}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="sec">
          <div className="secHead">
            <span className="ix">02</span>
            <h2>What a grade costs you</h2>
            <span className="lead" />
            <span className="meta">FSRS</span>
          </div>
          <p className="secNote">
            The four keys on the card are not a satisfaction rating. Each one sets the date the clue comes back, and the
            deck's daily load is the sum of every date you have set.
          </p>
          <div className="duo">
            <div className="panel">
              <header>
                <h2>Next interval, by grade</h2>
                <span className="note">
                  <span className="eg">Example</span>
                </span>
              </header>
              <div className="body">
                <Ladder />
                <p className="small" style={{ marginTop: 10 }}>
                  One clue you have seen a few times. The real numbers come from your own history — a clue you have
                  lapsed on twice restarts far shorter than one you have held for a month.
                </p>
              </div>
            </div>
            <div className="panel">
              <header>
                <h2>The next fortnight</h2>
                <span className="note">
                  <span className="eg">Example</span>
                </span>
              </header>
              <div className="body">
                <Fortnight />
                <p className="small" style={{ marginTop: 10 }}>
                  A deck of roughly 180 clues, a fortnight out. You never see this queue as a list of flashcards — it
                  arrives as the locations in your next games.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="secHead">
            <span className="ix">03</span>
            <h2>Held, and slipping</h2>
            <span className="lead" />
            <span className="meta">2 states, 1 rule</span>
          </div>
          <p className="secNote">
            A clue is <b>held</b> while you keep calling it right and the interval keeps growing. It is{' '}
            <b>slipping</b> the moment a lapse resets that interval — which is the only thing that decides what your
            next map is made of.
          </p>
          <div className="panel" style={{ marginTop: 16 }}>
            <header>
              <h2>Four clues in one deck</h2>
              <span className="note">
                <span className="eg">Example</span>
              </span>
            </header>
            <div className="body flush">
              <HeldSlipping />
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="secHead">
            <span className="ix">04</span>
            <h2>Before you start</h2>
            <span className="lead" />
            <span className="meta">{NOTES.length} notes</span>
          </div>
          <div className="notes">
            {NOTES.map((note) => (
              <div className="n" key={note.h}>
                <span className="ix">{note.n}</span>
                <h3>{note.h}</h3>
                <p>{note.p}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="panel cta">
          <div>
            <h3>Set up once, then just play.</h3>
            <p>A name, the Tampermonkey extension, and one install link. Nothing else to remember.</p>
          </div>
          <Link to="/start" className="btn">
            Get started <span className="arr">→</span>
          </Link>
        </div>
      </div>

      <Foot>
        <span>GeoCoach — not affiliated with GeoGuessr</span>
        <Link to="/start" className="quiet">
          Get started →
        </Link>
      </Foot>
    </>
  )
}
