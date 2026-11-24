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

const ALIASES = {
  eng: 'en', jpn: 'ja', hin: 'hi', fra: 'fr', fre: 'fr', spa: 'es', por: 'pt',
  ger: 'de', deu: 'de', ita: 'it', rus: 'ru', ara: 'ar', chi: 'zh', zho: 'zh',
  tur: 'tr', pol: 'pl', ind: 'id', tha: 'th', kor: 'ko',
  tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn',
};

/** A two-letter language code, including regional and ISO 639-2 variants. */
function languageCode(value) {
  const base = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  const code = ALIASES[base] || base;
  return /^[a-z]{2}$/.test(code) ? code : '';
}

/** Automatic and invalid/missing preferences retain the historic English default. */
export const normalizeDubLang = value => !String(value || '').trim() || String(value).trim().toLowerCase() === 'auto'
  ? 'en' : languageCode(value) || 'en';

export function audioLanguageName(value) {
  const code = normalizeDubLang(value);
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; }
  catch { return code; }
}

/** The names the sites give the tracks when they do not say the language. */
const NAMES = [
  { lang: 'en', words: ['english', 'ingles', 'inglés', 'anglais', 'englisch'] },
  { lang: 'ja', words: ['japanese', '日本語', 'japonais', 'japones', 'japonês', '日本'] },
  { lang: 'hi', words: ['hindi', 'हिन्दी', 'हिंदी'] },
  { lang: 'fr', words: ['french', 'français', 'francais'] },
  { lang: 'es', words: ['spanish', 'español', 'espanol', 'espagnol'] },
  { lang: 'pt', words: ['portuguese', 'português', 'portugues'] },
  { lang: 'de', words: ['german', 'deutsch'] },
  { lang: 'it', words: ['italian', 'italiano'] },
  { lang: 'ru', words: ['russian', 'русский'] },
  { lang: 'ar', words: ['arabic', 'العربية'] },
  { lang: 'zh', words: ['chinese', 'mandarin', '中文'] },
  { lang: 'tr', words: ['turkish', 'türkçe', 'turkce'] },
  { lang: 'pl', words: ['polish', 'polski'] },
  { lang: 'id', words: ['indonesian', 'bahasa indonesia'] },
  { lang: 'th', words: ['thai', 'ไทย'] },
  { lang: 'ko', words: ['korean', '한국어'] },
  { lang: 'ta', words: ['tamil', 'தமிழ்'] },
  { lang: 'te', words: ['telugu', 'తెలుగు'] },
  { lang: 'ml', words: ['malayalam', 'മലയാളം'] },
  { lang: 'kn', words: ['kannada', 'ಕನ್ನಡ'] },
  { lang: 'bn', words: ['bengali', 'bangla', 'বাংলা'] },
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
  const code = languageCode(track?.lang);
  if (code && String(track?.lang || '').toLowerCase() !== 'und') return code;
  const name = String(track?.name || '').toLowerCase();
  const row = NAMES.find(r => r.words.some(w => name.includes(w)));
  return row?.lang || '';
}

/** Is this track the language that was asked for? */
export function isLang(track, lang) {
  const want = languageCode(lang);
  if (!track || !want) return false;
  return trackLang(track) === want;
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
function narrow(text, pick, strict) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipUri = false;
  let variants = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skipUri) {
      if (!trimmed || trimmed.startsWith('#')) {
        // Comments and blank lines may sit between a variant tag and its URI.
        // Keep looking for that URI rather than leaving an orphan behind.
        out.push(line);
        continue;
      }
      skipUri = false;
      continue;
    }
    if (/^#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO/i.test(line)) {
      if (line === pick.line) out.push(flag(flag(line, 'DEFAULT', 'YES'), 'AUTOSELECT', 'YES'));
      continue; // the other languages are not in this stream any more
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const group = attributes(line).AUDIO || '';
      // Strict playback cannot retain a muxed variant of unknown language.
      // In every mode, a variant in another audio group cannot play the pick.
      if ((strict ? group !== pick.group : group && pick.group && group !== pick.group)) {
        skipUri = true;
        continue;
      }
      variants++;
    }
    out.push(line);
  }
  return { text: out.join('\n'), variants };
}

/**
 * The language the stream can play.
 *
 * ok: false means the playlist has audio tracks but none of them is the
 * language that was asked for — this stream cannot serve it, and another one
 * has to be tried.
 */
export function chooseAudio(master, lang, { strict = false } = {}) {
  const text = String(master || '');
  const tracks = audioTracks(text);
  if (!tracks.length) return { ok: !strict, master: text, lang: null, tracks, unverified: strict };
  const variants = text.split(/\r?\n/).filter(line => /^#EXT-X-STREAM-INF:/i.test(line))
    .map(line => ({ group: attributes(line).AUDIO || '' }));
  const grouped = variants.filter(variant => variant.group);
  // Strict playback accepts only a track attached to a video variant, and
  // rejects unassociated muxed variants whose language cannot be established.
  // Historic English/sub narrowing keeps its more permissive behavior.
  const pick = tracks.find(track => isLang(track, lang)
    && (!strict || grouped.some(variant => variant.group === track.group)));
  if (!pick) return { ok: false, master: text, lang: null, tracks };
  const narrowed = narrow(text, pick, strict);
  if (variants.length && !narrowed.variants) return { ok: false, master: text, lang: null, tracks };
  return { ok: true, master: narrowed.text, lang, tracks, picked: pick };
}
