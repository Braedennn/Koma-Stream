<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=32&pause=1000&color=7C5CBF&center=true&vCenter=true&width=600&lines=AllAnime+API;Scrape+allmanga.to+like+a+pro;Self-hosted+%26+free+forever" alt="Typing SVG" />

<br/>

<p>
  <img src="https://img.shields.io/badge/Python-3.11+-3776ab?style=for-the-badge&logo=python&logoColor=white"/>
  <img src="https://img.shields.io/badge/FastAPI-0.115-009688?style=for-the-badge&logo=fastapi&logoColor=white"/>
  <img src="https://img.shields.io/badge/CORS-Enabled-green?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/No%20Cookies%20Needed-CDN%20Streams-blueviolet?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge"/>
</p>

<p>
  <a href="https://discord.gg/zs22ZJttZM">
    <img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white"/>
  </a>
  <a href="https://github.com/walterwhite-69/AllManga.to-API">
    <img src="https://img.shields.io/badge/GitHub-walterwhite--69-181717?style=for-the-badge&logo=github&logoColor=white"/>
  </a>
</p>

<br/>

> **An unofficial, self-hostable REST API for [allmanga.to](https://allmanga.to/) — search anime, browse episodes, and get direct 1080p MP4 stream URLs with zero cookies needed.**

</div>

---

## Why does this exist?

**AnimeKai is shutting down.** And honestly, it won't be the last.

Every time a popular anime site dies, every app, bot, and project built on top of it dies too. Kai going down hit a lot of people. So instead of waiting for the next thing to get taken down, I built something you can run yourself — backed by a source that has been stable for years.

This scrapes **allmanga.to (AllAnime)**, which has a clean internal GraphQL API under the hood. It is not scraping HTML that breaks every redesign. It is talking directly to their data layer. Much more reliable.

Run it yourself. Host it yourself. No rate limits from me, no middleman, no praying someone else's server stays up.

---

## What it does

- Search anime by title with sorting, type and translation filters
- Homepage feed — latest updates + trending, just like the site
- Full anime info — description, genres, studios, scores, seasons, episode counts
- **Direct 1080p MP4 stream URLs** — no cookies, no captcha, no embeds needed
- All embed servers decoded — GogoAnime, StreamSB, Doodstream, Streamtape, Mp4Upload, Filemoon, MyCloud and more
- AES-256-CBC decryption for GogoAnime/VidStreaming
- CORS enabled — plug it straight into any frontend
- Beautiful built-in docs page at `/` plus full Swagger UI at `/docs`

---

## Quick Start

Requirements: Python 3.10+

```bash
git clone https://github.com/walterwhite-69/AllManga.to-API
cd AllManga.to-API

python -m venv .venv
source .venv/bin/activate

pip install fastapi "uvicorn[standard]" "httpx[http2]" beautifulsoup4 lxml pycryptodome

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Open **http://localhost:8000** and you will see the docs page with live Try it buttons.

---

## API Endpoints

### `GET /anime/home`

Homepage feed — recent and trending anime in one call.

| Param | Default | Options |
|-------|---------|---------|
| `translationType` | `sub` | `sub` `dub` `raw` |
| `countryOrigin` | `JP` | `JP` `CN` `KR` |
| `page` | `1` | any number |

```bash
curl "http://localhost:8000/anime/home?translationType=sub&countryOrigin=JP"
```

---

### `GET /anime/search`

Search by title. Supports sorting, type filter, translation type, country.

| Param | Required | Notes |
|-------|----------|-------|
| `q` | yes | Search query |
| `sortBy` | | `Latest_Update` `Trending` `Name_ASC` `Name_DESC` |
| `type` | | `TV` `Movie` `OVA` `ONA` `Special` |
| `translationType` | | `sub` `dub` `raw` |
| `countryOrigin` | | `JP` `CN` `KR` |
| `limit` | | Default 26, max 100 |
| `page` | | Default 1 |

```bash
curl "http://localhost:8000/anime/search?q=one+piece&sortBy=Trending&limit=5"
```

<details>
<summary>Example response</summary>

```json
{
  "results": [
    {
      "_id": "ReooPAxPMsHM4KPMY",
      "name": "1P",
      "englishName": "One Piece",
      "thumbnail": "https://cdn.myanimelist.net/images/anime/1810/139965.jpg",
      "score": 8.73,
      "type": "TV",
      "status": "Releasing",
      "genres": ["Action", "Adventure", "Comedy"],
      "availableEpisodes": { "sub": 1161, "dub": 1161, "raw": 0 },
      "season": { "quarter": "Fall", "year": 1999 }
    }
  ],
  "page": 1,
  "limit": 5,
  "hasNextPage": true
}
```

</details>

---

### `GET /anime/info/{show_id}`

Full details for a show — description, genres, tags, studios, aired dates, episode counts.

```bash
curl "http://localhost:8000/anime/info/ReooPAxPMsHM4KPMY"
```

---

### `GET /anime/episodes/{show_id}` — the main one

Episode list with direct CDN MP4 links. This is the one you actually want. Set `includeStreams=true` and you get playable 1080p URLs for sub and dub — no cookies, no captcha, no embed pages.

| Param | Default | Notes |
|-------|---------|-------|
| `episodeStart` | `1` | Starting episode number |
| `episodeEnd` | `9999` | Ending episode number |
| `includeStreams` | `false` | Set to `true` to get direct MP4 URLs |

```bash
curl "http://localhost:8000/anime/episodes/ReooPAxPMsHM4KPMY?includeStreams=true&episodeStart=1&episodeEnd=3"
```

<details>
<summary>Example stream object</summary>

```json
{
  "server": "allanime-cdn",
  "translationType": "sub",
  "url": "https://allanimenews.com/data2/media9/videos/.../sub/1_xxxx.mp4",
  "quality": "1080p",
  "sizeMB": 500.9,
  "durationSec": 1539.1,
  "type": "mp4",
  "headers": {
    "Referer": "https://allanimenews.com/",
    "Origin": "https://allanimenews.com"
  }
}
```

Pass the `Referer` header when playing. VLC, MPV, and most HTTP clients support this. You cannot paste the URL raw into a browser address bar — that is a browser security restriction, not an API limitation.

</details>

---

### `GET /anime/sources`

All embed server URLs for an episode, decoded from AllAnime's XOR encoding. Set `extractStreams=true` to also pull actual video URLs from each embed page.

Most people will not need this. The CDN streams from `/anime/episodes` are cleaner — direct MP4, no ads, known file size. This endpoint is only useful as a fallback for anime not hosted on the AllAnime CDN. It also requires your browser cookies from allmanga.to to bypass their captcha check.

| Param | Required | Notes |
|-------|----------|-------|
| `showId` | yes | Show ID |
| `episode` | yes | Episode number e.g. `"1"` |
| `translationType` | | `sub` `dub` `raw` |
| `extractStreams` | | Also extract m3u8/mp4 from each embed |
| `X-Cookie` *(header)* | yes | Your allmanga.to browser cookies |

<details>
<summary>How to get cookies</summary>

1. Open [allmanga.to](https://allmanga.to) in your browser and pass any Cloudflare challenge
2. Open DevTools then Application then Cookies and copy all the values
3. Paste them as the `X-Cookie` header value

```bash
curl -H "X-Cookie: <your cookies>" \
  "http://localhost:8000/anime/sources?showId=ReooPAxPMsHM4KPMY&episode=1&translationType=sub"
```

</details>

---

### `GET /anime/stream`

Extract playable video URLs from any embed page URL. Pass an embed link, get back m3u8 or mp4 URLs.

| Param | Notes |
|-------|-------|
| `url` | Full embed URL |
| `server` | Optional hint: `gogoanime` `streamsb` `doodstream` `streamtape` `mp4upload` `filemoon` `mycloud` |

```bash
curl "http://localhost:8000/anime/stream?url=https://dood.wf/e/XXXXX&server=doodstream"
```

---

## The flow that actually works (no cookies)

```
1. Search
   GET /anime/search?q=attack+on+titan
   grab the "_id" from the result you want

2. Get episodes with streams
   GET /anime/episodes/{id}?includeStreams=true
   each episode has a "streams" array

3. Play
   take any "url" from the streams array
   pass Referer: https://allanimenews.com/
   done. 1080p MP4, sub or dub.
```

---

## Supported Stream Servers

| Server | Method |
|--------|--------|
| AllAnime CDN | Direct MP4 — no cookies needed |
| GogoAnime / VidStreaming | AES-256-CBC decryption |
| StreamSB / SBPlay | Multi-host API extraction |
| Doodstream / Dood | pass_md5 token extraction |
| Streamtape | JS innerHTML link parsing |
| Mp4Upload | Source URL scan |
| Filemoon / MoonPlayer | Packed JS + m3u8 scan |
| MyCloud / VizCloud | HLS m3u8 extraction |

---

## Docker

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install fastapi "uvicorn[standard]" "httpx[http2]" beautifulsoup4 lxml pycryptodome
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```bash
docker build -t allanime-api .
docker run -p 8000:8000 allanime-api
```

---

## Project structure

```
AllManga.to-API/
└── main.py        # Everything. One file. ~640 lines.
```

No routers. No separate scrapers folder. No 12 config files. Just `main.py`.

---

## FAQ

**Q: Why allmanga.to?**
AllAnime has a real internal GraphQL API that has been stable for years. Most sites scrape raw HTML which breaks every time they redesign. This is far more reliable.

**Q: Will this break when sites get taken down?**
This does not depend on Kai or any site that went down. allmanga.to is an independent source. If they ever change their API I will update the code.

**Q: The MP4 URL does not play in my browser**
You need to send `Referer: https://allanimenews.com/` with the request. Browsers do not let you set Referer manually in the address bar — use VLC, MPV, or proxy it through your own backend.

**Q: Getting CAPTCHA_REQUIRED on /anime/sources**
Use `/anime/episodes?includeStreams=true` instead. Direct CDN streams, zero cookies needed. `/anime/sources` is just a fallback for edge cases.

**Q: Can I use this in my project?**
MIT licensed. Go for it.

---

## Found a bug?

Open an issue and I will look at it.

**[github.com/walterwhite-69/AllManga.to-API/issues](https://github.com/walterwhite-69/AllManga.to-API/issues)**

Include which endpoint you hit, what you expected vs what happened, and the full error message.

---

## Community

<div align="center">

Come hang out. Share what you are building. Ask questions.

[![Discord](https://img.shields.io/badge/Join%20the%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/zs22ZJttZM)

</div>

---

## Disclaimer

For personal and educational use only. Does not host, store, or redistribute any video content. All streams are sourced directly from third-party servers. Use responsibly.

---

<div align="center">

Built because Kai went down and I was tired of waiting for someone else to fix it

**[Star this repo](https://github.com/walterwhite-69/AllManga.to-API) · [Open an issue](https://github.com/walterwhite-69/AllManga.to-API/issues) · [Join Discord](https://discord.gg/zs22ZJttZM)**

</div>
