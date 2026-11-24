// The next playable part of a story: a following TV season, film, ONA or OVA.
// Resolved before the final episode ends so continuing never tears down the player.
import { airingSchedule, sourceEpisodes, watchOrder } from './api.js';
import { episodeIndex } from './ui.js';

const upcoming = new Map();

/**
 * Find the immediate sequel in AniList's prequel/sequel line and prepare its
 * first playable episode. Movies count as one episode through episodeIndex.
 * An announced but unaired sequel is a boundary, not something to skip past.
 */
export function nextPart(a) {
  if (!a?.id) return Promise.resolve(null);
  if (upcoming.has(a.id)) return upcoming.get(a.id);
  const promise = (async () => {
    const order = await watchOrder(a);
    const at = order.line.findIndex(media => media.id === a.id);
    const media = at >= 0 ? order.line[at + 1] : null;
    if (!media || media.status === 'NOT_YET_RELEASED') return null;
    const [schedule, source] = await Promise.all([
      airingSchedule(media.id).catch(() => []),
      sourceEpisodes(media),
    ]);
    const list = episodeIndex(media, schedule, source.episodes || [], source.offset || 0);
    const episode = list.find(item => !item.later);
    return episode ? { media, episode, list, schedule, source } : null;
  })().catch(error => {
    upcoming.delete(a.id); // a temporary API failure can be retried on the next visit
    throw error;
  });
  upcoming.set(a.id, promise);
  return promise;
}
