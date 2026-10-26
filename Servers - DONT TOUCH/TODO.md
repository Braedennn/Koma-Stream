# TODO — Anime Streaming Servers (`Servers - DONT TOUCH`)

Handoff prompt. Read this whole file before doing anything. Everything below is
either DONE (verified working, don't redo it) or TODO (do it, in order).
Last verified working: 2026-10-22.

---

## CONTEXT — what this folder is

Two self-hostable backend servers that give the anime website playable video
sources with Japanese SUB and English DUB. They are already cloned and
installed in this folder. Your job is to finish packaging them: docs, start/stop
scripts, and a final smoke test. No website code lives here.

| Folder | Stack | Port | Role | Status |
|---|---|---|---|---|
| `anivault-scraper` | Node/TS + Express | 3000 | PRIMARY streaming server (sub + dub, HLS + MP4, built-in CORS/Referer proxies, MAL/AniList metadata) | INSTALLED, PATCHED, **VERIFIED WORKING END-TO-END** |
| `allanime-api` | Python/FastAPI (venv at `.venv`) | 8000 | Secondary: search/catalog/episode lists with sub/dub counts; direct-CDN playback currently gated (see findings) | INSTALLED, PARTIALLY VERIFIED |

Requirements already satisfied on this machine: Node v22.23.2, npm 11.6.2, Python 3.13 (`py -3.13`), git, Chrome + Edge.

Why these two: `ghoshRitesh12/aniwatch-api` and the entire hianime/MegaCloud-Key
ecosystem (414+ forks) got DMCA-removed in March 2026 (Crunchyroll takedown,
github.com/github/dmca/blob/master/2026/03/2026-03-23-crunchyroll.md). Anivault-Scraper (github.com/SH0MIK/Anivault-Scraper) is the actively-maintained
successor (updated 2026-10-21) and was verified live. AllManga.to-API is a
mirror of github.com/walterwhite-69/AllManga.to-API (single `main.py`).

## DONE — do not redo

1. Cloned both repos; `npm ci` done in `anivault-scraper`; Python venv created
   and all deps installed in `allanime-api\.venv`.
2. `anivault-scraper` local-use patches applied (keep them):
   - `npm i dotenv` added; `import 'dotenv/config';` at top of `src/server.ts`.
   - `src/server.ts` supports `ALLOWED_ORIGINS=*` (helper `isOriginAllowed`
     used in the CORS callback, the origin gate, and the browser-proxy bypass).
   - Fixed an upstream bug: the browser-proxy regex had double backslashes
     (`/^\\/api\\/proxy\\/.../`) and could never match. Now single.
3. `anivault-scraper\.env` created (PORT=3000, `ANIVAULT_API_KEY=<generated hex>`,
   ALLOWED_ORIGINS=*, rate limit 300/min). Read the key from that file — it is
   required as `x-anivault-api-key` header on every `/api/*` call except the
   three `/api/proxy/*` routes (those accept browser requests with any allowed
   Origin and no key).
4. Anivault-Scraper verified live (all with the key header, all passed):
   - `GET /api/health` → `ok`
   - `GET /api/search?q=naruto` → 10 results (AniList)
   - `GET /api/episodes?malId=20&source=anikoto` → 220 eps
   - `GET /api/servers?malId=20&ep=1&type=sub|dub` → 4 servers each
   - `GET /api/watch/anikoto/20/1/sub` and `/dub` → distinct m3u8s
     (fetch.nexabloom.top), `hlsProxyUrl` ready, 2 subtitle tracks on sub.
   - `/api/proxy/hls?url=...` fetched with a browser-style `Origin` header and
     NO API key → 200, `Access-Control-Allow-Origin: *`, valid `#EXTM3U`.
   - `GET /api/watch/animeheaven/20/1/sub` → `playbackMode: "mp4"`, direct
     `rt.animeheaven.me/video.mp4?...` + `mp4ProxyUrl`. (AnimeHeaven dub for
     ep 1 didn't exist — use Anikoto for dub; that's normal.)
   - The proxy is general-purpose: any absolute `?url=` + optional `&ref=`,
     no host allowlist, forwards Range, rewrites playlists. Reuse it for any
     m3u8/mp4 from anywhere.
5. AllAnime server verified partially: `/anime/search?q=one+piece` works
   (ReooPAxPMsHM4KPMY, sub 1181 / dub 1161), `/anime/episodes/<id>?includeStreams=true`
   returns sub+dub `streams[]` entries. BUT the returned CDN URLs
   (`allanimenews.com/data2/...mp4`) 404 with every header combo — see findings.
6. Test server instances were stopped; ports 3000/8000 are free. Start fresh
   via the scripts (TODO #2), don't reuse old PIDs.

## FINDINGS — AllAnime direct-CDN problem (already investigated, don't re-derive)

- `allanimenews.com` root is alive but every media path 404s (both video and
  thumbnails). Not a header problem — tested Referer/Origin/UA/HTTP1.1/Range
  matrix.
- Live site facts: GraphQL at `api.allanime.day/api` still allows
  `searchShows`/`shows`/`episodeInfos` (with `vidInforssub/dub/raw.vidPath`)
  with just `Origin/Referer: https://allmanga.to` — no cookies. The
  `episode(...){sourceUrls}` query now returns `AA_CRYPTO_MISSING`.
- Site SPA (allmanga.to) loads config from `api.allanime.day/authconfigs`
  (returns an encrypted blob) and gates the watch page behind Cloudflare
  Turnstile (`challenges.cloudflare.com/turnstile`). Headless Chrome capture
  showed no video requests before the challenge — video URLs are signed
  post-Turnstile. That's why raw vidPaths 403/404.
- Hosts tried and ruled out for `data2/media9/videos/.../1180_*.mp4`:
  `cdn.allanime.day` (gateway 404, no media), `allanime.day` (404),
  `allanime.pro` (301 → expireddomains.com, parked), `youtube-anime.com`
  family incl. `aln.` (403 on video; aln serves `mcovers` thumbs with 206 —
  auth-gated for video), `upload.allmanga.to` (405). GQL schema introspected:
  NO pictureServers/videoServers/config fields (only `appParams`, encrypted).
- Practical consequence: use `allanime-api` for catalog/episodes/sub-dub
  counts; rely on `anivault-scraper` for playback. Its `/anime/sources`
  (+ `X-Cookie` header with real allmanga.to browser cookies) and
  `/anime/stream?url=` embed extractors (filemoon/streamsb/dood/streamtape)
  remain as a manual fallback path if ever needed.

## TODO — in order

### 1. Write `Servers - DONT TOUCH\README.md`
The ops manual. Must include:
- Quick start (run the scripts from TODO #2; what "running" looks like).
- Both servers' run commands WITHOUT the scripts:
  - Anivault: `cd anivault-scraper; npm run dev` (dev, respawns) or
    `npm run build; npm start` (prod). Reads `.env`.
  - AllAnime: `cd allanime-api; .\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000`.
- Auth: where the API key lives (`anivault-scraper\.env`,
  `ANIVAULT_API_KEY`), that every `/api/*` call needs header
  `x-anivault-api-key: <key>`, and that `/api/proxy/hls|video|subtitle` are
  the only keyless routes (browser Origin must be allowed; `*` is set).
- Endpoint reference for anivault-scraper (all under http://localhost:3000/api):
  `search?q=`, `info?anilistId=|malId=`, `episodes?malId=&source=anikoto|animeheaven`,
  `servers?malId=&ep=&type=sub|dub&source=`, `watch/:source/:id/:ep/:type`
  (also `watch?source=&anilistId=&ep=&type=` with `?server=&strict=1`),
  `proxy/hls?url=&ref=`, `proxy/video?url=` (Range), `proxy/subtitle?url=&ref=`,
  `mal/*` metadata routes, `health`.
- The sub/dub playback flow for the website, spelled out:
  search → info → episodes → servers(type=sub|dub) → watch → play
  `hlsProxyUrl` (HLS) or `streamUrl`/`mp4ProxyUrl` (MP4) in the player.
  Anikoto = HLS + subtitles (JP sub / EN dub). AnimeHeaven = direct MP4, mostly
  sub. Anikoto is the default source for a reason — use it first.
- AllAnime endpoints (http://127.0.0.1:8000, no auth, CORS *):
  `anime/home`, `anime/search?q=&translationType=sub|dub|raw`, `anime/info/{id}`,
  `anime/episodes/{id}?includeStreams=true`, `anime/sources`, `anime/stream?url=`.
  Note the CDN limitation from FINDINGS verbatim.
- Troubleshooting: if streams stop working, the upstream sites changed
  domains — check `src/scrapers/anikoto.ts` / `animeheaven.ts` base URLs and
  `git pull` upstream (SH0MIK/Anivault-Scraper); for AllAnime check `CDN_BASE`
  and `SITE_URL` in `main.py` and re-run the FINDINGS probes. Rate limits and
  where to change them. How to change ports.
- A short "why these" section (DMCA context from CONTEXT).

### 2. Create start/stop scripts in the folder root
- `start-servers.ps1`: open two visible PowerShell windows (Start-Process
  powershell -NoExit), one per server with the exact run commands above, so
  the user sees logs. Pause-print the URLs and the API key location.
- `stop-servers.ps1`: kill by port —
  `Get-NetTCPConnection -LocalPort 3000,8000 -State Listen` then
  `taskkill /PID <owningProcess> /T /F`. This exact method already worked.
- Optional convenience: `restart-servers.ps1` = stop + start.

### 3. Lifecycle smoke test
Run `start-servers.ps1`, wait for boot, then re-verify the golden path end to
end (all must pass; commands are pwsh):
- Anivault: `/api/health` with key header → `ok`
- `/api/watch/anikoto/20/1/sub` and `/dub` → non-null `hlsProxyUrl`
- GET the sub `hlsProxyUrl` with header `Origin: http://localhost:5500` and
  NO API key → 200 + body starts with `#EXTM3U` + `Access-Control-Allow-Origin: *`
- AllAnime: `/anime/search?q=naruto` → results; `/anime/episodes/ReooPAxPMsHM4KPMY?includeStreams=true&episodeStart=1&episodeEnd=1` → streams array present
Then run `stop-servers.ps1`, confirm both ports free, then start once more and
LEAVE BOTH RUNNING so the user can play immediately. Tell the user they're live.

### 4. (Optional, only if user asks) Get AllAnime playback working again
Leads, best first: (a) reverse the `authconfigs` encrypted blob + Turnstile
token flow from the SPA chunks (loaded from cdn.allanime.day/all/manga/*.js —
download and grep the full chunk list, the player chunk only loads
post-challenge); (b) monitor walterwhite-69/AllManga.to-API for a CDN fix and
diff it into the taseen mirror; (c) swap in a different maintained secondary —
screened and rejected: ryou-api (naive regex extractor, iframe-only embeds),
vlx-animeplus (MegaPlay-only, 0 stars, unverified), Aniraku-Backend (Go +
Supabase + TMDB keys, too heavy), Open-Anime-API (Puppeteer miner, unverified
quality), anistream-api (streaming routes dead), TatakaiAPI (suspicious
zip-download README). Do not resurrect aniwatch-api forks — DMCA'd network.

### 5. (When the website gets built) Integration notes for the frontend
- Catalog/metadata: AniList GraphQL (public) or anivault's `/api/mal/*`.
- Resolve → play via anivault's `watch` responses; hls.js for `hlsProxyUrl`,
  plain `<video>` for `mp4`/`streamUrl` (proxy already fixes CORS+Range).
- Sub/dub toggle = `type` param on `servers`/`watch`.
- If the site is static frontend-only, the API key is embedded client-side
  (private deployment, acceptable) — or better, put a tiny backend in front.
  To disable the key entirely: leave `ANIVAULT_API_KEY` empty in `.env`
  (middleware then requires an allowed Origin only).

## RULES
- Don't touch anything outside this folder. Don't build the website.
- Don't commit anything. Don't push anything.
- Keep the Anivault patches (dotenv, wildcard origins, regex fix) when pulling
  upstream updates — re-apply if a pull conflicts.
- Folder name stays exactly `Servers - DONT TOUCH`.
