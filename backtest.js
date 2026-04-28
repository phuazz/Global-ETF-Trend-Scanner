// backtest.js — Strategy backtest engine for the ETF Trend Scanner.
//
// Implements three strategies (see BACKTEST_METHODOLOGY.md):
//   1. petr   — cross-sectional rotational momentum, regime-gated, vol-targeted
//   2. tsmom  — AQR-style time-series momentum, 40% sum-of-abs-vol cap,
//                with an optional realized-vol scalar for AQR-equivalent leverage
//   3. multi  — multi-signal composite (mom + trend + low-vol + skew + kurt + vol),
//                regime-weighted, exponential signal decay, partial-turnover trading
//
// PIT discipline: every signal at decision time t uses data ≤ t-1 month-end.
// Default execution: trades fill at the close of the *first trading day of t+1*
// (one-day lag), and the holding period is firstDay-of-t+1 through
// last-trading-day-of-t+1. This matches AQR/published-research convention.
// Use --execMode=closeT for legacy close-of-t to close-of-t+1.
//
// Cash earns SHY (1-3y UST) — configurable via --rfTicker. Leverage pays
// rf + borrowBps annually (--borrowBps, default 50). Cost defaults to 5 bps
// each side, but is overridden per asset class (see DEFAULT_COST_BY_CLASS).
//
// Run:
//   node backtest.js                 # all strategies, default params, full history
//   node backtest.js --strategy=petr
//
// Output: backtest_results.json (consumed by index.html).

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_FILE = path.join(__dirname, 'backtest_results.json');

// ---------- Argv helpers ----------
function arg(name, def) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : def;
}
const ONLY_STRATEGY = arg('strategy', null);
const START_MONTH   = arg('startMonth', null);   // e.g. --startMonth=2005-01
const COST_BPS      = arg('costBps', null);      // override the 5 bps default
const REGIME_MODE   = arg('regimeMode', null);   // 'binary' (Petr original) or 'graduated'
const REGIME_SCALE  = arg('regimeScale', null);  // 0.05 = ±5% ramp around SMA
const WEIGHTING     = arg('weighting', null);    // 'volTarget' (default) or 'equal' (1/N)
const EQUITY_ONLY   = arg('equityOnly', null) === 'true' || process.argv.includes('--equityOnly'); // restrict universe to equity ETFs
const RF_TICKER     = arg('rfTicker', 'SHY');    // ETF used as risk-free proxy (SHY = 1-3y UST)
const BORROW_BPS    = arg('borrowBps', null);    // annual spread paid above rf when leveraged (default 50)
const EXEC_MODE     = arg('execMode', null);     // 'closeT' (legacy) or 'firstDayT1' (default)

// ============================================================================
// 1. Load history files
// ============================================================================

