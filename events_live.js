// events_live.js — daily "is any catalogue event firing now?" scan.
//
// The full event study (events.js) is input-bound on history/ and runs weekly.
// This is the complementary DAILY job: it fetches a short recent window of
// daily bars, computes the same indicators the study uses, and reports whether
// each pre-registered event has triggered in the last few sessions. Output is a
// small events_live.json that the Market Pulse "Live Events" strip reads.
//
// Run: node events_live.js
//
// IMPORTANT: the trigger conditions below MUST stay identical to the detectors
// in events.js. They are duplicated (not shared) because the study operates on
// full history loaded from disk, while this scan operates on freshly fetched
// in-memory bars. If you change a definition in events/catalogue.json, change
// it in BOTH places.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { rsiWilder, sma } = require('./events.js');
const { extractBars, sanitize } = require('./fetch_history.js');

const CATALOGUE = path.join(__dirname, 'events', 'catalogue.json');
const OUT = path.join(__dirname, 'events_live.json');

// A trigger within this many trading sessions of the latest bar is "ACTIVE".
const LIVE_LOOKBACK = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function yfFetch(tk, range, interval) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tk}?range=${range}&interval=${interval}&includePrePost=false`;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const result = j.chart && j.chart.result && j.chart.result[0];
          if (!result) reject(new Error('No data for ' + tk)); else resolve(result);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function yfBars(tk) {
  for (let i = 0; i < 3; i++) {
    try { return sanitize(extractBars(await yfFetch(tk, '2y', '1d')), tk); }
    catch (e) { if (i < 2) await sleep(1200 + i * 1000); else throw e; }
  }
}

// --- live detectors (mirror events.js) ---

// Most recent SPY RSI overbought->sub-50-in-window trigger, plus current RSI.
function liveRsi(bars, ev) {
  const ac = bars.map(b => b.ac), dates = bars.map(b => b.d);
  const rsi = rsiWilder(ac, ev.rsiPeriod || 14);
  const win = ev.window || 3;
  let last = null;
  for (let i = 1; i < rsi.length; i++) {
    if (rsi[i] == null || rsi[i - 1] == null) continue;
    if (!(rsi[i] < 50 && rsi[i - 1] >= 50)) continue;
    let ob = false;
    for (let k = 1; k <= win; k++) if (i - k >= 0 && rsi[i - k] != null && rsi[i - k] > 70) { ob = true; break; }
    if (ob) last = { date: dates[i], idx: i };
  }
  const n = rsi.length;
  const cur = rsi[n - 1];
  // "armed": currently overbought, so a sharp drop in the next few sessions would trigger.
  const armed = cur != null && cur > 70;
  return { current: cur == null ? null : +cur.toFixed(1), currentLabel: 'RSI', last, lastBarIdx: n - 1, armed };
}

// Current cross-asset breadth and the most recent cross below `level`.
function liveBreadth(barsByTk, ev, dates) {
  const level = ev.level != null ? ev.level : 0.5;
  const minNames = ev.minNames || 30;
  const aboveByDate = {}; // date -> {above,total}
  for (const tk in barsByTk) {
    const ac = barsByTk[tk].map(b => b.ac);
    const s200 = sma(ac, 200);
    for (let i = 0; i < barsByTk[tk].length; i++) {
      if (s200[i] == null) continue;
      const d = barsByTk[tk][i].d;
      if (!aboveByDate[d]) aboveByDate[d] = { above: 0, total: 0 };
      aboveByDate[d].total++;
      if (ac[i] > s200[i]) aboveByDate[d].above++;
    }
  }
  const breadth = dates.map(d => {
    const x = aboveByDate[d];
    return (x && x.total >= minNames) ? x.above / x.total : null;
  });
  let last = null;
  for (let i = 1; i < breadth.length; i++) {
    if (breadth[i] == null || breadth[i - 1] == null) continue;
    if (breadth[i] < level && breadth[i - 1] >= level) last = { date: dates[i], idx: i };
  }
  // current breadth = last non-null
  let cur = null, curIdx = -1;
  for (let i = breadth.length - 1; i >= 0; i--) if (breadth[i] != null) { cur = breadth[i]; curIdx = i; break; }
  return { current: cur == null ? null : +(cur * 100).toFixed(1), currentLabel: '% > 200d SMA', last, lastBarIdx: curIdx, levelPct: level * 100 };
}

async function main() {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  const universe = (cat.universe && cat.universe.length) ? cat.universe : ['SPY'];

  // Figure out which tickers we need to fetch.
  const needBreadth = cat.events.some(e => e.kind === 'breadth_cross' && e.rationale);
  const need = new Set(['SPY']);
  if (needBreadth) universe.forEach(t => need.add(t));

  console.log(`Live scan: fetching 2y daily bars for ${need.size} ticker(s)...`);
  const barsByTk = {};
  let i = 0;
  for (const tk of need) {
    try { barsByTk[tk] = await yfBars(tk); }
    catch (e) { console.warn(`  ${tk} fetch failed: ${e.message}`); }
    if (++i < need.size) await sleep(250);
  }
  const spy = barsByTk['SPY'];
  if (!spy) throw new Error('SPY fetch failed — cannot run live scan.');
  const spyDates = spy.map(b => b.d);
  const asOf = spyDates[spyDates.length - 1];

  const out = { generatedAt: new Date().toISOString(), asOf, lookbackSessions: LIVE_LOOKBACK, events: [] };

  for (const ev of cat.events) {
    if (!ev.rationale) continue;
    let r, status, detail;
    if (ev.kind === 'rsi_ob_to_mid') {
      r = liveRsi(barsByTk[ev.target || 'SPY'] || spy, ev);
      const since = r.last ? r.lastBarIdx - r.last.idx : null;
      if (since != null && since <= LIVE_LOOKBACK) { status = 'ACTIVE'; detail = `Triggered ${since === 0 ? 'today' : since + ' session(s) ago'} (${r.last.date}). Current ${r.currentLabel} ${r.current}.`; }
      else if (r.armed) { status = 'ARMED'; detail = `${r.currentLabel} ${r.current} (overbought) — a sharp drop below 50 in the next ${ev.window || 3} sessions would trigger.`; }
      else { status = 'QUIET'; detail = `${r.currentLabel} ${r.current}. Last trigger ${r.last ? r.last.date : 'none in 2y'}.`; }
      out.events.push({ id: ev.id, name: ev.name, target: ev.target || 'SPY', status, detail, current: r.current, currentLabel: r.currentLabel, lastTrigger: r.last ? r.last.date : null });
    } else if (ev.kind === 'breadth_cross') {
      r = liveBreadth(barsByTk, ev, spyDates);
      const since = r.last ? r.lastBarIdx - r.last.idx : null;
      const below = r.current != null && r.current < r.levelPct;
      if (since != null && since <= LIVE_LOOKBACK) { status = 'ACTIVE'; detail = `Crossed below ${r.levelPct}% ${since === 0 ? 'today' : since + ' session(s) ago'} (${r.last.date}). Now ${r.current}% above 200d SMA.`; }
      else if (below) { status = 'BELOW'; detail = `Currently ${r.current}% above 200d SMA (below the ${r.levelPct}% line, but the crossing is older than ${LIVE_LOOKBACK} sessions).`; }
      else { status = 'QUIET'; detail = `${r.current}% above 200d SMA. Last cross below ${r.levelPct}%: ${r.last ? r.last.date : 'none in 2y'}.`; }
      out.events.push({ id: ev.id, name: ev.name, target: ev.target || 'SPY', status, detail, current: r.current, currentLabel: r.currentLabel, lastTrigger: r.last ? r.last.date : null });
    }
    console.log(`  ${ev.id}: ${status}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`Wrote ${OUT} (asOf ${asOf}).`);
}

if (require.main === module) main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
