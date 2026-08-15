import { countryName } from '../data/countries'
import Flag from './Flag'
import { dueTomorrow } from '../logic/queue'
import { CLUES } from '../data/clues'
import { TRACKS } from '../data/tracks'
import { trackProgress } from '../logic/progress'
import type { AppState } from '../types'
import type { Result } from './Drill'
import { categoryName } from '../data/categories'

interface Props {
  results: Result[]
  state: AppState
  onHome: () => void
  onStats: () => void
}

export function Summary({ results, state, onHome, onStats }: Props) {
  const right = results.filter((r) => r.correct).length
  const wrong = results.filter((r) => !r.correct)
  const slowest = [...results].sort((a, b) => b.responseMs - a.responseMs).slice(0, 3)
  const pct = results.length ? Math.round((right / results.length) * 100) : 0

  return (
    <div className="summary">
      <div className="score">
        <p className="eyebrow">Session complete</p>
        <p className="tally">
          <em>{right}</em>
          <span>/{results.length}</span>
        </p>
        <p className="pct">{pct}% correct</p>
        <p className="sub">
          {(() => {
            const n = dueTomorrow(state.cards)
            return n === 1
              ? '1 clue comes back for review in the next 24 hours.'
              : `${n} clues come back for review in the next 24 hours.`
          })()}
        </p>
        <div className="actions">
          <button className="primary big" onClick={onHome}>
            Done
          </button>
          <button onClick={onStats}>Analysis</button>
        </div>

        {/* Where the session moved you along the path. */}
        <div className="pathway">
          {(() => {
            const path = trackProgress(CLUES, state.cards)
            const activeIndex = Math.max(0, path.findIndex((t) => !t.mastered))
            return TRACKS.map((t, i) => {
              const row = path[i]
              const pct = row.total ? (row.learned / row.total) * 100 : 0
              const phase = row.mastered ? 'done' : i === activeIndex ? 'now' : 'later'
              return (
                <div key={t.id} className={`leg ${phase}`} title={t.blurb}>
                  <span className="lname">{t.name}</span>
                  <span className="lbar">
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <span className="lnum">
                    {row.learned}
                    <i>/{row.total} learned</i>
                  </span>
                </div>
              )
            })
          })()}
        </div>
      </div>

      <div className="panel scrollport">
        <h3>Missed</h3>
        {wrong.length === 0 ? (
          <p className="empty">Clean sheet — nothing missed.</p>
        ) : (
          <ul className="list">
            {wrong.map((r, i) => (
              <li key={i}>
                <Flag code={r.clue.country} />
                <span className="name">{countryName(r.clue.country)}</span>
                <span className="meta">{categoryName(r.clue.category)}</span>
                <span className="trail">
                  <span className="arrow">said</span> <Flag code={r.chosen} />{' '}
                  {countryName(r.chosen)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3>Slowest</h3>
        <ul className="list">
          {slowest.map((r, i) => (
            <li key={i}>
              <Flag code={r.clue.country} />
              <span className="name">{countryName(r.clue.country)}</span>
              <span className="meta">{categoryName(r.clue.category)}</span>
              <span className="trail num">{(r.responseMs / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
