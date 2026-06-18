// events.js — SentimentTrader-style event scenario engine.
//
// Reads history/<ticker>.json (produced by fetch_history.js) and, for each
// pre-registered event in events/catalogue.json, finds every historical
// trigger date, measures the forward-return distribution at fixed horizons,
// and compares it to the unconditional baseline. Writes events_results.json,
// which the "Event Studies" tab of index.html renders.
//
// Run: node events.js
//
// ----------------------------------------------------------------------------
// The three ways this study is silently wrong, stated before the code (per the
// vault prompting convention), and the countermeasure for each:
//
//   1. Pseudo-replication from overlapping forward windows. "47 triggers" with
//      a 3-month forward window, when triggers cluster in a few volatile
//      episodes, is really a handful of independent observations. Countermeasure:
//      triggers within `clusterDays` collapse to one EPISODE; we headline the
//      episode count, and the significance test is a random-entry Monte Carlo
//      that resamples real overlapping windows of the same sample size, so the
//      null carries the same overlap structure as the conditional sample.
//
//   2. Look-ahead in the indicator. RSI/SMA/breadth at date t must use only
//      data through t. We compute every indicator causally and enter at the
//      close of the trigger day (the close that defines the signal) — the
//      conventional event-study timing. This is mildly optimistic versus the
//      backtest's firstDayT1 fill; it is documented on the card, not hidden.
//
//   3. Multiple testing. Scanning many event x horizon cells and surfacing the
//      green ones manufactures false positives. We record how many cells were
//      screened in the output so the dashboard can show the multiple-testing
//      context; a catalogue event without a written rationale is not admitted.
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'history');
const CATALOGUE = path.join(__dirname, 'events', 'catalogue.json');
const OUT = path.join(__dirname, 'events_results.json');

// Forward-return horizons in TRADING days (not calendar days — we index into
// the bar array, which sidesteps all weekday/holiday date arithmetic).
const HORIZONS = [5, 10, 21, 42, 63, 126, 252];
const HORIZON_LABELS = ['1W', '2W', '1M', '2M', '3M', '6M', '1Y'];

const BOOT_ITERS = 2000;

// ---------- small stats helpers ----------

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }

function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function median(a) { return quantile(a, 0.5); }

function hitRate(a) { return a.length ? a.filter(x => x > 0).length / a.length : NaN; }

function randInt(n) { return Math.floor(Math.random() * n); }

// ---------- indicators (all causal) ----------

