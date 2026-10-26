import os, re, json, base64, asyncio
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Request, Query, Path, Header
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
from bs4 import BeautifulSoup

# ── Constants ──────────────────────────────────────────────────────────────────
GQL_URL    = "https://api.allanime.day/api"
SITE_URL   = "https://allmanga.to"
CDN_BASE   = "https://allanimenews.com"
VALID_SORTS  = {"Latest_Update", "Trending", "Name_ASC", "Name_DESC"}
VALID_TRANS  = {"sub", "dub", "raw"}

GQL_HEADERS = {
    "Origin": SITE_URL,
    "Referer": SITE_URL + "/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
}

# NOTE: keep NO f-strings for field strings — curly braces in GraphQL selections
# would be misinterpreted by Python's f-string parser.
SHOW_FIELDS = (
    "_id name englishName nativeName thumbnail episodeCount score type "
    "status genres availableEpisodes season altNames countryOfOrigin"
)
SHOW_DETAIL_FIELDS = (
    "_id name englishName nativeName description thumbnail episodeCount "
    "score type status genres availableEpisodes season altNames "
    "countryOfOrigin tags studios airedStart airedEnd"
)
EP_FIELDS = (
    "_id episodeIdNum notes thumbnails "
    "vidInforssub vidInforsdub vidInforsraw"
)

# ── HTTP client ────────────────────────────────────────────────────────────────
_client: Optional[httpx.AsyncClient] = None

async def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=20.0, follow_redirects=True)
    return _client

# ── GraphQL helper ─────────────────────────────────────────────────────────────
async def gql(query: str, cookie: str = "") -> dict:
    client = await get_client()
    headers = dict(GQL_HEADERS)
    if cookie:
        headers["Cookie"] = cookie
    r = await client.post(GQL_URL, json={"query": query}, headers=headers)
    r.raise_for_status()
    return r.json()

# ── Query builders (plain concatenation — no f-strings with GraphQL fields) ────
def q_shows(sort: str, limit: int, page: int,
            trans: str = "", country: str = "", anime_type: str = "",
            search_query: str = "") -> str:
    search_parts = ["sortBy:" + sort]
    if search_query:
        search_parts.append('query:"' + search_query + '"')
    if anime_type:
        search_parts.append("type:" + anime_type)
    args = "search:{" + ",".join(search_parts) + "},limit:" + str(limit) + ",page:" + str(page)
    if trans:
        args += ",translationType:" + trans
    if country:
        args += ",countryOrigin:" + country
    return "{shows(" + args + "){edges{" + SHOW_FIELDS + "}}}"

def q_show(show_id: str) -> str:
    return '{show(_id:"' + show_id + '"){' + SHOW_DETAIL_FIELDS + "}}"

def q_episodes(show_id: str, ep_start: float, ep_end: float) -> str:
    return (
        "{episodeInfos(showId:\""
        + show_id
        + "\",episodeNumStart:"
        + str(ep_start)
        + ",episodeNumEnd:"
        + str(ep_end)
        + "){" + EP_FIELDS + "}}"
    )

def q_episode_sources(show_id: str, ep: str, trans: str) -> str:
    return (
        "{episode(showId:\""
        + show_id
        + "\",translationType:"
        + trans
        + ",episodeString:\""
        + ep
        + "\"){episodeString sourceUrls}}"
    )

# ── URL decoder ────────────────────────────────────────────────────────────────
def decode_url(raw: str) -> str:
    if not raw:
        return raw
    if raw.startswith("--"):
        try:
            return bytes(b ^ 56 for b in bytes.fromhex(raw[2:])).decode()
        except Exception:
            pass
    if raw.startswith("ap/"):
        try:
            return bytes.fromhex(raw[3:]).decode()
        except Exception:
            pass
    return raw

def cdn_url(path: str) -> str:
    if not path:
        return ""
    return path if path.startswith("http") else CDN_BASE.rstrip("/") + "/" + path.lstrip("/")

