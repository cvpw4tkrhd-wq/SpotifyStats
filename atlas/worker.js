// Import worker: reads the Spotify export (zip or json), keeps only listening to music, stores it on the device
// and runs the shared analysis. Runs off the main thread so the page stays responsive.
import { Unzip, UnzipInflate, UnzipPassThrough } from './vendor/fflate.js';
import { analyzeAll } from './core.js';
import * as store from './store.js';

const post = (m) => postMessage(m);
const RS = { trackdone: 't', clickrow: 'c', clickside: 'c', fwdbtn: 'f', backbtn: 'b', playbtn: 'p', appload: 'a', remote: 'r', trackerror: 'e' };

function platformFamily(p) {
  const s = String(p || '').toLowerCase().trim();
  if (s.startsWith('webplayer') || s.startsWith('web_player')) return 'b';
  if (s.startsWith('ios') || s.startsWith('iphone') || s.startsWith('ipad')) return 'i';
  if (s.startsWith('android')) return 'a';
  if (s.includes('windows')) return 'w';
  if (s.startsWith('os x') || s.startsWith('osx') || s.startsWith('mac')) return 'm';
  if (s.includes('linux')) return 'l';
  if (s.startsWith('partner') || s.startsWith('cast')) return 't';
  return 'o';
}
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

// Extended streaming history: Streaming_History_Audio_*.json
function fromExtended(r, out, seen, stats) {
  const n = r.master_metadata_track_name, a = r.master_metadata_album_artist_name, uri = r.spotify_track_uri;
  if (!(n && a && uri)) { stats.notMusic++; return; }
  if (r.incognito_mode) { stats.incognito++; return; }
  const ms = r.ms_played, fwd = r.reason_end === 'fwdbtn';
  if (ms < 5000 && !fwd) return;
  const key = r.ts + uri;
  if (seen.has(key)) return;
  seen.add(key);
  const row = { t: r.ts, id: uri.slice(uri.lastIndexOf(':') + 1), n, a, al: r.master_metadata_album_album_name || '', ms, e: 1,
    x: (RS[r.reason_start] || 'o') + platformFamily(r.platform) + (r.shuffle ? '1' : '0') };
  if (r.ts >= '2017-01-01') row.sk = fwd ? 1 : 0;
  out.push(row);
}
// Account data (last 12 months): StreamingHistory0.json = [{ endTime, artistName, trackName, msPlayed }]
function fromAccount(r, out, seen) {
  if (!r.trackName || !r.artistName || !(r.msPlayed >= 5000)) return;
  const t = String(r.endTime).replace(' ', 'T') + (String(r.endTime).length <= 16 ? ':00Z' : 'Z');
  const key = t + r.artistName + r.trackName;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ t, id: 'h' + hash(r.artistName + '\u0001' + r.trackName), n: r.trackName, a: r.artistName, al: '', ms: r.msPlayed, e: 1 });
}

const WANT = /(^|\/)(Streaming_History_Audio_[^/]*|StreamingHistory(_music)?_?\d*)\.json$/i;
const SKIP = /podcast|video/i;

async function readZip(file, onEntry, onBytes) {
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.register(UnzipPassThrough);
  let failure = null;
  uz.onfile = (f) => {
    if (!WANT.test(f.name) || SKIP.test(f.name)) return; // other files in the export are never read
    const chunks = []; let size = 0;
    f.ondata = (err, chunk, final) => {
      if (err) { failure = err; return; }
      chunks.push(chunk); size += chunk.length;
      if (final) {
        const u8 = new Uint8Array(size); let o = 0;
        for (const c of chunks) { u8.set(c, o); o += c.length; }
        chunks.length = 0;
        onEntry(f.name, u8);
      }
    };
    f.start();
  };
  const CH = 1 << 20;
  for (let off = 0; off < file.size; off += CH) {
    const end = Math.min(file.size, off + CH);
    uz.push(new Uint8Array(await file.slice(off, end).arrayBuffer()), end >= file.size);
    onBytes(end - off);
    if (failure) throw failure;
  }
}

async function saveResults(res, extra) {
  const put = {};
  for (const [k, v] of Object.entries(res.files)) put[k] = JSON.stringify(v);
  put.queue = res.queue;
  Object.assign(put, extra || {});
  await store.putMany(put);
}

async function doImport({ files, tz }) {
  const t0 = Date.now();
  const plays = [], seen = new Set();
  const stats = { notMusic: 0, incognito: 0, files: 0 };
  const total = files.reduce((s, f) => s + f.size, 0) || 1;
  let done = 0;
  const report = (phase) => post({ type: 'progress', phase, ratio: Math.min(1, done / total) });
  const ingest = (name, u8OrText) => {
    const text = typeof u8OrText === 'string' ? u8OrText : new TextDecoder().decode(u8OrText);
    let arr;
    try { arr = JSON.parse(text); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    stats.files++;
    for (const r of arr) {
      if (r && r.ts !== undefined && 'master_metadata_track_name' in r) fromExtended(r, plays, seen, stats);
      else if (r && r.endTime !== undefined && r.trackName !== undefined) fromAccount(r, plays, seen);
    }
  };
  report('Reading your export');
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) await readZip(file, ingest, (n) => { done += n; report('Reading your export'); });
    else if (lower.endsWith('.json')) {
      if (!SKIP.test(file.name)) ingest(file.name, await file.text());
      done += file.size; report('Reading your export');
    } else throw new Error(`"${file.name}" is not supported. Drop the .zip you got from Spotify, or its .json files.`);
  }
  if (!plays.length) throw new Error('No music listening history was found in that file. Make sure it is the "Extended streaming history" (or "Account data") export, unchanged as Spotify sent it.');

  post({ type: 'progress', phase: 'Saving on this device', ratio: 1 });
  await store.delPrefix('plays:');
  const byYear = {};
  for (const p of plays) (byYear[p.t.slice(0, 4)] ||= []).push(p);
  const put = {};
  for (const [y, rows] of Object.entries(byYear)) put['plays:' + y] = JSON.stringify(rows);
  await store.putMany(put);

  post({ type: 'progress', phase: 'Analysing your listening', ratio: 1, indeterminate: true });
  const tags = (await store.get('tags')) || {};
  const meta = (await store.get('meta')) || { ar: {}, yr: {} };
  const res = analyzeAll({ plays, tags, meta, tz });
  await saveResults(res, { profile: { importedAt: Date.now(), tz, rows: plays.length, files: stats.files, incognitoSkipped: stats.incognito } });
  const s = res.files.summary;
  post({ type: 'done', info: { rows: plays.length, months: Object.keys(s.months).length, first: s.meta.firstYm, last: s.meta.lastYm, incognito: stats.incognito, ms: Date.now() - t0 } });
}

async function doReanalyze({ tz }) {
  const keys = (await store.keys()).filter((k) => String(k).startsWith('plays:'));
  let plays = [];
  for (const k of keys) plays = plays.concat(JSON.parse(await store.get(k)));
  const tags = (await store.get('tags')) || {};
  const meta = (await store.get('meta')) || { ar: {}, yr: {} };
  const res = analyzeAll({ plays, tags, meta, tz });
  if (!res) throw new Error('There is no stored listening history to analyse.');
  await saveResults(res);
  post({ type: 'done', info: { rows: plays.length } });
}

self.onmessage = async (e) => {
  try {
    if (e.data.type === 'import') await doImport(e.data);
    else if (e.data.type === 'reanalyze') await doReanalyze(e.data);
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};
