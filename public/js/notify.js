// Desktop air notifications: watches the schedule for shows on your list and
// asks the app shell to toast when a new episode just aired. Clicking the
// toast opens that episode. In a normal browser tab there's no shell bridge,
// so this quietly does nothing.
import { api } from './api.js';
import { listIds } from './store.js';

const PREF = 'koma.notif';
const SEEN = 'koma.notif.seen';
const POLL_MS = 5 * 60e3;
const FRESH_S = 25 * 60; // an episode counts as "just aired" for 25 minutes

export const notifyPref = () => localStorage.getItem(PREF) !== 'off';
export function setNotifyPref(on) {
  localStorage.setItem(PREF, on ? 'on' : 'off');
  if (on) check().catch(() => {}); // flipping it on doubles as "check right now"
}

const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN)) || []; } catch { return []; } };
const writeSeen = list => { try { localStorage.setItem(SEEN, JSON.stringify(list.slice(-60))); } catch { /* full */ } };

export function pickFresh(schedules, ids, now, seenKeys) {
  return (schedules || []).filter(s =>
    ids.includes(s.media?.id)               // only shows on My list
    && s.airingAt <= now + 60               // already aired (not a minute from now)
    && now - s.airingAt < FRESH_S           // and recently — older episodes were already handled
    && !seenKeys.has(`${s.media.id}:${s.episode}`));
}

export async function check() {
  if (!notifyPref() || !window.koma?.notify) return;
  const ids = listIds();
  if (!ids.length) return;
  const now = Math.floor(Date.now() / 1000);
  const { schedules } = await api(`/schedule?from=${now - FRESH_S}&to=${now + 60}`);
  const seen = readSeen();
  const note = pickFresh(schedules, ids, now, new Set(seen.map(x => x.k)));
  if (!note.length) return;
  writeSeen([...seen.filter(x => Date.now() - x.at < 86400e3), ...note.map(s => ({ k: `${s.media.id}:${s.episode}`, at: Date.now() }))]);
  for (const s of note.slice(0, 4)) { // never stack a wall of toasts
    window.koma.notify({
      title: s.media.title.english || s.media.title.romaji,
      body: `Episode ${s.episode} is out — tap to watch`,
      url: `/watch/${s.media.id}?ep=${s.episode}`,
    });
  }
}

export function initNotifications() {
  if (!window.koma?.notify) return; // normal browser tab: nothing to do
  setTimeout(() => check().catch(() => {}), 10e3); // let the page settle first
  setInterval(() => check().catch(() => {}), POLL_MS);
  addEventListener('online', () => setTimeout(() => check().catch(() => {}), 3e3));
}