def build_streams(ep: dict) -> list:
    out = []
    for trans, field in [("sub", "vidInforssub"), ("dub", "vidInforsdub"), ("raw", "vidInforsraw")]:
        info = ep.get(field)
        if not info or not info.get("vidPath"):
            continue
        out.append({
            "server": "allanime-cdn",
            "translationType": trans,
            "url": cdn_url(info["vidPath"]),
            "rawPath": info["vidPath"],
            "quality": str(info.get("vidResolution", "")) + "p",
            "sizeMB": round((info.get("vidSize") or 0) / 1048576, 1),
            "durationSec": info.get("vidDuration"),
            "type": "mp4",
            "headers": {"Referer": CDN_BASE + "/", "Origin": CDN_BASE},
        })
    return out

# ── Stream extractors ──────────────────────────────────────────────────────────
async def _get(url: str, referer: str = SITE_URL) -> httpx.Response:
    c = await get_client()
    return await c.get(url, headers={
        "User-Agent": GQL_HEADERS["User-Agent"],
        "Referer": referer,
        "Accept": "*/*",
    })

async def extract_gogoanime(url: str) -> list:
    try:
        from Crypto.Cipher import AES
        from Crypto.Util.Padding import unpad

        def aes_dec(data: str, key: bytes, iv: bytes) -> str:
            return unpad(AES.new(key, AES.MODE_CBC, iv).decrypt(base64.b64decode(data)), 16).decode()

        r = await _get(url)
        html = r.text
        key_m = re.search(r'(?:data-value|encryption-key|keys)["\s:=\']+([a-fA-F0-9]{32})', html)
        iv_m  = re.search(r'(?:data-iv|iv)["\s:=\']+([a-fA-F0-9]{32})', html)
        enc_m = re.search(r'data-value=["\']([^"\']+)["\']', html)
        if key_m and iv_m and enc_m:
            dec = aes_dec(enc_m.group(1), key_m.group(1).encode(), iv_m.group(1).encode())
            data = json.loads(dec)
            return [{"server": "gogoanime", "url": s["file"],
                     "quality": s.get("label", "auto"),
                     "type": "hls" if "m3u8" in s["file"] else "mp4"}
                    for s in data.get("source", [])]
        # fallback — scan for raw sources
        sources = re.findall(r'"file"\s*:\s*"(https?://[^"]+\.(?:m3u8|mp4)[^"]*)"', html)
        return [{"server": "gogoanime", "url": s,
                 "type": "hls" if "m3u8" in s else "mp4"} for s in sources]
    except Exception as e:
        return [{"server": "gogoanime", "url": url, "error": str(e)}]

async def extract_streamsb(url: str) -> list:
    try:
        sid_m = re.search(r"/(?:e|v|embed|d)/([^/?#]+)", url)
        if not sid_m:
            return [{"server": "streamsb", "url": url, "error": "no ID found"}]
        sid = sid_m.group(1)
        hosts = ["streamsb.net", "sbplay.org", "sbfast.com", "sbfull.com",
                 "sbplay2.xyz", "sblongvu.com", "sbchill.com"]
        for host in hosts:
            try:
                api = "https://" + host + "/api/source/" + sid
                r = await _get(api, referer=url)
                data = r.json()
                if data.get("data"):
                    return [{"server": "streamsb", "url": s.get("file", ""),
                             "quality": s.get("label", "auto"),
                             "type": "hls" if "m3u8" in s.get("file", "") else "mp4"}
                            for s in data["data"]]
            except Exception:
                continue
        return [{"server": "streamsb", "url": url, "error": "all hosts failed"}]
    except Exception as e:
        return [{"server": "streamsb", "url": url, "error": str(e)}]

async def extract_doodstream(url: str) -> list:
    try:
        page_url = re.sub(r"/d/", "/e/", url)
        r = await _get(page_url, referer="https://dood.wf/")
        html = r.text
        pm = re.search(r"pass_md5/([^'\"]+)", html)
        if not pm:
            return [{"server": "doodstream", "url": url, "error": "pass_md5 not found"}]
        raw_r = await _get("https://dood.wf/pass_md5/" + pm.group(1), referer=page_url)
        raw = raw_r.text.strip()
        token = re.search(r"token=([^&'\"]+)", html)
        tok = token.group(1) if token else "abc123"
        stream = raw + "?token=" + tok + "&expiry=9999999999999"
        return [{"server": "doodstream", "url": stream, "quality": "auto", "type": "mp4"}]
    except Exception as e:
        return [{"server": "doodstream", "url": url, "error": str(e)}]

