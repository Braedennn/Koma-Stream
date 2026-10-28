// Pure stats engine for the Stats page: consumes the episode-completion journal that
// store.js records (every `onEnded` becomes one event) and produces everything the
// page shows — headline numbers, day histogram, genre spread, and badge unlocks
// replayed in historical order. No DOM, no network: it's testable as a function.
//
// `meta` maps anime id → { genres, format } (the view hydrates it lazily from AniList).
// `dayOf`/`now` are injectable so tests pin the calendar without TZ gymnastics.

/** Local calendar key (YYYYMMDD as a number). DST-safe — it never touches UTC. */
const dayOf = at => {
  const d = new Date(at);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
const shiftDay = (key, by) => {
  const y = key / 10000 | 0, m = (key / 100 | 0) % 100, d = key % 100;
  const nd = new Date(y, m - 1, d + by);
  return nd.getFullYear() * 10000 + (nd.getMonth() + 1) * 100 + nd.getDate();
};

export const BADGES = [
  { id: 'first', icon: 'play', name: 'First Step', hint: 'Finish your first episode', kind: 'eps', target: 1 },
  { id: 'habit', icon: 'spark', name: 'Solid Habit', hint: 'Finish 25 episodes', kind: 'eps', target: 25 },
  { id: 'century', icon: 'trophy', name: 'Century Club', hint: 'Finish 100 episodes', kind: 'eps', target: 100 },
  { id: 'warm', icon: 'fire', name: 'On Fire', hint: 'Watch on 3 days in a row', kind: 'streak', target: 3 },
  { id: 'week', icon: 'fire', name: 'Week Strong', hint: 'Watch on 7 days in a row', kind: 'streak', target: 7 },
  { id: 'fortnight', icon: 'fire', name: 'Fortnight Flame', hint: 'Watch on 14 days in a row', kind: 'streak', target: 14 },
  { id: 'marathon', icon: 'clock', name: 'Marathon', hint: '5 episodes in one day', kind: 'day', target: 5 },
  { id: 'blur', icon: 'skip', name: 'Blur Vision', hint: '10 episodes in one day', kind: 'day', target: 10 },
  { id: 'owl', icon: 'tv', name: 'Night Owl', hint: '5 episodes between midnight and 5', kind: 'night', target: 5 },
  { id: 'bird', icon: 'reload', name: 'Early Bird', hint: '5 episodes before breakfast (5–8 am)', kind: 'morning', target: 5 },
  { id: 'genres', icon: 'grid', name: 'Genre Explorer', hint: 'Watch 8 different genres', kind: 'genres', target: 8 },
  { id: 'dub', icon: 'mic', name: 'Dub Believer', hint: 'Finish 10 dubbed episodes', kind: 'dub', target: 10 },
  { id: 'film', icon: 'film', name: 'Film Buff', hint: 'Finish 5 movies', kind: 'movies', target: 5 },
];

/** The whole page in one object. `events` = the journal, any order (it sorts). */
export function computeStats(events = [], meta = {}, { dayOf: onDay = dayOf, now = Date.now() } = {}) {
  const evs = [...events]
    .filter(e => e && Number.isInteger(e.ep) && Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);

  const opened = new Map(); // badge id -> the moment its threshold was crossed
  const unlock = (id, at) => { if (!opened.has(id)) opened.set(id, at); };
  const cross = kind => value => at => {
    for (const b of BADGES) if (b.kind === kind && value >= b.target) unlock(b.id, at);
  };

  const counters = { eps: 0, dub: 0, movies: 0, night: 0, morning: 0 };
  let hours = 0;
  const perDay = new Map();     // day key -> { count, firstAt }
  const genres = new Map();     // genre -> distinct-watched count of episodes in it
  const ids = new Set();
  let distinctGenres = 0;

  for (const e of evs) {
    counters.eps++;
    if (e.type === 'dub') counters.dub++;
    // dur rides in seconds (video.duration at journal time); anything past 24 h is
    // bogus data and counts nothing toward watch time.
    if (Number.isFinite(e.dur) && e.dur > 0 && e.dur < 86400) hours += e.dur * 1000;
    ids.add(e.id);
    const m = meta[e.id] || {};
    if (m.format === 'MOVIE') counters.movies++;
    const hr = new Date(e.at).getHours();
    if (hr < 5) counters.night++;
    else if (hr < 8) counters.morning++;
    const g = m.genres || [];
    if (g.length) {
      for (const it of g) genres.set(it, (genres.get(it) || 0) + 1);
      distinctGenres = Math.max(distinctGenres, genres.size);
    }
    const key = onDay(e.at);
    const d = perDay.get(key) || { count: 0, firstAt: e.at, lastAt: e.at };
    d.count++;
    d.lastAt = e.at;
    perDay.set(key, d);
    cross('eps')(counters.eps)(e.at);
    cross('dub')(counters.dub)(e.at);
    cross('movies')(counters.movies)(e.at);
    cross('night')(counters.night)(e.at);
    cross('morning')(counters.morning)(e.at);
    cross('genres')(distinctGenres)(e.at);
  }

  // Calendar replay for streaks and per-day badges.
  const days = [...perDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, v]) => ({ key, count: v.count, at: v.firstAt, lastAt: v.lastAt }));
  let run = 0, best = 0, prev = null, maxDayAt = 0;
  let maxDayCount = Math.max(0, ...days.map(d => d.count));
  for (const d of days) {
    run = prev && d.key === shiftDay(prev, 1) ? run + 1 : 1;
    prev = d.key;
    best = Math.max(best, run);
    if (d.count === maxDayCount && !maxDayAt) maxDayAt = d.at;
    cross('streak')(run)(d.at);
    cross('day')(d.count)(d.lastAt); // "5 in one day" is crossed by its fifth completion
  }

  // Current streak: the run ending today — or still-alive from yesterday.
  let current = 0;
  if (days.length) {
    const today = onDay(now);
    const last = days.at(-1).key;
    if (last === today || last === shiftDay(today, -1)) {
      current = 1;
      for (let i = days.length - 2; i >= 0; i--) {
        if (days[i].key === shiftDay(days[i + 1].key, -1)) current++;
        else break;
      }
    }
  }

  const valueFor = b => ({
    eps: counters.eps, streak: best, day: maxDayCount, night: counters.night,
    morning: counters.morning, genres: distinctGenres, dub: counters.dub,
    movies: counters.movies,
  })[b.kind];
  const badgeState = BADGES.map(b => ({
    ...b,
    value: valueFor(b),
    unlocked: opened.has(b.id),
    unlockedAt: opened.get(b.id) || 0,
  }));

  return {
    empty: !evs.length,
    episodes: counters.eps,
    hours: Math.round(hours / 3600e3 * 10) / 10,
    minutes: Math.round(hours / 60e3),
    daysActive: days.length,
    uniqueAnime: ids.size,
    currentStreak: current,
    bestStreak: best,
    byDay: days,
    maxDay: maxDayCount,
    topGenres: [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    distinctGenres,
    badgeState,
  };
}
