import NodeCache from 'node-cache';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const cache = new NodeCache({ useClones: false });

const TTL = {
  mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'),   // 24h
  episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'),  // 1h
  stream: parseInt(process.env.CACHE_TTL_STREAM || '300'),       // 5min
};

/* ---------- the mapping, kept on disk ----------
 *
 * Which entry of which site holds a show is the slowest thing this server
 * does: it asks AniList, Anify and the sites themselves, and those searches
 * take seconds. It used to be remembered in memory only, so every restart
 * paid for it again — and the desktop app starts its own servers every time
 * it is launched, which made the first show of every session take ten
 * seconds instead of one. The mapping is written to disk as well, so a
 * restart costs a file read instead of a search.
 *
 * Only the mapping is kept: the episode lists are cheap to rebuild, and a
 * stream link is signed and short-lived, so neither belongs on disk.
 */
const DATA_DIR = process.env.KOMA_DATA_DIR || path.join(process.cwd(), '.data');
const FILE = path.join(DATA_DIR, 'anivault-mapping.json');
const persisted = new Map<string, { at: number; data: any }>();

function loadPersisted() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, { at: number; data: any }>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw || {})) {
      if (!entry || typeof entry.at !== 'number' || now - entry.at >= TTL.mapping * 1000) continue;
      persisted.set(key, entry);
      cache.set(key, entry.data, TTL.mapping);
    }
  } catch { /* no file yet, or a corrupt one: start clean */ }
}
loadPersisted();

let saveTimer: NodeJS.Timeout | null = null;
function saveNow() {
  saveTimer = null;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const out: Record<string, { at: number; data: any }> = {};
    const now = Date.now();
    for (const [key, entry] of persisted) {
      if (now - entry.at < TTL.mapping * 1000) out[key] = entry;
    }
    writeFileSync(FILE, JSON.stringify(out));
  } catch { /* a full disk is not worth stopping the server over */ }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 2000);
  saveTimer.unref?.();
}
process.on('exit', () => { if (saveTimer) saveNow(); });

export function cacheGet<T>(key: string): T | null {
  return cache.get<T>(key) ?? null;
}

export function cacheSet(key: string, data: any, type: keyof typeof TTL = 'mapping') {
  cache.set(key, data, TTL[type]);
  if (type === 'mapping') {
    persisted.set(key, { at: Date.now(), data });
    scheduleSave();
  }
}

export function cacheDel(key: string) {
  cache.del(key);
  persisted.delete(key);
}

export function cacheStats() {
  return cache.getStats();
}