async def extract_streamtape(url: str) -> list:
    try:
        r = await _get(url)
        html = r.text
        m = re.search(r"(streamtape\.(?:com|net|to)/get_video[^'\"<\s]+)", html)
        if not m:
            m = re.search(r"getElementById\('ideoooolink'\)\.innerHTML\s*=\s*\"([^\"]+)\"", html)
        if not m:
            return [{"server": "streamtape", "url": url, "error": "stream URL not found"}]
        stream = "https://" + m.group(1).lstrip("/") if not m.group(1).startswith("http") else m.group(1)
        return [{"server": "streamtape", "url": stream, "quality": "auto", "type": "mp4"}]
    except Exception as e:
        return [{"server": "streamtape", "url": url, "error": str(e)}]

async def extract_mp4upload(url: str) -> list:
    try:
        r = await _get(url)
        html = r.text
        m = re.search(r'"file"\s*:\s*"(https?://[^"]+\.mp4[^"]*)"', html)
        if not m:
            m = re.search(r"src:\s*\"(https?://[^\"]+\.mp4[^\"]*)\"|player\.src\(['\"]([^'\"]+\.mp4[^'\"]*)", html)
        if not m:
            return [{"server": "mp4upload", "url": url, "error": "no mp4 found"}]
        return [{"server": "mp4upload", "url": m.group(1) or m.group(2), "quality": "auto", "type": "mp4"}]
    except Exception as e:
        return [{"server": "mp4upload", "url": url, "error": str(e)}]

async def extract_filemoon(url: str) -> list:
    try:
        r = await _get(url)
        html = r.text
        sources = re.findall(r'"file"\s*:\s*"(https?://[^"]+\.m3u8[^"]*)"', html)
        if not sources:
            sources = re.findall(r"(https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*)", html)
        if not sources:
            sources = re.findall(r'"file"\s*:\s*"(https?://[^"]+)"', html)
        return [{"server": "filemoon", "url": s,
                 "type": "hls" if "m3u8" in s else "mp4"} for s in sources] \
               or [{"server": "filemoon", "url": url, "error": "no sources"}]
    except Exception as e:
        return [{"server": "filemoon", "url": url, "error": str(e)}]

async def extract_mycloud(url: str) -> list:
    try:
        r = await _get(url)
        html = r.text
        sources = re.findall(r'"file"\s*:\s*"(https?://[^"]+\.m3u8[^"]*)"', html)
        if not sources:
            sources = re.findall(r"(https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*)", html)
        return [{"server": "mycloud", "url": s, "type": "hls"} for s in sources] \
               or [{"server": "mycloud", "url": url, "error": "no hls found"}]
    except Exception as e:
        return [{"server": "mycloud", "url": url, "error": str(e)}]

async def extract_generic(url: str, name: str = "unknown") -> list:
    try:
        r = await _get(url)
        html = r.text
        m3u8 = re.findall(r"(https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*)", html)
        mp4  = re.findall(r"(https?://[^\s\"'<>]+\.mp4[^\s\"'<>]*)", html)
        out  = [{"server": name, "url": u, "type": "hls"} for u in m3u8]
        out += [{"server": name, "url": u, "type": "mp4"} for u in mp4]
        return out or [{"server": name, "url": url, "note": "no direct video found in page"}]
    except Exception as e:
        return [{"server": name, "url": url, "error": str(e)}]

