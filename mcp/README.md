# GeoCoach MCP

Coaches the GeoGuessr rounds you actually played — with the imagery.

[GeoCoach](https://geofsrs.pages.dev) already captures every round you play and
schedules what to practise next. This is the other half: a tutor that can *look
at* the round with you. It hands your MCP client the panorama as photographs,
the true location against where you clicked, your record on both countries, and
the Plonk It clues that separate the two.

No API key, ever. The server makes no LLM calls of its own — the intelligence is
whichever model you have connected. Its only credential is your own GeoCoach
token.

## Install

Get your token from the dashboard at **https://geofsrs.pages.dev**.

**Claude Code**

```
claude mcp add geocoach -e GEOCOACH_TOKEN=your-token -- npx -y geocoach-mcp
```

**Claude Desktop** — add this to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude:

```json
{
  "mcpServers": {
    "geocoach": {
      "command": "npx",
      "args": ["-y", "geocoach-mcp"],
      "env": {
        "GEOCOACH_TOKEN": "your-token"
      }
    }
  }
}
```

Any other MCP client: the command is `npx -y geocoach-mcp` over stdio, with
`GEOCOACH_TOKEN` in the environment.

Not on npm yet? Build the tarball with `npm pack` and swap the command for
`npx -y --package ./geocoach-mcp-0.1.0.tgz -- geocoach-mcp` — same server, same
four tools.

That is the whole install. Node 20 or newer, nothing to download first, no
Python, no native build. Then ask your client: *"coach my last round."*

## The tools

| tool | what it gives back |
| --- | --- |
| `geocoach_round_dossier(round?)` | One round, coached: **four photographs** of the panorama (front, right, back, left — front is the way the camera car faced), the true location and its terrain, where you clicked and how far off, your record on both countries, the clue the location was chosen to teach, and what separates the two countries. `round` is an index (`"1"` = most recent, the default) or a round id. |
| `geocoach_look(round, yaw, pitch?, fov?)` | The telephoto. One bearing, close up, to read a sign, a plate, a bollard or the road lines. `yaw` is degrees clockwise from the way the car faced, or a compass point (`"N"`, `"SSW"`). Below 45° of `fov` it fetches sharper zoom-5 imagery for that sector alone. |
| `geocoach_clues(country?, versus?, clue_type?, search?, facts?)` | The ~140 Plonk It country guides, sliced. `country` + `versus` for what separates two countries; `country` alone for a whole guide; `clue_type` (`"bollard"`, `"pole"`) for one clue across every country; `search` for free text; `facts` for the structured table — driving side, road-line colours, script, killer tell. No arguments lists the clue types. |
| `geocoach_profile()` | Standing form: country hit rate over 7 days, 30 days and all time; the confusions you repeat, stated directionally; your worst countries. Read it before choosing what to work on. |

`geocoach_clues` needs no token. The other three read your own round history.

## What it keeps on disk

Everything caches under `~/.geocoach` (override with `GEOCOACH_HOME`), built
lazily — a fresh install downloads nothing.

**Round imagery** is rebuilt from Google's public Street View tile CDN the first
time you ask about a round, and reused after: about 6 MB and a few seconds per
round. Panoramas Google has since retired fall back to the nearest live
coverage, and the dossier says so rather than quietly showing you a different
place.

**The clue library** is the text of the Plonk It guides — 1.5 MB, no images. The
server starts fetching it in the background on first launch and it takes about
five minutes, because plonkit.net serves roughly 25 guide pages a minute and
there is no way to spend that budget faster. Nothing blocks on it: dossiers,
close-ups and your profile all work while it fills, and say so if a clue section
is still missing. An interrupted build resumes where it stopped.

## Configuration

| variable | |
| --- | --- |
| `GEOCOACH_TOKEN` | **Required** for round tools. From https://geofsrs.pages.dev. |
| `GEOCOACH_HOME` | Cache directory. Default `~/.geocoach`. |
| `GEOCOACH_URL` | GeoCoach instance. Default `https://geofsrs.pages.dev`. |

## If something is wrong

The tools answer with a sentence, not a stack trace. **No token** tells you where
to get one. **A rejected token** says so rather than blaming the network. **An
account with no rounds** points you at the userscript. Each is the actual next
step.

If Claude Desktop reports that the server failed to start, it is almost always
that a GUI app does not see your shell's `PATH`. Use the absolute path instead —
`which npx` will print it — as `"command"`.

## Credits

Clue text is [Plonk It](https://www.plonkit.net)'s, fetched from their guide
pages the way the site itself asks scrapers to, and never redistributed in this
package. Imagery is Google Street View's, read from the same public tile
endpoint the game uses. Elevation is [Open-Meteo](https://open-meteo.com).

MIT.
