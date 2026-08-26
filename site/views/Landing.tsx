import { useEffect, useState } from 'react'
import { Foot, Link, Mast } from '../router'
import { fetchStats, getToken, type PublicStats } from '../api'

/* --------------------------------------------------------------------------
   One claim, stated once: a tutor decides what you work on next and explains
   what you got wrong. The page is the problem, then those two things, then the
   only real evidence there is — 605 rounds of my own log — and the setup steps.

   The second half is honest about not shipping yet. That is deliberate: the
   coached explanation runs on one laptop through a CLI, and saying otherwise
   on a public page would be a lie.
   -------------------------------------------------------------------------- */

const ROUND = {
  meta: 'United Kingdom: Scottish passing place signs',
  note: 'These ‘Passing Place’ signs are unique to Scotland.',
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

/* 605 rounds of my own log; the README carries the same table. One quantity —
   how often the country was called right — across three ordered classes, so
   the fills are three steps of theme.css's validated single-hue lime ramp,
   darkest at the low end. The number is printed beside every bar, so the
   colour is a second reading of the value and never the only one. */
const RECALL = [
  { k: 'First time ever', pct: 16, n: '35 / 216', c: 'var(--o2)' },
  { k: 'Second time', pct: 37, n: '46 / 126', c: 'var(--o3)' },
  { k: 'Third time or later', pct: 60, n: '127 / 212', c: 'var(--o4)' },
]

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
        <section className="top">
          <p className="kicker">Spaced repetition for GeoGuessr</p>
          <h1>A tutor decides what you work on next, and explains what you got wrong.</h1>
          <p className="lede">
            Most GeoGuessr tools do neither. GeoCoach is a spaced-repetition trainer that plugs into the game you
            already play.
          </p>
          <div className="topCta">
            <Link to="/start" className="btn big">
              Get started <span className="arr">→</span>
            </Link>
            <span className="hint">Free. Two minutes. No email.</span>
          </div>

          {/* The hero is one column, and this rail is what gives it a bottom
              edge across the full width of the page — without it the right
              half reads as a hole where a photograph used to be. Both figures
              are live from /api/stats; nothing here is illustrative. */}
          <dl className="rail">
            <div className="lead">
              <dt>GeoCoach so far</dt>
              <dd className="said">Counted off the rounds the trainer has actually graded.</dd>
            </div>
            <div>
              <dt>Rounds graded</dt>
              <dd className={stats ? undefined : 'wait'}>{stats ? stats.rounds.toLocaleString() : ' '}</dd>
            </div>
            <div>
              <dt>Clues tracked</dt>
              <dd className={stats ? undefined : 'wait'}>{stats ? stats.metasTracked.toLocaleString() : ' '}</dd>
            </div>
          </dl>
        </section>

        <section className="sec">
          <h2 className="secTitle">The problem</h2>
          <p className="fine">
            A meta map is a fixed list. It shows you the same clues in the same order however well you already know
            them, so most of your practice goes on things you have. And when you do miss, the game tells you how many
            kilometres out you were and nothing else.
          </p>
        </section>

        <section className="sec">
          <h2 className="secTitle">One — it decides what you practise</h2>
          <div className="two">
            <div>
              <p className="fine">
                Every round you play is a flashcard. Where your pin lands is the grade. After each game the trainer map
                is rebuilt so the clues you are weakest at come round soonest, and the ones you have proved you know are
                pushed months out.
              </p>
              <p className="fine">
                You keep playing normal GeoGuessr. The deck is the map you play on, so nothing extra has to be revised.
              </p>
            </div>
            <div className="twoFig">
              <Card />
              <p className="hint">The card the userscript shows when a round ends.</p>
            </div>
          </div>
        </section>

        <section className="sec">
          <h2 className="secTitle">Two — it explains what you missed</h2>
          <p className="fine">
            The round&rsquo;s own imagery is pulled back up and read to you: what was actually in the picture, and which
            clues separate the country it was from the country you said.
          </p>
          <p className="notYet">
            Not available yet. This part runs on my own laptop through a command line — there is nothing for you to
            install.
          </p>
        </section>

        <section className="sec">
          <h2 className="secTitle">Does it work</h2>
          <div className="recall">
            {RECALL.map((r) => (
              <div className="rr" key={r.k}>
                <span className="rk">{r.k}</span>
                <span className="rbar" aria-hidden>
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
          <p className="fine">
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
