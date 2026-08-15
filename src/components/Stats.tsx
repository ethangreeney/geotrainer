import { CLUES } from '../data/clues'
import { countryName } from '../data/countries'
import Flag from './Flag'
import { categoryAccuracy, confusionPairs } from '../logic/store'
import { isDue } from '../logic/queue'
import type { AppState } from '../types'
import { CATEGORIES, categoryName } from '../data/categories'

interface Props {
  state: AppState
  onDrillPair: (a: string, b: string) => void
  onDrillCategory: (category: string) => void
  onHome: () => void
}

export function Stats({ state, onDrillPair, onDrillCategory }: Props) {
  const pairs = confusionPairs(state)
  const categories = categoryAccuracy(state, CLUES)

  const now = new Date()
  const perCategory = new Map<string, { total: number; due: number }>()
  for (const clue of CLUES) {
    const row = perCategory.get(clue.category) ?? { total: 0, due: 0 }
    row.total += 1
    const card = state.cards[clue.id]
    if (card && isDue(card, now)) row.due += 1
    perCategory.set(clue.category, row)
  }

  return (
    <div className="analysis scrollport">
      <div className="col">
        <h3>What you confuse</h3>
        {pairs.length === 0 ? (
          <p className="empty">No mistakes logged yet — run a session first.</p>
        ) : (
          <ul className="confusion">
            {pairs.map((p) => (
              <li key={`${p.correct}>${p.chosen}`}>
                <span className="pairline">
                  <Flag code={p.correct} />
                  <span className="name">{countryName(p.correct)}</span>
                  <span className="ar">&#8594;</span>
                  <Flag code={p.chosen} />
                  <span className="name dimname">{countryName(p.chosen)}</span>
                </span>
                <span className="count">&times;{p.count}</span>
                <button className="small" onClick={() => onDrillPair(p.correct, p.chosen)}>
                  Drill this pair
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="col">
        <h3>Accuracy by category</h3>
        {categories.length === 0 ? (
          <p className="empty">Nothing to show yet.</p>
        ) : (
          <ul className="bars">
            {categories.map((c) => (
              <li key={c.category}>
                <span className="cat">{categoryName(c.category)}</span>
                <span className="track">
                  <span
                    className="fill"
                    style={{
                      width: `${Math.round(c.accuracy * 100)}%`,
                      background:
                        c.accuracy < 0.5
                          ? 'var(--red)'
                          : c.accuracy < 0.8
                            ? 'var(--amber)'
                            : 'var(--green)',
                    }}
                  />
                </span>
                <span className="pct">{Math.round(c.accuracy * 100)}%</span>
                <span className="seen">
                  {c.right}/{c.seen}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="latergroup">Drill one skill</h3>
        <p className="empty">
          Focused practice for a tell you have never learnt — then bring it back to the mixed
          reviews.
        </p>
        <div className="modegrid">
          {CATEGORIES.map((c) => {
            const row = perCategory.get(c.id)
            return (
              <button
                key={c.id}
                className={`mode ${row?.due ? 'has-due' : ''}`}
                title={c.blurb}
                onClick={() => onDrillCategory(c.id)}
              >
                <span className="mname">{c.name}</span>
                <span className="mcount">{row?.due ? `${row.due} due` : `${row?.total ?? 0}`}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
