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
const MAX_LOOKUPS = 1200; // Last.fm lookups per run (the rest are done on later runs)
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

// ---------- Last.fm tags ----------
if (!LK) {
  console.log('No LASTFM_API_KEY set - skipping artist tags.');
} else {
  const artists = readJson(ARTISTS, {});
  const counts = new Map();
  for (const f of fs.readdirSync(PLAYS)) {
    if (!f.endsWith('.json')) continue;
    for (const p of readJson(path.join(PLAYS, f), [])) if (p.a) counts.set(p.a, (counts.get(p.a) || 0) + 1);
  }
  const todo = [...counts.entries()].filter(([n]) => !Object.hasOwn(artists, n)).sort((a, b) => b[1] - a[1]).map(([n]) => n);
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
