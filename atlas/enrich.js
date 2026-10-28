// Gradual enrichment, entirely in the visitor's browser:
//   genres/moods  <- Last.fm (allows browser requests)
//   photos/covers/release years <- Deezer (no CORS, so it is called with JSONP)
//   artist home country <- MusicBrainz (allows browser requests, about 1 request per second)
// Results are cached on the device, so each name is only looked up once.
import * as store from './store.js';
import { LASTFM_KEY } from './config.js';

const SEP = '\u2016';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\b(deluxe|remaster(?:ed)?|edition|expanded|version|bonus|anniversary)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const hashFrom = (url, kind) => { const m = new RegExp('/images/' + kind + '/([0-9a-f]+)/').exec(url || ''); return m ? m[1] : 0; };

// Deezer answers browsers only through JSONP (a script tag with a callback)
function jsonp(url, timeout = 12000) {
  return new Promise((resolve) => {
    const cb = 'dz' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    let done = false;
    const finish = (v) => { if (done) return; done = true; delete window[cb]; s.remove(); resolve(v); };
    window[cb] = (d) => finish(d && d.error ? null : d);
    s.onerror = () => finish(null);
    setTimeout(() => finish(null), timeout);
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.appendChild(s);
  });
}

async function lastfmTags(artist) {
  try {
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&artist=${encodeURIComponent(artist)}&autocorrect=1&api_key=${LASTFM_KEY}&format=json`);
    if (!r.ok) return undefined;
    const j = await r.json();
    if (j.error === 29) return undefined; // rate limit
    return (j.toptags && j.toptags.tag ? j.toptags.tag : []).slice(0, 10).map((t) => [t.name, t.count]);
  } catch (e) { return undefined; }
}
async function deezerArtist(name) {
  const j = await jsonp('https://api.deezer.com/search/artist?limit=8&q=' + encodeURIComponent(name));
  if (!j) return undefined;
  const t = norm(name);
  const c = (j.data || []).filter((x) => norm(x.name) === t).sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))[0];
  return c ? hashFrom(c.picture_xl, 'artist') : 0;
}
// cover + original release year (earliest date among editions with the same title)
async function deezerAlbum(artist, album) {
  const j = await jsonp('https://api.deezer.com/search/album?limit=10&q=' + encodeURIComponent(artist + ' ' + album));
  if (!j) return undefined;
  const ta = norm(artist), tl = norm(album);
  const cands = (j.data || []).filter((x) => norm(x.artist && x.artist.name) === ta && norm(x.title) === tl).slice(0, 3);
  if (!cands.length) return { cover: 0, year: 0 };
  let cover = 0, best = 0;
  for (const c of cands) {
    cover = cover || hashFrom(c.cover_xl, 'cover');
    await sleep(200);
    const d = await jsonp('https://api.deezer.com/album/' + c.id);
    const y = +String((d && d.release_date) || '').slice(0, 4);
    if (y >= 1900 && y <= 2100 && (!best || y < best)) best = y;
  }
  return { cover, year: best };
}
async function mbCountry(name) {
  try {
    const r = await fetch('https://musicbrainz.org/ws/2/artist?fmt=json&limit=5&query=' + encodeURIComponent(`artist:"${name.replace(/(["\\])/g, '\\$1')}"`));
    if (r.status === 503 || r.status === 429) return undefined;
    if (!r.ok) return undefined;
    const j = await r.json();
    const t = norm(name);
    const c = (j.artists || []).filter((a) => norm(a.name) === t || norm(a['sort-name']) === t).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    if (!c) return 0;
    return c.country || (c.area && c.area['iso-3166-1-codes'] && c.area['iso-3166-1-codes'][0]) || 0;
  } catch (e) { return undefined; }
}

const PLAN = [
  { kind: 'tags', from: 0, to: 300, label: 'Fetching genres' },
  { kind: 'images', from: 0, to: 120, albums: [0, 120], label: 'Fetching photos and covers' },
  { milestone: true },
  { kind: 'tags', from: 300, to: 1000, label: 'Fetching genres' },
  { kind: 'images', from: 120, to: 400, albums: [120, 400], label: 'Fetching photos and covers' },
  { milestone: true },
  { kind: 'country', from: 0, to: 150, label: 'Finding artist countries' },
  { milestone: true },
];
const MORE = [
  { kind: 'tags', from: 1000, to: 2500, label: 'Fetching genres' },
  { kind: 'images', from: 400, to: 1000, albums: [400, 1200], label: 'Fetching photos and covers' },
  { milestone: true },
  { kind: 'country', from: 150, to: 500, label: 'Finding artist countries' },
  { milestone: true },
];