function loadHistory() {
  const manifestPath = path.join(HISTORY_DIR, '_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('history/_manifest.json missing — run `node fetch_history.js` first');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const history = {};
  for (const t of manifest.tickers) {
    if (t.status !== 'ok') continue;
    const file = path.join(HISTORY_DIR, `${t.ticker}.json`);
    if (!fs.existsSync(file)) continue;
    history[t.ticker] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return history;
}

// ============================================================================
// 2. Build aligned timeline
//
// We construct a master monthly timeline (the union of month-ends across all
// tickers). For each (ticker, month) we have either a price or null (PIT-out).
// We also expose a daily-vol estimator: for any (ticker, month-end) we can ask
// for the trailing 60-day annualised vol.
// ============================================================================

function lastDayOfMonth(d) {
  // d is "YYYY-MM-DD" string. Returns "YYYY-MM-31" (or 30/29/28).
  const [y, m] = d.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

function buildTimeline(history) {
  // Collect all month-end dates from monthly bars across all tickers
  const monthSet = new Set();
  for (const tk of Object.keys(history)) {
    for (const b of history[tk].monthly) {
      monthSet.add(b.d.slice(0, 7)); // YYYY-MM
    }
  }
  const months = [...monthSet].sort();

  // For each ticker, build a price array indexed by months[]
  const prices = {}; // ticker -> [adjclose at each month or null]
  const monthlyDate = {}; // ticker -> [actual bar date for that month or null]
  for (const tk of Object.keys(history)) {
    const m = history[tk].monthly;
    const idx = {};
    for (const b of m) idx[b.d.slice(0, 7)] = b;
    prices[tk] = months.map(ym => (idx[ym] ? idx[ym].ac : null));
    monthlyDate[tk] = months.map(ym => (idx[ym] ? idx[ym].d : null));
  }

  // For trailing-vol: build a daily map per ticker (date → adjclose)
  // and pre-compute log returns.
  const daily = {};
  for (const tk of Object.keys(history)) {
    const arr = history[tk].daily;
    const dates = arr.map(b => b.d);
    const ac = arr.map(b => b.ac);
    const logRet = new Array(arr.length);
    for (let i = 1; i < arr.length; i++) logRet[i] = Math.log(ac[i] / ac[i - 1]);
    daily[tk] = { dates, ac, logRet };
  }

  // First-trading-day adjclose per (ticker, month) — used for "execute at close
  // of first trading day of t+1" execution mode (audit fix #1).
  // For each YYYY-MM in months[], find the first daily bar whose date starts
  // with that month, and store its adjclose.
  const firstDayClose = {};
  for (const tk of Object.keys(history)) {
    const arr = history[tk].daily;
    const seen = {};
    for (const b of arr) {
      const ym = b.d.slice(0, 7);
      if (!(ym in seen)) seen[ym] = b.ac;  // first occurrence wins (sorted asc by date)
    }
    firstDayClose[tk] = months.map(ym => (ym in seen ? seen[ym] : null));
  }

  return { months, prices, monthlyDate, daily, firstDayClose };
}

// Trailing N-day annualised vol of ticker as of (or before) date `asOf`.
// Returns null if insufficient history.
function trailingVol(daily, ticker, asOf, nDays = 60) {
  const D = daily[ticker];
  if (!D) return null;
  // Find the largest index i such that dates[i] <= asOf
  let lo = 0, hi = D.dates.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (D.dates[mid] <= asOf) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < nDays) return null;
  // Clip individual log-returns at ±25% to neutralise corporate-action artifacts
  // (reverse-split bars in USO/UNG/PDBC etc.) without dropping the whole estimator.
  // The clip applies *only* to the vol estimate, not to the return path.
  const CLIP = 0.25;
  let sum = 0, sum2 = 0, n = 0;
  for (let i = idx - nDays + 1; i <= idx; i++) {
    let r = D.logRet[i];
    if (r == null || !isFinite(r)) continue;
    if (r >  CLIP) r =  CLIP; else if (r < -CLIP) r = -CLIP;
    sum += r; sum2 += r * r; n++;
  }
  if (n < nDays * 0.8) return null;
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  if (variance < 0) return null;
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Trailing vol from monthly-bar returns — fallback when daily history is too
// short for the 60-day estimator (Yahoo caps interval=1d at ~10y, but we still
// want to backtest pre-2016). nMonths=24 gives a stable estimate; uses prices
// strictly through monthIdx t-1 for PIT cleanliness (sigma at decision time t).
function trailingVolMonthly(prices, t, nMonths) {
  nMonths = nMonths || 24;
  if (t < nMonths + 1) return null;
  const rets = [];
  for (let i = t - nMonths; i < t; i++) {
    const a = prices[i], b = prices[i - 1];
    if (a == null || b == null || b <= 0) return null;
    rets.push(Math.log(a / b));
  }
  if (rets.length < nMonths) return null;
  // Clip monthly log returns at ±50% (split protection); see daily clip note.
  const CLIPM = 0.50;
  for (let i = 0; i < rets.length; i++) {
    if (rets[i] >  CLIPM) rets[i] =  CLIPM;
    else if (rets[i] < -CLIPM) rets[i] = -CLIPM;
  }
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  let var2 = 0;
  for (const r of rets) var2 += (r - mean) * (r - mean);
  var2 /= (rets.length - 1);
  if (var2 <= 0) return null;
  return Math.sqrt(var2) * Math.sqrt(12);  // annualised
}

// Combined trailing-vol estimator: daily preferred, falls back to monthly.
function trailingVolCombined(timeline, ticker, t, asOf) {
  const v = trailingVol(timeline.daily, ticker, asOf, 60);
  if (v != null) return v;
  return trailingVolMonthly(timeline.prices[ticker], t, 24);
}

// Trailing N-day return moments (skew, kurtosis) — used by the multi-signal stack.
function trailingMoments(daily, ticker, asOf, nDays = 60) {
  const D = daily[ticker];
  if (!D) return null;
  let lo = 0, hi = D.dates.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (D.dates[mid] <= asOf) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < nDays) return null;
  const r = [];
  for (let i = idx - nDays + 1; i <= idx; i++) {
    const v = D.logRet[i];
    if (v != null && isFinite(v)) r.push(v);
  }
  if (r.length < nDays * 0.8) return null;
  const n = r.length;
  const mean = r.reduce((s, v) => s + v, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of r) {
    const d = v - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return {
    sd,
    skew: sd > 0 ? m3 / (sd * sd * sd) : 0,
    excessKurt: sd > 0 ? m4 / (sd * sd * sd * sd) - 3 : 0
  };
}

// ============================================================================
// 3. Signals (computed from monthly bars; PIT-strict)
// ============================================================================

// 12-1 momentum at index t: ratio of price at (t-1) / price at (t-12). Returns null
// if the ticker doesn't have a monthly print at *both* t-1 and t-12 — strict PIT.
function mom12_1(prices, t) {
  if (t < 12) return null;
  const a = prices[t - 1], b = prices[t - 12];
  if (a == null || b == null || b <= 0) return null;
  return a / b - 1;
}

function momKtoJ(prices, t, k, j) {
  // return prices[t-j] / prices[t-k] - 1, skipping j months at the front.
  if (t - k < 0 || t - j < 0) return null;
  const a = prices[t - j], b = prices[t - k];
  if (a == null || b == null || b <= 0) return null;
  return a / b - 1;
}

// Regime exposure factor in [0, 1].
//   binary    — Petr's original: 1 if price > sma, else 0.
//   graduated — linear ramp: 0 at price/sma = 1 - scale, 0.5 at parity, 1 at 1 + scale.
//               Smooths the on/off whipsaw without giving up the defensive intent.
//               At price exactly == SMA we run 50% — splitting the difference.
function regimeFactor(price, sma, mode, scale) {
  if (price == null || sma == null || sma <= 0) return 0;
  if (!mode || mode === 'binary') return price > sma ? 1 : 0;
  if (mode === 'graduated') {
    const s = scale > 0 ? scale : 0.05;
    const x = (price / sma - 1) / s;       // -1 at -scale, +1 at +scale
    return Math.max(0, Math.min(1, 0.5 + x / 2));
  }
  return price > sma ? 1 : 0;
}

// Trailing N-month SMA of monthly closes ending at t-1.
function trailingSMA(prices, t, n) {
  if (t < n) return null;
  let s = 0, c = 0;
  for (let i = t - n; i < t; i++) {
    const p = prices[i];
    if (p == null) return null;
    s += p; c++;
  }
  return c === n ? s / n : null;
}

// ============================================================================
// 4. Generic monthly backtest loop
//
// `decide(t, ctx) -> targetWeights` is the strategy callback. ctx provides
// helpers (vol estimator, signal computers, regime, etc.) plus current and
// previous weights.
// ============================================================================

function runMonthly(timeline, decide, opts = {}) {
  const { months, prices, monthlyDate, daily, firstDayClose } = timeline;
  const costBps = opts.costBps != null ? opts.costBps : 5;       // 5 bps each side
  const costByClass = opts.costByClass || null;                  // optional per-class override
  const rfTicker  = opts.rfTicker || 'SHY';                       // risk-free proxy
  const borrowBps = opts.borrowBps != null ? opts.borrowBps : 50; // annual spread above rf
  const execMode  = opts.execMode || 'firstDayT1';                // 'firstDayT1' (default) or 'closeT'
  const classBy   = opts.classByTicker || {};
  let startIdx  = opts.startIdx != null ? opts.startIdx : 13;
  if (opts.startMonth) {
    const fromIdx = months.indexOf(opts.startMonth);
    if (fromIdx > startIdx) startIdx = fromIdx;
  }
  const rfPx = prices[rfTicker] || null;
  // Helper: monthly return for the rf proxy from close-of-t to close-of-t+1.
  function rfReturn(t1) {
    if (!rfPx) return 0;
    const a = rfPx[t1 - 1], b = rfPx[t1];
    if (a == null || b == null || a <= 0) return 0;
    return b / a - 1;
  }
  // Per-trade cost in bps for a given ticker.
  function bpsFor(tk) {
    if (costByClass && classBy[tk] && costByClass[classBy[tk]] != null) return costByClass[classBy[tk]];
    return costBps;
  }

  let nav = 1.0;
  let weights = {}; // ticker -> weight
  const equity = [];   // [{ date, nav, ret, turnover, gross, nHold }]
  const wHistory = []; // [{ date, weights }]
  // Diagnostics
  const diag = { regimeOnMonths: 0, regimeOffMonths: 0, fullNMonths: 0, partialNMonths: 0,
                 emptyMonths: 0, eligibleSum: 0, eligibleCount: 0, grossSum: 0, holdSum: 0 };

  for (let t = startIdx; t < months.length - 1; t++) {
    // -- Decision time: end of month t. Use data through t-1 (strict PIT).
    // (Trailing-vol uses daily data ≤ month-t end-of-month date, which is
    // consistent with "I observed today's close, here's my trade.")

    const decisionDate = lastDayOfMonth(months[t] + '-01');

    // Equity-only universe filter — keep only ETFs whose asset class is in the
    // equity family (US/Intl/EM Equity + Thematic, which are all equity-based).
    // Excludes Fixed Income, Commodity, Real Estate (REITs are equity-like but
    // we keep this conservative), Currency, Alternatives. This brings the
    // strategy closer to Petr's literal stock-version spirit on a liquid-ETF
    // proxy basis.
    const EQUITY_CLASSES = new Set(['US Equity', 'Intl Equity', 'EM Equity', 'Thematic']);
    const ctx = {
      t, date: months[t], decisionDate,
      eligibleTickers: Object.keys(prices).filter(tk => {
        if (prices[tk][t] == null || prices[tk][t - 1] == null || prices[tk][t - 12] == null) return false;
        if (opts.equityOnly && opts.classByTicker) {
          const cls = opts.classByTicker[tk];
          if (!EQUITY_CLASSES.has(cls)) return false;
        }
        return true;
      }),
      prices, monthlyDate, daily,
      pastReturns: equity.map(e => e.ret),  // PIT — only months already realised
      // Combined estimator: try daily first (60d window), fall back to monthly
      // (24m window) when daily history is too short. This is critical for
      // backtests that span pre-2016 — Yahoo's interval=1d only goes ~10y back.
      vol: (tk, days) => {
        const v = trailingVol(daily, tk, decisionDate, days || 60);
        if (v != null) return v;
        return trailingVolMonthly(prices[tk], t, 24);
      },
      moments: (tk, days) => trailingMoments(daily, tk, decisionDate, days || 60),
      mom12_1: tk => mom12_1(prices[tk], t),
      momKtoJ: (tk, k, j) => momKtoJ(prices[tk], t, k, j),
      sma: (tk, n) => trailingSMA(prices[tk], t, n),
      prevWeights: weights
    };

    let target = {};
    try { target = decide(t, ctx) || {}; }
    catch (e) { console.warn(`decide failed at ${months[t]}:`, e.message); target = {}; }

    diag.eligibleSum += ctx.eligibleTickers.length; diag.eligibleCount++;
    const tgtSize = Object.values(target).filter(w => Math.abs(w) > 1e-6).length;
    const fullThreshold = opts.targetN != null ? opts.targetN : 5;
    if (tgtSize === 0) diag.emptyMonths++;
    else if (tgtSize >= fullThreshold) diag.fullNMonths++;
    else diag.partialNMonths++;

    // -- Apply turnover cost on the *change* in weights, weighted by per-ticker bps
    const allTickers = new Set([...Object.keys(weights), ...Object.keys(target)]);
    let turnover = 0;
    let costFrac = 0;
    for (const tk of allTickers) {
      const dW = Math.abs((target[tk] || 0) - (weights[tk] || 0));
      if (dW <= 1e-9) continue;
      turnover += dW;
      costFrac += dW * (bpsFor(tk) / 10000);
    }

    // -- Apply month t+1 return.
    //   execMode='firstDayT1' (default): execute at close of first trading day
    //     of t+1, hold to close of last day of t+1. Return = monthlyClose[t+1]
    //     / firstDayClose[t+1] - 1. This matches the audit-fixed convention and
    //     is what published TSMOM/cross-sectional backtests use.
    //   execMode='closeT' (legacy): close-of-t to close-of-t+1. Slightly more
    //     flattering (you keep the first day's drift) but harder to implement.
    let portRet = -costFrac;
    let invested = 0;
    for (const tk of Object.keys(target)) {
      const w = target[tk];
      let pIn, pOut;
      if (execMode === 'closeT') {
        pIn  = prices[tk][t];
        pOut = prices[tk][t + 1];
      } else {
        const fdc = firstDayClose && firstDayClose[tk];
        pIn  = (fdc && fdc[t + 1] != null) ? fdc[t + 1] : prices[tk][t];
        pOut = prices[tk][t + 1];
      }
      if (pIn == null || pOut == null || pIn <= 0) continue;
      portRet += w * (pOut / pIn - 1);
      invested += Math.abs(w);
    }

    // -- Cash earns rf; leverage pays rf + borrowBps.
    const cashPortion = 1 - invested;
    const rfMo = rfReturn(t + 1);
    const borrowMo = borrowBps / 10000 / 12;
    if (cashPortion >= 0) {
      portRet += cashPortion * rfMo;
    } else {
      // Leveraged: pay rf + spread on the borrowed portion.
      portRet += cashPortion * (rfMo + borrowMo);  // cashPortion < 0, so this is a deduction
    }

    nav *= (1 + portRet);
    weights = target;

    const grossExposure = Object.values(weights).reduce((s, w) => s + Math.abs(w), 0);
    const nHold = Object.values(weights).filter(w => Math.abs(w) > 1e-6).length;
    diag.grossSum += grossExposure; diag.holdSum += nHold;

    equity.push({
      date: months[t + 1],   // attribute return to month t+1 (when it was earned)
      nav: +nav.toFixed(6),
      ret: +portRet.toFixed(6),
      turnover: +turnover.toFixed(4),
      gross: +grossExposure.toFixed(4),
      nHold
    });
    wHistory.push({ date: months[t], weights: { ...weights } });
  }

  // Finalise diagnostics
  const N = diag.eligibleCount || 1;
  const diagOut = {
    months: equity.length,
    avgEligible:  +(diag.eligibleSum / N).toFixed(1),
    avgGross:     +(diag.grossSum / N).toFixed(3),
    avgHoldings:  +(diag.holdSum / N).toFixed(2),
    pctEmpty:     +((diag.emptyMonths / N) * 100).toFixed(1),
    pctFullN:     +((diag.fullNMonths / N) * 100).toFixed(1),
    pctPartialN:  +((diag.partialNMonths / N) * 100).toFixed(1)
  };
  return { equity, wHistory, diag: diagOut };
}

// ============================================================================
// 5. Strategy 1 — Petr-style rotational momentum
// ============================================================================

function strategyPetr(opts = {}) {
  const N = opts.N || 5;
  const volTarget = opts.volTarget || 0.10;     // 10% per holding
  const cap = opts.cap || 0.30;                  // single-name cap
  const regimeTicker = opts.regimeTicker || 'SPY';
  const regimeSMA = opts.regimeSMA || 10;
  const regimeMode = opts.regimeMode || 'binary';     // 'binary' or 'graduated'
  const regimeScale = opts.regimeScale || 0.05;       // ±5% ramp
  const weighting = opts.weighting || 'volTarget';    // 'volTarget' or 'equal'  

  return function decide(t, ctx) {
    // Regime: SPY price vs. its 10-month SMA. Default is Petr's binary gate;
    // 'graduated' mode scales exposure linearly from 0 (price = SMA × 0.95) to
    // 1 (price = SMA × 1.05) so the strategy de-risks gradually instead of
    // flipping all-cash on a single month-end print.
    const spy = ctx.prices[regimeTicker];
    if (!spy) return {};
    const sma = trailingSMA(spy, t + 1, regimeSMA);
    const spyNow = spy[t];
    if (sma == null || spyNow == null) return {};
    const factor = regimeFactor(spyNow, sma, regimeMode, regimeScale);
    if (factor <= 0) return {};

    // Rank eligible by 12-1 momentum
    const ranked = ctx.eligibleTickers
      .map(tk => ({ tk, m: ctx.mom12_1(tk) }))
      .filter(x => x.m != null && isFinite(x.m))
      .sort((a, b) => b.m - a.m)
      .filter(x => x.m > 0)         // only positives
      .slice(0, N);

    if (!ranked.length) return {};

    // Sizing: vol-target (default) or equal-weight (1/N)
    const raw = {};
    let sumW = 0;
    if (weighting === 'equal') {
      // 1/N per holding, fully invested. Sigma still required so we ignore
      // tickers without a vol estimate (consistent eligibility filter).
      const eligible = ranked.filter(({ tk }) => {
        const s = ctx.vol(tk, 60);
        return s != null && s > 0;
      });
      const n = eligible.length;
      if (n === 0) return {};
      const w = 1 / n;
      for (const { tk } of eligible) { raw[tk] = w; sumW += w; }
    } else {
      // Vol-target: w_i = volTarget / sigma_i
      for (const { tk } of ranked) {
        const sigma = ctx.vol(tk, 60);
        if (sigma == null || sigma <= 0) continue;
        const w = volTarget / sigma;
        raw[tk] = w;
        sumW += w;
      }
    }
    if (sumW === 0) return {};

    // De-lever to <=1.0 gross (no-op for equal-weight which already sums to 1)
    let scale = sumW > 1 ? 1 / sumW : 1;
    const targetGross = Math.min(1, sumW);
    let weights = {};
    for (const tk of Object.keys(raw)) weights[tk] = raw[tk] * scale;

    // Iteratively apply per-name cap and redistribute the chopped excess
    // proportionally to the un-capped names. Without this, capped weight just
    // leaks to cash, under-deploying the portfolio.
    for (let iter = 0; iter < 4; iter++) {
      let excess = 0; const capped = new Set(); const free = [];
      for (const tk of Object.keys(weights)) {
        if (weights[tk] >= cap - 1e-9) { excess += weights[tk] - cap; weights[tk] = cap; capped.add(tk); }
        else free.push(tk);
      }
      if (excess <= 1e-9 || !free.length) break;
      const freeSum = free.reduce((s, tk) => s + weights[tk], 0);
      if (freeSum <= 0) break;
      for (const tk of free) weights[tk] += excess * (weights[tk] / freeSum);
    }
    // Apply regime factor as a gross-exposure multiplier. Binary mode keeps
    // the original Petr behaviour (factor = 0 already early-returned, factor = 1
    // is no-op). Graduated mode partially de-risks instead of going all-cash.
    if (factor < 1) {
      for (const tk of Object.keys(weights)) weights[tk] *= factor;
    }
    return weights;
  };
}

// ============================================================================
// 6. Strategy 2 — AQR-style TSMOM
// ============================================================================

function strategyTSMOM(opts = {}) {
  const sigmaAsset = opts.sigmaAsset || 0.20;        // 20% per-asset
  const sigmaPort = opts.sigmaPort || 0.40;          // 40% portfolio cap (assumed corr=1)
  // By default we only allow longs in equity ETFs (retail can't easily short ETFs).
  // Class names that are typically tradeable both ways for sophisticated retail:
  const shortable = new Set(opts.shortableClasses || [
    'Fixed Income', 'Commodity', 'Currency', 'Alternatives'
  ]);
  const allowShort = opts.allowShort != null ? opts.allowShort : true;
  const useLeverageScalar = !!opts.aqrLeverage;       // AQR-equivalent (geared) version
  const maxLeverage = opts.maxLeverage || 2.5;        // hard cap on gross exposure
  const lookbackMonths = opts.lookbackMonths || 12;   // 12-month TSMOM signal

  // Rolling buffer of conservative-gross history. Realised vol comes from
  // ctx.pastReturns inside the decide closure. Only used if useLeverageScalar.
  const recentAssumed = [];
  const ratioWindow = 12; // 1-year rolling

  return function decide(t, ctx) {
    const elig = ctx.eligibleTickers;
    const raw = {};
    let assumedGross = 0;
    let n = 0;
    for (const tk of elig) {
      const m = momKtoJ(ctx.prices[tk], t, lookbackMonths, 0); // r over last L months
      if (m == null || !isFinite(m)) continue;
      const sigma = ctx.vol(tk, 60);
      if (sigma == null || sigma <= 0) continue;

      // Determine sign and shortability
      let sign = m > 0 ? 1 : (m < 0 ? -1 : 0);
      if (sign === 0) continue;

      // Look up class for short-eligibility filter (passed via opts.classByTicker)
      const tkClass = opts.classByTicker ? opts.classByTicker[tk] : null;
      if (sign === -1) {
        if (!allowShort) continue;
        if (tkClass && !shortable.has(tkClass)) continue;
      }

      const w = sign * (sigmaAsset / sigma);
      raw[tk] = w;
      assumedGross += Math.abs(w) * sigma;
      n++;
    }
    if (n === 0) return {};

    // AQR-conservative cap: scale so sum of |w| × sigma ≤ sigmaPort
    let k = assumedGross > sigmaPort ? sigmaPort / assumedGross : 1;
    let weights = {};
    for (const tk of Object.keys(raw)) weights[tk] = raw[tk] * k;

    // AQR-equivalent leverage: divide by realised/assumed ratio so realised vol
    // hits sigmaPort, not the conservative all-correlated number.
    if (useLeverageScalar) {
      // Estimate the realised/conservative ratio from ACTUAL past portfolio
      // returns vs the conservative gross we ran in those months (audit fix #4).
      // ctx.pastReturns is the monthly return series of THIS strategy up to
      // (but not including) decision month t. Use the most recent ratioWindow
      // months for the realised side.
      const past = (ctx.pastReturns || []).slice(-ratioWindow);
      const assumPast = recentAssumed.slice(-ratioWindow);
      if (past.length >= 6 && assumPast.length >= 6) {
        const meanP = past.reduce((s, v) => s + v, 0) / past.length;
        let varP = 0;
        for (const v of past) varP += (v - meanP) * (v - meanP);
        varP /= Math.max(1, past.length - 1);
        const realisedVol = Math.sqrt(varP) * Math.sqrt(12);  // annualised
        const meanA = assumPast.reduce((s, v) => s + v, 0) / assumPast.length;
        const ratio = meanA > 0 ? realisedVol / meanA : 1;
        const minRatio = 1 / maxLeverage;
        const safeRatio = Math.max(minRatio, Math.min(1.0, ratio));
        for (const tk of Object.keys(weights)) weights[tk] /= safeRatio;
      }

      // The realised vol is now estimated from actual past PORTFOLIO returns
      // (ctx.pastReturns), which runMonthly populates. We compare those realised
      // monthly returns' annualised vol to the ex-ante conservative gross at
      // each of those months. Both are PIT-strict (only past returns used).
      const consVol = Object.keys(weights).reduce((s, tk) => {
        const sg = ctx.vol(tk, 60);
        return s + (sg != null ? Math.abs(weights[tk]) * sg : 0);
      }, 0);
      recentAssumed.push(consVol);
      if (recentAssumed.length > ratioWindow * 2) recentAssumed.shift();
    }

    return weights;
  };
}

// ============================================================================
// 7. Strategy 3 — Multi-signal composite
// ============================================================================

function strategyMultiSignal(opts = {}) {
  const K = opts.K || 8;
  const volTarget = opts.volTarget || 0.10;
  const cap = opts.cap || 0.25;
  const halfLife = opts.halfLife || 3;
  const tau = opts.tau || 0.5;            // partial turnover
  const regimeTicker = opts.regimeTicker || 'SPY';
  const regimeSMA = opts.regimeSMA || 10;
  const regimeMode = opts.regimeMode || 'binary';
  const regimeScale = opts.regimeScale || 0.05;
  const decay = 1 - Math.pow(0.5, 1 / halfLife);

  // Composite cache: ticker -> previous EMA value
  const ema = {};

  // Signal direction map and regime weights from §7.4 of methodology
  const regimeWeights = {
    on:  { MOM12: 1.0, MOM6: 1.0, MOM3: 0.5, TREND: 1.0, LOWVOL: 0.5, NEGSKEW: 1.0, NEGKURT: 0.0 },
    off: { MOM12: 0.5, MOM6: 0.5, MOM3: 1.0, TREND: 1.0, LOWVOL: 1.5, NEGSKEW: 0.5, NEGKURT: 1.0 }
  };

  return function decide(t, ctx) {
    // Determine global regime
    const spy = ctx.prices[regimeTicker];
    const sma = spy ? trailingSMA(spy, t + 1, regimeSMA) : null;
    const spyNow = spy ? spy[t] : null;
    const regime = (sma != null && spyNow != null && spyNow > sma) ? 'on' : 'off';
    const RW = regimeWeights[regime];

    // Compute raw signals per eligible ticker
    const rawSig = {};
    for (const tk of ctx.eligibleTickers) {
      const m12 = mom12_1(ctx.prices[tk], t);
      const m6  = momKtoJ(ctx.prices[tk], t, 6, 1);
      const m3  = momKtoJ(ctx.prices[tk], t, 3, 1);
      const sma10 = trailingSMA(ctx.prices[tk], t + 1, 10);
      const pNow = ctx.prices[tk][t];
      const trend = (sma10 && pNow) ? (pNow - sma10) / sma10 : null;
      const sigma = ctx.vol(tk, 60);
      const moments = ctx.moments(tk, 60);

      rawSig[tk] = {
        MOM12: m12,
        MOM6: m6,
        MOM3: m3,
        TREND: trend,
        LOWVOL: sigma != null && sigma > 0 ? -sigma : null,         // higher = better (low vol)
        NEGSKEW: moments ? -moments.skew : null,                     // long low-skew
        NEGKURT: moments ? -moments.excessKurt : null,
        sigma
      };
    }

    // Cross-sectional z-score per signal (median/MAD for robustness)
    const sigKeys = ['MOM12', 'MOM6', 'MOM3', 'TREND', 'LOWVOL', 'NEGSKEW', 'NEGKURT'];
    const zSig = {};
    for (const k of sigKeys) {
      const vals = ctx.eligibleTickers
        .map(tk => rawSig[tk][k])
        .filter(v => v != null && isFinite(v));
      if (vals.length < 5) { zSig[k] = null; continue; }
      const sorted = [...vals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const absDev = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
      const mad = absDev[Math.floor(absDev.length / 2)] || 1e-6;
      zSig[k] = { median, mad };
    }

    // Composite per ticker
    const composite = {};
    for (const tk of ctx.eligibleTickers) {
      let s = 0, w = 0;
      for (const k of sigKeys) {
        const r = rawSig[tk][k];
        const z = zSig[k];
        if (r == null || !isFinite(r) || !z) continue;
        const zv = (r - z.median) / (z.mad || 1e-6);
        const wt = RW[k] || 0;
        s += wt * zv;
        w += wt;
      }
      if (w > 0) composite[tk] = s / w;
    }

    // EMA smoothing per ticker. New entrants are seeded at decay × composite
    // (steady-state weight) instead of full composite, so they don't get an
    // unfair "instant signal" advantage over incumbents (audit fix #11).
    for (const tk of Object.keys(composite)) {
      ema[tk] = ema[tk] != null
        ? (1 - decay) * ema[tk] + decay * composite[tk]
        : decay * composite[tk];
    }
    // Decay carried positions of tickers that fell out of the universe
    for (const tk of Object.keys(ema)) {
      if (composite[tk] == null) ema[tk] = (1 - decay) * ema[tk]; // bleed toward 0
    }
    // Prune microscopic EMAs to keep the cache from growing unbounded (audit fix #14).
    for (const tk of Object.keys(ema)) {
      if (Math.abs(ema[tk]) < 1e-6 && !ctx.eligibleTickers.includes(tk)) delete ema[tk];
    }

    // Top-K by EMA composite, and only positive scores
    const ranked = Object.keys(ema)
      .filter(tk => ctx.eligibleTickers.includes(tk) && ema[tk] > 0)
      .sort((a, b) => ema[b] - ema[a])
      .slice(0, K);

    if (!ranked.length) {
      // Trend the existing portfolio toward cash via partial turnover
      const out = {};
      for (const tk of Object.keys(ctx.prevWeights)) {
        const w = (1 - tau) * ctx.prevWeights[tk];
        if (Math.abs(w) > 1e-4) out[tk] = w;
      }
      return out;
    }

    // Vol-target sizing on the new target
    const raw = {};
    let sumW = 0;
    for (const tk of ranked) {
      const sigma = rawSig[tk].sigma;
      if (sigma == null || sigma <= 0) continue;
      const w = volTarget / sigma;
      raw[tk] = w; sumW += w;
    }
    if (sumW === 0) return ctx.prevWeights;

    const scale = sumW > 1 ? 1 / sumW : 1;
    let targetW = {};
    for (const tk of Object.keys(raw)) targetW[tk] = raw[tk] * scale;
    // Iteratively cap and redistribute (audit fix #8 — same leak the Petr
    // strategy had). Without this, capped weight leaks to cash silently.
    for (let iter = 0; iter < 4; iter++) {
      let excess = 0; const free = [];
      for (const tk of Object.keys(targetW)) {
        if (targetW[tk] >= cap - 1e-9) { excess += targetW[tk] - cap; targetW[tk] = cap; }
        else free.push(tk);
      }
      if (excess <= 1e-9 || !free.length) break;
      const freeSum = free.reduce((s, tk) => s + targetW[tk], 0);
      if (freeSum <= 0) break;
      for (const tk of free) targetW[tk] += excess * (targetW[tk] / freeSum);
    }

    // Apply regime factor to the target before partial turnover. In graduated
    // mode this scales exposure smoothly with how strong the equity-trend gate
    // is. Binary mode is a no-op since target was already computed only when
    // regime was 'on' or 'off' weighting was applied above.
    const mFactor = regimeFactor(spyNow, sma, regimeMode, regimeScale);
    if (mFactor < 1 && mFactor > 0) {
      for (const tk of Object.keys(targetW)) targetW[tk] *= mFactor;
    }

    // Partial turnover from current to target
    const out = {};
    const all = new Set([...Object.keys(ctx.prevWeights), ...Object.keys(targetW)]);
    for (const tk of all) {
      const cur = ctx.prevWeights[tk] || 0;
      const tgt = targetW[tk] || 0;
      const w = (1 - tau) * cur + tau * tgt;
      if (Math.abs(w) > 1e-4) out[tk] = w;
    }
    return out;
  };
}

// ============================================================================
// 8. Stats
// ============================================================================

function computeStats(equity) {
  if (!equity.length) return null;
  const rets = equity.map(e => e.ret);
  const n = rets.length;

  const meanM = rets.reduce((s, r) => s + r, 0) / n;
  const varM = rets.reduce((s, r) => s + (r - meanM) * (r - meanM), 0) / Math.max(1, n - 1);
  const sdM = Math.sqrt(varM);

  const annReturn = Math.pow(equity[n - 1].nav, 12 / n) - 1;
  const annVol = sdM * Math.sqrt(12);
  const sharpe = sdM > 0 ? (meanM / sdM) * Math.sqrt(12) : 0;

  // Sortino: downside-only sd, normalized by TOTAL n (not by downside count).
  // Standard convention so it compares apples-to-apples with Sharpe (audit fix #9).
  let sumDn2 = 0;
  for (const r of rets) if (r < 0) sumDn2 += r * r;
  const sdD = n > 0 ? Math.sqrt(sumDn2 / n) : 0;
  const sortino = sdD > 0 ? (meanM / sdD) * Math.sqrt(12) : 0;

  // Max drawdown (peak-to-trough)
  let peak = 1, maxDD = 0, ddStart = null, maxDDStart = null, maxDDEnd = null;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i].nav > peak) { peak = equity[i].nav; ddStart = equity[i].date; }
    const dd = equity[i].nav / peak - 1;
    if (dd < maxDD) { maxDD = dd; maxDDStart = ddStart; maxDDEnd = equity[i].date; }
  }

  const calmar = maxDD < 0 ? annReturn / -maxDD : 0;
  const hitRate = rets.filter(r => r > 0).length / n;

  // Higher moments (used for deflated Sharpe)
  let m3 = 0, m4 = 0;
  for (const r of rets) {
    const d = r - meanM;
    m3 += d * d * d; m4 += d * d * d * d;
  }
  m3 /= n; m4 /= n;
  const skew = sdM > 0 ? m3 / (sdM * sdM * sdM) : 0;
  const kurt = sdM > 0 ? m4 / (sdM * sdM * sdM * sdM) : 3;

  // Turnover (annualised)
  const meanTurnover = equity.reduce((s, e) => s + (e.turnover || 0), 0) / n * 12;

  // Bailey/López de Prado deflated Sharpe ratio
  // Treat each strategy as 1 trial here; aggregate-trial DSR is computed in the writer.
  const sr = sharpe / Math.sqrt(12); // monthly Sharpe
  const dsrDenom = Math.sqrt(1 - skew * sr + ((kurt - 1) / 4) * sr * sr);
  const dsrMonthly = dsrDenom > 0 ? sr / dsrDenom : 0;

  return {
    months: n,
    finalNAV: +equity[n - 1].nav.toFixed(4),
    cagr: +annReturn.toFixed(4),
    vol: +annVol.toFixed(4),
    sharpe: +sharpe.toFixed(3),
    sortino: +sortino.toFixed(3),
    calmar: +calmar.toFixed(3),
    maxDD: +maxDD.toFixed(4),
    maxDDStart, maxDDEnd,
    hitRate: +hitRate.toFixed(3),
    skew: +skew.toFixed(3),
    excessKurt: +(kurt - 3).toFixed(3),
    annTurnover: +meanTurnover.toFixed(2),
    dsrMonthly: +dsrMonthly.toFixed(3)
  };
}

// Buy-and-hold benchmark (e.g., SPY) over the same window
function benchmarkBH(timeline, ticker, startDate) {
  const idx = timeline.months.indexOf(startDate);
  const px = timeline.prices[ticker];
  if (idx < 0 || !px) return null;
  let nav = 1;
  const equity = [];
  for (let t = idx; t < timeline.months.length - 1; t++) {
    const a = px[t], b = px[t + 1];
    if (a == null || b == null || a <= 0) continue;
    const r = b / a - 1;
    nav *= (1 + r);
    equity.push({ date: timeline.months[t + 1], nav: +nav.toFixed(6), ret: +r.toFixed(6),
                   turnover: 0, gross: 1, nHold: 1 });
  }
  return equity;
}

// ============================================================================
// 9. Main
// ============================================================================

function main() {
  console.log(`[${new Date().toISOString()}] Loading history...`);
  const history = loadHistory();
  const tickers = Object.keys(history);
  console.log(`  loaded ${tickers.length} tickers`);

  // Ticker → class lookup (for TSMOM short eligibility)
  const classByTicker = {};
  for (const tk of tickers) classByTicker[tk] = history[tk].cls;

  const timeline = buildTimeline(history);
  console.log(`  timeline: ${timeline.months.length} months from ${timeline.months[0]} to ${timeline.months[timeline.months.length-1]}`);

  const out = {
    generatedAt: new Date().toISOString(),
    universe: tickers.map(t => ({ ticker: t, name: history[t].name, cls: history[t].cls,
                                  inception: history[t].inception })),
    timeline: { firstMonth: timeline.months[0], lastMonth: timeline.months[timeline.months.length-1] },
    strategies: {}
  };

  const regimeOpts = {};
  if (REGIME_MODE)  regimeOpts.regimeMode  = REGIME_MODE;
  if (REGIME_SCALE) regimeOpts.regimeScale = parseFloat(REGIME_SCALE);
  if (WEIGHTING)    regimeOpts.weighting   = WEIGHTING;

  const strategies = {
    petr:           { name: 'Petr Rotational Momentum',       run: strategyPetr(regimeOpts),                      targetN: 5  },
    tsmom:          { name: 'TSMOM (40% vol cap, conservative)',
                       run: strategyTSMOM({ classByTicker, aqrLeverage: false }),                                  targetN: 10 },
    tsmom_aqr:      { name: 'TSMOM (40% vol target, AQR-leveraged)',
                       run: strategyTSMOM({ classByTicker, aqrLeverage: true }),                                   targetN: 10 },
    multi:          { name: 'Multi-signal composite',         run: strategyMultiSignal(regimeOpts),               targetN: 8  }
  };

  // Per-class default costs in bps (one-way). Tuned to typical retail spreads:
  // mega-cap blends are tight; small/thematic/EM/alts are wider.
  const DEFAULT_COST_BY_CLASS = {
    'US Equity':     2,
    'Intl Equity':   5,
    'EM Equity':     8,
    'Fixed Income':  3,
    'Commodity':     8,
    'Real Estate':   5,
    'Currency':      6,
    'Alternatives': 12,
    'Thematic':     12
  };
  const runOpts = {
    classByTicker,
    costByClass: DEFAULT_COST_BY_CLASS,
    rfTicker:    RF_TICKER || 'SHY',
    borrowBps:   BORROW_BPS != null ? parseFloat(BORROW_BPS) : 50,
    execMode:    EXEC_MODE || 'firstDayT1'
  };
  if (START_MONTH) runOpts.startMonth = START_MONTH;
  if (COST_BPS != null) runOpts.costBps = parseFloat(COST_BPS);
  if (EQUITY_ONLY) runOpts.equityOnly = true;

  for (const key of Object.keys(strategies)) {
    if (ONLY_STRATEGY && ONLY_STRATEGY !== key) continue;
    console.log(`\nRunning strategy: ${strategies[key].name}`);
    const stratOpts = { ...runOpts, targetN: strategies[key].targetN };
    const { equity, wHistory, diag } = runMonthly(timeline, strategies[key].run, stratOpts);
    const stats = computeStats(equity);
    if (!stats) { console.warn(`  no equity produced for ${key}`); continue; }
    console.log(`  CAGR=${(stats.cagr*100).toFixed(2)}%  Vol=${(stats.vol*100).toFixed(2)}%  Sharpe=${stats.sharpe}  MaxDD=${(stats.maxDD*100).toFixed(2)}%  Turnover=${stats.annTurnover}/yr`);
    console.log(`  Diag: avgEligible=${diag.avgEligible}  avgGross=${diag.avgGross}  avgHoldings=${diag.avgHoldings}  cash%=${diag.pctEmpty}%  fullN%=${diag.pctFullN}%  partialN%=${diag.pctPartialN}%`);
    out.strategies[key] = {
      name: strategies[key].name,
      stats,
      diag,
      equity,
      // Sample every 6 months but always include the final snapshot
      weightSnapshots: wHistory.filter((_, i) => i % 6 === 0 || i === wHistory.length - 1)
    };
  }

  // Benchmark over the period of the first strategy.
  const refKey = Object.keys(out.strategies)[0];
  if (refKey) {
    const startDate = out.strategies[refKey].equity[0].date;
    const bh = benchmarkBH(timeline, 'SPY', startDate);
    if (bh) {
      out.benchmarks = {
        SPY: { name: 'SPY Buy & Hold', equity: bh, stats: computeStats(bh) }
      };
    }
  }
  out.params = {
    startMonth: START_MONTH || null,
    costBps: COST_BPS != null ? parseFloat(COST_BPS) : 5,
    costByClass: runOpts.costByClass,
    rfTicker: runOpts.rfTicker,
    borrowBps: runOpts.borrowBps,
    execMode: runOpts.execMode,
    regimeMode: REGIME_MODE || 'binary',
    regimeScale: REGIME_SCALE != null ? parseFloat(REGIME_SCALE) : 0.05,
    weighting: WEIGHTING || 'volTarget',
    equityOnly: !!EQUITY_ONLY
  };

  // Bailey/Lopez de Prado deflated Sharpe (multi-trial). Use a realistic trial
  // count that reflects parameters considered across this codebase (regime
  // mode, lookback, N, cap, vol-target, halfLife, etc.) — not just the 4
  // strategies we ran. Honesty matters here (audit fix #10).
  const dsrTrialCount = 50; // see methodology §10
  const N = Math.max(Object.keys(out.strategies).length, dsrTrialCount);
  const eulerGamma = 0.5772156649;
  const expectedMaxSR = N > 1
    ? Math.sqrt(2 * Math.log(N)) - (eulerGamma + Math.log(Math.log(Math.max(N, 2)))) / Math.sqrt(2 * Math.log(N))
    : 0;
  for (const k of Object.keys(out.strategies)) {
    const s = out.strategies[k].stats;
    const srMo = s.sharpe / Math.sqrt(12);
    const skew = s.skew, kurt = s.excessKurt + 3;
    const denom = Math.sqrt(1 - skew * srMo + ((kurt - 1) / 4) * srMo * srMo);
    const months = s.months;
    s.deflatedSharpe = denom > 0 && months > 1
      ? +(((srMo - expectedMaxSR / Math.sqrt(12)) * Math.sqrt(months - 1)) / denom).toFixed(3)
      : 0;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out));
  const sizeKB = fs.statSync(OUTPUT_FILE).size / 1024;
  console.log(`\nWrote ${OUTPUT_FILE} (${sizeKB.toFixed(1)} KB)`);
}

if (require.main === module) main();

module.exports = {
  loadHistory, buildTimeline, runMonthly,
  strategyPetr, strategyTSMOM, strategyMultiSignal,
  computeStats, benchmarkBH, regimeFactor
};
