import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'crypto';
import routes from './routes';
import discordRelay from './discord-relay';
import imageMigrator from './image-migrator';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.set('trust proxy', 1);

const rawOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
const allowAllOrigins = rawOrigins === '*';
const allowedOrigins = new Set(
  (rawOrigins && !allowAllOrigins
    ? rawOrigins
    : 'https://www.anivault.co,https://beta.anivault.co')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const isOriginAllowed = (origin?: string) =>
  allowAllOrigins || (!!origin && allowedOrigins.has(origin));

app.use(cors({
  origin(origin, callback) {
    if (!origin || isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'x-anivault-api-key'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}));
app.use(express.json());

// Private server-to-server authentication for scraper API endpoints.
// Browser media proxy routes are limited to the two AniVault site origins.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (!req.path.startsWith('/api/')) return next();

  const expected = process.env.ANIVAULT_API_KEY || '';
  const supplied = req.get('x-anivault-api-key') || '';
  let authenticated = false;
  if (expected && supplied) {
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    authenticated = a.length === b.length && timingSafeEqual(a, b);
  }
  if (authenticated) return next();

  const browserProxy = /^\/api\/proxy\/(?:hls|video|subtitle)$/.test(req.path)
    && !!origin && isOriginAllowed(origin);
  if (browserProxy) return next();

  return res.status(403).json({ error: 'Forbidden' });
});

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);

// API routes
app.use('/api', routes);

// Discord webhook relay (PHP → Railway → Vercel bot → Discord)
app.use('/discord', discordRelay);

// One-off InfinityFree → R2 image migration tool (FTP-based). Delete this
// line + src/image-migrator.ts once the migration is done.
app.use('/migrate-images', imageMigrator);

// Never expose the API docs/tester at the public service root.
app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, () => {
  console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
  console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
  console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);

  // Keep FlareSolverr alive on Render free tier (sleeps after 15min inactivity)
  const flaresolverrUrl = process.env.FLARESOLVERR_URL;
  if (flaresolverrUrl) {
    const ping = () => {
      fetch(flaresolverrUrl)
        .then(() => console.log('[pinger] FlareSolverr alive ✅'))
        .catch((e: any) => console.warn('[pinger] FlareSolverr ping failed:', e.message));
    };
    ping(); // ping immediately on startup
    setInterval(ping, 9 * 60 * 1000); // then every 9 minutes
    console.log(`🏓 FlareSolverr pinger active → ${flaresolverrUrl}`);
  }
});

export default app;
