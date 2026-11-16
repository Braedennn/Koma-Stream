// The language of a stream's audio.
//
// A dub is not always a dub. The sites put several audio tracks into one
// playlist — Hindi, English, Japanese — and mark the first one as the
// default. A player that takes the default plays Hindi to somebody who asked
// for English, and nothing on screen says so. The playlist says which track is
// which, so the track that was asked for can be chosen instead of guessed at.
//
// A playlist with no audio tracks at all holds one track mixed into the
// video: the site's own language — Japanese on the sub sites, English on the
// dub sites. There is nothing to choose there, and nothing to go wrong.

/** The audio language a track type needs. */
export const AUDIO_LANG = { dub: 'en', sub: 'ja' };

/** The names the sites give the tracks when they do not say the language. */
const NAMES = [
  { lang: 'en', words: ['english', 'ingles', 'inglés', 'anglais', 'englisch'] },
  { lang: 'ja', words: ['japanese', '日本語', 'japonais', 'japones', 'japonês', '日本'] },
  { lang: 'hi', words: ['hindi', 'हिन्दी', 'हिंदी'] },
  { lang: 'es', words: ['spanish', 'español', 'espanol', 'espagnol'] },
  { lang: 'pt', words: ['portuguese', 'português', 'portugues'] },
];

/** The attributes of an #EXT-X-MEDIA line. */
function attributes(line) {
  const out = {};
  const payload = line.slice(line.indexOf(':') + 1);
  for (const m of payload.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
    out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** The audio tracks a master playlist offers. */
export function audioTracks(master) {
  const out = [];
  for (const line of String(master || '').split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line) || !/TYPE=AUDIO/i.test(line)) continue;
    const a = attributes(line);
    out.push({
      line,
      group: a['GROUP-ID'] || '',
      lang: (a.LANGUAGE || '').toLowerCase(),
      name: a.NAME || '',
      default: (a.DEFAULT || '').toUpperCase() === 'YES',
      autoselect: (a.AUTOSELECT || '').toUpperCase() === 'YES',
      uri: a.URI || '',
    });
  }
  return out;
}

/** The language a track is in, as far as the playlist says. */
export function trackLang(track) {
  const code = String(track?.lang || '').toLowerCase().split(/[-_]/)[0];
  if (code && code !== 'und') return code;
  const name = String(track?.name || '').toLowerCase();
  const row = NAMES.find(r => r.words.some(w => name.includes(w)));
  return row?.lang || '';
}

/** Is this track the language that was asked for? */
export function isLang(track, lang) {
  if (!track || !lang) return false;
  return trackLang(track) === lang;
}

/** Set a flag on an #EXT-X-MEDIA line, adding it when it is not there. */
function flag(line, name, value) {
  const re = new RegExp(`(${name}=)(YES|NO)`, 'i');
  if (re.test(line)) return line.replace(re, `$1${value}`);
  return `${line.replace(/\s+$/, '')},${name}=${value}`;
}

/**
 * The playlist with one language left in it.
 *
 * The track that was asked for becomes the default one, the others go, and
 * the variants that needed them go with them.
 */
function narrow(text, pick) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipUri = false;
  for (const line of lines) {
    if (skipUri && line.trim() && !line.startsWith('#')) { skipUri = false; continue; }
    skipUri = false;
    if (/^#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO/i.test(line)) {
      if (line === pick.line) out.push(flag(flag(line, 'DEFAULT', 'YES'), 'AUTOSELECT', 'YES'));
      continue; // the other languages are not in this stream any more
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const group = attributes(line).AUDIO || '';
      // Its group has no track left, so this variant cannot play.
      if (group && pick.group && group !== pick.group) { skipUri = true; continue; }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The language the stream can play.
 *
 * ok: false means the playlist has audio tracks but none of them is the
 * language that was asked for — this stream cannot serve it, and another one
 * has to be tried.
 */
export function chooseAudio(master, lang) {
  const text = String(master || '');
  const tracks = audioTracks(text);
  if (!tracks.length) return { ok: true, master: text, lang: null, tracks };
  const pick = tracks.find(t => isLang(t, lang));
  if (!pick) return { ok: false, master: text, lang: null, tracks };
  return { ok: true, master: narrow(text, pick), lang, tracks, picked: pick };
}
