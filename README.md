<h1 align="center">GeoTrainer</h1>

<p align="center">
  <b>Spaced repetition for GeoGuessr, hidden inside the games you were going to play anyway.</b><br>
  <sub>It watches your rounds, works out which clue each one was testing, grades your pin against it,<br>
  and rebuilds your practice map out of the metas you're about to forget.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/scheduler-FSRS-a3e961?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/edge-Workers%20%2B%20D1-f5a838?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/client-Tampermonkey-7dc4ff?style=flat-square&labelColor=2b1b58">
  <img src="https://img.shields.io/badge/LLM%20calls-zero,%20on%20purpose-e8e4f6?style=flat-square&labelColor=2b1b58">
</p>

<p align="center"><img src="docs/card.jpg" width="100%" alt="The GeoCoach clue card over a Scottish round"></p>

<p align="center"><sub><b>A real round, a real card.</b> You guessed Wales. It was Skye — and the passing place sign that would have told you so was sitting right there in the frame. That card is now a flashcard.</sub></p>

## The problem

GeoGuessr is a memory game wearing a geography costume. Alberta's bollards, the extra bar on a Nusa pole, which countries paint dashed yellow centre lines — these are *metas*, and there are thousands of them.

[Learnable Meta](https://learnablemeta.com) already solved the teaching half, beautifully: finish a round, and a note explains exactly which clue you were meant to spot. Thousands of locations, hand-annotated. The best meta resource that exists.

But it has no memory of **you**. Every round is taught to a blank slate:

1. See a meta you don't know. Get it wrong.
2. Read the note. Genuinely learn it.
3. See it ten minutes later. Nail it. Feel like a genius.
4. Don't see it again for three weeks.
5. Blank completely.

Meanwhile you keep drawing Norwegian bollards you've known cold since March, because nothing is tracking that you know them. Excellent teaching, no scheduling — so the practice you get is uncorrelated with the practice you need.

Anki solved this in 2006. But nobody wants to grind flashcards about bollards. They want to play GeoGuessr.

## So make the round *be* the flashcard

<p align="center"><img src="docs/loop.png" width="100%" alt="Play a round, your pin is the grade, the card lands in 0.4s, FSRS rebuilds the map"></p>

No extra app, no self-reporting, no grinding. You play, and the game quietly becomes a curriculum.

The rebuild is the part people don't expect: the server picks what's due, then the userscript drives GeoGuessr's *own* map-maker API with your session cookies and publishes it into your library. It's a normal map. Play it from the app, share it, ignore it.

## Does it work?

605 rounds, 216 distinct metas, 98 countries — my own log:

| Times I'd seen that meta | I identified it correctly |
| --- | --- |
| First time ever | **16%** &nbsp;<sub>35/216</sub> |
| Second time | **37%** &nbsp;<sub>46/126</sub> |
| Third time or later | **60%** &nbsp;<sub>127/212</sub> |

Caveat, plainly: one person's log, not a study. First exposures are unfamiliar by definition, so some of that climb is regression to the mean. But the shape is the shape — and it showed up in three days, not three months.

## What's in the box

| | |
| --- | --- |
| `coach/geocoach.user.js` | Tampermonkey. Captures rounds, renders the card, publishes the map. |
| `cloud/src/worker.mjs` | Worker + D1. Grading, state, deck building. |
| `coach/server.mjs` | The same pipeline as a local Node server, for offline work and full-res dossiers. |
| `coach/scheduler.mjs` | [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), wrapped in pure functions with no clock reads — so old rounds can be replayed. |
| `site/`, `dashboard/` | React + Vite. Retention curves, per-country accuracy, confusion pairs. |

Per-user state is ~70KB of JSON: one FSRS card per meta, plus counters. That's the whole backend. The deck isn't stored — it's recomputed from the cards on demand.

## Run it

```bash
npm install
node coach/server.mjs   # local bridge on :5177
npm run dev             # dashboard
```

Install `coach/geocoach.user.js` in Tampermonkey. On first run it mints a trainer map in your GeoGuessr library and republishes that same map forever after. The Worker + D1 deployment is optional — it only exists so progress survives the laptop shutting.

<details>
<summary><b>Four things that took embarrassingly long to work out</b></summary>

<br>

**The round detector was starting my rounds for me.** It polled `/api/v3/games/<token>` to notice when a round began. That endpoint doesn't *read* a game — it *serves the next round*, timer and all. Sitting on the results screen was burning clock on a round I hadn't opened. Fix: stop asking, and passively read what the page already fetches.

**Publishing a map is two calls, and it looks like one.** PUT a valid draft with all your coordinates, get a 200, watch nothing change. Draft edits don't go live until you PUT an empty `{}` to `/publish`.

**A pin 4km from the flag graded wrong for weeks.** The Vientiane meta is scoped to the Vientiane region; the reverse geocoder returns the Lao romanization, `Viangchan`. No match, wrong answer, card knocked back into relearning. Region scopes have to be written in the geocoder's vocabulary, not the atlas's.

**Getting the card under half a second took three fixes**, because there were three stacked problems: the userscript's HTTP transport added ~900ms, the server read its database serially, and the meta lookup was cold every round. A synchronous fetch tap at document-start, parallel reads, and a prewarm fired the moment a round is served took 4.2s → 0.4s — most of which is now GeoGuessr's own scoring response.

</details>

## Credit

This is a layer on other people's work, and it's worth being specific about whose.

[**Learnable Meta**](https://learnablemeta.com) — trausi's maps and annotations, plurk's userscript, likeon's platform ([likeon/geometa](https://github.com/likeon/geometa)) — is the reason any of this is possible. The hard, unglamorous, years-long part is curating thousands of locations and knowing what each one teaches. Scheduling on top of that is the easy bit.

[**Plonk It**](https://www.plonkit.net) is the reference the round dossiers pull from. That snapshot is gitignored here — it's their content, not mine.

Scheduling is [**ts-fsrs**](https://github.com/open-spaced-repetition/ts-fsrs), an implementation of [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler).
