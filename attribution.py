"""
attribution.py — Benchmark-relative attribution layer for the ETF Trend Scanner.

Additive layer on top of backtest.js. Reads:
  - backtest_results.json     (strategy daily returns + monthly equity)
  - history/<TICKER>.json     (daily adj-close per ETF)
  - history/ACWI.json         (or URTH/VT fallback) for the single-ETF proxy

For each strategy in `strategies`, regresses the daily strategy return series
onto two benchmark return series using statsmodels.OLS:
  - Equal-weighted basket of all universe ETFs, daily rebalanced
  - ACWI (or URTH / VT fallback) as a single-ETF global proxy

Writes the results back into backtest_results.json under the `attribution` key
so the dashboard can render the comparison table, decision flag, and rolling
3-year residual Sharpe chart.

Run: `python3 attribution.py`

Strategy logic in backtest.js is NOT touched. Existing output sections
(strategies, benchmarks, equity, stats, weightSnapshots) are preserved
exactly — `attribution` is purely additive.
"""

import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

ROOT = Path(__file__).resolve().parent
HIST_DIR = ROOT / "history"
RESULTS_PATH = ROOT / "backtest_results.json"

# ----------------------------------------------------------------------------
# Loaders
# ----------------------------------------------------------------------------

def _normalize_index(df, freq):
    """Normalise the date index so daily and monthly series compose cleanly.

    Yahoo writes monthly bars with month-START timestamps (`YYYY-MM-01`) but
    our strategy monthly returns are month-END (so the index represents the
    end of the holding month, matching `equity[].date`). Aligning both to
    month-end here lets `pd.concat([...], axis=1).dropna()` actually match
    rows instead of dropping everything. We drop within-month duplicates
    (keeping the last value), which can occur if Yahoo emits the current
    partial month alongside the prior full-month bar.
    """
    if freq == "monthly":
        df.index = df.index.to_period("M").to_timestamp("M")
        df = df[~df.index.duplicated(keep="last")]
    return df


def load_history(freq="daily"):
    """Return {ticker: pd.Series of adj-close} for every ticker in the manifest.

    freq='daily' uses the 'daily' field (~10y back, Yahoo limit).
    freq='monthly' uses the 'monthly' field (back to inception, often 1990s).
    The monthly variant powers the long-sample monthly OLS — see §10.6.
    """
    manifest_path = HIST_DIR / "_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    out = {}
    for t in manifest["tickers"]:
        if t.get("status") != "ok":
            continue
        p = HIST_DIR / f"{t['ticker']}.json"
        if not p.exists():
            continue
        h = json.loads(p.read_text())
        bars = h.get(freq)
        if not bars:
            continue
        df = pd.DataFrame(bars)[["d", "ac"]]
        df["d"] = pd.to_datetime(df["d"])
        df = df.set_index("d").sort_index()
        df = _normalize_index(df, freq)
        out[t["ticker"]] = df["ac"]
    return out


def load_benchmark_etf(freq="daily"):
    """Try ACWI first, fall back to URTH then VT. Returns (ticker, ac_series) or (None, None)."""
    for tk in ("ACWI", "URTH", "VT"):
        p = HIST_DIR / f"{tk}.json"
        if p.exists():
            h = json.loads(p.read_text())
            bars = h.get(freq)
            if not bars:
                continue
            df = pd.DataFrame(bars)[["d", "ac"]]
            df["d"] = pd.to_datetime(df["d"])
            df = df.set_index("d").sort_index()
            df = _normalize_index(df, freq)
            return tk, df["ac"]
    return None, None


# ----------------------------------------------------------------------------
# Series builders
# ----------------------------------------------------------------------------

def daily_returns_series(strategy):
    """Pull the strategy daily return series produced by backtest.js."""
    dr = strategy.get("dailyReturns")
    if not dr:
        return None
    df = pd.DataFrame(dr)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")["ret"].astype(float).sort_index()


