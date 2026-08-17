import { useEffect, useState } from 'react'
import Globe from '../GlobeLazy'
import { Foot, Link, Mast } from '../router'
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
    n: '01',
    h: 'Runs in your browser',
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
  { n: '02', h: 'Free', p: <>No charge, no email, no password.</> },
  {
    n: '03',
    h: 'Your account is a link',
    p: <>Signing up hands you a private link. Anyone holding it can read your account, so keep it to yourself.</>,
  },
  {
    n: '04',
    h: 'Scheduled by FSRS',
    p: <>Reviews are timed by the same memory model Anki uses, fed by how you rate each round.</>,
  },
  {
    n: '05',
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
          <span>Free, no account details</span>
        </div>

        <header className="hero">
          <div className="heroCopy">
            <span className="tag b">Sheet 01 — What this is</span>
            <h1>
              Practice the clues you <em>keep getting wrong.</em>
            </h1>
            <p className="lede">
              You play GeoGuessr the way you already do. Every round is captured and graded against the clue it was
              testing, so GeoCoach learns which tells you actually hold. The next game is dealt from your own weak
              spots.
            </p>
            <div className="heroCta">
              <Link to="/start" className="btn">
                Get started <span className="arr">→</span>
              </Link>
              {hasAccount && (
                <Link to="/app" className="quiet">
                  Dashboard →
                </Link>
              )}
            </div>
          </div>

          <figure className="plate">
            <Globe />
            <figcaption className="plateCap">
              <span className="tag">Fig. 1 — Dotted earth</span>
              <span className="tag">Drag to spin</span>
            </figcaption>
          </figure>
        </header>

        {stats && (
          <dl className="readout">
            <div>
              <dt>Players</dt>
              <dd>{stats.users.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Rounds captured</dt>
              <dd>{stats.rounds.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Clues tracked</dt>
              <dd>{stats.metasTracked.toLocaleString()}</dd>
            </div>
          </dl>
        )}

        <section>
          <div className="sheetHead">
            <span className="no">02</span>
            <h2>How it works</h2>
            <span className="lead" />
            <span className="meta">3 steps</span>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="step" key={s.n}>
                <span className="no">{s.n}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="sheetHead">
            <span className="no">03</span>
            <h2>Before you start</h2>
            <span className="lead" />
            <span className="meta">{NOTES.length} notes</span>
          </div>
          <div className="notes">
            {NOTES.map((note) => (
              <div className="note" key={note.h}>
                <span className="no">{note.n}</span>
                <h3>{note.h}</h3>
                <p>{note.p}</p>
              </div>
            ))}
          </div>
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