_EXTRACTORS = {
    "gogoanime":    extract_gogoanime,
    "gogoplay":     extract_gogoanime,
    "vidstreaming": extract_gogoanime,
    "streamsb":     extract_streamsb,
    "sbplay":       extract_streamsb,
    "doodstream":   extract_doodstream,
    "dood":         extract_doodstream,
    "streamtape":   extract_streamtape,
    "mp4upload":    extract_mp4upload,
    "filemoon":     extract_filemoon,
    "moonplayer":   extract_filemoon,
    "mycloud":      extract_mycloud,
    "vizcloud":     extract_mycloud,
}

async def extract_stream(url: str, server_hint: str = "") -> list:
    key = (server_hint + url).lower().replace("-", "").replace("_", "").replace(" ", "")
    for k, fn in _EXTRACTORS.items():
        if k in key:
            return await fn(url)
    return await extract_generic(url, server_hint or "unknown")

# ── App setup ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()

app = FastAPI(title="AllAnime API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def docs():
    return HTML_DOCS

@app.get("/anime/home")
async def home(
    translationType: str = Query("sub"),
    countryOrigin:   str = Query("JP"),
    page:            int = Query(1, ge=1),
):
    if translationType not in VALID_TRANS:
        translationType = "sub"
    recent, trending = await asyncio.gather(
        gql(q_shows("Latest_Update", 26, page, translationType, countryOrigin)),
        gql(q_shows("Trending",      26, page, translationType, countryOrigin)),
    )
    return {
        "recent":   (recent.get("data") or {}).get("shows", {}).get("edges", []),
        "trending": (trending.get("data") or {}).get("shows", {}).get("edges", []),
        "page": page,
    }

@app.get("/anime/search")
async def search(
    q:               str           = Query(...),
    page:            int           = Query(1, ge=1),
    limit:           int           = Query(26, ge=1, le=100),
    translationType: Optional[str] = Query(None),
    countryOrigin:   Optional[str] = Query(None),
    type:            Optional[str] = Query(None),
    sortBy:          str           = Query("Latest_Update"),
):
    if sortBy not in VALID_SORTS:
        sortBy = "Latest_Update"
    trans   = translationType if translationType in VALID_TRANS else ""
    country = countryOrigin or ""
    d = await gql(q_shows(sortBy, limit, page, trans, country, type or "", q))
    edges = (d.get("data") or {}).get("shows", {}).get("edges", [])
    return {"results": edges, "page": page, "limit": limit, "hasNextPage": len(edges) == limit}

@app.get("/anime/info/{show_id}")
async def info(show_id: str = Path(...)):
    d    = await gql(q_show(show_id))
    show = (d.get("data") or {}).get("show")
    if not show:
        return JSONResponse(status_code=404, content={"error": "Anime not found"})
    return show

@app.get("/anime/episodes/{show_id}")
async def episodes(
    show_id:        str   = Path(...),
    episodeStart:   float = Query(1.0, ge=0),
    episodeEnd:     float = Query(9999.0),
    includeStreams: bool  = Query(False),
):
    d   = await gql(q_episodes(show_id, episodeStart, episodeEnd))
    eps = (d.get("data") or {}).get("episodeInfos", [])
    eps = sorted(eps, key=lambda e: e.get("episodeIdNum", 0))
    for ep in eps:
        ep["thumbnails"] = [cdn_url(t) if not t.startswith("http") else t
                            for t in (ep.get("thumbnails") or [])]
        if includeStreams:
            ep["streams"] = build_streams(ep)
    return {"showId": show_id, "total": len(eps), "episodes": eps}

@app.get("/anime/sources")
async def sources(
    showId:          str           = Query(...),
    episode:         str           = Query(...),
    translationType: str           = Query("sub"),
    extractStreams:  bool          = Query(False),
    x_cookie:        Optional[str] = Header(None, alias="X-Cookie"),
):
    if translationType not in VALID_TRANS:
        translationType = "sub"
    d = await gql(q_episode_sources(showId, episode, translationType), cookie=x_cookie or "")

    if "errors" in d:
        msg = (d["errors"][0].get("message") or "") if d.get("errors") else ""
        if msg == "NEED_CAPTCHA":
            return JSONResponse(status_code=403, content={
                "error": "CAPTCHA_REQUIRED",
                "message": "Pass your allmanga.to cookies via the X-Cookie request header.",
                "hint": ("Open allmanga.to in your browser → DevTools → Application → Cookies "
                         "→ copy all cookies → paste as the X-Cookie header value."),
                "sourceUrls": [],
            })
        return JSONResponse(status_code=500, content={"error": msg, "sourceUrls": []})

    ep_data     = (d.get("data") or {}).get("episode") or {}
    raw_sources = ep_data.get("sourceUrls") or []
    decoded     = []
    if isinstance(raw_sources, list):
        for s in raw_sources:
            if isinstance(s, dict):
                decoded.append({
                    "sourceName": s.get("sourceName", "Unknown"),
                    "type":       s.get("type", "iframe"),
                    "priority":   s.get("priority", 0),
                    "url":        decode_url(s.get("url", "")),
                    "rawUrl":     s.get("url", ""),
                })
            else:
                decoded.append({"url": decode_url(str(s)), "rawUrl": str(s)})
        decoded.sort(key=lambda x: x.get("priority") or 0, reverse=True)

    if extractStreams and decoded:
        tasks     = [extract_stream(s["url"], s.get("sourceName", "")) for s in decoded]
        extracted = await asyncio.gather(*tasks, return_exceptions=True)
        for i, src in enumerate(decoded):
            src["streams"] = (extracted[i] if not isinstance(extracted[i], Exception)
                              else [{"error": str(extracted[i])}])

    return {
        "showId":          showId,
        "episode":         episode,
        "translationType": translationType,
        "episodeString":   ep_data.get("episodeString", episode),
        "sourceUrls":      decoded,
    }

@app.get("/anime/stream")
async def stream(
    url:    str = Query(..., description="Embed page URL to extract streams from"),
    server: str = Query("", description="Server hint: gogoanime · streamsb · doodstream · streamtape · mp4upload · filemoon · mycloud"),
):
    results = await extract_stream(url, server)
    return {"url": url, "server": server or "auto", "streams": results}

# ── Global error handler ───────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_error(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})

# ── HTML docs ──────────────────────────────────────────────────────────────────
HTML_DOCS = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AllAnime API</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#08091a;--card:#0f1128;--border:#1b1d3a;--accent:#7c5cbf;--blue:#5b8af5;--green:#3ecf8e;--red:#f87171;--text:#dde0f5;--muted:#6b6e9a;--tag:#141630;--code:#a5f3fc}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;line-height:1.6}
header{background:linear-gradient(135deg,#0a0a25,#160d3a,#0b1530);border-bottom:1px solid var(--border);padding:52px 24px 40px;text-align:center}
h1{font-size:2.6rem;font-weight:900;letter-spacing:-1px;background:linear-gradient(90deg,#a78bfa,#60a5fa,#34d399);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
header p{color:var(--muted);margin-top:10px;font-size:1rem}
.badges{display:flex;justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap}
.badge{background:var(--tag);border:1px solid var(--border);border-radius:20px;padding:4px 14px;font-size:.75rem;color:var(--muted)}
.badge.live{border-color:var(--green);color:var(--green)}
main{max-width:980px;margin:0 auto;padding:44px 24px 80px}
.sec{font-size:.68rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:44px 0 14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;margin-bottom:14px;overflow:hidden;transition:border-color .2s}
.card:hover{border-color:var(--accent)}
.ch{display:flex;align-items:flex-start;gap:12px;padding:20px 22px 12px;flex-wrap:wrap}
.method{background:var(--blue);color:#fff;font-size:.68rem;font-weight:800;padding:3px 10px;border-radius:5px;letter-spacing:.06em;margin-top:3px;flex-shrink:0}
.path{font-family:Consolas,monospace;font-size:.98rem;font-weight:700;color:#c4b5fd;flex:1;word-break:break-all}
.desc{color:var(--muted);font-size:.86rem;padding:0 22px 14px;line-height:1.55}
.desc code,.desc strong{color:var(--text)}
table{width:calc(100% - 44px);margin:0 22px 14px;border-collapse:collapse;font-size:.8rem}
th{text-align:left;color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.09em;padding:5px 8px;border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid #12142a}
tr:last-child td{border:none}
.pn{font-family:monospace;color:var(--code)}
.req{color:var(--red);font-size:.68rem}
.opt{color:var(--muted);font-size:.68rem}
.ex{background:#060818;border-top:1px solid var(--border);padding:12px 22px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.eu{font-family:monospace;font-size:.78rem;color:#86efac;flex:1;word-break:break-all}
.btn{background:linear-gradient(135deg,var(--accent),var(--blue));color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:.78rem;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn.sm{padding:5px 12px;font-size:.74rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:10px;margin-top:6px}
.chip{background:var(--tag);border:1px solid var(--border);border-radius:9px;padding:10px 14px}
.cn{font-weight:700;color:#c4b5fd;font-size:.84rem}
.ct{font-size:.72rem;color:var(--muted);margin-top:2px}
.info{background:#0a1422;border:1px solid #1a3454;border-radius:10px;padding:16px 20px;font-size:.84rem;color:#94c5f8;line-height:1.75;margin-top:6px}
.info code{background:#060d18;padding:1px 6px;border-radius:4px;font-family:monospace;font-size:.8em}
footer{text-align:center;color:var(--muted);font-size:.78rem;padding:30px 0;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header>
  <h1>&#9889; AllAnime API</h1>
  <p>Unofficial REST API for allmanga.to &mdash; anime info, episodes &amp; all streaming servers</p>
  <div class="badges">
    <span class="badge live">&#9679; Live</span>
    <span class="badge">Python &middot; FastAPI</span>
    <span class="badge">GraphQL scraper</span>
    <span class="badge">10 stream servers</span>
    <span class="badge">CORS enabled</span>
    <span class="badge">AES decryption</span>
  </div>
</header>
<main>

<div class="sec">Endpoints</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/home</span></div>
  <div class="desc">Homepage feed &mdash; returns <strong>recent</strong> (latest updates) and <strong>trending</strong> anime lists. Each item includes title, thumbnail, score, type, season, available episodes and more.</div>
  <table><tr><th>Param</th><th>Default</th><th>Notes</th></tr>
  <tr><td class="pn">translationType <span class="opt">opt</span></td><td>sub</td><td>sub &middot; dub &middot; raw</td></tr>
  <tr><td class="pn">countryOrigin <span class="opt">opt</span></td><td>JP</td><td>JP &middot; CN &middot; KR</td></tr>
  <tr><td class="pn">page <span class="opt">opt</span></td><td>1</td><td>Page number</td></tr>
  </table>
  <div class="ex"><span class="eu">/anime/home?translationType=sub&amp;countryOrigin=JP</span><a class="btn" href="/anime/home?translationType=sub&countryOrigin=JP" target="_blank">Try it &#8599;</a></div>
</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/search</span></div>
  <div class="desc">Search anime by title. Supports sorting, type filtering and translation type.</div>
  <table><tr><th>Param</th><th>Default</th><th>Notes</th></tr>
  <tr><td class="pn">q <span class="req">required</span></td><td>&mdash;</td><td>Search query</td></tr>
  <tr><td class="pn">page <span class="opt">opt</span></td><td>1</td><td></td></tr>
  <tr><td class="pn">limit <span class="opt">opt</span></td><td>26</td><td>Max 100</td></tr>
  <tr><td class="pn">sortBy <span class="opt">opt</span></td><td>Latest_Update</td><td>Latest_Update &middot; Trending &middot; Name_ASC &middot; Name_DESC</td></tr>
  <tr><td class="pn">type <span class="opt">opt</span></td><td>&mdash;</td><td>TV &middot; Movie &middot; OVA &middot; ONA &middot; Special</td></tr>
  <tr><td class="pn">translationType <span class="opt">opt</span></td><td>&mdash;</td><td>sub &middot; dub &middot; raw</td></tr>
  <tr><td class="pn">countryOrigin <span class="opt">opt</span></td><td>&mdash;</td><td>JP &middot; CN &middot; KR</td></tr>
  </table>
  <div class="ex"><span class="eu">/anime/search?q=one+piece&amp;sortBy=Trending&amp;limit=10</span><a class="btn" href="/anime/search?q=one+piece&sortBy=Trending&limit=10" target="_blank">Try it &#8599;</a></div>
</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/info/{show_id}</span></div>
  <div class="desc">Full anime details &mdash; title (English/native/alt), description, genres, tags, studios, score, season, status, sub/dub/raw episode counts and aired dates.</div>
  <table><tr><th>Param</th><th>Notes</th></tr>
  <tr><td class="pn">show_id <span class="req">required</span></td><td>AllAnime ID from search results (e.g. <code>ReooPAxPMsHM4KPMY</code>)</td></tr>
  </table>
  <div class="ex">
    <span class="eu">/anime/info/ReooPAxPMsHM4KPMY</span>
    <a class="btn" href="/anime/info/ReooPAxPMsHM4KPMY" target="_blank">Try it (One Piece) &#8599;</a>
  </div>
</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/episodes/{show_id}</span></div>
  <div class="desc">Episode list with thumbnails, titles, and direct AllAnime CDN stream paths for sub/dub/raw. Set <code>includeStreams=true</code> to get full CDN URLs with resolution, file size and duration &mdash; <strong>no captcha needed</strong>.</div>
  <table><tr><th>Param</th><th>Default</th><th>Notes</th></tr>
  <tr><td class="pn">show_id <span class="req">required</span></td><td>&mdash;</td><td>AllAnime show ID</td></tr>
  <tr><td class="pn">episodeStart <span class="opt">opt</span></td><td>1</td><td>Starting episode number</td></tr>
  <tr><td class="pn">episodeEnd <span class="opt">opt</span></td><td>9999</td><td>Ending episode number</td></tr>
  <tr><td class="pn">includeStreams <span class="opt">opt</span></td><td>false</td><td>Include AllAnime CDN direct stream URLs</td></tr>
  </table>
  <div class="ex">
    <span class="eu">/anime/episodes/ReooPAxPMsHM4KPMY?episodeStart=1&amp;episodeEnd=5&amp;includeStreams=true</span>
    <a class="btn" href="/anime/episodes/ReooPAxPMsHM4KPMY?episodeStart=1&episodeEnd=5&includeStreams=true" target="_blank">Try it &#8599;</a>
    <a class="btn sm" href="/anime/episodes/jbJnkcKSzYjwd3NGY?includeStreams=true" target="_blank">Try another &#8599;</a>
  </div>
</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/sources</span></div>
  <div class="desc">All embed server URLs for an episode, fully decoded from AllAnime&rsquo;s XOR encoding. Set <code>extractStreams=true</code> to also extract actual m3u8/mp4 video URLs from each embed.<br><br>
  <strong style="color:#fca5a5">&#9888; Requires cookies:</strong> AllAnime uses captcha protection on this endpoint. Pass your <code>allmanga.to</code> browser cookies via the <code>X-Cookie</code> header.</div>
  <table><tr><th>Param</th><th>Default</th><th>Notes</th></tr>
  <tr><td class="pn">showId <span class="req">required</span></td><td>&mdash;</td><td>AllAnime show ID</td></tr>
  <tr><td class="pn">episode <span class="req">required</span></td><td>&mdash;</td><td>Episode number string e.g. <code>"1"</code></td></tr>
  <tr><td class="pn">translationType <span class="opt">opt</span></td><td>sub</td><td>sub &middot; dub &middot; raw</td></tr>
  <tr><td class="pn">extractStreams <span class="opt">opt</span></td><td>false</td><td>Extract actual video from each embed server</td></tr>
  <tr><td class="pn">X-Cookie <span class="opt">header</span></td><td>&mdash;</td><td>Your allmanga.to browser cookies (bypasses captcha)</td></tr>
  </table>
  <div class="ex"><span class="eu">/anime/sources?showId=ReooPAxPMsHM4KPMY&amp;episode=1&amp;translationType=sub&amp;extractStreams=true</span><a class="btn" href="/anime/sources?showId=ReooPAxPMsHM4KPMY&episode=1&translationType=sub" target="_blank">Try it &#8599;</a></div>
</div>

<div class="card">
  <div class="ch"><span class="method">GET</span><span class="path">/anime/stream</span></div>
  <div class="desc">Extract actual playable video URLs (m3u8 / mp4) from any embed page URL. Handles per-server extraction: AES decryption for GogoAnime, token extraction for Doodstream, JS parsing for Streamtape, and generic m3u8/mp4 scanning for others.</div>
  <table><tr><th>Param</th><th>Notes</th></tr>
  <tr><td class="pn">url <span class="req">required</span></td><td>Full embed URL to extract streams from</td></tr>
  <tr><td class="pn">server <span class="opt">opt</span></td><td>Hint: gogoanime &middot; streamsb &middot; doodstream &middot; streamtape &middot; mp4upload &middot; filemoon &middot; mycloud</td></tr>
  </table>
  <div class="ex"><span class="eu">/anime/stream?url=https://dood.wf/e/XXXXX&amp;server=doodstream</span><a class="btn" href="/docs#/default/stream_anime_stream_get" target="_blank">Open in Swagger &#8599;</a></div>
</div>

<div class="sec">Supported Stream Servers</div>
<div class="grid">
  <div class="chip"><div class="cn">AllAnime CDN</div><div class="ct">Direct MP4 &mdash; no captcha</div></div>
  <div class="chip"><div class="cn">GogoAnime</div><div class="ct">AES-256-CBC decrypt</div></div>
  <div class="chip"><div class="cn">VidStreaming</div><div class="ct">AES-256-CBC decrypt</div></div>
  <div class="chip"><div class="cn">StreamSB</div><div class="ct">Multi-host API extract</div></div>
  <div class="chip"><div class="cn">Doodstream</div><div class="ct">pass_md5 token extract</div></div>
  <div class="chip"><div class="cn">Streamtape</div><div class="ct">JS link parse</div></div>
  <div class="chip"><div class="cn">Mp4Upload</div><div class="ct">Source URL scan</div></div>
  <div class="chip"><div class="cn">Filemoon</div><div class="ct">Packed JS + m3u8 scan</div></div>
  <div class="chip"><div class="cn">MyCloud</div><div class="ct">HLS m3u8 extract</div></div>
  <div class="chip"><div class="cn">VizCloud</div><div class="ct">HLS m3u8 extract</div></div>
</div>

<div class="sec">How to get streams (step by step)</div>
<div class="info">
<strong>Option A &mdash; AllAnime CDN (works without any cookies):</strong><br>
1. <code>GET /anime/episodes/{showId}?includeStreams=true</code><br>
2. Each episode has a <code>streams</code> array with direct <code>.mp4</code> URLs for sub / dub / raw.<br>
3. Play the <code>url</code> with headers: <code>Referer: https://allanimenews.com/</code> and <code>Origin: https://allanimenews.com</code><br><br>
<strong>Option B &mdash; All embed servers (requires browser cookies):</strong><br>
1. Open <code>allmanga.to</code> in your browser and pass any Cloudflare challenge.<br>
2. DevTools &rarr; Application &rarr; Cookies &rarr; copy all cookie values.<br>
3. <code>GET /anime/sources?showId=ID&amp;episode=1&amp;extractStreams=true</code> with header <code>X-Cookie: &lt;your cookies&gt;</code><br>
4. Response includes decoded embed URLs + extracted m3u8 / mp4 per server, sorted by priority.
</div>

<div class="sec">Interactive API docs</div>
<div class="ex" style="border:1px solid var(--border);border-radius:12px;background:var(--card)">
  <span class="eu">Full Swagger UI with live testing for every endpoint</span>
  <a class="btn" href="/docs" target="_blank">Swagger UI &#8599;</a>
  <a class="btn" href="/redoc" target="_blank">ReDoc &#8599;</a>
</div>

</main>
<footer>AllAnime API &mdash; for personal &amp; educational use only</footer>
</body>
</html>"""

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