// Wilder's RSI over `period` bars on a value series. Returns an array aligned
// to `vals`, with the first `period` entries null (not yet defined).
function rsiWilder(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Trailing simple moving average; out[i] uses vals[i-period+1 .. i] inclusive.
function sma(vals, period) {
  const out = new Array(vals.length).fill(null);
  let run = 0;
  for (let i = 0; i < vals.length; i++) {
    run += vals[i];
    if (i >= period) run -= vals[i - period];
    if (i >= period - 1) out[i] = run / period;
  }
  return out;
}

// ---------- data loading ----------

function loadTicker(tk) {
  const f = path.join(HISTORY_DIR, `${tk}.json`);
  if (!fs.existsSync(f)) throw new Error(`history/${tk}.json not found — run fetch_history.js`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// Global risk regime indicator (methodology §7.4): SPY above its 200-day SMA.
// Returned as a map from ISO date -> true/false for every SPY daily bar where
// the 200-day SMA is defined.
function buildRegime(spy) {
  const ac = spy.daily.map(b => b.ac);
  const s200 = sma(ac, 200);
  const map = {};
  for (let i = 0; i < spy.daily.length; i++) {
    if (s200[i] != null) map[spy.daily[i].d] = ac[i] > s200[i];
  }
  return map;
}

// ---------- trigger detection ----------
//
// Each event produces a boolean trigger on an "indicator series" that shares a
// date axis with the "target series" whose forward returns we measure. For a
// single-asset event the two are the same ticker; for a breadth event the
// indicator is the breadth series and the target is SPY.

// SPY RSI goes from overbought (>70) to below 50 within `window` trading days.
// Trigger fires on the day RSI crosses below 50, provided RSI exceeded 70
// within the preceding `window` bars.
function detectRsiOverboughtToMid(target, ev) {
  const ac = target.daily.map(b => b.ac);
  const dates = target.daily.map(b => b.d);
  const rsi = rsiWilder(ac, ev.rsiPeriod || 14);
  const win = ev.window || 3;
  const triggers = [];
  for (let i = 1; i < rsi.length; i++) {
    if (rsi[i] == null || rsi[i - 1] == null) continue;
    // moment of crossing below 50
    if (!(rsi[i] < 50 && rsi[i - 1] >= 50)) continue;
    // was overbought within the preceding `win` bars?
    let wasOB = false;
    for (let k = 1; k <= win; k++) {
      if (i - k >= 0 && rsi[i - k] != null && rsi[i - k] > 70) { wasOB = true; break; }
    }
    if (wasOB) triggers.push(i);
  }
  return { dates, ac, triggers, indicator: rsi, indicatorName: `RSI(${ev.rsiPeriod || 14})` };
}

// Cross-asset breadth: share of the universe trading above its own 200-day SMA,
// computed on SPY's date axis. Trigger fires when breadth crosses below `level`.
function detectBreadthCross(spy, ev, universe) {
  const level = ev.level != null ? ev.level : 0.5;
  const minNames = ev.minNames || 20;

  // Per-ticker map: date -> (ac > its trailing 200d SMA), only where defined.
  const aboveByTk = {};
  for (const tk of universe) {
    let h;
    try { h = loadTicker(tk); } catch (e) { continue; }
    const ac = h.daily.map(b => b.ac);
    const s200 = sma(ac, 200);
    const m = {};
    for (let i = 0; i < h.daily.length; i++) {
      if (s200[i] != null) m[h.daily[i].d] = ac[i] > s200[i];
    }
    aboveByTk[tk] = m;
  }

  // Breadth on SPY's axis.
  const dates = spy.daily.map(b => b.d);
  const ac = spy.daily.map(b => b.ac);
  const breadth = new Array(dates.length).fill(null);
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    let above = 0, total = 0;
    for (const tk of universe) {
      const m = aboveByTk[tk];
      if (m && d in m) { total++; if (m[d]) above++; }
    }
    if (total >= minNames) breadth[i] = above / total;
  }

  const triggers = [];
  for (let i = 1; i < breadth.length; i++) {
    if (breadth[i] == null || breadth[i - 1] == null) continue;
    if (breadth[i] < level && breadth[i - 1] >= level) triggers.push(i);
  }
  // Express breadth as a 0-100 series for display, consistent with RSI scale.
  return { dates, ac, triggers, indicator: breadth.map(b => b == null ? null : +(b * 100).toFixed(1)), indicatorName: '% > 200d SMA' };
}

// Collapse triggers whose forward windows overlap into one episode. We keep the
// FIRST trigger of each cluster; any later trigger within `clusterDays` bars of
// the cluster's anchor is absorbed.
function clusterEpisodes(triggers, clusterDays) {
  const eps = [];
  let anchor = -Infinity;
  for (const t of triggers) {
    if (t - anchor > clusterDays) { eps.push(t); anchor = t; }
  }
  return eps;
}

// ---------- forward-return analysis ----------

function analyseEvent(series, ev, regimeMap) {
  const { dates, ac, triggers } = series;
  const clusterDays = ev.clusterDays != null ? ev.clusterDays : 10;
  const episodes = clusterEpisodes(triggers, clusterDays);

  // Baseline: unconditional overlapping forward returns per horizon.
  const baseFwd = {};
  for (const h of HORIZONS) {
    const arr = [];
    for (let i = 0; i + h < ac.length; i++) arr.push(ac[i + h] / ac[i] - 1);
    baseFwd[h] = arr;
  }

  // Per-horizon conditional stats + significance.
  const byHorizon = HORIZONS.map((h, hi) => {
    const fwd = [], mfe = [], mae = [];
    for (const idx of episodes) {
      if (idx + h >= ac.length) continue;
      fwd.push(ac[idx + h] / ac[idx] - 1);
      let hi2 = -Infinity, lo2 = Infinity;
      for (let k = 1; k <= h; k++) {
        const r = ac[idx + k] / ac[idx] - 1;
        if (r > hi2) hi2 = r;
        if (r < lo2) lo2 = r;
      }
      mfe.push(hi2); mae.push(lo2);
    }
    const n = fwd.length;
    const base = baseFwd[h];
    const condMedian = median(fwd);

    // Random-entry Monte Carlo: draw n start indices uniformly from the valid
    // range, take the median forward return, repeat. The null inherits the same
    // overlap structure and sample size as the conditional set, so the p-value
    // is not inflated by pseudo-replication.
    let ge = 0;
    const nullMedians = [];
    const maxStart = ac.length - h;
    if (n > 0 && maxStart > 0) {
      for (let b = 0; b < BOOT_ITERS; b++) {
        const draws = [];
        for (let j = 0; j < n; j++) draws.push(base[randInt(maxStart)]);
        const m = median(draws);
        nullMedians.push(m);
        if (m >= condMedian) ge++;
      }
    }
    const pTwoSided = n > 0 ? 2 * Math.min(ge, BOOT_ITERS - ge) / BOOT_ITERS : NaN;
    const percentile = n > 0 ? 1 - ge / BOOT_ITERS : NaN; // where the conditional median sits in the null

    // CI on the conditional median by resampling episodes with replacement.
    let ciLo = NaN, ciHi = NaN;
    if (n > 1) {
      const meds = [];
      for (let b = 0; b < BOOT_ITERS; b++) {
        const s = [];
        for (let j = 0; j < n; j++) s.push(fwd[randInt(n)]);
        meds.push(median(s));
      }
      ciLo = quantile(meds, 0.05); ciHi = quantile(meds, 0.95);
    }

    return {
      h, label: HORIZON_LABELS[hi], n,
      mean: mean(fwd), median: condMedian, hit: hitRate(fwd),
      mfeMedian: median(mfe), maeMedian: median(mae),
      baseMean: mean(base), baseMedian: median(base), baseHit: hitRate(base),
      edgeMedian: condMedian - median(base),
      ciLo, ciHi, pValue: pTwoSided, percentile
    };
  });

  // Episode list with per-horizon forward returns + regime tag, for the table
  // and the signal map.
  const episodeRows = episodes.map(idx => {
    const fwd = {};
    for (const h of HORIZONS) fwd[h] = idx + h < ac.length ? +( (ac[idx + h] / ac[idx] - 1) * 100).toFixed(2) : null;
    const d = dates[idx];
    return { date: d, idx, regime: d in regimeMap ? (regimeMap[d] ? 'on' : 'off') : null, fwd };
  });

  const onCount = episodeRows.filter(e => e.regime === 'on').length;
  const offCount = episodeRows.filter(e => e.regime === 'off').length;

  // Downsample target + indicator series for the signal map (keep every bar —
  // ~2,500 points is fine, but round to keep the JSON compact).
  const priceSeries = dates.map((d, i) => ({ d, ac: +ac[i].toFixed(2), ind: series.indicator[i] == null ? null : +series.indicator[i].toFixed(1) }));

  return {
    nTriggers: triggers.length,
    nEpisodes: episodes.length,
    clusterDays,
    firstDate: episodes.length ? dates[episodes[0]] : null,
    lastDate: episodes.length ? dates[episodes[episodes.length - 1]] : null,
    regimeSplit: { on: onCount, off: offCount, untagged: episodeRows.length - onCount - offCount },
    indicatorName: series.indicatorName,
    byHorizon,
    episodes: episodeRows,
    priceSeries
  };
}

// ---------- main ----------

function main() {
  if (!fs.existsSync(CATALOGUE)) throw new Error(`catalogue not found at ${CATALOGUE}`);
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  const spy = loadTicker('SPY');
  const regimeMap = buildRegime(spy);

  const universe = (cat.universe && cat.universe.length)
    ? cat.universe
    : ['SPY']; // breadth events default to the catalogue's universe list

  const out = {
    generatedAt: new Date().toISOString(),
    dailyWindow: { start: spy.dailyStart, end: spy.lastDate },
    horizons: HORIZONS,
    horizonLabels: HORIZON_LABELS,
    nEventsScreened: cat.events.length,
    nHorizonsScreened: HORIZONS.length,
    multipleTestingNote:
      `${cat.events.length} pre-registered event(s) x ${HORIZONS.length} horizons = ` +
      `${cat.events.length * HORIZONS.length} cells screened. P-values are NOT corrected for ` +
      `multiple testing; treat a single green cell among many as weak evidence.`,
    events: []
  };

  for (const ev of cat.events) {
    if (!ev.rationale) { console.warn(`SKIP ${ev.id}: no rationale (not admitted to the catalogue).`); continue; }
    console.log(`Analysing ${ev.id} (${ev.kind})...`);
    let series;
    if (ev.kind === 'rsi_ob_to_mid') {
      series = detectRsiOverboughtToMid(loadTicker(ev.target), ev);
    } else if (ev.kind === 'breadth_cross') {
      series = detectBreadthCross(spy, ev, universe);
    } else {
      console.warn(`SKIP ${ev.id}: unknown kind ${ev.kind}`); continue;
    }
    const res = analyseEvent(series, ev, regimeMap);
    out.events.push({
      id: ev.id, name: ev.name, kind: ev.kind,
      target: ev.target || 'SPY', rationale: ev.rationale, definition: ev.definition,
      entryNote: 'Forward return measured from the close of the trigger day (event-study convention).',
      ...res
    });
    console.log(`  ${res.nTriggers} triggers -> ${res.nEpisodes} independent episodes (regime on/off: ${res.regimeSplit.on}/${res.regimeSplit.off})`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nWrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB) — ${out.events.length} event(s).`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('Fatal:', e.message); process.exit(1); }
}

module.exports = { rsiWilder, sma, clusterEpisodes, HORIZONS, HORIZON_LABELS };