export function createEnricher({ onProgress = () => {}, onMilestone = async () => {}, scale = 1 } = {}) {
  let tags, images, meta, queue;
  let stopped = false, running = false, dirty = false;
  const prog = { label: '', done: 0, total: 0, finished: false, running: false };
  const emit = () => onProgress({ ...prog });

  async function save() {
    await store.putMany({ tags, images, meta });
  }
  const scaled = (n) => (n === 0 ? 0 : Math.max(1, Math.round(n * scale)));
  const pendingArtists = (from, to, map) => queue.artists.slice(scaled(from), scaled(to)).filter((n) => !Object.hasOwn(map, n));
  const pendingAlbums = (from, to) => queue.albums.slice(scaled(from), scaled(to)).filter(([a, al]) => { const k = a + SEP + al; return !Object.hasOwn(images.l, k) || !Object.hasOwn(meta.yr, k); });

  async function runStep(step) {
    prog.label = step.label;
    let fails = 0;
    const tick = async (every) => { prog.done++; if (prog.done % 20 === 0) { await save(); } emit(); await sleep(every); };
    if (step.kind === 'tags') {
      for (const n of pendingArtists(step.from, step.to, tags)) {
        if (stopped) return;
        const r = await lastfmTags(n);
        if (r === undefined) { if (++fails >= 10) return; await sleep(1500); continue; }
        fails = 0; tags[n] = r; dirty = true; await tick(250);
      }
    } else if (step.kind === 'images') {
      for (const n of pendingArtists(step.from, step.to, images.a)) {
        if (stopped) return;
        const r = await deezerArtist(n);
        if (r === undefined) { if (++fails >= 10) return; await sleep(1500); continue; }
        fails = 0; images.a[n] = r; await tick(220);
      }
      for (const [a, al] of pendingAlbums(step.albums[0], step.albums[1])) {
        if (stopped) return;
        const r = await deezerAlbum(a, al);
        if (r === undefined) { if (++fails >= 10) return; await sleep(1500); continue; }
        fails = 0; const k = a + SEP + al; images.l[k] = r.cover; meta.yr[k] = r.year; dirty = true; await tick(220);
      }
    } else if (step.kind === 'country') {
      for (const n of pendingArtists(step.from, step.to, meta.ar)) {
        if (stopped) return;
        const r = await mbCountry(n);
        if (r === undefined) { if (++fails >= 6) return; await sleep(4000); continue; }
        fails = 0; meta.ar[n] = r; dirty = true; await tick(1100);
      }
    }
  }
  const countTotal = (plan) => plan.reduce((s, st) => {
    if (st.milestone) return s;
    if (st.kind === 'tags') return s + pendingArtists(st.from, st.to, tags).length;
    if (st.kind === 'images') return s + pendingArtists(st.from, st.to, images.a).length + pendingAlbums(st.albums[0], st.albums[1]).length;
    return s + pendingArtists(st.from, st.to, meta.ar).length;
  }, 0);

  async function run(plan = PLAN) {
    if (running) return;
    running = true; stopped = false;
    tags = (await store.get('tags')) || {};
    images = (await store.get('images')) || { a: {}, l: {} };
    meta = (await store.get('meta')) || { ar: {}, yr: {} };
    queue = await store.get('queue');
    if (!queue) { running = false; return; }
    prog.done = 0; prog.total = countTotal(plan); prog.finished = false; prog.running = true; emit();
    for (const step of plan) {
      if (stopped) break;
      if (step.milestone) { await save(); if (dirty) { dirty = false; try { await onMilestone(); } catch (e) { /* the next milestone tries again */ } } continue; }
      await runStep(step);
    }
    await save();
    prog.running = false; prog.finished = !stopped; emit();
    running = false;
  }
  return {
    run,
    more: () => run(MORE),
    stop: () => { stopped = true; },
    get running() { return running; },
  };
}
