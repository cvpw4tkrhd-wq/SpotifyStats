// Reads data/plays/*.json + data/artists.json and writes data/summary.json
// Run: node scripts/analyze.mjs
import fs from 'node:fs';
import path from 'node:path';
import { MOODS, moodVector, primaryGenre, topGenres } from './moods.mjs';

const DATA = process.env.DATA_DIR || 'data';
const OUT = process.env.OUT_FILE || path.join(DATA, 'summary.json');
const TZ = 'Europe/Stockholm';
const DEMO = process.env.DEMO === '1';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ---------- load ----------
const dir = path.join(DATA, 'plays');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
let plays = [];
for (const f of files) plays = plays.concat(readJson(path.join(dir, f), []));
if (!plays.length) {
  console.log('No plays yet - leaving summary.json untouched.');
  process.exit(0);
}
const tags = readJson(path.join(DATA, 'artists.json'), {});

// Rows from the history import carry e:1. Drop live-collector rows that duplicate one of them
// (same track, within 5 seconds) so overlapping days are not counted twice.
const importTimes = new Map();
for (const p of plays) {
  if (!p.e) continue;
  let arr = importTimes.get(p.id);
  if (!arr) { arr = []; importTimes.set(p.id, arr); }
  arr.push(Date.parse(p.t));
}
if (importTimes.size) {
  plays = plays.filter((p) => {
    if (p.e) return true;
    const arr = importTimes.get(p.id);
    if (!arr) return true;
    const t = Date.parse(p.t);
    return !arr.some((x) => Math.abs(x - t) <= 5000);
  });
}

