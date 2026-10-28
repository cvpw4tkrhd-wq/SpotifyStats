// Shared analysis core. Used by the browser (worker) and can be used from Node.
// Input: plays [{t,id,n,a,al,ms,e,x,sk}], tags {artist: [[tag,count]]}, meta {ar:{}, yr:{}}, tz
import { MOODS, moodVector, primaryGenre, topGenres } from './moods.js';

const dd = (x, y) => (Math.abs(x - y) > 1e-6 ? x - y : 0); // minute totals that differ only by float rounding count as equal
const cmpS = (x, y) => (x < y ? -1 : x > y ? 1 : 0); // fixed tie-breaker so results do not depend on the order files were read

export function analyzeAll({ plays, tags = {}, meta = { ar: {}, yr: {} }, tz = 'UTC', demo = false, detailN = 1000 }) {
  if (!plays || !plays.length) return null;
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
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23',
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
    g: gCache.get(a), mv: mCache.get(a), sk: p.sk, t: p.t, x: p.x,
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
const topN = (map, n, f) => [...map.entries()].sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0])).slice(0, n).map(f);

function agg(rs, period, withDays) {
  const am = new Map(), ap = new Map(), tr = new Map(), al = new Map(), gn = new Map();
  const moods = {};
  const hm = new Array(168).fill(0);
  const days = {};
  let min = 0, unc = 0, newMin = 0;

  for (const r of rs) {
    min += r.min;
    if (period && firstSeen.get(r.a).startsWith(period)) newMin += r.min;
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
  const lst = (map, n) => [...map.values()].sort((a, b) => b.p - a.p || dd(b.m, a.m) || cmpS(a.n, b.n) || cmpS(a.a, b.a)).slice(0, n)
    .map((x) => ({ n: x.n, a: x.a, p: x.p, m: Math.round(x.m) }));

  const out = {
    hours: +(min / 60).toFixed(1),
    plays: rs.length,
    artists: am.size,
    newArtists: newA,
    newShare: period && min ? +(newMin / min).toFixed(3) : null,
    discover: period && period.length === 4
      ? [...am.entries()].filter(([a]) => firstSeen.get(a).startsWith(period)).sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0])).slice(0, 5).map(([n, m]) => ({ n, m: Math.round(m) }))
      : undefined,
    variety: +variety.toFixed(3),
    eff: Math.round(Math.exp(H)),
    skipRate: skipRateFor(period),
    dom,
    moods: moodsR,
    unclassified: Math.round(unc),
    topArtists: topN(am, 20, ([n, m]) => ({ n, m: Math.round(m), p: ap.get(n) })),
    topTracks: lst(tr, 10),
    topAlbums: [...al.values()].sort((a, b) => dd(b.m, a.m) || cmpS(a.n, b.n) || cmpS(a.a, b.a)).slice(0, 10).map((x) => ({ n: x.n, a: x.a, p: x.p, m: Math.round(x.m) })),
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
  if (!t) { t = { n: r.n, a: r.a, al: '', p: 0, m: 0, y: {}, f: r.date, l: r.date }; x.tr.set(r.n, t); }
  t.p++; t.m += r.min; t.y[r.y] = (t.y[r.y] || 0) + 1;
  if (r.date < t.f) t.f = r.date;
  if (r.date > t.l) t.l = r.date;
  if (r.al) { if (!t.al) { t.al = r.al; t.c1 = 1; } else if (r.al === t.al) t.c1++; else { t.alc = t.alc || {}; t.alc[r.al] = (t.alc[r.al] || 0) + 1; } }
  if (r.al) {
    let b = x.al.get(r.al);
    if (!b) { b = { n: r.al, p: 0, m: 0 }; x.al.set(r.al, b); }
    b.p++; b.m += r.min;
  }
}
for (const x of AR.values()) for (const t of x.tr.values()) {
  if (!t.alc) continue;
  let best = t.al, bc = t.c1;
  for (const [al, c] of Object.entries(t.alc)) if (c > bc || (c === bc && cmpS(al, best) < 0)) { best = al; bc = c; }
  t.al = best;
}
const skA = new Map();
for (const r of allRows) {
  if (r.sk === undefined) continue;
  let e = skA.get(r.a);
  if (!e) { e = [0, 0]; skA.set(r.a, e); }
  e[0]++; if (r.sk) e[1]++;
}

// Light index of every artist (for search and ranking): [name, minutes, plays, first, last, "year:minutes,..."]
const ranked = [...AR.values()].sort((a, b) => dd(b.min, a.min) || cmpS(a.n, b.n));
const artistIndex = ranked.map((x) => [x.n, r1(x.min), x.p, x.f, x.l, yrStr(x.yrs)]);

