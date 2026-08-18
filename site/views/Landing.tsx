import { useCallback, useEffect, useState } from 'react'
import { Foot, Link, Mast } from '../router'
import { fetchStats, getToken, type PublicStats } from '../api'
import Pano from '../Pano'

/* --------------------------------------------------------------------------
   The whole page hangs off one round: 2026-08-17, round 1, a single-track
   road above Portree on Skye. I guessed Wales and missed by 484 km. The
   panorama behind the fold is that round's own capture, the card over it is
   that round's own card, and the sign that gives it away is in the
   photograph — drag right and you will find it.

   Nothing here is a mock-up, which is the only reason the page is this short.
   -------------------------------------------------------------------------- */
const ROUND = {
  pano: '/skye.jpg',
  yaw: -2.86, /* facing down the road; the sign is 141° behind your right shoulder */
  pitch: -0.19,
  meta: 'United Kingdom: Scottish passing place signs',
  note: 'These ‘Passing Place’ signs are unique to Scotland.',
  where: 'Portree, Skye',
  guess: 'Wales',
  km: 484,
  score: 3595,
}

const KEYS = ['Again', 'Hard', 'Good', 'Easy'] as const

/** coach/geocoach.user.js showCard(), redrawn in markup at its real 380px. */
function Card() {
  return (
    <div className="panel gcCard" role="img" aria-label={`The GeoCoach clue card for ${ROUND.meta}`}>
      <div className="gcHead" aria-hidden>
        <div className="gcTop">
          <b>{ROUND.meta}</b>
          <div className="rt">
            <span className="pill slip">✗ Missed clue</span>
            <span className="gcX">✕</span>
          </div>
        </div>
        <p className="gcNote">{ROUND.note}</p>
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
  )
}

/* What became of that one round, carrying its own numbers. */
const BEATS = [
  {
    t: '+0s',
    h: 'The round ends',
    p: (
      <>
        GeoGuessr scores it {ROUND.score.toLocaleString()}. GeoCoach reads the rest: {ROUND.where}, my pin in{' '}
        {ROUND.guess}, {ROUND.km} km out, and the clue the location was chosen for.
      </>
    ),
  },
  {
    t: '+0.4s',
    h: 'The card lands',
    p: (
      <>
        Passing place signs. I did not know it, so it grades itself <b>Again</b> unless I say otherwise.
      </>
    ),
  },
  {
    t: 'next game',
    h: 'The map is rebuilt',
    p: <>That clue goes to the front of my trainer map. Everything else is re-dated behind it.</>,
  },
]

/* 605 rounds of my own log; the README carries the same table. */
const RECALL = [
  { k: 'First time ever', pct: 16, n: '35 / 216', c: 'var(--o2)' },
  { k: 'Second time', pct: 37, n: '46 / 126', c: 'var(--o3)' },
  { k: 'Third time or later', pct: 60, n: '127 / 212', c: 'var(--o4)' },
]

export default function Landing() {
  const [stats, setStats] = useState<PublicStats | null>(null)
  const [hasAccount] = useState(() => !!getToken())
  const [dragged, setDragged] = useState(false)
  const onFirstDrag = useCallback(() => setDragged(true), [])

  /* The masthead is a floating overlay while the photograph is behind it, and
     a solid bar the moment anything scrolls under it. */
  useEffect(() => {
    const sync = () => document.body.classList.toggle('atTop', scrollY < 40)
    sync()
    addEventListener('scroll', sync, { passive: true })
    return () => {
      removeEventListener('scroll', sync)
      document.body.classList.remove('atTop')
    }
  }, [])

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

      <section className="stage">
        <Pano src={ROUND.pano} yaw={ROUND.yaw} pitch={ROUND.pitch} onFirstDrag={onFirstDrag} />
        <div className="stageVeil" aria-hidden />

        <div className="shell stageIn">
          <div className="stageCopy">
            <p className="slug">
              <span className="dot" aria-hidden /> Round 1 · {ROUND.where} · guessed {ROUND.guess}, {ROUND.km} km off
            </p>
            <h1>This is a flashcard.</h1>
            <p className="lede">
              <span>Every round you play is one.</span>
              <span>Where your pin lands is the grade.</span>
            </p>
            <div className="heroCta">
              <Link to="/start" className="btn big">
                Get started <span className="arr">→</span>
              </Link>
              <span className="hint">Free. Two minutes.</span>
            </div>
          </div>
          <div className="stageCard">
            <Card />
          </div>
        </div>

        <div className="stageFoot">
          <span className={'grab' + (dragged ? ' off' : '')}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M7 9 4 12l3 3M17 9l3 3-3 3M4.6 12h14.8" />
            </svg>
            Drag — the sign is behind you
          </span>
          <span className="tally mono">
            {stats ? `${stats.rounds.toLocaleString()} rounds graded · ${stats.metasTracked} clues tracked` : ''}
          </span>
        </div>
      </section>

      <div className="shell">
        <section className="sec">
          <h2 className="secTitle">What happened to that round</h2>
          <ol className="beats">
            {BEATS.map((b) => (
              <li key={b.h}>
                <span className="mono when">{b.t}</span>
                <h3>{b.h}</h3>
                <p>{b.p}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="sec">
          <h2 className="secTitle">Does it work</h2>
          <div className="recall">
            {RECALL.map((r) => (
              <div className="rr" key={r.k}>
                <span className="rk">{r.k}</span>
                <span className="rbar">
                  <i style={{ width: `${r.pct}%`, background: r.c }} />
                </span>
                <b className="rp mono">{r.pct}%</b>
                <span className="rn mono">{r.n}</span>
              </div>
            ))}
          </div>
          <p className="fine">
            605 rounds, one player — me. Some of that climb is first exposures being unfamiliar by definition, so read
            it as a hint rather than evidence.
          </p>
        </section>

        <section className="sec last">
          <h2 className="secTitle">Getting set up</h2>
          <p className="fine wide">
            Install{' '}
            <a className="inl" href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">
              Tampermonkey
            </a>
            , pick a name, click your link once. GeoCoach mints a trainer map in your GeoGuessr library and republishes
            that same map from then on. No email, no password, no charge.
          </p>
          <Link to="/start" className="btn big">
            Get started <span className="arr">→</span>
          </Link>
        </section>
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
