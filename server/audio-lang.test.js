import test from 'node:test';
import assert from 'node:assert/strict';
import { audioLanguageName, audioTracks, chooseAudio, normalizeDubLang, trackLang } from './audio-lang.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en-US",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",URI="hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="fra",NAME="Français",URI="fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="audio"
video.m3u8
`;

test('dub language normalization keeps Automatic as English and accepts aliases', () => {
  assert.equal(normalizeDubLang(''), 'en');
  assert.equal(normalizeDubLang('auto'), 'en');
  assert.equal(normalizeDubLang('hi-IN'), 'hi');
  assert.equal(normalizeDubLang('fra'), 'fr');
  assert.equal(normalizeDubLang('tam'), 'ta');
  assert.equal(normalizeDubLang('tel'), 'te');
  assert.equal(normalizeDubLang('not-a-language'), 'en');
  assert.equal(audioLanguageName('hi'), 'Hindi');
  assert.equal(audioLanguageName('fr'), 'French');
});

test('audio tracks match regional codes, ISO 639-2 codes, and language names', () => {
  const tracks = audioTracks(MASTER);
  assert.equal(trackLang(tracks[0]), 'en');
  assert.equal(trackLang(tracks[1]), 'hi');
  assert.equal(trackLang(tracks[2]), 'fr');
});

test('Hindi selection makes the name-only Hindi track the sole default', () => {
  const chosen = chooseAudio(MASTER, 'hi');
  assert.equal(chosen.ok, true);
  assert.equal(chosen.lang, 'hi');
  assert.match(chosen.master, /NAME="Hindi"/);
  assert.match(chosen.master, /NAME="Hindi"[^\n]*DEFAULT=YES,AUTOSELECT=YES/);
  assert.doesNotMatch(chosen.master, /NAME="English"/);
  assert.doesNotMatch(chosen.master, /NAME="Français"/);
  assert.match(chosen.master, /video\.m3u8/);
});

test('French selection accepts a three-letter track code and rejects missing languages', () => {
  assert.equal(chooseAudio(MASTER, 'fr').ok, true);
  assert.equal(chooseAudio(MASTER, 'de').ok, false);
});

test('metadata-free single-audio playlists retain the historic behavior but are not strict proof', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n';
  const chosen = chooseAudio(master, 'hi');
  assert.equal(chosen.ok, true);
  assert.equal(chosen.tracks.length, 0);
  assert.equal(chooseAudio(master, 'hi', { strict: true }).ok, false);
});

test('strict selection requires the requested audio group to be attached to video', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hindi",NAME="Hindi",URI="hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="english",NAME="English",URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="english"
en-video.m3u8
`;
  assert.equal(chooseAudio(master, 'hi', { strict: true }).ok, false);
  assert.equal(chooseAudio(master, 'en', { strict: true }).ok, true);
});

test('strict selection drops unassociated muxed variants and removed URIs across comments', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hindi",NAME="Hindi",URI="hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="english",NAME="English",URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="english"
# English variant comment

en-video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1
unknown-video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="hindi"
hi-video.m3u8
`;
  const chosen = chooseAudio(master, 'hi', { strict: true });
  assert.equal(chosen.ok, true);
  assert.match(chosen.master, /# English variant comment/);
  assert.match(chosen.master, /hi-video\.m3u8/);
  assert.doesNotMatch(chosen.master, /en-video\.m3u8/);
  assert.doesNotMatch(chosen.master, /unknown-video\.m3u8/);
  assert.doesNotMatch(chosen.master, /AUDIO="english"/);
});

test('English track narrowing keeps its historic unassociated-variant behavior', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="english",NAME="English",URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="english"
en-video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1
mixed-video.m3u8
`;
  const chosen = chooseAudio(master, 'en');
  assert.equal(chosen.ok, true);
  assert.match(chosen.master, /mixed-video\.m3u8/);
});

test('historic English and Japanese selection tolerates an otherwise-unused track group', () => {
  for (const [lang, name, group] of [['en', 'English', 'english'], ['ja', 'Japanese', 'japanese']]) {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group}",NAME="${name}",URI="${lang}.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="french",NAME="French",URI="fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="french"
fr-video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1
mixed-video.m3u8
`;
    const chosen = chooseAudio(master, lang);
    assert.equal(chosen.ok, true);
    assert.match(chosen.master, /mixed-video\.m3u8/);
  }
});