// Full detail for the top artists
const DETAIL_N = (detailN || 1000);
const details = {};
for (const x of ranked.slice(0, DETAIL_N)) {
  const sk = skA.get(x.n);
  const mv = mCache.get(x.n);
  let md = null, best = 0;
  if (mv) for (const [k, v] of Object.entries(mv)) if (v > best) { best = v; md = k; }
  details[x.n] = {
    m: r1(x.min), p: x.p, f: x.f, l: x.l,
    mo: Object.fromEntries(Object.entries(x.mo).sort().map(([k, v]) => [k, r1(v)])),
    t: [...x.tr.values()].sort((a, b) => b.p - a.p || dd(b.m, a.m) || cmpS(a.n, b.n)).slice(0, 25).map((t) => [t.n, t.p, r1(t.m), yrStr(t.y), t.al]),
    al: [...x.al.values()].sort((a, b) => dd(b.m, a.m) || cmpS(a.n, b.n)).slice(0, 8).map((b) => [b.n, b.p, r1(b.m)]),
    sk: sk && sk[0] >= 10 ? +(sk[1] / sk[0]).toFixed(3) : null,
    tg: topGenres(tags[x.n] || [], 4),
    md,
  };
}

// Track index: top 1500 overall plus the top 100 of every year
const allTracks = [];
for (const x of AR.values()) for (const t of x.tr.values()) allTracks.push(t);
allTracks.sort((a, b) => b.p - a.p || dd(b.m, a.m) || cmpS(a.n, b.n) || cmpS(a.a, b.a));
const keepT = new Set(allTracks.slice(0, 1500));
const perYear = new Map();
for (const t of allTracks) for (const [y, c] of Object.entries(t.y)) {
  let arr = perYear.get(y);
  if (!arr) { arr = []; perYear.set(y, arr); }
  arr.push([c, t]);
}
for (const arr of perYear.values()) { arr.sort((a, b) => b[0] - a[0] || cmpS(a[1].n, b[1].n) || cmpS(a[1].a, b[1].a)); arr.slice(0, 100).forEach(([, t]) => keepT.add(t)); }

// ---------- Phase 2: records, rhythm, sessions, on-this-day ----------
const MOOD_KEYS = Object.keys(MOODS);
const moodHour = {}, moodWd = {};
for (const m of MOOD_KEYS) { moodHour[m] = new Array(24).fill(0); moodWd[m] = new Array(7).fill(0); }
for (const r of rows) if (r.mv) for (const m in r.mv) { moodHour[m][r.h] += r.min * r.mv[m]; moodWd[m][r.wd] += r.min * r.mv[m]; }
const skH = Array.from({ length: 24 }, () => [0, 0]);
for (const r of allRows) if (r.sk !== undefined) { skH[r.h][0]++; if (r.sk) skH[r.h][1]++; }
const extra = {
  moodHour: Object.fromEntries(Object.entries(moodHour).map(([k, v]) => [k, v.map(Math.round)])),
  moodWd: Object.fromEntries(Object.entries(moodWd).map(([k, v]) => [k, v.map(Math.round)])),
  skipHour: skH.map(([n, y]) => (n >= 200 ? +(y / n).toFixed(3) : null)),
};

// records
const dayMin = new Map();
let firstRow = null;
for (const r of rows) {
  dayMin.set(r.date, (dayMin.get(r.date) || 0) + r.min);
  if (!firstRow || r.t < firstRow.t) firstRow = r;
}
const dnum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
const dayList = [...dayMin.keys()].sort();
let streak = { len: 0, from: null, to: null }, runFrom = dayList[0], prevN = null;
for (let i = 0; i < dayList.length; i++) {
  const n = dnum(dayList[i]);
  if (prevN !== null && n !== prevN + 1) runFrom = dayList[i];
  const len = n - dnum(runFrom) + 1;
  if (len > streak.len) streak = { len, from: runFrom, to: dayList[i] };
  prevN = n;
}
const topDayE = [...dayMin.entries()].sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0]))[0];

