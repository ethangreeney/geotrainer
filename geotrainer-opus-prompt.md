# Build "GeoTrainer" — a GeoGuessr deliberate-practice web app

## Context
I'm a software engineer building a training tool that helps GeoGuessr players improve as fast as possible using learning science: retrieval practice, spaced repetition (FSRS), interleaving, and confusion-aware discrimination drills. This prompt is the full spec. Build the MVP exactly as scoped — nothing more.

## Workflow (follow in order)
1. **Plan first, briefly.** Before writing code, output a short plan (max ~15 lines): file structure, data flow, and how each acceptance test will be satisfied. Do not ask me questions — make sensible assumptions and note them in one line each.
2. **Build.**
3. **Run the Gauntlet** (below).
4. **Report** (format at the end).

## Tech constraints
- Vite + React + TypeScript. No backend, no auth. All state in localStorage.
- Use the `ts-fsrs` npm package for scheduling. Do not implement your own spaced-repetition algorithm.
- Vitest for automated tests.
- Keep it simple: no state management library, no CSS framework needed (plain CSS is fine, but make it clean and usable).

## Data model
A clue record: `id`, `country` (ISO code + display name), `category` (one of: bollard, licence-plate, road-line, pole, language, landscape), `imageUrl` (nullable — placeholder box if null), `description` (text description of the clue, shown as the stimulus when no image), `confusedWith` (array of country codes this clue is commonly mistaken for), `notes` (the "how to tell it apart" explanation shown in feedback).

Per-user state in localStorage: FSRS card state per clue, full answer log (clueId, chosen country, correct country, timestamp, response ms), and a derived confusion matrix (wrong-answer pairs with counts).

## Seed data
Create ~40 seed clues covering Europe across at least 3 categories. Write accurate real-world descriptions and confusion pairs from well-known GeoGuessr meta knowledge (e.g. Polish vs Czech bollards, Nordic pole differences, road line colours). Leave `imageUrl` null — I'll add screenshots later. Accuracy matters more than quantity; if unsure about a fact, pick a different clue you're sure of.

## Features (MVP — exhaustive list)
1. **Drill session.** Serves a mixed queue: FSRS-due reviews first, then new clues, interleaved across categories (never more than 2 of the same category in a row when avoidable). Session length: 10 questions, then a summary screen.
2. **Question screen.** Shows the clue (image or description). Player picks from 4 options: the correct country + 3 distractors. Distractors must be drawn from `confusedWith` first, padded with same-region countries only if needed — never random far-away countries.
3. **Feedback screen.** Instant right/wrong. On wrong: show the chosen country's comparable clue side by side (if one exists in the DB) plus the `notes` explaining the difference. On right: brief confirmation, next question.
4. **FSRS integration.** Every answer is graded into FSRS (wrong = Again, correct = Good; correct under 5s = Easy) and rescheduled.
5. **Confusion matrix + stats page.** Table of most-confused country pairs with counts, per-category accuracy, and a "weakest pairs" list. A button to launch a targeted A-vs-B drill for any confusion pair (only clues from those two countries, 2 options).
6. **Session summary.** Score, slowest/wrong items, what's due tomorrow.

Explicitly OUT of scope: AI feedback mode, accounts, backend, mobile polish, Plonkit scraping, image sourcing.

## The Gauntlet (verification loop)
Definition of done = all checks below pass. Loop: run all checks → fix all failures in one batch → re-run. **Hard cap: 3 loop iterations.** If anything still fails after 3, stop and report what fails and why — do not keep iterating and do not rewrite the app.

### Automated (Vitest — write these as real tests)
- G1: Distractor generator never returns the correct answer as a distractor, always returns 3 unique options, and prefers `confusedWith` countries when 3+ exist.
- G2: Answer logging updates the confusion matrix correctly (wrong answer increments exactly one pair; correct answers increment none).
- G3: FSRS grading maps wrong→Again, correct→Good, fast-correct→Easy, and due dates move forward after review.
- G4: Session queue interleaves categories (no 3 identical categories in a row when the pool allows) and puts due reviews before new clues.
- G5: State round-trips through localStorage (save → reload → identical).
- G6: Seed data validates: 40+ clues, every `confusedWith` country exists as a real ISO code, every clue has a non-empty description and notes.

### Manual smoke (run the dev server and verify yourself, e.g. with curl/Playwright or by reasoning over rendered output; state exactly what you checked)
- G7: `npm run dev` starts clean; `npm run build` succeeds with zero TS errors.
- G8: A full 10-question session can be completed end to end; feedback screens render for both right and wrong answers.
- G9: Stats page shows the confusion matrix after a session with deliberate wrong answers; targeted A-vs-B drill launches and only contains those two countries.

## Usage economy rules
- No exploratory rewrites or refactors after the plan is set.
- Batch all fixes per gauntlet iteration; never fix-and-rerun one test at a time.
- Don't add tests, features, or polish beyond this spec.

## Final report format
1. One-paragraph summary of what was built.
2. Gauntlet results table: G1–G9, pass/fail, iteration count used.
3. Assumptions made.
4. Anything unverified or failing, with the reason.
5. Exact commands to run the app and the tests.
