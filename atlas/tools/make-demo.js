// Generates the fictional demo data (artists, tracks and plays are invented) with the same analysis core the app uses.
// Run: node tools/make-demo.js
import fs from 'node:fs';
import { analyzeAll } from '../core.js';

function rng(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(42);
const pick = (arr) => arr[Math.floor(R() * arr.length)];

// [name, tags, centre month, width, base weight, country]
const A = [
  ['Nordlys', [['indie', 100], ['dream pop', 80], ['chill', 60]], 2, 7, 0.4, 'NO'],
  ['Velvet Static', [['shoegaze', 100], ['indie rock', 80], ['alternative', 60]], 3, 6, 0.3, 'GB'],
  ['Mossa', [['ambient', 100], ['chillout', 70], ['instrumental', 60]], 4, 8, 0.5, 'SE'],
  ['The Paper Lanterns', [['folk', 100], ['singer-songwriter', 90], ['acoustic', 70]], 1, 6, 0.3, 'US'],
  ['Saltkråkan', [['indie pop', 100], ['pop', 70], ['happy', 40]], 6, 6, 0.2, 'SE'],
  ['Hollow Ground', [['post-rock', 100], ['instrumental', 80], ['atmospheric', 60]], 5, 7, 0.3, 'US'],
  ['Kvarts', [['electronic', 100], ['downtempo', 80], ['chill', 60]], 8, 6, 0.2, 'DE'],
  ['Lilla Eld', [['pop', 100], ['synth-pop', 80], ['dance pop', 60]], 9, 5, 0.2, 'SE'],
  ['Brass & Bone', [['rock', 100], ['alternative rock', 80], ['indie rock', 50]], 10, 6, 0.2, 'US'],
  ['Dagny Vale', [['singer-songwriter', 100], ['folk', 80], ['melancholy', 60]], 11, 5, 0.2, 'CA'],
  ['Neon Harbor', [['synthpop', 100], ['electronic', 80], ['disco', 50]], 12, 6, 0.1, 'GB'],
  ['Iron Meridian', [['metal', 100], ['heavy metal', 90], ['hard rock', 70]], 14, 5, 0.0, 'FI'],
  ['Rökmoln', [['hip-hop', 100], ['rap', 90]], 13, 6, 0.1, 'SE'],
  ['Static Chapel', [['post-punk', 100], ['gothic rock', 80], ['dark', 70]], 15, 5, 0.0, 'GB'],
  ['Fjärilsdans', [['house', 100], ['deep house', 90], ['dance', 70]], 16, 6, 0.0, 'SE'],
  ['Blåbär', [['soul', 100], ['r&b', 90], ['love songs', 50]], 17, 6, 0.1, 'SE'],
  ['Marlow Quartet', [['jazz', 100], ['instrumental', 80], ['piano', 60]], 18, 6, 0.1, 'US'],
  ['Terrazzo', [['funk', 100], ['disco', 80], ['happy', 70]], 19, 5, 0.0, 'FR'],
  ['Echo Parade', [['punk rock', 100], ['pop punk', 90], ['energetic', 60]], 20, 5, 0.0, 'AU'],
  ['Silvergran', [['dream pop', 100], ['chillwave', 80], ['dreamy', 60]], 21, 5, 0.0, 'SE'],
  ['Orkan', [['hardcore', 100], ['punk', 80], ['metalcore', 60]], 16, 4, 0.0, 'NO'],
  ['Lykta', [['lo-fi', 100], ['chill', 90], ['instrumental', 60]], 7, 12, 0.3, 'JP'],
  ['Grå Vinter', [['blues', 100], ['sad', 70], ['singer-songwriter', 60]], 0, 4, 0.1, 'SE'],
  ['Cobalt Sky', [['trance', 100], ['electronic', 90], ['techno', 50]], 18, 4, 0.0, 'NL'],
  ['Ruby Lane', [['country', 100], ['folk', 60], ['happy', 40]], 5, 5, 0.0, 'US'],
];
const tags = {}, ar = {}, yr = {};
for (const [n, t, , , , c] of A) { tags[n] = t; ar[n] = c; }
const W1 = ['Midnight', 'Paper', 'Glass', 'Slow', 'Northern', 'Golden', 'Quiet', 'Burning', 'Soft', 'Electric', 'Winter', 'Harbor', 'Velvet', 'Distant', 'Neon', 'Salt'];
const W2 = ['Letters', 'Rivers', 'Hours', 'Lights', 'Fires', 'Echoes', 'Roads', 'Windows', 'Skies', 'Tides', 'Gardens', 'Machines', 'Signals', 'Rooms', 'Dreams'];
const trackNames = {}, albumNames = {};
for (const [n] of A) {
  trackNames[n] = Array.from({ length: 7 }, () => pick(W1) + ' ' + pick(W2));
  albumNames[n] = [pick(W1) + ' ' + pick(W2), pick(W1) + ' ' + pick(W2)];
  for (const al of albumNames[n]) yr[n + '\u2016' + al] = pick([1971, 1984, 1993, 1999, 2004, 2009, 2012, 2015, 2017, 2019, 2021, 2023]);
}
const REASONS = 'ttttttttttccccffffppaarro';
const DEVICES = 'iiiiiiiwwmmaatb';

const plays = [];
const start = Date.UTC(2025, 0, 1), end = Date.UTC(2026, 9, 26);
for (let t = start; t <= end; t += 864e5) {
  const d = new Date(t), mi = (d.getUTCFullYear() - 2025) * 12 + d.getUTCMonth(), wd = (d.getUTCDay() + 6) % 7;
  let n = Math.round(14 + R() * 14 + (wd >= 5 ? 8 : 0) + (mi > 12 ? 6 : 0));
  if (R() < 0.08) n = 0;
  const w = A.map(([, , c, wi, b]) => b + Math.exp(-0.5 * (((mi - c) / (wi / 2)) ** 2)));
  const sum = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    let r = R() * sum, k = 0;
    while (k < w.length - 1 && r > w[k]) { r -= w[k]; k++; }
    const name = A[k][0], pr = R();
    let h = pr < 0.28 ? 6 + Math.floor(R() * 3) : pr < 0.5 ? 15 + Math.floor(R() * 3) : pr < 0.9 ? 19 + Math.floor(R() * 5) : 10 + Math.floor(R() * 5);
    if (wd >= 5) h = 9 + Math.floor(R() * 14);
    const ts = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.min(23, h), Math.floor(R() * 60), Math.floor(R() * 60)));
    const skipped = R() < 0.22;
    const tn = pick(trackNames[name]);
    plays.push({
      t: ts.toISOString().replace('.000Z', 'Z'), id: name + tn, n: tn, a: name, al: pick(albumNames[name]),
      ms: skipped ? 2000 + Math.floor(R() * 18000) : 150000 + Math.floor(R() * 120000), e: 1,
      x: (skipped ? 'f' : pick(REASONS.split(''))) + pick(DEVICES.split('')) + (R() < 0.4 ? '1' : '0'), sk: skipped ? 1 : 0,
    });
  }
}
const res = analyzeAll({ plays, tags, meta: { ar, yr }, tz: 'UTC', demo: true, detailN: 200 });
fs.mkdirSync(new URL('../demo/', import.meta.url), { recursive: true });
for (const [k, v] of Object.entries(res.files)) fs.writeFileSync(new URL(`../demo/${k}.json`, import.meta.url), JSON.stringify(v));
console.log('demo written:', plays.length, 'plays,', Object.keys(res.files.summary.months).length, 'months');
