# GeoTrainer

Personal GeoGuessr learning system. Trainer app (Vite + React) plus the GeoCoach
bridge (`coach/`): a Tampermonkey userscript and Node server that capture every
round into `coach/rounds/<id>/` and drive spaced repetition over `coach/state.json`.

## Discussing a round

Rounds are discussed **only when asked** — never auto-coach after games.

When asked, run `node coach/brief.mjs` (no argument = the round just played; or
an index like `3`, or a round id; `--list` to see recent rounds). One call pulls
the dossier from the cloud, rebuilds the imagery from Google's tile CDN into
`coach/rounds/<id>/`, samples the terrain at both ends of the guess, and prints
the user's standing patterns, a country-facts differential, and the Plonk It
clues that separate the true country from the guessed one.

Read the `view_front/right/back/left.jpg` it names — rectilinear views, the
round as the player saw it (front = the way the camera car faced). `pano.jpg`
is the 360° overview; `pano_<row>_<col>.jpg` tiles carry native detail. For a
close-up of one thing (a sign, a plate, road lines):
`node coach/look.mjs <id> <yaw> [pitch] [fov]` — fov below 45 fetches sharper
zoom-5 imagery for just that sector.

For the wider question — "what else could this have been?" — `node coach/clues.mjs`
slices all 140 guides by clue type across countries: `bollard`, `pole white top`,
`--find cyrillic`, `--country HR`. `--facts` is the structured layer: driving
side, road-line colours, script and killer tells for every covered country
(`--facts MY KH`, `--facts drives=left lines=yellow`).

## Tutoring

The goal is a closed loop: miss → coached discussion → drilled → ranked → re-measured.
`node coach/brief.mjs --profile` prints standing form (hit rates, direction-specific
confusions, worst countries) — read it before choosing what to work on.
`node coach/brief.mjs --quiz` replays a past miss cold, imagery only: the user must
state a country AND their reasoning before any reveal; only then run the full brief
and coach the gap. Never reveal early. Occasionally audit a round the user got
*right* — right-for-wrong-reasons is an error flashcards cannot catch.

Everything is offline; the brief's only network calls are the round fetch and an
elevation lookup. If `coach/plonkit/` is empty, regenerate it:
`node coach/plonkit/scrape.mjs` (~10 min, ~500MB; snapshot is gitignored).

## Constraints

Commits use the home identity (Ethan Greene <ethan@greene.nz>), **no DEV- ticket
prefix** — this is a personal repo. The system makes zero Anthropic API calls;
never introduce an API key dependency. Server runs via
`nohup node coach/server.mjs > coach/server.log 2>&1 &` on port 5177 (LAN-exposed
for the Windows gaming PC).
