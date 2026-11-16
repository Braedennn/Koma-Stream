"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cacheDel = cacheDel;
exports.cacheStats = cacheStats;
const node_cache_1 = __importDefault(require("node-cache"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const cache = new node_cache_1.default({ useClones: false });
const TTL = {
    mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'), // 24h
    episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'), // 1h
    stream: parseInt(process.env.CACHE_TTL_STREAM || '300'), // 5min
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
const DATA_DIR = process.env.KOMA_DATA_DIR || node_path_1.default.join(process.cwd(), '.data');
const FILE = node_path_1.default.join(DATA_DIR, 'anivault-mapping.json');
const persisted = new Map();
function loadPersisted() {
    try {
        const raw = JSON.parse((0, node_fs_1.readFileSync)(FILE, 'utf8'));
        const now = Date.now();
        for (const [key, entry] of Object.entries(raw || {})) {
            if (!entry || typeof entry.at !== 'number' || now - entry.at >= TTL.mapping * 1000)
                continue;
            persisted.set(key, entry);
            cache.set(key, entry.data, TTL.mapping);
        }
    }
    catch { /* no file yet, or a corrupt one: start clean */ }
}
loadPersisted();
let saveTimer = null;
function saveNow() {
    saveTimer = null;
    try {
        (0, node_fs_1.mkdirSync)(DATA_DIR, { recursive: true });
        const out = {};
        const now = Date.now();
        for (const [key, entry] of persisted) {
            if (now - entry.at < TTL.mapping * 1000)
                out[key] = entry;
        }
        (0, node_fs_1.writeFileSync)(FILE, JSON.stringify(out));
    }
    catch { /* a full disk is not worth stopping the server over */ }
}
function scheduleSave() {
    if (saveTimer)
        return;
    saveTimer = setTimeout(saveNow, 2000);
    saveTimer.unref?.();
}
process.on('exit', () => { if (saveTimer)
    saveNow(); });
function cacheGet(key) {
    return cache.get(key) ?? null;
}
function cacheSet(key, data, type = 'mapping') {
    cache.set(key, data, TTL[type]);
    if (type === 'mapping') {
        persisted.set(key, { at: Date.now(), data });
        scheduleSave();
    }
}
function cacheDel(key) {
    cache.del(key);
    persisted.delete(key);
}
function cacheStats() {
    return cache.getStats();
}
//# sourceMappingURL=cache.js.map