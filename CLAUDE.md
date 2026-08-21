# GeoTrainer

Personal GeoGuessr learning system. Trainer app (Vite + React) plus the GeoCoach
bridge (`coach/`): a Tampermonkey userscript and Node server that capture every
round into `coach/rounds/<id>/` and drive spaced repetition over `coach/state.json`.

## Discussing a round

Rounds are discussed **only when asked** — never auto-coach after games.

When asked, run `node coach/brief.mjs` (no argument = the round just played; or
an index like `3`, or a round id; `--list` to see recent rounds). One call pulls
the dossier from the cloud, rebuilds the panorama from Google's tile CDN into
`coach/rounds/<id>/`, samples the terrain at both ends of the guess, and prints
the Plonk It clues that separate the true country from the guessed one. Then
read the `pano.jpg` it names — that is the whole loop. Open a `pano_<row>_<col>.jpg`
tile to read detail the overview loses, or a `coach/plonkit/img/...` reference
image when a clue needs visual confirmation.

For the wider question — "what else could this have been?" — `node coach/clues.mjs`
slices all 140 guides by clue type across countries: `bollard`, `pole white top`,
`--find cyrillic`, `--country HR`.

Everything is offline; the brief's only network calls are the round fetch and an
elevation lookup. If `coach/plonkit/` is empty, regenerate it:
`node coach/plonkit/scrape.mjs` (~10 min, ~500MB; snapshot is gitignored).

## Constraints

Commits use the home identity (Ethan Greene <ethan@greene.nz>), **no DEV- ticket
prefix** — this is a personal repo. The system makes zero Anthropic API calls;
never introduce an API key dependency. Server runs via
`nohup node coach/server.mjs > coach/server.log 2>&1 &` on port 5177 (LAN-exposed
for the Windows gaming PC).