// listening sessions: tracks less than 20 minutes apart belong together
const ev = plays.map((p) => { const end = Date.parse(p.t), ms = p.ms || 180000; return [end - ms, end, ms]; }).sort((a, b) => a[0] - b[0]);
let sCount = 0, sMs = 0, sLongest = null, cur = null;
const sYear = {};
const finishS = (c) => {
  sCount++; sMs += c.ms;
  const y = String(new Date(c.start).getUTCFullYear());
  (sYear[y] ||= [0, 0]); sYear[y][0]++; sYear[y][1] += c.ms;
  if (!sLongest || c.ms > sLongest.ms) sLongest = c;
};
for (const [st, en, ms] of ev) {
  if (cur && st - cur.end <= 20 * 60e3) { cur.end = Math.max(cur.end, en); cur.ms += ms; cur.n++; }
  else { if (cur) finishS(cur); cur = { start: st, end: en, ms, n: 1 }; }
}
if (cur) finishS(cur);
const ls = sLongest ? local(sLongest.start) : null;
const records = {
  firstPlay: firstRow ? { n: firstRow.n, a: firstRow.a, date: firstRow.date } : null,
  streak,
  topDay: topDayE ? { date: topDayE[0], min: r1(topDayE[1]) } : null,
  activeDays: dayList.length,
  daysSinceFirst: firstRow ? Math.round(dnum(dayList[dayList.length - 1]) - dnum(firstRow.date)) + 1 : 0,
  sessions: {
    count: sCount,
    avgMin: sCount ? r1(sMs / 60000 / sCount) : 0,
    longest: sLongest ? { min: r1(sLongest.ms / 60000), n: sLongest.n, date: `${ls.y}-${ls.m}-${ls.d}` } : null,
    byYear: Object.fromEntries(Object.entries(sYear).sort().map(([y, [n, ms]]) => [y, r1(ms / 60000 / n)])),
  },
};

// "on this day": the top artist and track of every calendar day, per year
const otd = new Map();
for (const r of rows) {
  const k = r.date.slice(5) + '|' + r.y;
  let x = otd.get(k);
  if (!x) { x = { min: 0, a: new Map(), t: new Map() }; otd.set(k, x); }
  x.min += r.min;
  x.a.set(r.a, (x.a.get(r.a) || 0) + r.min);
  const tk = r.n + '\u0001' + r.a;
  x.t.set(tk, (x.t.get(tk) || 0) + 1);
}
const onThisDay = {};
for (const [k, x] of [...otd.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  if (x.min < 20) continue;
  const [md, y] = k.split('|');
  const ta = [...x.a.entries()].sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0]))[0];
  const tt = [...x.t.entries()].sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0]))[0];
  const [tn, tart] = tt[0].split('\u0001');
  (onThisDay[md] ||= []).push([+y, ta[0], tn, tart, r1(x.min)]);
}
for (const md of Object.keys(onThisDay)) onThisDay[md].sort((a, b) => b[0] - a[0]);

// per-track skip rate for the track index
const skTrk = new Map();
for (const r of allRows) {
  if (r.sk === undefined) continue;
  const k = r.n + '\u0001' + r.a;
  let e = skTrk.get(k);
  if (!e) { e = [0, 0]; skTrk.set(k, e); }
  e[0]++; if (r.sk) e[1]++;
}

const trackIndex = allTracks.filter((t) => keepT.has(t)).map((t) => { const e = skTrk.get(t.n + '\u0001' + t.a); return [t.n, t.a, t.al || '', t.p, r1(t.m), t.f, t.l, yrStr(t.y), e && e[0] >= 8 ? +(e[1] / e[0]).toFixed(2) : null]; });


// ---------- Phase 3: release decades, origin countries, how you choose music ----------
const SEPc = '\u2016';
const nowYear = new Date().getFullYear();
let decades = null, geo = null, how = null;

