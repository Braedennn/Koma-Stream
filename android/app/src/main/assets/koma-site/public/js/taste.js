// Pure taste model for the Home page's "For you" rail: turn the watch journal into
// per-genre weights, then rank candidate anime by how well they match. No DOM, no
// network — the caller hydrates metadata and passes it in, exactly like stats.js.

const HALF_LIFE = 120 * 86400e3; // a finished episode fades to half weight in ~4 months

/** Genre weights from journal events: every finished episode votes for its show's
 *  genres, weighted by recency. Last month's obsession outranks a phase from two
 *  years ago; a show you kept finishing beats one you dropped after one episode. */
export function genreWeights(entries, meta, { now = Date.now() } = {}) {
  const w = {};
  for (const e of entries) {
    const genres = meta[e.id]?.genres;
    if (!genres?.length) continue;
    const f = Math.pow(0.5, Math.max(0, now - e.at) / HALF_LIFE);
    for (const g of genres) w[g] = (w[g] || 0) + f;
  }
  return w;
}

/** The genres worth recommending from, strongest first. */
export const topGenres = (weights, n = 2) =>
  Object.entries(weights).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g);

/** Rank candidates for one person: genre affinity first, quality and reach as
 *  tie-breakers. `exclude` removes anything already owned, and Hentai never
 *  surfaces from a taste rail no matter how strong the taste. */
export function rankCandidates(candidates, weights = {}, { exclude = new Set() } = {}) {
  const max = Math.max(1, ...Object.values(weights));
  return candidates
    .filter(a => !exclude.has(a.id) && !(a.genres || []).includes('Hentai'))
    .map(a => {
      const affinity = (a.genres || []).reduce((s, g) => s + (weights[g] || 0), 0) / max;
      const quality = (a.averageScore || 0) / 100;
      const reach = Math.log10((a.popularity || 0) + 10) / 6; // ≈0.3 at 100k members
      return { a, s: affinity * 2 + quality + reach };
    })
    .sort((x, y) => y.s - x.s) // Array#sort is stable, so equal scores keep input order
    .map(x => x.a);
}
