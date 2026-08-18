<h1 align="center">GeoTrainer</h1>

<p align="center">
  <b>Spaced repetition for GeoGuessr, hidden inside the games you were going to play anyway.</b><br>
  <sub>It grades every round you play against the clue it was testing, then rebuilds<br>your practice map out of the metas you're about to forget.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/scheduler-FSRS-a3e961?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/edge-Workers%20%2B%20D1-f5a838?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/client-Tampermonkey-7dc4ff?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/LLM%20calls-zero,%20on%20purpose-e8e4f6?style=flat-square&labelColor=2b1b58">
</p>

<p align="center"><img src="docs/card.jpg" width="100%" alt="The clue card over a Scottish round"></p>

<p align="center"><sub><b>A real round, a real card.</b> You guessed Wales; it was Skye. The sign that would have told you so was in the frame all along — the circle is mine, the card doesn't point at the clue for you.</sub></p>

## The problem

GeoGuessr is a memory game wearing a geography costume. Alberta's bollards, the extra bar on a Nusa pole, which countries paint dashed yellow centre lines — these are *metas*, and there are thousands of them.

[Learnable Meta](https://learnablemeta.com) solved the teaching half, beautifully: finish a round, and a note explains exactly which clue you were meant to spot. Thousands of locations, hand-annotated.

But it has no memory of **you**:

1. See a meta you don't know. Get it wrong.
2. Read the note. Genuinely learn it.
3. See it ten minutes later. Nail it.
4. Don't see it again for three weeks.
5. Blank.

Excellent teaching, no scheduling — so the practice you get is uncorrelated with the practice you need. Anki fixed this in 2006, but nobody wants to grind flashcards about bollards. They want to play GeoGuessr.

## So make the round *be* the flashcard

<p align="center"><img src="docs/loop.png" width="100%" alt="Play a round, your pin is the grade, the card lands in 0.4s, FSRS rebuilds the map"></p>

No extra app, no self-reporting. The rebuild is the part people don't expect: the server picks what's due, then the userscript drives GeoGuessr's *own* map-maker API with your session cookies and publishes it into your library. It's a normal map. Play it, share it, ignore it.

## Does it work?

605 rounds, 216 distinct metas, 98 countries — my own log:

| Times I'd seen that meta | I identified it correctly |
| --- | --- |
| First time ever | **16%** &nbsp;<sub>35/216</sub> |
| Second time | **37%** &nbsp;<sub>46/126</sub> |
| Third time or later | **60%** &nbsp;<sub>127/212</sub> |

One person's log, not a study — first exposures are unfamiliar by definition, so some of that climb is regression to the mean. But it showed up in three days, not three months.

## What's in the box

| | |
| --- | --- |
| `coach/geocoach.user.js` | Tampermonkey. Captures rounds, renders the card, publishes the map. |
| `cloud/src/worker.mjs` | Worker + D1. Grading, state, deck building. |
| `coach/server.mjs` | The same pipeline as a local Node server, for full-resolution round dossiers. |
| `coach/scheduler.mjs` | [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), wrapped in pure functions with no clock reads — so old rounds can be replayed. |
| `site/`, `dashboard/` | React + Vite. Retention curves, per-country accuracy, confusion pairs. |

State is ~70KB of JSON per user: one FSRS card per meta, plus counters. The deck isn't stored anywhere — it's recomputed on demand.

## Run it

```bash
npm install
node coach/server.mjs   # local bridge on :5177
npm run dev             # dashboard
```

Install `coach/geocoach.user.js` in Tampermonkey. On first run it mints a trainer map in your library and republishes that same map forever after. Worker + D1 is optional — it only exists so progress survives the laptop shutting.

<details>
<summary><b>Four things that took embarrassingly long to work out</b></summary>

<br>

**The round detector was starting my rounds for me.** It polled `/api/v3/games/<token>` to notice when a round began — but that endpoint doesn't *read* a game, it *serves the next round*, timer and all. Sitting on the results screen was burning clock. Fix: stop asking, and passively read what the page already fetches.

**Publishing a map is two calls, and it looks like one.** PUT a valid draft, get a 200, watch nothing change. Edits don't go live until you PUT an empty `{}` to `/publish`.

**A pin 4km from the flag graded wrong for weeks.** The Vientiane meta is scoped to the Vientiane region; the geocoder returns the Lao romanization, `Viangchan`. Region scopes have to be written in the geocoder's vocabulary, not the atlas's.

**Getting the card under half a second took three fixes**, because three problems were stacked: the userscript's HTTP transport added ~900ms, the server read its database serially, and the meta lookup was cold every round. A synchronous fetch tap at document-start, parallel reads, and a prewarm fired the moment a round is served took it 4.2s → 0.4s.

</details>

## Credit

[**Learnable Meta**](https://learnablemeta.com) — trausi's maps, plurk's userscript, likeon's platform ([likeon/geometa](https://github.com/likeon/geometa)) — is the reason any of this is possible. The hard, years-long part is curating thousands of locations and knowing what each one teaches; scheduling on top of that is the easy bit. [**Plonk It**](https://www.plonkit.net) is the reference the dossiers pull from — that snapshot is gitignored, it's their content. Scheduling is [**ts-fsrs**](https://github.com/open-spaced-repetition/ts-fsrs).
