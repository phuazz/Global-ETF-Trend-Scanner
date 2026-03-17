// fetch_data.js — Run via GitHub Actions daily
// Usage: node fetch_data.js
// Output: data.json in the same directory

const https = require('https');
const fs = require('fs');
const path = require('path');

const UNI = [
  {t:"SPY",n:"S&P 500",c:"US Equity"},{t:"QQQ",n:"Nasdaq 100",c:"US Equity"},
  {t:"IWM",n:"Russell 2000",c:"US Equity"},{t:"DIA",n:"Dow Jones 30",c:"US Equity"},
  {t:"VTV",n:"US Value",c:"US Equity"},{t:"VUG",n:"US Growth",c:"US Equity"},
  {t:"MDY",n:"S&P MidCap 400",c:"US Equity"},
  {t:"EFA",n:"EAFE Developed",c:"Intl Equity"},{t:"VGK",n:"Europe",c:"Intl Equity"},
  {t:"EWJ",n:"Japan",c:"Intl Equity"},{t:"EWU",n:"United Kingdom",c:"Intl Equity"},
  {t:"EWG",n:"Germany",c:"Intl Equity"},{t:"EWA",n:"Australia",c:"Intl Equity"},
  {t:"EWC",n:"Canada",c:"Intl Equity"},
  {t:"EEM",n:"Emerging Markets",c:"EM Equity"},{t:"FXI",n:"China Large Cap",c:"EM Equity"},
  {t:"EWZ",n:"Brazil",c:"EM Equity"},{t:"INDA",n:"India",c:"EM Equity"},
  {t:"EWT",n:"Taiwan",c:"EM Equity"},{t:"EWY",n:"South Korea",c:"EM Equity"},
  {t:"THD",n:"Thailand",c:"EM Equity"},{t:"EWS",n:"Singapore",c:"EM Equity"},
  {t:"TLT",n:"US 20Y+ Treasury",c:"Fixed Income"},{t:"IEF",n:"US 7-10Y Treasury",c:"Fixed Income"},
  {t:"LQD",n:"IG Corp Bonds",c:"Fixed Income"},{t:"HYG",n:"High Yield",c:"Fixed Income"},
  {t:"EMB",n:"EM Bonds",c:"Fixed Income"},{t:"TIP",n:"TIPS",c:"Fixed Income"},
  {t:"BND",n:"US Agg Bond",c:"Fixed Income"},
  {t:"GLD",n:"Gold",c:"Commodity"},{t:"SLV",n:"Silver",c:"Commodity"},
  {t:"USO",n:"Crude Oil",c:"Commodity"},{t:"DBA",n:"Agriculture",c:"Commodity"},
  {t:"DBB",n:"Base Metals",c:"Commodity"},{t:"UNG",n:"Natural Gas",c:"Commodity"},
  {t:"PDBC",n:"Diversified Cmdty",c:"Commodity"},
  {t:"VNQ",n:"US REITs",c:"Real Estate"},{t:"VNQI",n:"Intl REITs",c:"Real Estate"},
  {t:"IYR",n:"US Real Estate",c:"Real Estate"},
  {t:"UUP",n:"US Dollar",c:"Currency"},{t:"FXE",n:"Euro",c:"Currency"},
  {t:"FXY",n:"Yen",c:"Currency"},{t:"FXB",n:"Pound",c:"Currency"},
  {t:"FXA",n:"AUD",c:"Currency"},
  {t:"KMLM",n:"Managed Futures",c:"Alternatives"},{t:"DBMF",n:"MF Replication",c:"Alternatives"},
  {t:"BTAL",n:"Anti-Beta",c:"Alternatives"},{t:"GCC",n:"Cmdty Basket",c:"Alternatives"},
  {t:"GMOM",n:"Cambria Mom",c:"Alternatives"},
  {t:"SHLD",n:"Defense Tech",c:"Thematic"},{t:"URA",n:"Uranium/Nuclear",c:"Thematic"},
  {t:"PAVE",n:"US Infrastructure",c:"Thematic"},{t:"SMH",n:"Semiconductors",c:"Thematic"},
  {t:"COPX",n:"Copper Miners",c:"Thematic"},{t:"HACK",n:"Cybersecurity",c:"Thematic"},
  {t:"BITQ",n:"Crypto Industry",c:"Thematic"}
];

