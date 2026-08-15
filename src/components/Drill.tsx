import { useEffect, useMemo, useState } from 'react'
import { CLUES } from '../data/clues'
import { ALL_CLUES } from '../data/curriculum'
import { LM_CLUES } from '../data/lm'
import { countryName } from '../data/countries'
import { buildPairOptions } from '../logic/distractors'
import { comparableClue, lookalikes } from '../logic/compare'
import { categoryName } from '../data/categories'
import { buildCategoryQueue, buildPairQueue, buildQueue, buildSessionQueue, isDue, SESSION_LENGTH } from '../logic/queue'
import type { AppState, Clue } from '../types'
import { WorldMap } from './WorldMap'
import Flag from './Flag'

export type DrillConfig =
  | { mode: 'mixed' }
  | { mode: 'category'; category: string }
  | { mode: 'pair'; a: string; b: string }
  | { mode: 'lm' }
  | { mode: 'review' }

export interface Result {
  clue: Clue
  chosen: string
  correct: boolean
  responseMs: number
}

interface Props {
  config: DrillConfig
  state: AppState
  onAnswer: (clue: Clue, chosen: string, responseMs: number) => void
  onFinish: (results: Result[]) => void
  onQuit: () => void
}

export function Drill({ config, state, onAnswer, onFinish, onQuit }: Props) {
  const [queue] = useState<Clue[]>(() => {
    if (config.mode === 'pair') return buildPairQueue(CLUES, config.a, config.b)
    if (config.mode === 'category')
      return buildCategoryQueue(CLUES, config.category, state.cards, new Date(), SESSION_LENGTH)
    // The Learnable Meta list is one flat curated set — no tracks inside it.
    if (config.mode === 'lm') return buildQueue(LM_CLUES, state.cards, new Date(), SESSION_LENGTH)
    // Review: everything due across both sources, recalled on the map.
    if (config.mode === 'review') {
      const now = new Date()
      const pool = ALL_CLUES.filter((c) => state.cards[c.id] && isDue(state.cards[c.id], now))
      return buildQueue(pool, state.cards, now, SESSION_LENGTH)
    }
    return buildSessionQueue(CLUES, state.cards, new Date(), SESSION_LENGTH)
  })
  const [index, setIndex] = useState(0)
  const [results, setResults] = useState<Result[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [askedAt, setAskedAt] = useState(() => Date.now())

  const clue = queue[index]
  const last = index + 1 >= queue.length

  // Forced-choice options exist only in pair mode; mixed mode answers on the map.
  const options = useMemo(() => {
    if (!clue || config.mode !== 'pair') return []
    return buildPairOptions(config.a, config.b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clue?.id])

  const pick = (code: string) => {
    if (chosen || !clue) return
    const responseMs = Date.now() - askedAt
    setChosen(code)
    onAnswer(clue, code, responseMs)
    setResults((r) => [...r, { clue, chosen: code, correct: code === clue.country, responseMs }])
  }

  const next = () => {
    if (last) {
      onFinish(results)
      return
    }
    setIndex(index + 1)
    setChosen(null)
    setAskedAt(Date.now())
  }

  // 1–2 to answer in pair mode, Enter/space to advance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!chosen) {
        const n = Number(e.key)
        if (n >= 1 && n <= options.length) pick(options[n - 1])
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!clue) {
    return (
      <div className="hollow">
        <p>No clues available for this drill.</p>
        <button className="primary" onClick={onQuit}>
          Back
        </button>
      </div>
    )
  }

  const isCorrect = chosen === clue.country
  const comparable = chosen && !isCorrect ? comparableClue(chosen, clue) : undefined
  const twins = chosen ? lookalikes(clue) : []
  const blurred = clue.category === 'licence-plate' && !chosen

  return (
    <div className={`drill ${chosen ? 'is-answered' : ''}`}>
      <div className="progress" style={{ ['--p' as string]: `${(index / queue.length) * 100}%` }} />

      <section className="plate">
        <figure className={`shot ${blurred ? 'blurred' : ''}`}>
          {clue.imageUrl && (
            <>
              {/* Plonk It crops are often tall and narrow; the clue must never be
                  cropped away, so the sharp copy is contained and a blurred copy
                  fills the letterbox behind it. */}
              <img className="bg" src={clue.imageUrl} alt="" aria-hidden="true" />
              <img className="fg" src={clue.imageUrl} alt="Street-level clue" />
            </>
          )}
          <figcaption>
            <span className="ord">
              {String(index + 1).padStart(2, '0')}
              <i>/{String(queue.length).padStart(2, '0')}</i>
            </span>
            <span className="cat">{categoryName(clue.category)}</span>
            {config.mode === 'pair' && (
              <span className="cat alt">
                {config.a} vs {config.b}
              </span>
            )}
          </figcaption>
          {blurred && <span className="blurnote">blurred as in-game &mdash; read the colours</span>}
        </figure>

        {chosen && (
          <div className={`debrief ${isCorrect ? 'ok' : 'no'}`}>
            <div className="scrollport">
              <p className="verdict">
                <span className="mark">{isCorrect ? 'Correct' : 'Missed'}</span>
                <Flag code={clue.country} />
                {countryName(clue.country)}
                {/* The tell's name is the retrieval hook — but only after answering. */}
                {clue.tell && <span className="tellname">{clue.tell}</span>}
                {clue.region && <span className="regionchip">{clue.region}</span>}
              </p>
              {!isCorrect && (
                <p className="youpicked">
                  you picked <Flag code={chosen} /> {countryName(chosen)}
                </p>
              )}

              {!comparable && <p className="describe">{clue.description}</p>}

              {!isCorrect && !comparable && (
                <p className="nomatch">
                  The {countryName(chosen)} guide has no tell about this feature, so there is no
                  comparison to show.
                </p>
              )}

              {/* The discrimination set: other countries whose guides describe
                  the same feature in the same colours. Pretending a shared
                  tell is unique would teach a false rule. */}
              {twins.length > 0 && (
                <p className="twins">
                  <span className="twinlabel">Easily confused with</span>
                  {twins.map((t) => (
                    <span key={t.country} className="twin">
                      <Flag code={t.country} /> {countryName(t.country)}
                    </span>
                  ))}
                </p>
              )}

              {!isCorrect && comparable && (
                <div className="compare">
                  <div>
                    <p className="who">
                      <Flag code={clue.country} /> {countryName(clue.country)}
                      <span className="role">answer</span>
                    </p>
                    {clue.imageUrl && <img className="ref" src={clue.imageUrl} alt="" />}
                    <p>{clue.description}</p>
                  </div>
                  <div>
                    <p className="who">
                      <Flag code={chosen} /> {countryName(chosen)}
                      <span className="role">your pick</span>
                    </p>
                    {comparable.imageUrl && <img className="ref" src={comparable.imageUrl} alt="" />}
                    <p>{comparable.description}</p>
                  </div>
                </div>
              )}

              {clue.notes && <p className="notes">{clue.notes}</p>}

              {clue.source && (
                <a className="source" href={clue.source} target="_blank" rel="noreferrer">
                  Plonk It guide &#8599;
                </a>
              )}
            </div>

            <div className="advance">
              <button className="primary" onClick={next}>
                {last ? 'See summary' : 'Next'}
              </button>
              <span className="kbd">Enter</span>
            </div>
          </div>
        )}
      </section>

      <section className="answerpane">
        {config.mode !== 'pair' ? (
          <WorldMap
            onPick={pick}
            correct={chosen ? clue.country : null}
            chosen={chosen}
            resetKey={clue.id}
          />
        ) : (
          <div className={`pair ${chosen ? 'answered' : ''}`}>
            <p className="ask">Which one?</p>
            {options.map((code, i) => {
              const cls = !chosen
                ? ''
                : code === clue.country
                  ? 'right'
                  : code === chosen
                    ? 'wrong'
                    : 'dim'
              return (
                <button key={code} className={`option ${cls}`} onClick={() => pick(code)}>
                  <span className="key">{i + 1}</span>
                  <Flag code={code} />
                  <span>{countryName(code)}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
