import { useEffect, useMemo, useRef, useState } from 'react'
import { countryName } from '../data/countries'
import { applyAnswer, blitzOptions, nextBatch, type BlitzCard } from '../logic/blitz'
import type { Clue } from '../types'
import Flag from './Flag'

interface Props {
  batch: Clue[]
  onAnswer: (clue: Clue, chosen: string, responseMs: number) => void
  onFinish: () => void
  onQuit: () => void
}

type Phase = 'study' | 'drill' | 'done'

/**
 * The acquisition loop: flash through the batch once, then a forced-choice
 * drill where a correct answer barely pauses and a miss comes straight back.
 * The debrief lives in the miss: that is the only moment worth stopping for.
 */
export function Blitz({ batch, onAnswer, onFinish, onQuit }: Props) {
  const [phase, setPhase] = useState<Phase>('study')
  const [studyAt, setStudyAt] = useState(0)
  const [queue, setQueue] = useState<BlitzCard[]>(() =>
    batch.map((clue) => ({ clue, streak: 0, firstChosen: null, firstMs: 0 })),
  )
  const [askedAt, setAskedAt] = useState(() => Date.now())
  const [attempt, setAttempt] = useState(0)
  const [flash, setFlash] = useState<'right' | null>(null)
  const [missed, setMissed] = useState<string | null>(null)
  const retiredCount = batch.length - queue.length
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const head = queue[0]
  const options = useMemo(
    () => (head ? blitzOptions(head.clue, batch) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [head?.clue.id, attempt],
  )

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const advance = (chosen: string) => {
    const step = applyAnswer(queue, chosen, Date.now() - askedAt)
    if (step.retired) {
      onAnswer(step.retired.clue, step.retired.firstChosen!, step.retired.firstMs)
    }
    setQueue(step.queue)
    setAttempt((a) => a + 1)
    setAskedAt(Date.now())
    setFlash(null)
    setMissed(null)
    if (step.queue.length === 0) setPhase('done')
  }

  const pick = (chosen: string) => {
    if (!head || flash || missed) return
    if (chosen === head.clue.country) {
      setFlash('right')
      timer.current = setTimeout(() => advance(chosen), 620)
    } else {
      setMissed(chosen)
    }
  }

  // Keyboard: 1–4 answers, Enter/Space advances study cards and miss reveals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (phase === 'study') {
          if (studyAt + 1 >= batch.length) setPhase('drill')
          else setStudyAt(studyAt + 1)
          setAskedAt(Date.now())
        } else if (phase === 'drill' && missed) {
          advance(missed)
        } else if (phase === 'done') {
          onFinish()
        }
        return
      }
      if (phase === 'drill' && !flash && !missed) {
        const n = Number(e.key)
        if (n >= 1 && n <= options.length) pick(options[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (batch.length === 0) {
    return (
      <div className="hollow">
        <p>Nothing left to learn — everything is scheduled.</p>
        <button className="primary" onClick={onQuit}>
          Back
        </button>
      </div>
    )
  }

  if (phase === 'study') {
    const clue = batch[studyAt]
    return (
      <div className="blitz">
        <header className="bhead">
          <span className="bphase">Study</span>
          <span className="bcount">
            {studyAt + 1}/{batch.length} new tells
          </span>
        </header>
        <figure className="bshot">
          {clue.imageUrl && <img src={clue.imageUrl} alt="Tell to memorise" />}
        </figure>
        <div className="bpanel">
          <p className="banswer">
            <Flag code={clue.country} /> {countryName(clue.country)}
            {clue.tell && <span className="tellname">{clue.tell}</span>}
            {clue.region && <span className="regionchip">{clue.region}</span>}
          </p>
          <p className="bnote">{clue.description}</p>
          <div className="advance">
            <button
              className="primary"
              onClick={() => {
                if (studyAt + 1 >= batch.length) setPhase('drill')
                else setStudyAt(studyAt + 1)
              }}
            >
              {studyAt + 1 >= batch.length ? 'Start the drill' : 'Next'}
            </button>
            <span className="kbd">Enter</span>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="blitz">
        <div className="bdone">
          <h2>Batch cleared.</h2>
          <ul className="brecap">
            {batch.map((clue) => (
              <li key={clue.id}>
                <Flag code={clue.country} /> {countryName(clue.country)}
                <span className="tellname">{clue.tell ?? clue.category}</span>
              </li>
            ))}
          </ul>
          <div className="advance">
            <button className="primary" onClick={onFinish}>
              Keep going
            </button>
            <span className="kbd">Enter</span>
          </div>
        </div>
      </div>
    )
  }

  const clue = head!.clue
  return (
    <div className="blitz">
      <header className="bhead">
        <span className="bphase">Drill</span>
        <span className="bdots" aria-label={`${retiredCount} of ${batch.length} cleared`}>
          {batch.map((_, i) => (
            <i key={i} className={i < retiredCount ? 'on' : ''} />
          ))}
        </span>
      </header>
      <figure className={`bshot ${flash ? 'right' : ''} ${missed ? 'wrong' : ''}`}>
        {clue.imageUrl && <img src={clue.imageUrl} alt="Which country?" />}
      </figure>

      {!missed ? (
        <div className="bopts">
          {options.map((code, i) => (
            <button
              key={code}
              className={`bopt ${flash && code === clue.country ? 'right' : ''}`}
              onClick={() => pick(code)}
            >
              <span className="key">{i + 1}</span>
              <Flag code={code} />
              {countryName(code)}
            </button>
          ))}
        </div>
      ) : (
        <div className="bpanel miss">
          <p className="banswer">
            <span className="mark">Missed</span>
            <Flag code={clue.country} /> {countryName(clue.country)}
            {clue.tell && <span className="tellname">{clue.tell}</span>}
            {clue.region && <span className="regionchip">{clue.region}</span>}
          </p>
          <p className="bnote">{clue.description}</p>
          <div className="advance">
            <button className="primary" onClick={() => advance(missed)}>
              Got it — it comes back
            </button>
            <span className="kbd">Enter</span>
          </div>
        </div>
      )}
    </div>
  )
}

export { nextBatch }
