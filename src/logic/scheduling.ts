import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import type { StoredCard } from '../types'

const scheduler = fsrs()

/** Correct answers under this many ms are graded Easy. */
export const FAST_ANSWER_MS = 5000

export function gradeFor(correct: boolean, responseMs: number): Grade {
  if (!correct) return Rating.Again
  return responseMs < FAST_ANSWER_MS ? Rating.Easy : Rating.Good
}

export function toStored(card: Card): StoredCard {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : undefined,
  }
}

export function fromStored(stored: StoredCard): Card {
  return {
    due: new Date(stored.due),
    stability: stored.stability,
    difficulty: stored.difficulty,
    elapsed_days: stored.elapsed_days,
    scheduled_days: stored.scheduled_days,
    learning_steps: stored.learning_steps,
    reps: stored.reps,
    lapses: stored.lapses,
    state: stored.state as State,
    last_review: stored.last_review ? new Date(stored.last_review) : undefined,
  }
}

export function newCard(now: Date): StoredCard {
  return toStored(createEmptyCard(now))
}

/** Grades an answer into FSRS and returns the rescheduled card. */
export function reviewCard(
  existing: StoredCard | undefined,
  correct: boolean,
  responseMs: number,
  now: Date,
): StoredCard {
  const card = existing ? fromStored(existing) : createEmptyCard(now)
  const { card: next } = scheduler.next(card, now, gradeFor(correct, responseMs))
  return toStored(next)
}
