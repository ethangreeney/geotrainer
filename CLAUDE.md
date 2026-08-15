# GeoTrainer

Personal GeoGuessr learning system. Trainer app (Vite + React) plus the GeoCoach
bridge (`coach/`): a Tampermonkey userscript and Node server that capture every
round into `coach/rounds/<id>/` and drive spaced repetition over `coach/state.json`.

## Discussing a round

Dossier rounds are discussed **only when asked** — never auto-coach after games.
When asked about a round, read `coach/rounds/<id>/dossier.json` and `pano.jpg`,
then pull the offline Plonk It guides for both the **actual** and the **guessed**
country: `coach/plonkit/<slug>.md` (slug lookup in `coach/plonkit/INDEX.md`).
Read the markdown first; open individual images from `coach/plonkit/img/<slug>/`
only when a specific clue needs visual confirmation. Everything is offline — no
web fetches needed.

If `coach/plonkit/` is empty, regenerate it: `node coach/plonkit/scrape.mjs`
(~10 min, ~500MB; snapshot is gitignored).

## Constraints

Commits use the home identity (Ethan Greene <ethan@greene.nz>), **no DEV- ticket
prefix** — this is a personal repo. The system makes zero Anthropic API calls;
never introduce an API key dependency. Server runs via
`nohup node coach/server.mjs > coach/server.log 2>&1 &` on port 5177 (LAN-exposed
for the Windows gaming PC).
