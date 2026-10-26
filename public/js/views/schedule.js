import { api } from '../api.js';
import { inList } from '../store.js';
import { $, $$, esc, icon, img, name, relTime, setTitle, small, switchHTML } from '../ui.js';

const DAY = 86400000;

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
const shortDate = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export async function schedule(root, { query, alive }) {
  setTitle('Schedule');
  const offset = Math.max(-8, Math.min(8, Number.parseInt(query.get('week'), 10) || 0));
  let mine = query.get('mine') === '1';
  const start = mondayOf(new Date());
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const now = new Date();
  const todayIdx = days.findIndex(d => d.toDateString() === now.toDateString());
  const asked = Number.parseInt(query.get('day'), 10);
  let day = asked >= 0 && asked < 7 ? asked : Math.max(0, todayIdx);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekLink = w => `/schedule${w ? `?week=${w}` : ''}`;
  const sync = () => {
    const q = new URLSearchParams();
    if (offset) q.set('week', offset);
    if (day !== Math.max(0, todayIdx)) q.set('day', day);
    if (mine) q.set('mine', 1);
    history.replaceState(history.state, '', '/schedule' + (String(q) ? `?${q}` : ''));
  };

  root.innerHTML = `<div class="page">
    <div class="page-head">
      <div><h1>Airing schedule</h1><p>Every episode this week, in your time zone (${esc(tz)}).</p></div>
      <div class="week-nav">
        <a class="icon-btn" href="${weekLink(offset - 1)}" aria-label="Previous week">${icon('left')}</a>
        <strong>${shortDate(days[0])} – ${shortDate(days[6])}</strong>
        <a class="icon-btn" href="${weekLink(offset + 1)}" aria-label="Next week">${icon('right')}</a>
        ${offset ? `<a class="btn btn-ghost btn-sm" href="/schedule">This week</a>` : ''}
      </div>
    </div>
    <div class="days" role="tablist" aria-label="Day">${days.map((d, i) => `
      <button class="day-btn${i === todayIdx ? ' today' : ''}" type="button" role="tab" data-day="${i}" aria-selected="${i === day}">
        <small>${i === todayIdx ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })}</small><b>${d.getDate()}</b><span class="n">&nbsp;</span>
      </button>`).join('')}</div>
    <div class="sched-tools"><span id="count">Loading…</span>${switchHTML('mine', 'Only my list', mine)}</div>
    <div class="slots" id="slots">${Array.from({ length: 6 }, () => '<div class="sk" style="height:96px"></div>').join('')}</div>
  </div>`;

  const { schedules } = await api(`/schedule?from=${Math.floor(start / 1000)}&to=${Math.floor(end / 1000)}`);
  if (!alive()) return;

  const byDay = days.map(() => []);
  for (const s of schedules) {
    // Days aren't always 24h around daylight-saving changes; clamp into the week.
    const i = Math.max(0, Math.min(6, Math.floor((new Date(s.airingAt * 1000) - start) / DAY)));
    byDay[i].push(s);
  }

  const paint = () => {
    const pick = list => (mine ? list.filter(s => inList(s.media.id)) : list);
    $$('.day-btn', root).forEach((b, i) => {
      b.setAttribute('aria-selected', i === day);
      const n = pick(byDay[i]).length;
      $('.n', b).textContent = `${n} ${n === 1 ? 'show' : 'shows'}`;
    });
    const items = pick(byDay[day]);
    $('#count', root).textContent = `${items.length} ${items.length === 1 ? 'episode' : 'episodes'} on ${days[day].toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;
    $('#slots', root).innerHTML = items.length ? items.map((s, i) => {
      const t = new Date(s.airingAt * 1000);
      const mins = (t - Date.now()) / 60000;
      const pill = mins <= 0 ? '<span class="pill done">Aired</span>'
        : mins < 180 ? `<span class="pill soon">${relTime(s.airingAt)}</span>`
          : `<span class="pill up">${relTime(s.airingAt)}</span>`;
      // Aired episodes jump straight to the player; upcoming ones open the title page.
      return `<a class="slot${inList(s.media.id) ? ' mine' : ''}" href="${mins <= 0 ? `/watch/${s.media.id}?ep=${s.episode}` : `/anime/${s.media.id}`}" style="animation-delay:${Math.min(i, 12) * 35}ms">
        <time datetime="${t.toISOString()}">${t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
        ${img(small(s.media))}
        <span><b>${esc(name(s.media))}</b><small>Episode ${s.episode}${s.media.episodes ? ` of ${s.media.episodes}` : ''}${inList(s.media.id) ? ' · In your list' : ''}</small></span>
        ${pill}</a>`;
    }).join('') : `<div class="empty-state"><div class="bubble">${icon('calendar')}</div>
        <h2>${mine ? 'Nothing from your list' : 'Nothing airs this day'}</h2>
        <p>${mine ? 'None of the shows on your list air on this day. Turn off “Only my list” to see everything.' : 'Pick another day, or check next week.'}</p></div>`;
  };

  $('.days', root).addEventListener('click', e => {
    const b = e.target.closest('.day-btn');
    if (!b) return;
    $('#slots', root).classList.remove('still'); // a new day animates in
    day = Number(b.dataset.day);
    sync();
    paint();
  });
  $('#mine', root).addEventListener('change', e => { mine = e.target.checked; sync(); paint(); });
  paint();
  $('.day-btn[aria-selected="true"]', root)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  // Keep the countdowns ("In 30m", "Aired") current while the page is open.
  const tick = setInterval(() => { if (!alive()) return clearInterval(tick); $('#slots', root).classList.add('still'); paint(); }, 60e3);
}
