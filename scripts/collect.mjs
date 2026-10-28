// Collects your recently played tracks from Spotify and adds Last.fm tags for new artists.
// Run by the GitHub Action: node scripts/collect.mjs
import fs from 'node:fs';
import path from 'node:path';

const { SPOTIFY_CLIENT_ID: CID, SPOTIFY_REFRESH_TOKEN: RT, LASTFM_API_KEY: LK } = process.env;
if (!CID || !RT) throw new Error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_REFRESH_TOKEN secret.');

const DATA = 'data';
const PLAYS = path.join(DATA, 'plays');
const STATE = path.join(DATA, 'state.json');
const ARTISTS = path.join(DATA, 'artists.json');
const MAX_LOOKUPS = +(process.env.MAX_LOOKUPS ?? 1200); // Last.fm lookups per run (the rest are done on later runs)
const MAX_IMG = +(process.env.MAX_IMG ?? 600); // artist/album image lookups per run
const IMAGES = path.join(DATA, 'images.json');
const SEP = '\u2016';
fs.mkdirSync(PLAYS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

// ---------- Spotify ----------
async function getToken() {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT, client_id: CID }),
  });
  if (!r.ok) throw new Error(`Spotify token refresh failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  if (j.refresh_token && j.refresh_token !== RT) {
    console.log('::warning::Spotify issued a new refresh token. If runs start failing, log in again via login.html and update the SPOTIFY_REFRESH_TOKEN secret.');
  }
  return j.access_token;
}

async function api(url, token) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 429) { await sleep((+(r.headers.get('retry-after') || 5) + 1) * 1000); continue; }
    if (!r.ok) throw new Error(`Spotify API error (${r.status}): ${await r.text()}`);
    return r.json();
  }
  throw new Error('Spotify rate limit - try again later.');
}

const token = await getToken();
const state = readJson(STATE, { after: 0 });
const url = 'https://api.spotify.com/v1/me/player/recently-played?limit=50' + (state.after ? `&after=${state.after}` : '');
const recent = await api(url, token);

const byMonth = {};
let maxAfter = state.after || 0;
for (const it of recent.items || []) {
  const t = it.track;
  if (!t || !t.id) continue; // skip local files
  maxAfter = Math.max(maxAfter, new Date(it.played_at).getTime());
  const ym = it.played_at.slice(0, 7);
  (byMonth[ym] ||= []).push({
    t: it.played_at, id: t.id, n: t.name,
    a: t.artists?.[0]?.name || 'Unknown', al: t.album?.name || '', ms: t.duration_ms,
  });
}

let added = 0;
for (const [ym, list] of Object.entries(byMonth)) {
  const f = path.join(PLAYS, ym + '.json');
  const cur = readJson(f, []);
  const seen = new Set(cur.map((p) => p.t + '|' + p.id));
  for (const p of list) {
    const k = p.t + '|' + p.id;
    if (!seen.has(k)) { cur.push(p); seen.add(k); added++; }
  }
  cur.sort((a, b) => (a.t < b.t ? -1 : 1));
  writeJson(f, cur);
}
state.after = maxAfter;
writeJson(STATE, state);
console.log(`Spotify: ${recent.items?.length || 0} plays fetched, ${added} new.`);

// ---------- Scan the stored plays once ----------
const artistPlays = new Map(), artistMin = new Map(), albumMin = new Map();
for (const f of fs.readdirSync(PLAYS)) {
  if (!f.endsWith('.json')) continue;
  for (const p of readJson(path.join(PLAYS, f), [])) {
    if (!p.a) continue;
    artistPlays.set(p.a, (artistPlays.get(p.a) || 0) + 1);
    if ((p.ms || 0) >= 30000) {
      artistMin.set(p.a, (artistMin.get(p.a) || 0) + p.ms / 60000);
      if (p.al) { const k = p.a + SEP + p.al; albumMin.set(k, (albumMin.get(k) || 0) + p.ms / 60000); }
    }
  }
}

// ---------- Last.fm tags ----------
if (!LK) {
  console.log('No LASTFM_API_KEY set - skipping artist tags.');
} else {
  const artists = readJson(ARTISTS, {});
  const todo = [...artistPlays.entries()].filter(([n]) => !Object.hasOwn(artists, n)).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  let done = 0;
  for (const name of todo.slice(0, MAX_LOOKUPS)) {
    try {
      const u = new URL('https://ws.audioscrobbler.com/2.0/');
      u.search = new URLSearchParams({ method: 'artist.gettoptags', artist: name, autocorrect: '1', api_key: LK, format: 'json' });
      const r = await fetch(u);
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      if (j.error === 29) { console.log('Last.fm rate limit reached - continuing next run.'); break; }
      artists[name] = (j.toptags?.tag || []).slice(0, 10).map((t) => [t.name, t.count]);
      done++;
    } catch (e) {
      console.log('Last.fm lookup failed for', name, e.message);
    }
    await sleep(250);
  }
  writeJson(ARTISTS, artists);
  console.log(`Last.fm: ${done} artists tagged, ${Math.max(0, todo.length - done)} still waiting.`);
}

// ---------- Artist pictures and album covers (Deezer, iTunes as fallback for covers) ----------
// images.json: { a: { artist: code }, l: { "artist\u2016album": code } }
// code = Deezer hash, "i:<iTunes base url>", or 0 when nothing was found.
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\b(deluxe|remaster(?:ed)?|edition|expanded|version|bonus|anniversary)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

class Quota extends Error {}
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SpotifyStats/2.0 (+https://github.com/cvpw4tkrhd-wq/SpotifyStats)' } });
      if (r.status === 429) { await sleep(5000); continue; }
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      if (j && j.error && (j.error.code === 4 || j.error.type === 'Exception')) throw new Quota('Deezer quota');
      return j;
    } catch (e) { if (e instanceof Quota) throw e; await sleep(1000); }
  }
  return null;
}

async function deezerArtist(name) {
  const j = await getJson('https://api.deezer.com/search/artist?limit=8&q=' + encodeURIComponent(name));
  if (!j) return undefined; // lookup failed: try again next run
  const t = norm(name);
  const c = (j.data || []).filter((x) => norm(x.name) === t).sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0];
  const m = c && /\/artist\/([0-9a-f]+)\//.exec(c.picture_xl || '');
  return m ? m[1] : 0;
}
async function deezerAlbum(artist, album) {
  const j = await getJson('https://api.deezer.com/search/album?limit=10&q=' + encodeURIComponent(artist + ' ' + album));
  if (!j) return undefined;
  const ta = norm(artist), tl = norm(album);
  const cands = (j.data || []).filter((x) => norm(x.artist?.name) === ta);
  const c = cands.find((x) => norm(x.title) === tl) || (tl.length > 2 ? cands.find((x) => { const t = norm(x.title); return t.includes(tl) || (t.length > 2 && tl.includes(t)); }) : null);
  const m = c && /\/cover\/([0-9a-f]+)\//.exec(c.cover_xl || '');
  return m ? m[1] : 0;
}
async function itunesAlbum(artist, album) {
  const j = await getJson('https://itunes.apple.com/search?entity=album&limit=10&term=' + encodeURIComponent(artist + ' ' + album));
  if (!j) return 0;
  const ta = norm(artist), tl = norm(album);
  const cands = (j.results || []).filter((x) => norm(x.artistName) === ta);
  const c = cands.find((x) => norm(x.collectionName) === tl);
  return c && c.artworkUrl100 ? 'i:' + c.artworkUrl100.replace(/\/[^/]*$/, '') : 0;
}

const im = readJson(IMAGES, { a: {}, l: {} });
const summaryNow = readJson(path.join(DATA, 'summary.json'), null);
const rankedArtists = [...artistMin.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
// What the dashboard actually shows comes first: the newest month, then older months, then years and all-time.
const artistQ = [], albumQ = [];
if (summaryNow) {
  const sets = [
    ...Object.keys(summaryNow.months || {}).sort().reverse().map((k) => summaryNow.months[k]),
    ...Object.keys(summaryNow.years || {}).sort().reverse().map((k) => summaryNow.years[k]),
    summaryNow.all,
  ].filter(Boolean);
  for (const set of sets) {
    for (const x of (set.topArtists || []).slice(0, 10)) artistQ.push(x.n);
    for (const b of set.topAlbums || []) albumQ.push(b.a + SEP + b.n);
  }
}
artistQ.push(...rankedArtists.slice(0, 5000));
albumQ.push(...[...albumMin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3000).map((e) => e[0]));

const queue = []; const seenQ = new Set();
for (let i = 0; i < Math.max(artistQ.length, albumQ.length); i++) {
  for (const [t, k] of [['a', artistQ[i]], ['l', albumQ[i]]]) {
    if (!k || seenQ.has(t + k)) continue;
    seenQ.add(t + k);
    if (!Object.hasOwn(t === 'a' ? im.a : im.l, k)) queue.push([t, k]);
  }
}

let imgDone = 0, imgFound = 0;
try {
  for (const [t, k] of queue.slice(0, MAX_IMG)) {
    let code;
    if (t === 'a') code = await deezerArtist(k);
    else {
      const [artist, album] = k.split(SEP);
      code = await deezerAlbum(artist, album);
      if (code === 0) { await sleep(200); code = await itunesAlbum(artist, album); }
    }
    await sleep(200);
    if (code === undefined) continue;
    (t === 'a' ? im.a : im.l)[k] = code;
    imgDone++; if (code) imgFound++;
    if (imgDone % 50 === 0) writeJson(IMAGES, im);
  }
} catch (e) {
  console.log('Image lookups stopped early:', e.message);
}
writeJson(IMAGES, im);
console.log(`Images: ${imgDone} looked up (${imgFound} found), ${Math.max(0, queue.length - imgDone)} still waiting.`);

// ---------- Release years (Deezer) and artist origin country (MusicBrainz) ----------
// meta.json: { ar: { artist: "SE" | 0 }, yr: { "artist\u2016album": 1998 | 0 } }  (0 = looked up, nothing found)
const META = process.env.META_FILE || path.join(DATA, 'meta.json');
const MAX_MB = +(process.env.MAX_MB ?? 300); // MusicBrainz: about one request per second, and it often sheds load
const MAX_YR = +(process.env.MAX_YR ?? 600); // Deezer album lookups for the original release year
const MB_UA = 'SpotifyStats/3.0 (+https://github.com/cvpw4tkrhd-wq/SpotifyStats)';
const meta = readJson(META, { ar: {}, yr: {} });
const mbEsc = (x) => String(x).replace(/(["\\])/g, '\\$1');
let mbLast = 0;
async function mb(url) {
  for (let i = 0; i < 5; i++) {
    const wait = 1100 - (Date.now() - mbLast);
    if (wait > 0) await sleep(wait);
    mbLast = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': MB_UA, Accept: 'application/json' } });
      if (r.status === 503 || r.status === 429) { await sleep(4000 * (i + 1)); continue; } // MusicBrainz sheds load when busy
      if (!r.ok) return undefined;
      return await r.json();
    } catch (e) { await sleep(2000); }
  }
  return undefined;
}
async function mbArtist(name) {
  const j = await mb('https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=' + encodeURIComponent(`artist:"${mbEsc(name)}"`));
  if (!j) return undefined;
  const t = norm(name);
  const c = (j.artists || []).filter((a) => norm(a.name) === t || norm(a['sort-name']) === t).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (!c) return 0;
  return c.country || c.area?.['iso-3166-1-codes']?.[0] || 0;
}
// Original release year: the earliest date among Deezer editions with the same title (so remasters do not move an album to a later decade)
async function deezerYear(artist, album) {
  const j = await getJson('https://api.deezer.com/search/album?limit=10&q=' + encodeURIComponent(artist + ' ' + album));
  if (!j) return undefined;
  const ta = norm(artist), tl = norm(album);
  const cands = (j.data || []).filter((x) => norm(x.artist?.name) === ta && norm(x.title) === tl).slice(0, 4);
  if (!cands.length) return 0;
  let best = 0;
  for (const c of cands) {
    await sleep(180);
    const d = await getJson('https://api.deezer.com/album/' + c.id);
    const y = +String(d?.release_date || '').slice(0, 4);
    if (y >= 1900 && y <= 2100 && (!best || y < best)) best = y;
  }
  return best;
}
// ---- release years (Deezer) ----
const yrQueue = [...albumMin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8000).map((e) => e[0]).filter((k) => !Object.hasOwn(meta.yr, k));
let yrDone = 0;
try {
  for (const k of yrQueue.slice(0, MAX_YR)) {
    const [artist, album] = k.split(SEP);
    const v = await deezerYear(artist, album);
    await sleep(180);
    if (v === undefined) continue;
    meta.yr[k] = v; yrDone++;
    if (yrDone % 50 === 0) writeJson(META, meta);
  }
} catch (e) { console.log('Release-year lookups stopped early:', e.message); }
writeJson(META, meta);
console.log(`Release years: ${yrDone} looked up, ${Math.max(0, yrQueue.length - yrDone)} still waiting (${Object.keys(meta.yr).length} albums known).`);

// ---- artist origin country (MusicBrainz) ----
const mbQueue = rankedArtists.slice(0, 5000).filter((k) => !Object.hasOwn(meta.ar, k));
let mbDone = 0, mbFail = 0;
try {
  for (const k of mbQueue.slice(0, MAX_MB)) {
    const v = await mbArtist(k);
    if (v === undefined) { if (++mbFail >= 8) { console.log('MusicBrainz is busy - stopping for this run.'); break; } continue; }
    mbFail = 0;
    meta.ar[k] = v; mbDone++;
    if (mbDone % 20 === 0) writeJson(META, meta);
  }
} catch (e) { console.log('MusicBrainz lookups stopped early:', e.message); }
writeJson(META, meta);
console.log(`MusicBrainz: ${mbDone} artists looked up, ${Math.max(0, mbQueue.length - mbDone)} still waiting (${Object.keys(meta.ar).length} artists known).`);