// === Yahoo Finance fetch (server-side, no CORS proxy needed) ===
function yfFetch(tk, range, interval) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${tk}?range=${range}&interval=${interval}&includePrePost=false`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const result = j.chart && j.chart.result && j.chart.result[0];
          if (!result) reject(new Error('No data for ' + tk));
          else resolve(result);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function yfRetry(tk, range, interval, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await yfFetch(tk, range, interval); }
    catch (e) {
      if (i < retries - 1) await sleep(1500 + i * 1000);
      else throw e;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Indicator calculations ===
function getMC(res) {
  const ts = res.timestamp || [], cl = (res.indicators.quote[0].close) || [];
  const d = [];
  for (let i = 0; i < ts.length; i++) if (cl[i] != null) d.push(cl[i]);
  return d;
}

function getDHLC(res) {
  const q = res.indicators.quote[0];
  const h = q.high || [], l = q.low || [], c = q.close || [];
  const d = [];
  for (let i = 0; i < h.length; i++)
    if (h[i] != null && l[i] != null && c[i] != null)
      d.push({ high: h[i], low: l[i], close: c[i] });
  return d;
}

function smaC(a, p) {
  if (a.length < p) return null;
  let s = 0;
  for (let i = a.length - p; i < a.length; i++) s += a[i];
  return s / p;
}

function momR(mc) {
  const n = mc.length, cur = mc[n - 1];
  function g(m) { const i = n - 1 - m; return i >= 0 ? ((cur - mc[i]) / mc[i]) * 100 : null; }
  return { m1: g(1), m2: g(2), m3: g(3), m6: g(6), m12: g(12) };
}

function calcR2(mc) {
  const n = Math.min(mc.length, 13);
  if (n < 6) return 0;
  const sl = mc.slice(-n), ln = [], xs = [];
  for (let i = 0; i < n; i++) { ln.push(Math.log(sl[i])); xs.push(i); }
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ln[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ln[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(0, Math.min(1, r * r));
}

function calcADX(daily) {
  const P = 14;
  if (daily.length < P + 1) return { adx: 15, dp: 15, dm: 15 };
  const tr = [], pd = [], md = [];
  for (let i = 1; i < daily.length; i++) {
    const c = daily[i], p = daily[i - 1];
    const hd = c.high - p.high, ld = p.low - c.low;
    pd.push(hd > ld && hd > 0 ? hd : 0);
    md.push(ld > hd && ld > 0 ? ld : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (tr.length < P) return { adx: 15, dp: 15, dm: 15 };
  let sTR = 0, sPD = 0, sMD = 0;
  for (let i = 0; i < P; i++) { sTR += tr[i]; sPD += pd[i]; sMD += md[i]; }
  const dxs = [];
  for (let i = P; i < tr.length; i++) {
    sTR = sTR - (sTR / P) + tr[i];
    sPD = sPD - (sPD / P) + pd[i];
    sMD = sMD - (sMD / P) + md[i];
    const dip = sTR > 0 ? (sPD / sTR) * 100 : 0;
    const dim = sTR > 0 ? (sMD / sTR) * 100 : 0;
    const ds = dip + dim;
    dxs.push({ dx: ds > 0 ? (Math.abs(dip - dim) / ds) * 100 : 0, dp: dip, dm: dim });
  }
  if (dxs.length < P) {
    const l = dxs[dxs.length - 1] || { dx: 15, dp: 15, dm: 15 };
    return { adx: +l.dx.toFixed(1), dp: +l.dp.toFixed(1), dm: +l.dm.toFixed(1) };
  }
  let adx = 0;
  for (let i = 0; i < P; i++) adx += dxs[i].dx;
  adx /= P;
  for (let i = P; i < dxs.length; i++) adx = ((adx * (P - 1)) + dxs[i].dx) / P;
  const last = dxs[dxs.length - 1];
  return { adx: +adx.toFixed(1), dp: +last.dp.toFixed(1), dm: +last.dm.toFixed(1) };
}

function compComposite(data) {
  const ms = data.map(d => d.momScore).sort((a, b) => a - b);
  function pR(arr, v) { let c = 0; for (let i = 0; i < arr.length; i++) if (arr[i] <= v) c++; return (c / arr.length) * 100; }
  data.forEach(d => {
    const A = d.aboveSMA === true ? 100 : d.aboveSMA === false ? 0 : 50;
    const B = Math.max(0, Math.min(100, ((d.adx - 10) / 40) * 100));
    const C = pR(ms, d.momScore);
    const D = d.r2 * 100;
    const dir = d.dp > d.dm ? 1.0 : 0.3;
    d.composite = +((A * .25 + B * .25 + C * .25 + D * .25) * dir).toFixed(1);
    d.composite = Math.max(0, Math.min(100, d.composite));
    if (d.composite >= 70 && d.aboveSMA && d.adx >= 25) d.regime = "STRONG_UP";
    else if (d.composite >= 50 && d.aboveSMA) d.regime = "UP";
    else if (d.composite >= 30) d.regime = "NEUTRAL";
    else if (d.composite >= 15) d.regime = "DOWN";
    else d.regime = "STRONG_DOWN";
    d.signals = 0;
    if (d.aboveSMA) d.signals++;
    if (d.adx >= 25) d.signals++;
    if (d.dp > d.dm) d.signals++;
    if (pR(ms, d.momScore) >= 67) d.signals++;
    if (d.r2 >= 0.6) d.signals++;
  });
  return data;
}

// === Main pipeline ===
async function main() {
  console.log(`[${new Date().toISOString()}] Starting ETF data fetch for ${UNI.length} tickers...`);
  const results = [];
  const fails = [];

  // Process sequentially with small delay to be kind to Yahoo
  for (let i = 0; i < UNI.length; i++) {
    const e = UNI[i];
    try {
      const mr = await yfRetry(e.t, "2y", "1mo");
      const mc = getMC(mr);
      await sleep(300);
      const dr = await yfRetry(e.t, "3mo", "1d");
      const daily = getDHLC(dr);

      const price = mc[mc.length - 1];
      const s10 = smaC(mc, 10);
      const above = s10 ? price > s10 : null;
      const moms = momR(mc);
      const r2 = calcR2(mc);
      const ax = calcADX(daily);

      results.push({
        ticker: e.t, name: e.n, cls: e.c,
        price: +price.toFixed(2),
        sma10m: s10 ? +s10.toFixed(2) : null,
        aboveSMA: above,
        m1: moms.m1 != null ? +moms.m1.toFixed(2) : null,
        m2: moms.m2 != null ? +moms.m2.toFixed(2) : null,
        m3: moms.m3 != null ? +moms.m3.toFixed(2) : null,
        m6: moms.m6 != null ? +moms.m6.toFixed(2) : null,
        m12: moms.m12 != null ? +moms.m12.toFixed(2) : null,
        adx: ax.adx, dp: ax.dp, dm: ax.dm,
        r2: +r2.toFixed(2),
        ok: true
      });
      console.log(`  [${i + 1}/${UNI.length}] ${e.t} OK — price ${price.toFixed(2)}`);
    } catch (err) {
      fails.push(e.t);
      console.log(`  [${i + 1}/${UNI.length}] ${e.t} FAILED — ${err.message}`);
    }

    // Delay between tickers
    if (i < UNI.length - 1) await sleep(500);
  }

  // Compute momentum scores and composite
  results.forEach(d => {
    const vals = [d.m2, d.m3, d.m6, d.m12].filter(v => v != null);
    d.momScore = vals.length > 0 ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : 0;
  });
  const scored = compComposite(results);

  const output = {
    ts: new Date().toISOString(),
    tsUnix: Date.now(),
    total: UNI.length,
    loaded: scored.length,
    failed: fails,
    data: scored
  };

  const outPath = path.join(__dirname, 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`\n[${new Date().toISOString()}] Done. ${scored.length}/${UNI.length} loaded, ${fails.length} failed.`);
  console.log(`Written to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  if (fails.length > 0) console.log(`Failed tickers: ${fails.join(', ')}`);
  // Exit with error if too many failures
  if (fails.length > UNI.length * 0.5) {
    console.error('ERROR: More than 50% of tickers failed. Not committing.');
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