def monthly_returns_from_equity(strategy):
    """Pull the strategy monthly return series from `equity` (back to 1994).

    The `equity` field is produced by runMonthly() in backtest.js and exists
    for the full backtest window (vs `dailyReturns` which is bounded by Yahoo's
    ~10-year daily history). Indexed by month-end timestamp.
    """
    eq = strategy.get("equity")
    if not eq:
        return None
    df = pd.DataFrame(eq)
    df["date"] = pd.to_datetime(df["date"] + "-01") + pd.offsets.MonthEnd(0)
    return df.set_index("date")["ret"].astype(float).sort_index()


def ew_basket_returns(universe_prices):
    """Daily-rebalanced equal-weighted basket of all universe ETFs.

    Each day's return is the simple mean of available ETF daily returns. ETFs
    with no data on a given day (pre-inception or trading halt) are excluded
    from that day's mean — equivalent to a daily 1/N rebalance over the
    eligible set.
    """
    prices = pd.concat(universe_prices, axis=1, sort=False).sort_index()
    rets = prices.pct_change()
    return rets.mean(axis=1, skipna=True)


def class_by_ticker(results):
    """Build {ticker: class} from backtest_results.json's `universe` field."""
    return {u["ticker"]: u["cls"] for u in results.get("universe", [])}


def filtered_ew(universe_prices, classes_map, allowed_classes):
    """EW basket restricted to ETFs whose class is in `allowed_classes`.

    Returns (series, n_tickers, ticker_list). The ticker_list is the set of
    universe tickers in scope for this restricted basket — useful for the
    dashboard to label what the strategy was compared against.
    """
    allowed = set(allowed_classes)
    keep = {tk: ac for tk, ac in universe_prices.items()
            if classes_map.get(tk) in allowed}
    if not keep:
        return None, 0, []
    return ew_basket_returns(keep), len(keep), sorted(keep.keys())


def benchmark_etf_returns(ac):
    return ac.pct_change()


# ----------------------------------------------------------------------------
# Statistics
# ----------------------------------------------------------------------------

def max_drawdown(rets):
    """Max peak-to-trough drawdown of a return Series. Returns a negative float
    (or 0.0 if no drawdown). NaN if the series is empty or all-NaN."""
    r = rets.dropna()
    if r.empty:
        return float("nan")
    nav = (1.0 + r).cumprod()
    peak = nav.cummax()
    dd = (nav / peak - 1.0).min()
    return float(dd)


def gross_stats(rets, periods_per_year):
    """Annualised return, vol, Sharpe, max DD from a return Series."""
    rets = rets.dropna()
    n = len(rets)
    if n < 2:
        return None
    growth = float((1 + rets).prod())
    years = n / periods_per_year
    ann_return = growth ** (1 / years) - 1 if growth > 0 else float("nan")
    ann_vol = float(rets.std(ddof=1)) * math.sqrt(periods_per_year)
    p_mean = float(rets.mean())
    p_std = float(rets.std(ddof=1))
    sharpe = (p_mean / p_std) * math.sqrt(periods_per_year) if p_std > 0 else 0.0
    return {
        "ann_return": ann_return,
        "ann_vol": ann_vol,
        "sharpe": sharpe,
        "max_dd": max_drawdown(rets),
        "n_obs": int(n),
        "start": rets.index[0].strftime("%Y-%m-%d"),
        "end": rets.index[-1].strftime("%Y-%m-%d"),
    }


def gross_daily_stats(rets):
    """Backwards-compatible wrapper."""
    out = gross_stats(rets, 252)
    if out:
        out["n_days"] = out["n_obs"]
    return out


