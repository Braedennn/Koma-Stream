# Anime Streaming Servers — Ops Manual

Two self-hostable backend servers that give the anime website playable video
sources with Japanese SUB and English DUB. No website code lives here.

| Folder | Stack | Port | Role |
|---|---|---|---|
| `anivault-scraper` | Node/TS + Express | 3000 | **PRIMARY streaming server** — sub + dub playback (HLS + MP4), built-in CORS/Referer proxies, MAL/AniList/TMDB/Kitsu metadata |
| `allanime-api` | Python/FastAPI (venv at `.venv`) | 8000 | **Secondary** — search / catalog / episode lists with sub-dub counts. Direct-CDN playback currently gated (see [AllAnime CDN limitation](#allanime-cdn-limitation-known-broken)) |

Last verified working end-to-end: 2026-10-22.

---

## Quick start

From this folder:

```powershell
.\start-servers.ps1
```

That opens **two visible PowerShell windows** (they stay open, logs streaming):

- **Anivault window** — ready when you see:
  `🟢 AniVault API running on http://localhost:3000`
- **AllAnime window** — ready when uvicorn prints:
  `Uvicorn running on http://127.0.0.1:8000`

Quick sanity check: `curl http://localhost:3000/api/health -H "x-anivault-api-key: <key>"`
(key from `anivault-scraper\.env`, see [Authentication](#authentication-anivault)) → `ok`.

Stop everything: `.\stop-servers.ps1` — kills by port (3000 + 8000).
Restart: `.\restart-servers.ps1`.

---

## Running without the scripts

**Anivault** (reads `anivault-scraper\.env` automatically):

```powershell
cd anivault-scraper
npm run dev        # dev mode, auto-respawns on file changes
# or, for prod:
npm run build
npm start
```

**AllAnime** (uses the venv already created in `allanime-api\.venv`):

```powershell
cd allanime-api
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

---

## Authentication (AniVault)

- The API key lives in **`anivault-scraper\.env`** → `ANIVAULT_API_KEY`.
- **Every `/api/*` call** must carry the header:

  ```
  x-anivault-api-key: <key>
  ```

- The **only keyless routes** are the three browser media proxies:
  `GET /api/proxy/hls`, `GET /api/proxy/video`, `GET /api/proxy/subtitle`.
  They accept browser requests **without any key** as long as the request's
  `Origin` header is allowed. `ALLOWED_ORIGINS=*` is set in `.env`, so any
  Origin passes.
- To disable the key entirely (private deployment): leave `ANIVAULT_API_KEY`
  **empty** in `.env` — the middleware then only requires an allowed Origin.

AllAnime (`http://127.0.0.1:8000`) has **no auth** and `CORS *`.

---

## AniVault endpoint reference

Base URL: **`http://localhost:3000/api`** — key header required on everything
below except the three `/proxy/*` routes.

### Playback chain (the important ones)

| Endpoint | What it does |
|---|---|
| `GET /search?q=<title>` | Search. AniList (falls back to MAL if AniList is down). Returns `results[]` with `id` (AniList ID) / `malId`. |
| `GET /info?anilistId=<id>` or `?malId=<id>` | Resolves the anime across streaming sites: returns `anilistId`, `malId`, `title`, `episodeCount`, and `siteIds` (per-source slugs). |
| `GET /episodes?malId=<id>&source=anikoto\|animeheaven\|desidub` | Episode list for a streaming source (source defaults to `anikoto`; AnimeHeaven also accepts `?heavenId=` directly). |
| `GET /servers?malId=<id>&ep=<n>&type=sub\|dub\|all&source=<src>` | Available servers for one episode, filtered by audio type. |
| `GET /watch/:source/:id/:ep/:type` | Resolve a playable stream. `:id` = AniList ID, `mal-<id>`, or AnimeHeaven slug; `:type` = `sub`/`dub`/`raw`. |
| `GET /watch?source=&anilistId=&ep=&type=` | Query-string form of the same. Extras: `?server=<name>` (prefer that server, falls back to others) and `?strict=1` (restrict to **only** that server — good for testing). |

`/watch` response fields that matter:

- `hlsProxyUrl` — ready-to-play **HLS** URL (already routed through the local
  proxy, CORS fixed, playlist rewritten). Use with hls.js.
- `streamUrl` / `mp4ProxyUrl` — direct **MP4** (proxy fixes CORS + Range).
  Use with a plain `<video>` element.
- `subtitles[]` — subtitle tracks (already proxied, SRT auto-converted to VTT).
- `playbackMode` — `hls` | `mp4` | `iframe`; `availableServers` — other
  servers that resolved.

### Media proxies (keyless, general-purpose)

| Endpoint | What it does |
|---|---|
| `GET /proxy/hls?url=<absolute>&ref=<optional referer>` | Fetches any m3u8/segment, re-serves it with `Access-Control-Allow-Origin: *`, forwards Range, **rewrites playlists so every segment/variant/key also goes through the proxy**. |
| `GET /proxy/video?url=<absolute>` | Streams any video/MP4. Forwards `Range` (seeking works), CORS `*`. |
| `GET /proxy/subtitle?url=<absolute>&ref=<optional>` | Fetches subtitle files, CORS `*`, converts SRT → WEBVTT on the fly. |

The proxy is **general-purpose**: any absolute `?url=` + optional `&ref=`, no
host allowlist. Reuse it for any m3u8/mp4 from anywhere.

### Metadata

| Endpoint | What it does |
|---|---|
| `GET /mal/anime/:id` | MAL details (title, synopsis, score, genres, studios, …). |
| `GET /mal/anime/:id/episodes[?page=]` / `.../episodes/:epNum` | MAL episode list / single episode (Jikan-shaped). |
| `GET /mal/search?q=&limit=` | MAL text search (Jikan-shaped). |
| `GET /mal/anime/:id/characters` · `.../pictures` · `.../themes` · `.../videos` · `.../streaming` · `.../external` · `.../recommendations` | The rest of the MAL scrapes. |
| `GET /mal/character/:id` · `.../pictures` | Character details / pictures. |
| `GET /anilist/season` | Current-season lineup (AniList). |
| `GET /anilist/top-banners?limit=` | Trending/top art. |
| `GET /anilist/id?malId=` | MAL → AniList ID mapping. |
| `GET /anilist/episodes?malId=[&ep=]` | AniList streaming-episode titles + thumbs. |
| `GET /anilist/anime?malId=` | Poster + cover art from AniList. |
| `GET /tmdb/episode-thumb?ep=(&title=\|&malId=)` · `GET /tmdb/anime?(&title=\|&malId=)` | TMDB stills / poster+backdrop+logo. |
| `GET /kitsu/episode-thumb?ep=(&title=\|&malId=)` · `GET /kitsu/anime?(&title=\|&malId=)` | Kitsu equivalents. |
| `GET /anime?malId=<id>` | **One-call details**: everything from `/mal/anime/:id` plus poster/cover/logo art (TMDB → Kitsu → AniList fallback). |
| `GET /episode?malId=<id>[&ep=<n>]` | Episode titles + air dates + filler/recap + thumbnails, whole show or single ep (`?concurrency=` 1–10, default 5). |
| `GET /health` | Liveness check → `ok`. |

Sources at a glance: **anikoto** (anikoto.net — HiAnime/Zoro-style, HLS +
subtitles, JP sub / EN dub — the default), **animeheaven** (animeheaven.me —
direct MP4, mostly sub), **desidub** (desidubanime.me — Hindi/regional dubs,
rate-limit touchy).

---

## Sub/dub playback flow (for the website)

```
search?q=<title>            → pick an anime (get anilistId / malId)
  → info?malId=<id>         → confirm it's indexed (siteIds, episodeCount)
    → episodes?malId=<id>&source=anikoto
      → servers?malId=<id>&ep=<n>&type=sub|dub    (toggle = the type param)
        → watch/anikoto/<anilistId>/<ep>/sub      (or /dub)
          → play the returned hlsProxyUrl (HLS, hls.js)
            or streamUrl/mp4ProxyUrl (MP4, plain <video>)
```

- **Anikoto is the default source for a reason — use it first.** HLS +
  subtitle tracks, and it carries both sub and dub.
- **AnimeHeaven** = direct MP4, mostly sub-only. Useful as a fallback;
  AnimeHeaven dub for ep 1 of many shows simply doesn't exist — that's
  normal, not a bug.
- Sub/dub toggle is just the `type` param on `servers` and `watch`.

---

## AllAnime endpoints

Base URL: **`http://127.0.0.1:8000`** — no auth, CORS `*`. Docs also served
at the root (`/`) and FastAPI's `/docs`.

| Endpoint | What it does |
|---|---|
| `GET /anime/home?translationType=sub\|dub\|raw&countryOrigin=JP&page=1` | Recent + trending (`recent[]`, `trending[]`). |
| `GET /anime/search?q=<title>&translationType=sub\|dub\|raw&page=&limit=&sortBy=` | Search → `results[]` (each entry has sub/dub available-episode counts). |
| `GET /anime/info/{show_id}` | Full show record from the AllAnime GraphQL backend. |
| `GET /anime/episodes/{show_id}?includeStreams=true&episodeStart=&episodeEnd=` | Episode list; `includeStreams=true` attaches per-episode `streams[]` (sub/dub `vidPath` URLs). |
| `GET /anime/sources?showId=&episode=&translationType=&extractStreams=` | Per-episode embed sources. **Requires an `X-Cookie` header with real allmanga.to browser cookies** (open allmanga.to → DevTools → copy cookies) or the backend returns `CAPTCHA_REQUIRED`. |
| `GET /anime/stream?url=<embed page>&server=gogoanime\|streamsb\|doodstream\|streamtape\|mp4upload\|filemoon\|mycloud` | Embed-page stream extractor (manual fallback path). |

### AllAnime CDN limitation (known broken)

`allanimenews.com` root is alive but every media path 404s (both video and
thumbnails). Not a header problem — tested Referer/Origin/UA/HTTP1.1/Range
matrix. The live site gates the watch page behind Cloudflare Turnstile and
video URLs are signed post-challenge; raw `vidPath`s 403/404. The GraphQL
`episode(...){sourceUrls}` query returns `AA_CRYPTO_MISSING`.

**Practical consequence: use `allanime-api` for catalog/episodes/sub-dub
counts; rely on `anivault-scraper` for playback.** Its `/anime/sources`
(+ `X-Cookie`) and `/anime/stream?url=` embed extractors
(filemoon/streamsb/dood/streamtape) remain as a manual fallback if ever
needed.

---

## Troubleshooting

**Streams stop working (Anivault)** — the upstream sites changed domains:

1. Check the base URLs in `anivault-scraper\src\scrapers\anikoto.ts`
   (`BASE = 'https://anikoto.net'`) and `animeheaven.ts`
   (`BASE = 'https://animeheaven.me'`), plus `desidub.ts`.
2. `git pull` upstream: `SH0MIK/Anivault-Scraper` (actively maintained).
   **Keep the local patches when pulling** — re-apply if a pull conflicts:
   - `dotenv` in `package.json` + `import 'dotenv/config';` at top of
     `src/server.ts`
   - `ALLOWED_ORIGINS=*` support (`isOriginAllowed` used in the CORS
     callback, the origin gate, and the browser-proxy bypass)
   - the browser-proxy regex fix (upstream had double backslashes and the
     route could never match)
3. Re-verify with the golden path: `health` → `watch/anikoto/20/1/sub` →
   fetch the returned `hlsProxyUrl` in a browser.

**AllAnime catalog/episodes break** — check `CDN_BASE`
(`https://allanimenews.com`) and `SITE_URL` (`https://allmanga.to`) at the
top of `allanime-api\main.py`; if the site moved again, re-run the probes
from the CDN findings (test `api.allanime.day/api` with
`Origin/Referer: https://allmanga.to`, check whether media paths still 404).

**Rate limits** — Anivault: `anivault-scraper\.env`
(`RATE_LIMIT_WINDOW_MS=60000`, `RATE_LIMIT_MAX=300` → 300 req/min per IP).
AllAnime has none.

**Ports** — Anivault: `PORT` in `anivault-scraper\.env` (default 3000).
AllAnime: the `--port` in the uvicorn command (8000). If you change them,
update the start script and the website accordingly.

**"Port already in use" / stale servers** — run `.\stop-servers.ps1` first;
it kills whatever owns ports 3000 and 8000.

---

## Why these two

`ghoshRitesh12/aniwatch-api` and the entire hianime/MegaCloud-Key ecosystem
(414+ forks) got DMCA-removed in March 2026 (Crunchyroll takedown —
github.com/github/dmca/blob/master/2026/03/2026-03-23-crunchyroll.md).
**Anivault-Scraper** (github.com/SH0MIK/Anivault-Scraper) is the
actively-maintained successor (updated 2026-10-21) and was verified live.
**AllAnime** is a mirror of github.com/walterwhite-69/AllManga.to-API
(single `main.py`). Do not resurrect aniwatch-api forks — DMCA'd network.
