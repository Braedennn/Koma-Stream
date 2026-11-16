// Discord Rich Presence: shows what you're doing in Koma on your Discord
// profile. The desktop app owns the connection to Discord — in a normal
// browser tab there's no bridge, so this quietly does nothing.

const PROGRESS_MS = 15000; // a new timestamp every 15s is plenty

const bridge = () => window.koma?.presence || null;

let state = { connected: false, status: '', clientId: '', error: '' };
let last = null;             // the activity we last asked for
let watching = null;         // what the watch page is playing right now
let progressAt = 0;

function apply(s) {
  state = {
    connected: Boolean(s?.connected),
    status: String(s?.status || ''),
    clientId: String(s?.clientId || ''),
    error: String(s?.error || ''),
  };
}

/** Ask the app shell for the current state and listen for changes. */
export async function initPresence() {
  const api = bridge();
  if (!api) return;
  try { apply(await api.state()); } catch { /* the shell isn't listening yet */ }
  api.onStatus(apply);
}

export function setActivity(activity) {
  const api = bridge();
  if (!api) return;
  last = activity || null;
  api.activity(last);
}

/** Discord downloads plain https cover URLs itself for large_image/small_image — the client
 *  fetches them straight from AniList, no uploaded asset needed. No cover, no key:
 *  a dead key is worse than none. */
const coverImage = cover => (/^https?:\/\//.test(String(cover || '')) ? String(cover) : undefined);

/** The page you're on, when you're not watching something. */
export function presencePage(label) {
  return { details: label, state: 'Koma' };
}

/** An anime's own page. */
export function presenceAnime(title, cover) {
  return { details: title, state: 'Browsing anime on Koma', largeImage: coverImage(cover), largeText: title };
}

/** The route you're on, mapped to something worth showing on a profile. */
export function presenceForRoute(path = location.pathname) {
  if (path.startsWith('/anime/')) return null; // the anime page fills this in itself
  if (path.startsWith('/watch/')) return null; // the watch page fills this in itself
  if (path.startsWith('/browse')) return presencePage('Browsing anime');
  if (path.startsWith('/schedule')) return presencePage('Checking the schedule');
  if (path.startsWith('/list')) return presencePage('Browsing My list');
  if (path.startsWith('/stats')) return presencePage('Reviewing watch stats');
  return presencePage('Browsing Koma');
}

/** Start showing an episode. `startedAt`/`duration` are added once we know them. */
export function presenceWatching(info) {
  watching = { ...info, paused: false };
  progressAt = 0;
  setActivity(watchingActivity(watching));
}

/** Playback moved on: refresh the progress bar on the profile. */
export function presenceProgress(t, dur) {
  if (!watching || watching.paused) return;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const now = Date.now();
  if (now - progressAt < PROGRESS_MS) return;
  progressAt = now;
  setActivity(watchingActivity({ ...watching, startedAt: now - t * 1000, duration: dur }));
}

/** A seek landed: scrub drop, Skip Intro/Outro, a resume point jump, arrow keys. The
 *  profile's bar re-anchors here and now — instantly, without waiting for the
 *  throttled progress tick — so it always means where in the episode you are.
 *  Rapid seeks (scrub preview, bursts) collapse into one trailing push. */
let seekTimer = null;
export function presenceSeek(t, dur) {
  if (!watching) return;
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(dur) || dur <= 0) return;
  watching.startedAt = Date.now() - t * 1000;
  watching.duration = dur;
  clearTimeout(seekTimer);
  if (watching.paused) return; // paused shows no bar; it takes the anchor back up on resume
  seekTimer = setTimeout(() => setActivity(watchingActivity(watching)), 250);
}

/** Paused: stop the timing bar, or it would keep running while nothing plays. */
export function presencePaused() {
  if (!watching) return;
  watching.paused = true;
  progressAt = 0;
  setActivity(watchingActivity(watching));
}

/** Resumed: pick the timing bar back up from where the video actually is. */
export function presenceResumed(t, dur) {
  if (!watching) return;
  watching.paused = false;
  if (Number.isFinite(t) && t >= 0 && Number.isFinite(dur) && dur > 0) {
    watching.startedAt = Date.now() - t * 1000;
    watching.duration = dur;
  }
  progressAt = 0;
  setActivity(watchingActivity(watching));
}

/** Left the watch page (or the episode ended). */
export function presenceStopped() {
  watching = null;
  progressAt = 0;
}

function watchingActivity({ title, episode, episodeTitle, type, cover, startedAt, duration, paused }) {
  const details = episode
    ? `Episode ${episode}${episodeTitle ? ` · ${episodeTitle}` : ''}`
    : 'Watching';
  const activity = {
    details,
    state: title || 'Koma',
    largeImage: coverImage(cover),
    largeText: title || 'Koma',
    smallImage: paused ? 'pause' : 'play',
    smallText: type === 'dub' ? 'Dubbed' : 'Subbed',
  };
  if (!paused && startedAt && duration) {
    activity.startTimestamp = startedAt;
    activity.endTimestamp = startedAt + duration * 1000;
  }
  return activity;
}