def run_ols(strat_ret, bench_ret, periods_per_year=252, min_obs=30):
    """OLS: strat_t = alpha + beta * bench_t + eps_t. Returns dict of stats.

    `periods_per_year` controls annualisation. Use 252 for daily returns and
    12 for monthly. `min_obs` is the minimum sample size to run the regression.
    """
    df = pd.concat(
        [strat_ret.rename("y"), bench_ret.rename("x")], axis=1, sort=False
    ).sort_index().dropna()
    if len(df) < min_obs:
        return None
    X = sm.add_constant(df["x"])
    model = sm.OLS(df["y"], X).fit()
    alpha_per = float(model.params["const"])
    beta = float(model.params["x"])
    rsq = float(model.rsquared)
    # ddof matches statsmodels (n - k); resid.std with default ddof=1 is fine
    # for an alpha-significance display since statsmodels already gives a t-stat.
    resid_std_per = float(np.std(model.resid, ddof=2))
    alpha_ann = alpha_per * periods_per_year
    resid_std_ann = resid_std_per * math.sqrt(periods_per_year)
    resid_sharpe = alpha_ann / resid_std_ann if resid_std_ann > 0 else 0.0
    alpha_t = float(model.tvalues["const"])
    return {
        "alpha_ann": alpha_ann,
        "beta": beta,
        "rsq": rsq,
        "resid_std_ann": resid_std_ann,
        "resid_sharpe": resid_sharpe,
        "alpha_tstat": alpha_t,
        # Benchmark max DD over the same overlapping window — lets the dashboard
        # show "DD strategy vs DD benchmark" for the drawdown attribution row.
        "bench_max_dd": max_drawdown(df["x"]),
        "n_obs": int(len(df)),
    }


