"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const crypto_1 = require("crypto");
const routes_1 = __importDefault(require("./routes"));
const discord_relay_1 = __importDefault(require("./discord-relay"));
const image_migrator_1 = __importDefault(require("./image-migrator"));
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3000');
app.set('trust proxy', 1);
const rawOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
const allowAllOrigins = rawOrigins === '*';
const allowedOrigins = new Set((rawOrigins && !allowAllOrigins
    ? rawOrigins
    : 'https://www.anivault.co,https://beta.anivault.co')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean));
const isOriginAllowed = (origin) => allowAllOrigins || (!!origin && allowedOrigins.has(origin));
app.use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin || isOriginAllowed(origin))
            return callback(null, true);
        return callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'x-anivault-api-key'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));
app.use(express_1.default.json());
// Private server-to-server authentication for scraper API endpoints.
// Browser media proxy routes are limited to the two AniVault site origins.
app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && !isOriginAllowed(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    if (!req.path.startsWith('/api/'))
        return next();
    const expected = process.env.ANIVAULT_API_KEY || '';
    const supplied = req.get('x-anivault-api-key') || '';
    let authenticated = false;
    if (expected && supplied) {
        const a = Buffer.from(expected);
        const b = Buffer.from(supplied);
        authenticated = a.length === b.length && (0, crypto_1.timingSafeEqual)(a, b);
    }
    if (authenticated)
        return next();
    const browserProxy = /^\/api\/proxy\/(?:hls|video|subtitle)$/.test(req.path)
        && !!origin && isOriginAllowed(origin);
    if (browserProxy)
        return next();
    return res.status(403).json({ error: 'Forbidden' });
});
// Rate limiting
const limiter = (0, express_rate_limit_1.default)({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
    max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);
// API routes
app.use('/api', routes_1.default);
// Discord webhook relay (PHP → Railway → Vercel bot → Discord)
app.use('/discord', discord_relay_1.default);
// One-off InfinityFree → R2 image migration tool (FTP-based). Delete this
// line + src/image-migrator.ts once the migration is done.
app.use('/migrate-images', image_migrator_1.default);
// Never expose the API docs/tester at the public service root.
app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
});
// The desktop app asks for the loopback: the streaming API is private to this
// machine, and a server on every interface makes Windows ask for firewall
// permission - and puts the API on the network - for nothing. A hosted
// deployment sets no HOST and keeps listening the way it always has.
const HOST = (process.env.HOST || '').trim();
const onReady = () => {
    console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
    console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
    console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);
    // Keep FlareSolverr alive on Render free tier (sleeps after 15min inactivity)
    const flaresolverrUrl = process.env.FLARESOLVERR_URL;
    if (flaresolverrUrl) {
        const ping = () => {
            fetch(flaresolverrUrl)
                .then(() => console.log('[pinger] FlareSolverr alive ✅'))
                .catch((e) => console.warn('[pinger] FlareSolverr ping failed:', e.message));
        };
        ping(); // ping immediately on startup
        setInterval(ping, 9 * 60 * 1000); // then every 9 minutes
        console.log(`🏓 FlareSolverr pinger active → ${flaresolverrUrl}`);
    }
};
if (HOST)
    app.listen(PORT, HOST, onReady);
else
    app.listen(PORT, onReady);
exports.default = app;
//# sourceMappingURL=server.js.map