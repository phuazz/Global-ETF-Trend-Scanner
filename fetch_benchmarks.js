// fetch_benchmarks.js — Pulls benchmark ETFs into history/ alongside the universe.
//
// Why a separate fetcher: the attribution layer (attribution.py) regresses
// strategy returns onto two benchmarks — an equal-weighted basket of the
// universe (built in-memory, no fetch needed) and a single-ETF global proxy
// (ACWI primary, with URTH / VT fallbacks). The universe fetcher
// (fetch_history.js) deliberately stays focused on the trade universe so the
// scanner outputs aren't polluted; this script only adds benchmark series.
//
// Run:
//   node fetch_benchmarks.js [--max-age-hours=168]   (default: weekly cadence)
//
// Output: history/ACWI.json (and URTH.json / VT.json if reached as fallback).

const https = require('https');
const fs = require('fs');
const path = require('path');

const BENCHMARKS = [
  { t: 'ACWI', n: 'MSCI ACWI',           c: 'Benchmark' },
  { t: 'URTH', n: 'MSCI World',          c: 'Benchmark' },
  { t: 'VT',   n: 'Vanguard Total World',c: 'Benchmark' }
];

const ARG_MAX_AGE = (() => {
  const m = process.argv.find(a => a.startsWith('--max-age-hours='));
  return m ? parseFloat(m.split('=')[1]) : 168;
})();

const HISTORY_DIR = path.join(__dirname, 'history');

function yfFetch(tk, range, interval) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tk}?range=${range}&interval=${interval}&includePrePost=false`;
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r = j.chart && j.chart.result && j.chart.result[0];
          if (!r) reject(new Error('No data for ' + tk));
          else resolve(r);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function yfRetry(tk, range, interval, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await yfFetch(tk, range, interval); }
    catch (e) { lastErr = e; if (i < retries - 1) await sleep(1500 + i * 1200); }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractBars(result) {
  const ts = result.timestamp || [];
  const q = (result.indicators.quote && result.indicators.quote[0]) || {};
  const adj = (result.indicators.adjclose && result.indicators.adjclose[0]
               && result.indicators.adjclose[0].adjclose) || q.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    const ac = adj[i];
    if (c == null || ac == null || ac <= 0 || c <= 0) continue;
    out.push({
      d: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      o: round4(q.open ? q.open[i] : null),
      h: round4(q.high ? q.high[i] : null),
      l: round4(q.low ? q.low[i] : null),
      c: round4(c),
      ac: round4(ac),
      v: q.volume ? q.volume[i] : null
    });
  }
  return out;
}
function round4(x) { return x == null ? null : +(+x).toFixed(4); }

async function fetchOne(entry) {
  const file = path.join(HISTORY_DIR, `${entry.t}.json`);
  if (fs.existsSync(file)) {
    const ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 3.6e6;
    if (ageHours < ARG_MAX_AGE) {
      return { ticker: entry.t, status: 'skipped', age: +ageHours.toFixed(1) };
    }
  }
  const dRes = await yfRetry(entry.t, '10y', '1d');
  const dailyBars = extractBars(dRes);
  await sleep(350);
  const mRes = await yfRetry(entry.t, 'max', '1mo');
  const monthlyBars = extractBars(mRes);
  if (dailyBars.length < 60) throw new Error(`only ${dailyBars.length} daily bars`);
  if (monthlyBars.length < 13) throw new Error(`only ${monthlyBars.length} monthly bars`);

  const meta = mRes.meta || dRes.meta || {};
  const out = {
    ticker: entry.t,
    name: entry.n,
    cls: entry.c,
    fetchedAt: new Date().toISOString(),
    inception: monthlyBars[0].d,
    dailyStart: dailyBars[0].d,
    lastDate: dailyBars[dailyBars.length - 1].d,
    nDaily: dailyBars.length,
    nMonthly: monthlyBars.length,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    daily: dailyBars,
    monthly: monthlyBars
  };
  fs.writeFileSync(file, JSON.stringify(out));
  return { ticker: entry.t, status: 'ok', inception: out.inception,
           nDaily: out.nDaily, nMonthly: out.nMonthly,
           sizeKB: +(fs.statSync(file).size / 1024).toFixed(1) };
}

async function main() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  console.log(`[${new Date().toISOString()}] Fetching benchmark ETFs (attribution layer)...`);

  let primaryOk = false;
  for (const b of BENCHMARKS) {
    try {
      const r = await fetchOne(b);
      if (r.status === 'skipped') {
        console.log(`  ${b.t} skipped (age ${r.age}h)`);
      } else {
        console.log(`  ${b.t} OK — ${r.nDaily} daily, ${r.nMonthly} monthly, since ${r.inception} (${r.sizeKB} KB)`);
      }
      primaryOk = true;
      // ACWI is the primary; if we got it, the fallbacks aren't strictly needed
      // but we still fetch all three so the user can compare or swap if desired.
    } catch (err) {
      console.warn(`  ${b.t} FAILED — ${err.message}`);
    }
    await sleep(500);
  }

  if (!primaryOk) {
    console.error('No benchmark ETFs fetched. attribution.py will compute EW basket only.');
    process.exit(1);
  }
  console.log('Done. Run `python3 attribution.py` to compute the attribution layer.');
}

if (require.main === module) main().catch(err => { console.error('Fatal:', err); process.exit(1); });
