# Koma TV — interface study

A separate, throwaway app: a proposal for what Koma's television screen could
look like, built by itself so it can be judged on its own, run next to the real
app, and thrown away without touching it.

It is not the shipping TV app. It has no streaming, no account, no updates. It
has one job: a screen you can drive from the sofa, with artwork, type and focus
that behave like a real product — and every destination a real page.

## Run it

```
cd tv-ui
npm install
npm start
```

It opens **full screen**, the way a television app should: no window furniture,
no taskbar, nothing desktop-shaped. Escape goes back a page, F fills or
unfills the screen, Alt+F4 quits.

| Keys | What they do |
| --- | --- |
| Arrows / WASD | Move the focus; up from the top of a page takes the rail |
| Enter | Open the title under the focus; the rail, the pills and the settings all answer it |
| Escape | Back the way you came — a page, then the sheet, then the screen |
| F | Leave or re-enter full screen |

## What is on the screen

| Page | What it is |
| --- | --- |
| **Home** | One spotlight (air date, runtime, genres, studio, score, where it streams) over four shelves |
| **A title** | Its own screen: wordmark, meta, one start button, seasons with watched ticks, and the episodes with their thumbnails and progress |
| **The player** | A full-screen player with a seek bar, subtitles, next episode, resume, and keys that match a remote |
| **Browse** | The catalog by genre: a strip of genres, then a wall of posters; down at the bottom loads the next page |
| **TV** | The airing schedule: seven days, and every episode of the day under it |
| **Library** | Your list — save a title from any screen and it appears here — and an honest "continue watching" |
| **Search** | The catalog by name, through Koma's own server |
| **Settings** | Where the study looks for Koma, full screen, and a reload |

Every page loads its own data and says what it is doing; a page that needs
Koma and cannot find it explains itself instead of pretending.

### The player

Nothing new runs underneath it: the study asks **Koma's own server** for the
episode (`/api/stream/watch`, exactly what the site asks), plays the playlist
**Koma's own proxy** serves with hls.js, and shows **Koma's own** subtitles.
The only thing this app adds is a local page to play them on, because a page
may only load video from its own origin.

| Keys | What they do |
| --- | --- |
| Space / K | Play and pause |
| ← → | Back and forward 10 seconds (the seek bar walks with them) |
| ↑ ↓ | Volume |
| N / P | Next and previous episode |
| C | Subtitles, when the episode has them |
| M | Mute |
| F | Full screen |
| 0–9 | Jump to that part of the episode |
| Escape | Back to the episode list |

Progress is remembered per episode, so a title resumes where you left off and
the episodes you have finished carry a tick.

## Where the data comes from

The study prefers Koma's own server — `http://127.0.0.1:4000` by default, then
4100 and 4101 — and shows `/api/home`, `/api/anime/<id>`, `/api/browse`,
`/api/genres` and `/api/schedule` from it. Point it somewhere else with:

```
npm start -- --api http://127.0.0.1:4999
```

When no server is there, the home page renders a snapshot of 15 live AniList
records (`renderer/sample.json`), and the other pages say what they need. The
footer chip on the right says which of the two is on screen; Settings walks
the candidate addresses.

## Pack it into an .exe

```
node build-exe.mjs
```

That borrows the packager already installed for the desktop app, so there is no
second Electron to download, and leaves:

```
tv-ui\dist\KomaTV-win32-x64\KomaTV.exe
```

## Files

| Path | What it is |
| --- | --- |
| `main.js` | The Electron shell: one full-screen window, the local site, and the bridge |
| `preload.js` | The bridge — the page asks, the shell fetches |
| `bridge.js` | The handlers both the app and the picture tool register |
| `serve.js` | The study's own local site: the page, and the relay that carries Koma's stream to its own origin |
| `renderer/index.html` | The screen: backdrop, the rail, and the stage the pages fill |
| `renderer/css/tv.css` | The whole design |
| `renderer/js/app.js` | The pages, the router, and the remote |
| `renderer/js/player.js` | The player |
| `renderer/js/lib/hls.min.js` | hls.js, from Koma's own site, for the playlist Koma's proxy serves |
| `renderer/sample.json` | A snapshot of 15 AniList records for when no server runs |
| `tools/fetch-sample.mjs` | Refreshes that snapshot from AniList |
| `tools/shot.js` | Takes a picture without a person, and says what is on the screen |
| `tools/relay-check.mjs` | Checks the stream relay against a running Koma, without a browser |

```
node_modules/.bin/electron.cmd tools/shot.js out.png 8000 home|browse|tv|library|settings|watch|play|playing|find|top|list|backtest
```