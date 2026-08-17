import { useEffect, useState } from 'react'
import Globe from '../GlobeLazy'
import { Link, Wordmark } from '../router'
import { fetchStats, getToken, type PublicStats } from '../api'

const STEPS = [
  {
    n: '01',
    h: 'Play',
    p: 'Start a game like any other. A userscript reads each round the moment it ends and passes the result to GeoCoach.',
  },
  {
    n: '02',
    h: 'Rate',
    p: 'A small card shows the clue that location was built around. One click says how well you knew it.',
  },
  {
    n: '03',
    h: 'Return',
    p: 'Before your next game the practice map is rebuilt, leading with the clues closest to slipping.',
  },
]

const NOTES = [
  {
    h: 'It runs in your browser',
    p: (
      <>
        GeoCoach is a userscript. Install the{' '}
        <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">
          Tampermonkey
        </a>{' '}
        extension, click your personal link once, and updates arrive from the same place.
      </>
    ),
  },
  { h: 'It is free', p: <>No charge, no email, no password.</> },
  {
    h: 'Your account is a link',
    p: <>Signing up hands you a private link. Anyone holding it can read your account, so keep it to yourself.</>,
  },
  {
    h: 'The schedule is FSRS',
    p: <>Reviews are timed by the same memory model Anki uses, fed by how you rate each round.</>,
  },
  {
    h: 'Made by a player',
    p: <>Built for the GeoGuessr community. GeoCoach has no connection to GeoGuessr itself.</>,
  },
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
    <div className="shell">
      <div className="topline">
        <Wordmark />
        {hasAccount && (
          <Link to="/app" className="quiet">
            Your dashboard →
          </Link>
        )}
      </div>

      <header className="hero">
        <div className="heroCopy">
          <p className="kicker">Spaced repetition for GeoGuessr</p>
          <h1>
            A trainer that knows what you're <em>about to forget.</em>
          </h1>
          <p className="lede">
            You play GeoGuessr the way you already do. Every round is captured and graded against the clue it was
            testing, so GeoCoach learns which tells you actually hold. The next game is dealt from your own weak spots.
          </p>
          <div className="heroCta">
            <Link to="/start" className="btn">
              Get started <span className="arr">→</span>
            </Link>
            {hasAccount && (
              <Link to="/app" className="quiet">
                Your dashboard →
              </Link>
            )}
          </div>
          {stats && (
            <p className="heroStat">
              <b>{stats.users.toLocaleString()}</b> {stats.users === 1 ? 'player' : 'players'} ·{' '}
              <b>{stats.rounds.toLocaleString()}</b> rounds captured · <b>{stats.metasTracked.toLocaleString()}</b>{' '}
              clues tracked
            </p>
          )}
        </div>
        <Globe />
      </header>

      <section>
        <div className="secLabel">
          <span className="kicker">How it works</span>
        </div>
        <h2>
          Play, rate, <em>come back.</em>
        </h2>
        <div className="steps">
          {STEPS.map((s) => (
            <div className="step" key={s.n}>
              <span className="n">{s.n}</span>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="secLabel">
          <span className="kicker">Before you start</span>
        </div>
        <div className="notes">
          {NOTES.map((n) => (
            <div className="note" key={n.h}>
              <h3>{n.h}</h3>
              <p>{n.p}</p>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>GeoCoach</span>
        <Link to="/start" className="quiet">
          Get started →
        </Link>
      </footer>
    </div>
  )
}