if (Object.keys(meta.yr).length) {
  const all = {}, byYear = {}, covY = {}, avgAcc = {}, topAlb = new Map();
  let known = 0, total = 0;
  for (const r of rows) {
    total += r.min;
    const cv = (covY[r.y] ||= [0, 0]); cv[1] += r.min;
    if (!r.al) continue;
    const yr = meta.yr[r.a + SEPc + r.al];
    if (!yr || yr < 1900 || yr > nowYear + 1) continue;
    const d = Math.floor(yr / 10) * 10;
    known += r.min; cv[0] += r.min;
    all[d] = (all[d] || 0) + r.min;
    const by = (byYear[r.y] ||= {}); by[d] = (by[d] || 0) + r.min;
    const av = (avgAcc[r.y] ||= [0, 0]); av[0] += yr * r.min; av[1] += r.min;
    let tm = topAlb.get(d); if (!tm) { tm = new Map(); topAlb.set(d, tm); }
    const k = r.a + SEPc + r.al; let o = tm.get(k); if (!o) { o = { n: r.al, a: r.a, m: 0, y: yr }; tm.set(k, o); }
    o.m += r.min;
  }
  decades = {
    coverage: total ? +(known / total).toFixed(3) : 0,
    all: Object.fromEntries(Object.entries(all).map(([d, m]) => [d, r1(m)])),
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, o]) => [y, Object.fromEntries(Object.entries(o).map(([d, m]) => [d, r1(m)]))])),
    avgYear: Object.fromEntries(Object.entries(avgAcc).sort().filter(([, v]) => v[1] >= 600).map(([y, v]) => [y, +(v[0] / v[1]).toFixed(1)])),
    coverageByYear: Object.fromEntries(Object.entries(covY).sort().map(([y, v]) => [y, v[1] ? +(v[0] / v[1]).toFixed(2) : 0])),
    top: Object.fromEntries([...topAlb.entries()].sort((a, b) => a[0] - b[0]).map(([d, tm]) => [d, [...tm.values()].sort((a, b) => dd(b.m, a.m) || cmpS(a.n, b.n) || cmpS(a.a, b.a)).slice(0, 8).map((o) => ({ n: o.n, a: o.a, m: r1(o.m), y: o.y }))])),
  };
}

if (Object.keys(meta.ar).length) {
  const NOGEO = new Set(['XW', 'XE', 'XU', 'XG']);
  const all = {}, byYear = {}, arts = new Map();
  let known = 0, total = 0;
  for (const r of rows) {
    total += r.min;
    const c = meta.ar[r.a];
    if (!c || NOGEO.has(c)) continue;
    known += r.min;
    all[c] = (all[c] || 0) + r.min;
    const by = (byYear[r.y] ||= {}); by[c] = (by[c] || 0) + r.min;
    let am = arts.get(c); if (!am) { am = new Map(); arts.set(c, am); }
    am.set(r.a, (am.get(r.a) || 0) + r.min);
  }
  geo = {
    coverage: total ? +(known / total).toFixed(3) : 0,
    all: Object.fromEntries(Object.entries(all).sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0])).map(([c, m]) => [c, r1(m)])),
    byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, o]) => [y, Object.fromEntries(Object.entries(o).map(([c, m]) => [c, r1(m)]))])),
    top: Object.fromEntries([...arts.entries()].map(([c, am]) => [c, [...am.entries()].sort((a, b) => dd(b[1], a[1]) || cmpS(a[0], b[0])).slice(0, 5).map(([n, m]) => ({ n, m: r1(m) }))])),
  };
}

if (allRows.some((r) => r.x)) {
  const mk = () => ({ s: {}, sh: [0, 0], dev: {} });
  const years = {}, allH = mk();
  for (const r of allRows) {
    if (!r.x) continue;
    const h = (years[r.y] ||= mk());
    for (const t of [h, allH]) {
      t.s[r.x[0]] = (t.s[r.x[0]] || 0) + 1;
      t.sh[1]++; if (r.x[2] === '1') t.sh[0]++;
      if (r.min >= 0.5) t.dev[r.x[1]] = (t.dev[r.x[1]] || 0) + r.min;
    }
  }
  const fin = (t) => ({ s: t.s, sh: t.sh, dev: Object.fromEntries(Object.entries(t.dev).map(([k, v]) => [k, r1(v)])) });
  how = { years: Object.fromEntries(Object.entries(years).sort().map(([y, t]) => [y, fin(t)])), all: fin(allH) };
}

// ---------- write ----------
const moodMeta = {};
for (const [k, m] of Object.entries(MOODS)) moodMeta[k] = { label: m.label, color: m.color, color2: m.color2 };

const summary = {
  generated: new Date().toISOString(),
  meta: { firstYm: monthKeys[0], lastYm: monthKeys[monthKeys.length - 1], totalPlays: rows.length, tz, demo, moods: moodMeta },
  months, years, all, extra, records, decades, geo, how,
  highlights: H.slice(0, 80),
};


// What to enrich first in the browser: the most listened artists and albums
const albAll = [];
for (const x of AR.values()) for (const b of x.al.values()) albAll.push([x.n, b.n, b.m]);
albAll.sort((a, b) => dd(b[2], a[2]) || cmpS(a[0], b[0]) || cmpS(a[1], b[1]));
const queue = { artists: ranked.slice(0, 2500).map((x) => x.n), albums: albAll.slice(0, 1200).map(([a, al]) => [a, al]) };

  return {
    files: { summary, 'artist-index': artistIndex, 'artist-details': details, 'track-index': trackIndex, 'on-this-day': onThisDay },
    queue,
  };
}
