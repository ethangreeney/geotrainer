import { useRef, useState } from 'react'
import { Blitz } from './components/Blitz'
import { Drill, type DrillConfig, type Result } from './components/Drill'
import { WorldMap } from './components/WorldMap'
import { Stats } from './components/Stats'
import { Summary } from './components/Summary'
import { ALL_CLUES, CURRICULUM } from './data/curriculum'
import { LM_CLUES } from './data/lm'
import { nextBatch } from './logic/blitz'
import { isDue } from './logic/queue'
import { loadState, recordAnswer, saveState } from './logic/store'
import type { Clue } from './types'

type View =
  | { kind: 'home' }
  | { kind: 'drill'; config: DrillConfig }
  | { kind: 'blitz'; batch: Clue[] }
  | { kind: 'summary'; results: Result[] }
  | { kind: 'stats' }

export default function App() {
  const [state, setState] = useState(() => loadState())
  const [view, setView] = useState<View>({ kind: 'home' })
  // Handlers that fire after a burst of answers need the freshest state, not
  // the render they closed over.
  const stateRef = useRef(state)
  stateRef.current = state

  const handleAnswer = (clue: Clue, chosen: string, responseMs: number) => {
    setState((prev) => {
      const next = recordAnswer(prev, { clue, chosen, responseMs })
      saveState(next)
      return next
    })
  }

  const go = (v: View) => setView(v)

  /** The single decision the app makes for you: review what is due, else learn. */
  const continueNext = () => {
    const cards = stateRef.current.cards
    const now = new Date()
    const due = ALL_CLUES.some((c) => cards[c.id] && isDue(cards[c.id], now))
    if (due) {
      go({ kind: 'drill', config: { mode: 'review' } })
      return
    }
    const batch = nextBatch(CURRICULUM, cards, now)
    if (batch.length > 0) go({ kind: 'blitz', batch })
    else go({ kind: 'home' })
  }

  const now = new Date()
  const due = ALL_CLUES.filter((c) => state.cards[c.id] && isDue(state.cards[c.id], now)).length
  const learned = ALL_CLUES.filter((c) => state.cards[c.id]).length
  const lmUnseen = LM_CLUES.filter((c) => !state.cards[c.id]).length
  const allDone = learned === ALL_CLUES.length && due === 0

  const stage =
    lmUnseen > 0
      ? `beginner set · ${LM_CLUES.length - lmUnseen}/${LM_CLUES.length}`
      : 'plonk it library'

  return (
    <div className="shell">
      <header className="rail">
        <button className="brand" onClick={() => go({ kind: 'home' })}>
          {/* The mark is a plonked pin, not a globe: the game is about the drop. */}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1.9c-3.2 0-5.7 2.5-5.7 5.6 0 3.9 4.1 6.5 5.7 9.9 1.6-3.4 5.7-6 5.7-9.9 0-3.1-2.5-5.6-5.7-5.6Z" />
            <circle className="dot" cx="10" cy="7.3" r="2" />
            <path d="M5.6 18.1h8.8" opacity="0.45" />
          </svg>
          GeoTrainer
        </button>

        <nav>
          <button className={view.kind === 'home' ? 'on' : ''} onClick={() => go({ kind: 'home' })}>
            Today
          </button>
          <button
            className={view.kind === 'stats' ? 'on' : ''}
            onClick={() => go({ kind: 'stats' })}
          >
            Analysis
          </button>
        </nav>

        <div className="railmeta">
          {view.kind === 'drill' || view.kind === 'blitz' ? (
            <button className="quit" onClick={() => go({ kind: 'home' })}>
              End session
            </button>
          ) : (
            <>
              <span>
                <i>{due}</i> due
              </span>
              <span>
                <i>{learned}</i>/{ALL_CLUES.length} learned
              </span>
            </>
          )}
        </div>
      </header>

      <main className="stage">
        {view.kind === 'home' && (
          <div className="home">
            <div className="pitch">
              <p className="eyebrow">GeoGuessr world meta &middot; spaced repetition</p>
              <h1>
                {due > 0 ? (
                  <>
                    <em>{due}</em> {due === 1 ? 'tell is' : 'tells are'} due for recall.
                  </>
                ) : allDone ? (
                  <>All caught up. Come back tomorrow.</>
                ) : (
                  <>
                    <em>{Math.min(6, CURRICULUM.length - learned)}</em> new tells, two minutes.
                  </>
                )}
              </h1>
              <p className="sub">
                {due > 0
                  ? 'A quick map session. Recall on the map is the graduation test — misses come back sooner.'
                  : 'Study a small batch, then a rapid drill until every tell is beaten twice in a row. Misses return within seconds, not days.'}
              </p>

              <div className="actions">
                <button className="primary big" onClick={continueNext} disabled={allDone}>
                  Continue
                </button>
                <button onClick={() => go({ kind: 'stats' })}>Analysis &amp; focus drills</button>
              </div>

              <div className="progressline">
                <span className="pbar">
                  <i style={{ width: `${(learned / ALL_CLUES.length) * 100}%` }} />
                </span>
                <span className="pnums">
                  {learned}/{ALL_CLUES.length} tells &middot; {stage}
                </span>
              </div>
            </div>

            <div className="hero">
              <WorldMap ambient />
            </div>
          </div>
        )}

        {view.kind === 'drill' && (
          <Drill
            key={JSON.stringify(view.config)}
            config={view.config}
            state={state}
            onAnswer={handleAnswer}
            onFinish={(results) => go({ kind: 'summary', results })}
            onQuit={() => go({ kind: 'home' })}
          />
        )}

        {view.kind === 'blitz' && (
          <Blitz
            key={view.batch.map((c) => c.id).join()}
            batch={view.batch}
            onAnswer={handleAnswer}
            onFinish={continueNext}
            onQuit={() => go({ kind: 'home' })}
          />
        )}

        {view.kind === 'summary' && (
          <Summary
            results={view.results}
            state={state}
            onHome={() => go({ kind: 'home' })}
            onStats={() => go({ kind: 'stats' })}
          />
        )}

        {view.kind === 'stats' && (
          <Stats
            state={state}
            onDrillPair={(a, b) => go({ kind: 'drill', config: { mode: 'pair', a, b } })}
            onDrillCategory={(category) =>
              go({ kind: 'drill', config: { mode: 'category', category } })
            }
            onHome={() => go({ kind: 'home' })}
          />
        )}
      </main>
    </div>
  )
}
