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

Then **always** run `node coach/look.mjs <id> --scan` and read all eight frames
it prints in one pass. The `view_front/right/back/left.jpg` the brief writes are
100° wide — about sixteen pixels per degree — which is too coarse to resolve the
thing that usually decides the round: the holes in a holey pole, a bollard's
stripe, a plate. Judging a round off the four wide views alone has already
produced a confidently wrong answer. The scan rings the round in eight
overlapping 50° frames at eye level, at twice that detail, so nothing has to be
guessed at before it is seen.

`pano.jpg` is the 360° overview; `pano_<row>_<col>.jpg` tiles carry native
detail. To go closer still on one thing:
`node coach/look.mjs <id> <yaw> [pitch] [fov]`. Aim at or below the horizon —
pole shafts, signposts and road lines all live there, and a positive pitch looks
straight past them.

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

The result-map overlay draws its boundaries from geoBoundaries (OSM), with
Natural Earth as the naming layer and the fallback. The same shapes are packed
into `coach/geo/pack/` and are how a round's country is resolved — reverse
geocoding is offline, no API and no key, in the Worker and on the laptop alike.
If `coach/geo/` has no slices: `node coach/geo/fetch.mjs` then
`node coach/geo/build.mjs` (~10 min, ~650MB download, ~30s to build; sources,
slices and packs are all gitignored, and build.mjs writes the packs itself).
`node coach/geo/audit.mjs` checks that every meta scope and every country
played still resolves to a shape.

## Constraints

Commits use the home identity (Ethan Greene <ethan@greene.nz>), **no DEV- ticket
prefix** — this is a personal repo. The system makes zero Anthropic API calls;
never introduce an API key dependency. Server runs via
`nohup node coach/server.mjs > coach/server.log 2>&1 &` on port 5177 (LAN-exposed
for the Windows gaming PC).
