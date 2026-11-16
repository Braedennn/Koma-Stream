import { mediaByIds } from '../api.js';
import { readJournal, takesById } from '../store.js';
import { computeStats, takeStats } from '../stats.js';
import { esc, icon, setTitle } from '../ui.js';

const DAY = 86400e3;
const midnight = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const keyOf = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

export async function stats(root, { alive }) {
  setTitle('Your stats');
  root.innerHTML = `<div class="sk sk-line" style="width:28%;height:34px;margin:0 0 18px"></div>
    <div class="st-tiles">${'<div class="st-tile"><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>'.repeat(4)}</div>
    <div class="stack"><div class="sk" style="height:118px"></div><div class="sk" style="height:200px"></div></div>`;

  const journal = readJournal();
  const takeMap = takesById();
  const ts = takeStats(takeMap);
  if (!alive()) return;

  // Hydrate what the journal and takes reference (genres, format, names). The server
  // only knows some AniList ids; partial metadata just trims the genre spread — nothing else needs it.
  const meta = {};
  let media = [];
  const ids = [...new Set([...journal.map(e => e.id), ...Object.keys(takeMap).map(Number)])];
  if (ids.length) {
    media = await mediaByIds(ids).catch(() => []) || [];
    for (const m of media) meta[m.id] = { genres: m.genres || [], format: m.format };
  }
  const s = computeStats(journal, meta);
  if (!alive()) return;

  if (s.empty) {
    root.innerHTML = `<div class="empty-state"><div class="bubble">${icon('bookmark')}</div>
      <h2>No stats to show</h2><p>Koma logs your finished episodes on this device from here on —
      this page fills up as you watch. Your Library and sync run regardless.</p>
      <a class="btn btn-primary" href="/browse">${icon('search')}Find something to watch</a></div>`;
    return;
  }

  const hoursLabel = s.hours >= 0.1 ? `${s.hours.toLocaleString()} h` : s.minutes ? `${s.minutes} min` : '< 1 min';
  const streakWord = n => (n === 1 ? 'day' : 'days');
  const tiles = [
    [s.episodes.toLocaleString(), 'Episodes finished', `${s.uniqueAnime} show${s.uniqueAnime === 1 ? '' : 's'} · ${s.daysActive} active day${s.daysActive === 1 ? '' : 's'}`],
    [hoursLabel, 'Watch time', 'counted from completed plays'],
    [s.currentStreak, 'Current streak', s.currentStreak ? `${streakWord(s.currentStreak)} in a row` : 'finish an episode today'],
    [s.bestStreak, 'Longest streak', s.bestStreak === s.currentStreak && s.bestStreak ? 'current run leads' : `${streakWord(s.bestStreak)} in a row`],
  ];

  // 12-week log, GitHub-style: rows are weekdays (Monday on top), columns are weeks.
  const perDay = new Map(s.byDay.map(d => [d.key, d.count]));
  const TOTAL = 84;
  const today = midnight(Date.now());
  const start = today - (TOTAL - 1) * DAY;
  const pad = (new Date(start).getDay() + 6) % 7; // leading blanks in week column 1
  const cells = Array.from({ length: pad }, (_, r) =>
    `<span class="hm hm-pad" style="grid-row:${r + 1};grid-column:1"></span>`);
  for (let i = 0; i < TOTAL; i++) {
    const ms = start + i * DAY;
    const d = new Date(ms);
    const n = perDay.get(keyOf(d)) || 0;
    cells.push(`<span class="hm hm${n > 4 ? 4 : n}" style="grid-row:${(d.getDay() + 6) % 7 + 1};grid-column:${((pad + i) / 7 | 0) + 1}" title="${keyOf(d)}: ${n} episode${n === 1 ? '' : 's'}"></span>`);
  }

  // "My takes" — your private scores and rewatch counters. Only rendered once
  // there's something in them; an untouched panel would just be nagging.
  const nameOf = id => { const m = media.find(x => x.id === id); return m ? (m.title.english || m.title.romaji) : `#${id}`; };
  const takeSection = (ts.rated || ts.rewatches) ? `<section><h2 class="section-title">My takes<span>your own ratings, private to this device</span></h2>
    <div class="take-grid">
      <div class="take-stat"><b>${ts.rated ? ts.avg.toFixed(1) : '—'}</b><span>average of your scores</span></div>
      <div class="take-stat"><b>${ts.rated}</b><span>show${ts.rated === 1 ? '' : 's'} rated</span></div>
      <div class="take-stat"><b>${ts.rewatches}</b><span>rewatch${ts.rewatches === 1 ? '' : 'es'} logged</span></div>
    </div>
    ${ts.best.length ? `<div class="tk-list">${ts.best.slice(0, 6).map(r => `
      <a class="tk-row" href="/anime/${r.id}"><span>${esc(nameOf(r.id))}</span><b>${icon('star')}${r.score}<small>/10</small></b></a>`).join('')}</div>` : ''}
    ${ts.topRewatch ? `<a class="tk-rew" href="/anime/${ts.topRewatch.id}">
      <span class="lead">${icon('reload')}</span>
      <span class="lbl"><b>Most rewatched</b><span>${esc(nameOf(ts.topRewatch.id))}</span></span>
      <b class="n">${ts.topRewatch.n}×</b></a>` : ''}
  </section>` : '';

  root.innerHTML = `
    <div class="page">
    <div class="page-head"><div><h1>Your stats</h1>
      <p>Everything here is logged on this device — finished episodes only, so the numbers are honest.</p></div></div>
    <div class="st-tiles">${tiles.map(([v, label, sub]) => `
      <div class="st-tile"><b>${v}</b><span>${label}</span><small>${esc(sub)}</small></div>`).join('')}</div>
    <div class="stack">
      <section><h2 class="section-title">Watch log<span>last 12 weeks</span></h2>
        <div class="heatmap">${cells.join('')}</div>
        <div class="hm-legend"><span>less</span><i class="hm hm0"></i><i class="hm hm1"></i><i class="hm hm2"></i><i class="hm hm3"></i><i class="hm hm4"></i><span>more</span></div>
      </section>

      <section><h2 class="section-title">Genres you lean into</h2>
        ${s.topGenres.length ? `<div class="gb-list">${s.topGenres.map(([g, n], i) => `
          <div class="gb-row"><span>${esc(g)}</span><i style="width:${Math.round(n / s.topGenres[0][1] * 100)}%"></i><b>${n}</b>${i === 0 ? '<em>top</em>' : ''}</div>`).join('')}</div>`
          : '<p class="st-mute">Genre data isn\'t available for your shows right now.</p>'}
      </section>

      ${takeSection}

      <section><h2 class="section-title">Badges<span>${s.badgeState.filter(b => b.unlocked).length} of ${s.badgeState.length} earned</span></h2>
        <div class="badge-grid">${s.badgeState.map(b => b.unlocked
          ? `<div class="badge got"><span class="b-i">${icon(b.icon)}</span><b>${b.name}</b><small>${b.hint}</small>
             <em>Unlocked ${esc(new Date(b.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</em></div>`
          : `<div class="badge"><span class="b-i">${icon(b.icon)}</span><b>${b.name}</b><small>${esc(b.hint)}</small>
             <div class="b-bar"><i style="width:${Math.min(100, Math.round(b.value / b.target * 100))}%"></i></div><small class="b-side">${b.value} / ${b.target}</small></div>`).join('')}</div>
      </section>
    </div>
    </div>`;

  // An episode finishing mid-view folds in via a reload — this only happens if you're
  // sitting on the stats page when the last credits roll, so the simplest honest refresh.
  addEventListener('koma:journal', () => { if (alive()) location.reload(); }, { once: true });
}
