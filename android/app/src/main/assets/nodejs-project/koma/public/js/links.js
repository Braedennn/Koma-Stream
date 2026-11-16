// Where Koma lives outside itself. The links live here — and only here — so
// the Discord invite can be swapped later without hunting through the markup
// and rebuilding the paths around it.

/** The repository Koma is published from. */
export const REPO = 'Braedennn/Koma-Stream';

/** Koma's own Discord invite. */
export const DISCORD_URL = 'https://discord.gg/ssVPb8WBVA';

/** The source repository. */
export const GITHUB_URL = `https://github.com/${REPO}`;

const LINKS = { discord: DISCORD_URL, github: GITHUB_URL };

/**
 * Point every [data-link] element at its destination. The markup carries the
 * name of the link, not the address, so there is one place to change.
 */
export function initLinks() {
  for (const el of document.querySelectorAll('[data-link]')) {
    const url = LINKS[el.dataset.link];
    if (url) el.href = url;
  }
}