// ---------- local time ----------
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
});
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function local(t) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: p.year, m: p.month, d: p.day, h: +p.hour, wd: WD.indexOf(p.weekday) };
}
const monthLabel = (ym) => {
  const [y, m] = ym.split('-');
  return new Date(Date.UTC(+y, +m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// ---------- rows ----------
const gCache = new Map();
const mCache = new Map();
const allRows = plays.map((p) => {
  const l = local(p.t);
  const a = p.a || 'Unknown';
  if (!gCache.has(a)) {
    const tg = tags[a] || [];
    gCache.set(a, primaryGenre(tg));
    mCache.set(a, moodVector(tg));
  }
  return {
    ym: `${l.y}-${l.m}`, y: l.y, date: `${l.y}-${l.m}-${l.d}`, day: +l.d, h: l.h, wd: l.wd,
    min: (p.ms || 180000) / 60000, a, n: p.n || 'Unknown', al: p.al || '',
    g: gCache.get(a), mv: mCache.get(a), sk: p.sk,
  };
});

// A play counts after 30 seconds. Shorter rows are only used for the skip rate.
const rows = allRows.filter((r) => r.min >= 0.5);

const skT = new Map(); // period -> [rows, skipped]
for (const r of allRows) {
  if (r.sk === undefined) continue;
  for (const k of [r.ym, r.y, 'all']) {
    let e = skT.get(k);
    if (!e) { e = [0, 0]; skT.set(k, e); }
    e[0]++; if (r.sk) e[1]++;
  }
}
const skipRateFor = (k) => { const e = skT.get(k || 'all'); return e && e[0] >= 20 ? +(e[1] / e[0]).toFixed(3) : null; };

const firstSeen = new Map();
for (const r of rows) {
  const cur = firstSeen.get(r.a);
  if (!cur || r.date < cur) firstSeen.set(r.a, r.date);
}

// ---------- aggregate ----------
const topN = (map, n, f) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(f);

function agg(rs, period, withDays) {
  const am = new Map(), ap = new Map(), tr = new Map(), al = new Map(), gn = new Map();
  const moods = {};
  const hm = new Array(168).fill(0);
  const days = {};
  let min = 0, unc = 0;

  for (const r of rs) {
    min += r.min;
    am.set(r.a, (am.get(r.a) || 0) + r.min);
    ap.set(r.a, (ap.get(r.a) || 0) + 1);
    const tk = r.n + '\u0001' + r.a;
    let t = tr.get(tk);
    if (!t) { t = { n: r.n, a: r.a, p: 0, m: 0 }; tr.set(tk, t); }
    t.p++; t.m += r.min;
    if (r.al) {
      const ak = r.al + '\u0001' + r.a;
      let x = al.get(ak);
      if (!x) { x = { n: r.al, a: r.a, p: 0, m: 0 }; al.set(ak, x); }
      x.p++; x.m += r.min;
    }
    if (r.g) gn.set(r.g, (gn.get(r.g) || 0) + r.min);
    if (r.mv) { for (const m in r.mv) moods[m] = (moods[m] || 0) + r.min * r.mv[m]; } else unc += r.min;
    hm[r.wd * 24 + r.h] += r.min;
    days[r.day] = (days[r.day] || 0) + r.min;
  }

  let H = 0;
  for (const m of am.values()) { const q = m / min; if (q > 0) H -= q * Math.log(q); }
  const variety = am.size > 1 ? H / Math.log(am.size) : 0;

  let newA = 0;
  for (const a of am.keys()) if (!period || firstSeen.get(a).startsWith(period)) newA++;

  const moodsR = {};
  let dom = null, best = 0;
  for (const [k, v] of Object.entries(moods)) {
    moodsR[k] = Math.round(v);
    if (v > best) { best = v; dom = k; }
  }
  const lst = (map, n) => [...map.values()].sort((a, b) => b.p - a.p || b.m - a.m).slice(0, n)
    .map((x) => ({ n: x.n, a: x.a, p: x.p, m: Math.round(x.m) }));

  const out = {
    hours: +(min / 60).toFixed(1),
    plays: rs.length,
    artists: am.size,
    newArtists: newA,
    variety: +variety.toFixed(3),
    eff: Math.round(Math.exp(H)),
    skipRate: skipRateFor(period),
    dom,
    moods: moodsR,
    unclassified: Math.round(unc),
    topArtists: topN(am, 20, ([n, m]) => ({ n, m: Math.round(m), p: ap.get(n) })),
    topTracks: lst(tr, 10),
    topAlbums: [...al.values()].sort((a, b) => b.m - a.m).slice(0, 10).map((x) => ({ n: x.n, a: x.a, p: x.p, m: Math.round(x.m) })),
    genres: topN(gn, 12, ([g, m]) => [g, Math.round(m)]),
    hm: hm.map(Math.round),
    _g: gn,
  };
  if (withDays) out.days = Object.fromEntries(Object.entries(days).map(([d, m]) => [d, Math.round(m)]));
  return out;
}

// Share of listening (0-100) that sits in different genres than in the other period
function genreShift(a, b) {
  let ta = 0, tb = 0;
  for (const v of a.values()) ta += v;
  for (const v of b.values()) tb += v;
  if (!ta || !tb) return null;
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(k) || 0) / ta - (b.get(k) || 0) / tb);
  return Math.round((d / 2) * 100);
}

function churn(cur, prev) {
  if (!prev) return null;
  const a = cur.topArtists.map((x) => x.n);
  const A = new Set(a);
  const B = new Set(prev.topArtists.map((x) => x.n));
  return {
    kept: a.filter((x) => B.has(x)).length,
    of: a.length,
    newIn: a.filter((x) => !B.has(x)).slice(0, 6),
    out: [...B].filter((x) => !A.has(x)).slice(0, 6),
  };
}

function group(keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const byMonth = group((r) => r.ym);
const byYear = group((r) => r.y);
const monthKeys = [...byMonth.keys()].sort();
const yearKeys = [...byYear.keys()].sort();

const months = {};
for (const k of monthKeys) months[k] = agg(byMonth.get(k), k, true);
const years = {};
for (const k of yearKeys) years[k] = agg(byYear.get(k), k, false);
const all = agg(rows, null, false);

function link(keys, set) {
  keys.forEach((k, i) => {
    const cur = set[k];
    const prev = i ? set[keys[i - 1]] : null;
    cur.churn = churn(cur, prev);
    cur.tasteShift = prev ? genreShift(cur._g, prev._g) : null;
  });
}
link(monthKeys, months);
link(yearKeys, years);
for (const set of [months, years, { all }]) for (const v of Object.values(set)) delete v._g;

// ---------- highlights ----------
const H = [];
const lab = (k) => MOODS[k]?.label || k;
monthKeys.forEach((ym, i) => {
  if (!i) return;
  const c = months[ym], p = months[monthKeys[i - 1]];
  const L = monthLabel(ym);
  const g1 = c.genres[0]?.[0], g0 = p.genres[0]?.[0];
  if (g1 && g0 && g1 !== g0) H.push({ ym, text: `In ${L} your top genre switched from ${g0} to ${g1}.` });
  if (c.dom && p.dom && c.dom !== p.dom) H.push({ ym, text: `Your dominant mood moved from ${lab(p.dom)} to ${lab(c.dom)}.` });
  const a1 = c.topArtists[0]?.n, a0 = p.topArtists[0]?.n;
  if (a1 && a0 && a1 !== a0) H.push({ ym, text: `${a1} took over from ${a0} as your most played artist.` });
  const prevMax = Math.max(...monthKeys.slice(1, i).map((k) => months[k].newArtists), 0);
  if (c.newArtists >= 10 && c.newArtists > prevMax) H.push({ ym, text: `You discovered ${c.newArtists} new artists, your most in any month so far.` });
  if (p.hours > 0) {
    const ch = Math.round(((c.hours - p.hours) / p.hours) * 100);
    if (Math.abs(ch) >= 25) H.push({ ym, text: `Listening time ${ch > 0 ? 'rose' : 'fell'} ${Math.abs(ch)}% to ${c.hours} hours.` });
  }
});
yearKeys.forEach((y, i) => {
  if (!i) return;
  const c = years[y], p = years[yearKeys[i - 1]];
  const g1 = c.genres[0]?.[0], g0 = p.genres[0]?.[0];
  if (g1 && g0 && g1 !== g0) H.push({ ym: y, text: `${y}: your top genre changed from ${g0} to ${g1}.` });
  if (p.hours > 0) {
    const ch = Math.round(((c.hours - p.hours) / p.hours) * 100);
    if (Math.abs(ch) >= 10) H.push({ ym: y, text: `You listened ${Math.abs(ch)}% ${ch > 0 ? 'more' : 'less'} in ${y} than in ${yearKeys[i - 1]}.` });
  }
});
H.sort((a, b) => (a.ym < b.ym ? 1 : -1));

// ---------- deep-dive data: artists and tracks ----------
const r1 = (x) => Math.round(x);
const yrStr = (o) => Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${r1(v)}`).join(',');

const AR = new Map();
for (const r of rows) {
  let x = AR.get(r.a);
  if (!x) { x = { n: r.a, min: 0, p: 0, f: r.date, l: r.date, yrs: {}, mo: {}, tr: new Map(), al: new Map() }; AR.set(r.a, x); }
  x.min += r.min; x.p++;
  if (r.date < x.f) x.f = r.date;
  if (r.date > x.l) x.l = r.date;
  x.yrs[r.y] = (x.yrs[r.y] || 0) + r.min;
  x.mo[r.ym] = (x.mo[r.ym] || 0) + r.min;
  let t = x.tr.get(r.n);
  if (!t) { t = { n: r.n, a: r.a, al: r.al, p: 0, m: 0, y: {}, f: r.date, l: r.date }; x.tr.set(r.n, t); }
  t.p++; t.m += r.min; t.y[r.y] = (t.y[r.y] || 0) + 1;
  if (r.date < t.f) t.f = r.date;
  if (r.date > t.l) t.l = r.date;
  if (!t.al && r.al) t.al = r.al;
  if (r.al) {
    let b = x.al.get(r.al);
    if (!b) { b = { n: r.al, p: 0, m: 0 }; x.al.set(r.al, b); }
    b.p++; b.m += r.min;
  }
}
const skA = new Map();
for (const r of allRows) {
  if (r.sk === undefined) continue;
  let e = skA.get(r.a);
  if (!e) { e = [0, 0]; skA.set(r.a, e); }
  e[0]++; if (r.sk) e[1]++;
}

// Light index of every artist (for search and ranking): [name, minutes, plays, first, last, "year:minutes,..."]
const ranked = [...AR.values()].sort((a, b) => b.min - a.min);
const artistIndex = ranked.map((x) => [x.n, r1(x.min), x.p, x.f, x.l, yrStr(x.yrs)]);

// Full detail for the top artists
const DETAIL_N = +(process.env.DETAIL_N || 1000);
const details = {};
for (const x of ranked.slice(0, DETAIL_N)) {
  const sk = skA.get(x.n);
  const mv = mCache.get(x.n);
  let md = null, best = 0;
  if (mv) for (const [k, v] of Object.entries(mv)) if (v > best) { best = v; md = k; }
  details[x.n] = {
    m: r1(x.min), p: x.p, f: x.f, l: x.l,
    mo: Object.fromEntries(Object.entries(x.mo).sort().map(([k, v]) => [k, r1(v)])),
    t: [...x.tr.values()].sort((a, b) => b.p - a.p || b.m - a.m).slice(0, 25).map((t) => [t.n, t.p, r1(t.m), yrStr(t.y), t.al]),
    al: [...x.al.values()].sort((a, b) => b.m - a.m).slice(0, 8).map((b) => [b.n, b.p, r1(b.m)]),
    sk: sk && sk[0] >= 10 ? +(sk[1] / sk[0]).toFixed(3) : null,
    tg: topGenres(tags[x.n] || [], 4),
    md,
  };
}

// Track index: top 1500 overall plus the top 100 of every year
const allTracks = [];
for (const x of AR.values()) for (const t of x.tr.values()) allTracks.push(t);
allTracks.sort((a, b) => b.p - a.p || b.m - a.m);
const keepT = new Set(allTracks.slice(0, 1500));
const perYear = new Map();
for (const t of allTracks) for (const [y, c] of Object.entries(t.y)) {
  let arr = perYear.get(y);
  if (!arr) { arr = []; perYear.set(y, arr); }
  arr.push([c, t]);
}
for (const arr of perYear.values()) { arr.sort((a, b) => b[0] - a[0]); arr.slice(0, 100).forEach(([, t]) => keepT.add(t)); }
const trackIndex = allTracks.filter((t) => keepT.has(t)).map((t) => [t.n, t.a, t.al || '', t.p, r1(t.m), t.f, t.l, yrStr(t.y)]);

// ---------- write ----------
const moodMeta = {};
for (const [k, m] of Object.entries(MOODS)) moodMeta[k] = { label: m.label, color: m.color, color2: m.color2 };

const summary = {
  generated: new Date().toISOString(),
  meta: { firstYm: monthKeys[0], lastYm: monthKeys[monthKeys.length - 1], totalPlays: rows.length, tz: TZ, demo: DEMO, moods: moodMeta },
  months, years, all,
  highlights: H.slice(0, 80),
};

function writeIfChanged(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

let changed = false;
const prevSummary = readJson(OUT, null);
if (!(prevSummary && JSON.stringify({ ...prevSummary, generated: 0 }) === JSON.stringify({ ...summary, generated: 0 }))) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary));
  changed = true;
}
const outDir = path.dirname(OUT);
for (const [name, obj] of [['artist-index.json', artistIndex], ['artist-details.json', details], ['track-index.json', trackIndex]]) {
  if (writeIfChanged(path.join(outDir, name), JSON.stringify(obj))) changed = true;
}
console.log(changed ? `Data files updated: ${rows.length} plays, ${monthKeys.length} months, ${artistIndex.length} artists, ${trackIndex.length} tracks indexed.` : 'No changes.');