def rolling_residual_sharpe(strat_ret, bench_ret, window_days=756, step_days=21):
    """Rolling residual Sharpe (annualised alpha / annualised residual stdev) versus a benchmark.

    Uses a 3-year (756 trading day) window. Sampled every `step_days` days to
    keep the output series compact for the dashboard chart.
    """
    df = pd.concat(
        [strat_ret.rename("y"), bench_ret.rename("x")], axis=1, sort=False
    ).sort_index().dropna()
    n = len(df)
    if n < window_days + 1:
        return []
    out = []
    for end in range(window_days, n + 1, step_days):
        win = df.iloc[end - window_days : end]
        X = sm.add_constant(win["x"])
        m = sm.OLS(win["y"], X).fit()
        alpha_ann = float(m.params["const"]) * 252
        resid_std_ann = float(np.std(m.resid, ddof=2)) * math.sqrt(252)
        rs = alpha_ann / resid_std_ann if resid_std_ann > 0 else 0.0
        out.append({
            "date": win.index[-1].strftime("%Y-%m-%d"),
            "rs": float(rs),
        })
    return out


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main():
    if not RESULTS_PATH.exists():
        print(f"ERROR: {RESULTS_PATH} missing — run `node backtest.js` first.", file=sys.stderr)
        sys.exit(1)

    print("Loading history...")
    universe_prices = load_history("daily")
    universe_prices_m = load_history("monthly")
    print(f"  {len(universe_prices)} universe ETFs loaded (daily) | "
          f"{len(universe_prices_m)} (monthly)")

    bench_tk, bench_ac = load_benchmark_etf("daily")
    bench_tk_m, bench_ac_m = load_benchmark_etf("monthly")
    if bench_tk is None:
        print("  WARNING: no ACWI / URTH / VT in history/ — single-ETF benchmark unavailable.")
        print("           Run `node fetch_benchmarks.js` to populate, then re-run attribution.py.")
    else:
        print(f"  Single-ETF benchmark: {bench_tk} ({len(bench_ac)} daily bars, "
              f"{len(bench_ac_m) if bench_ac_m is not None else 0} monthly bars)")

    print("Building EW basket benchmark...")
    ew_ret = ew_basket_returns(universe_prices)
    print(f"  EW basket (daily):   {ew_ret.dropna().shape[0]} obs "
          f"({ew_ret.dropna().index[0].date()} -> {ew_ret.dropna().index[-1].date()})")
    ew_ret_m = ew_basket_returns(universe_prices_m)
    print(f"  EW basket (monthly): {ew_ret_m.dropna().shape[0]} obs "
          f"({ew_ret_m.dropna().index[0].date()} -> {ew_ret_m.dropna().index[-1].date()})")

    if bench_ac is not None:
        bench_ret = benchmark_etf_returns(bench_ac)
    else:
        bench_ret = None
    if bench_ac_m is not None:
        bench_ret_m = benchmark_etf_returns(bench_ac_m)
    else:
        bench_ret_m = None

    print("Loading backtest results...")
    with open(RESULTS_PATH) as f:
        results = json.load(f)

    classes_map = class_by_ticker(results)

    # Cache restricted EW baskets so we don't rebuild for each strategy in a
    # variant family. Key: (tuple_of_classes_or_None, freq).
    ew_cache = {
        (None, "daily"):   (ew_ret,   len(universe_prices),   sorted(universe_prices.keys())),
        (None, "monthly"): (ew_ret_m, len(universe_prices_m), sorted(universe_prices_m.keys())),
    }

    def get_ew(universe_filter, freq):
        """Return (basket_series, n_tickers, ticker_list, label) for a filter+freq."""
        if not universe_filter:
            s, n, tks = ew_cache[(None, freq)]
            return s, n, tks, "EW basket (full universe)"
        classes = tuple(sorted(universe_filter.get("classes", [])))
        key = (classes, freq)
        if key not in ew_cache:
            prices = universe_prices if freq == "daily" else universe_prices_m
            s, n, tks = filtered_ew(prices, classes_map, classes)
            ew_cache[key] = (s, n, tks)
        s, n, tks = ew_cache[key]
        return s, n, tks, f"EW basket ({', '.join(classes)})"

    attribution = {}
    for sname, strat in results["strategies"].items():
        sr = daily_returns_series(strat)
        if sr is None or sr.empty:
            print(f"  {sname}: no dailyReturns — skipping")
            continue
        print(f"\nStrategy: {sname} ({sname})")
        print(f"  Daily strategy returns: {len(sr)} days "
              f"({sr.index[0].date()} -> {sr.index[-1].date()})")

        # Class-matched EW basket — fair benchmark for a restricted strategy.
        # A universe-wide EW basket includes assets the strategy is forbidden
        # from holding (bonds, commodities, etc.), so alpha against it would
        # conflate signal value with asset-class allocation. The matched basket
        # isolates the signal value.
        uf = strat.get("universeFilter")
        strat_ew, ew_n, ew_tks, ew_label = get_ew(uf, "daily")
        if strat_ew is None:
            print(f"  {sname}: filtered EW basket is empty — falling back to full universe")
            strat_ew, ew_n, ew_tks, ew_label = get_ew(None, "daily")
        if uf:
            print(f"  Universe restricted to classes: {uf.get('classes')} -> {ew_n} ETFs")
        else:
            print(f"  Universe: full ({ew_n} ETFs)")

        # Confine all series to the strategy's date range so the regression
        # window is consistent.
        common_start = sr.index[0]
        common_end = sr.index[-1]
        ew_w = strat_ew.loc[common_start:common_end]
        bench_w = bench_ret.loc[common_start:common_end] if bench_ret is not None else None

        gross = gross_daily_stats(sr)
        ew_stats = run_ols(sr, ew_w)
        acwi_stats = run_ols(sr, bench_w) if bench_w is not None else None
        rolling = rolling_residual_sharpe(sr, ew_w, window_days=756, step_days=21)

        # Long-sample monthly OLS — uses the strategy's monthly equity series
        # (back to 1994), which captures regimes the daily series misses
        # (dot-com, GFC). Fewer observations per year but materially longer
        # window; alpha and Sharpe annualised on 12-period basis.
        mr = monthly_returns_from_equity(strat)
        gross_m = ew_stats_m = acwi_stats_m = None
        mr_range = None
        if mr is not None and not mr.empty:
            strat_ew_m, ew_n_m, _, _ = get_ew(uf, "monthly")
            if strat_ew_m is None:
                strat_ew_m, ew_n_m, _, _ = get_ew(None, "monthly")
            ew_w_m = strat_ew_m.loc[mr.index[0]:mr.index[-1]] if strat_ew_m is not None else None
            bench_w_m = bench_ret_m.loc[mr.index[0]:mr.index[-1]] if bench_ret_m is not None else None
            gross_m = gross_stats(mr, 12)
            ew_stats_m = run_ols(mr, ew_w_m, periods_per_year=12, min_obs=24) if ew_w_m is not None else None
            acwi_stats_m = run_ols(mr, bench_w_m, periods_per_year=12, min_obs=24) if bench_w_m is not None else None
            mr_range = (mr.index[0].strftime("%Y-%m"), mr.index[-1].strftime("%Y-%m"), int(len(mr)))

        attribution[sname] = {
            "gross": gross,
            "vsEW": ew_stats,
            "vsACWI": acwi_stats,
            "ewLabel": ew_label,
            "ewUniverseSize": ew_n,
            "benchmarkTicker": bench_tk if bench_tk else None,
            "benchmarkNote": (
                f"Single-ETF proxy: {bench_tk}"
                if bench_tk
                else "Run `node fetch_benchmarks.js` to populate ACWI/URTH/VT history."
            ),
            "rollingResidualSharpe_vsEW": rolling,
            "rollingWindowDays": 756,
            "rollingStepDays": 21,
            # Long-sample monthly attribution (back to 1994). Annualised
            # using 12 periods/year. Same regression form as the daily layer.
            "monthly": {
                "gross": gross_m,
                "vsEW": ew_stats_m,
                "vsACWI": acwi_stats_m,
                "range": mr_range,  # (start_ym, end_ym, n_obs) or None
            } if mr_range else None,
        }
        if gross:
            print(f"  Gross (daily, {gross['start']}->{gross['end']}): "
                  f"ann_ret={gross['ann_return']*100:.2f}%  "
                  f"vol={gross['ann_vol']*100:.2f}%  Sharpe={gross['sharpe']:.2f}")
        if ew_stats:
            print(f"  vs EW (daily):   alpha={ew_stats['alpha_ann']*100:.2f}%  "
                  f"beta={ew_stats['beta']:.2f}  R^2={ew_stats['rsq']:.3f}  "
                  f"resSharpe={ew_stats['resid_sharpe']:.2f}  t(a)={ew_stats['alpha_tstat']:.2f}")
        if acwi_stats:
            print(f"  vs {bench_tk:<5} (daily): alpha={acwi_stats['alpha_ann']*100:.2f}%  "
                  f"beta={acwi_stats['beta']:.2f}  R^2={acwi_stats['rsq']:.3f}  "
                  f"resSharpe={acwi_stats['resid_sharpe']:.2f}  t(a)={acwi_stats['alpha_tstat']:.2f}")
        if gross_m:
            print(f"  Gross (monthly, {mr_range[0]}->{mr_range[1]}, n={mr_range[2]}): "
                  f"ann_ret={gross_m['ann_return']*100:.2f}%  "
                  f"vol={gross_m['ann_vol']*100:.2f}%  Sharpe={gross_m['sharpe']:.2f}")
        if ew_stats_m:
            print(f"  vs EW (monthly):   alpha={ew_stats_m['alpha_ann']*100:.2f}%  "
                  f"beta={ew_stats_m['beta']:.2f}  R^2={ew_stats_m['rsq']:.3f}  "
                  f"resSharpe={ew_stats_m['resid_sharpe']:.2f}  t(a)={ew_stats_m['alpha_tstat']:.2f}")
        if acwi_stats_m:
            print(f"  vs {bench_tk:<5} (monthly): alpha={acwi_stats_m['alpha_ann']*100:.2f}%  "
                  f"beta={acwi_stats_m['beta']:.2f}  R^2={acwi_stats_m['rsq']:.3f}  "
                  f"resSharpe={acwi_stats_m['resid_sharpe']:.2f}  t(a)={acwi_stats_m['alpha_tstat']:.2f}")

    results["attribution"] = attribution
    # Pretty top-level metadata for dashboard
    results["attributionMeta"] = {
        "benchmarkTicker": bench_tk,
        "ewUniverseSize": len(universe_prices),
        "rollingWindowDays": 756,
        "rollingStepDays": 21,
        "generatedAt": pd.Timestamp.now("UTC").isoformat(),
    }

    with open(RESULTS_PATH, "w") as f:
        json.dump(results, f)
    size_kb = RESULTS_PATH.stat().st_size / 1024
    print(f"\nWrote attribution layer into {RESULTS_PATH} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
