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

def load_history():
    """Return {ticker: {'daily': DataFrame[date,ac]}} for every ticker in the manifest."""
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
        df = pd.DataFrame(h["daily"])[["d", "ac"]]
        df["d"] = pd.to_datetime(df["d"])
        df = df.set_index("d").sort_index()
        out[t["ticker"]] = df["ac"]
    return out


def load_benchmark_etf():
    """Try ACWI first, fall back to URTH then VT. Returns (ticker, ac_series) or (None, None)."""
    for tk in ("ACWI", "URTH", "VT"):
        p = HIST_DIR / f"{tk}.json"
        if p.exists():
            h = json.loads(p.read_text())
            df = pd.DataFrame(h["daily"])[["d", "ac"]]
            df["d"] = pd.to_datetime(df["d"])
            df = df.set_index("d").sort_index()
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


def ew_basket_returns(universe_prices):
    """Daily-rebalanced equal-weighted basket of all universe ETFs.

    Each day's return is the simple mean of available ETF daily returns. ETFs
    with no data on a given day (pre-inception or trading halt) are excluded
    from that day's mean — equivalent to a daily 1/N rebalance over the
    eligible set.
    """
    prices = pd.concat(universe_prices, axis=1)
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

def gross_daily_stats(rets):
    """Annualised return, vol, Sharpe from a daily-return Series."""
    rets = rets.dropna()
    n = len(rets)
    if n < 2:
        return None
    growth = float((1 + rets).prod())
    years = n / 252.0
    ann_return = growth ** (1 / years) - 1 if growth > 0 else float("nan")
    ann_vol = float(rets.std(ddof=1)) * math.sqrt(252)
    daily_mean = float(rets.mean())
    daily_std = float(rets.std(ddof=1))
    sharpe = (daily_mean / daily_std) * math.sqrt(252) if daily_std > 0 else 0.0
    return {
        "ann_return": ann_return,
        "ann_vol": ann_vol,
        "sharpe": sharpe,
        "n_days": int(n),
        "start": rets.index[0].strftime("%Y-%m-%d"),
        "end": rets.index[-1].strftime("%Y-%m-%d"),
    }


def run_ols(strat_ret, bench_ret):
    """OLS: strat_t = alpha + beta * bench_t + eps_t. Returns dict of stats."""
    df = pd.concat(
        [strat_ret.rename("y"), bench_ret.rename("x")], axis=1
    ).dropna()
    if len(df) < 30:
        return None
    X = sm.add_constant(df["x"])
    model = sm.OLS(df["y"], X).fit()
    alpha_daily = float(model.params["const"])
    beta = float(model.params["x"])
    rsq = float(model.rsquared)
    # ddof matches statsmodels (n - k); resid.std with default ddof=1 is fine
    # for an alpha-significance display since statsmodels already gives a t-stat.
    resid_std_daily = float(np.std(model.resid, ddof=2))
    alpha_ann = alpha_daily * 252
    resid_std_ann = resid_std_daily * math.sqrt(252)
    resid_sharpe = alpha_ann / resid_std_ann if resid_std_ann > 0 else 0.0
    alpha_t = float(model.tvalues["const"])
    return {
        "alpha_ann": alpha_ann,
        "beta": beta,
        "rsq": rsq,
        "resid_std_ann": resid_std_ann,
        "resid_sharpe": resid_sharpe,
        "alpha_tstat": alpha_t,
        "n_days": int(len(df)),
    }


def rolling_residual_sharpe(strat_ret, bench_ret, window_days=756, step_days=21):
    """Rolling residual Sharpe (annualised alpha / annualised residual stdev) versus a benchmark.

    Uses a 3-year (756 trading day) window. Sampled every `step_days` days to
    keep the output series compact for the dashboard chart.
    """
    df = pd.concat(
        [strat_ret.rename("y"), bench_ret.rename("x")], axis=1
    ).dropna()
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
    universe_prices = load_history()
    print(f"  {len(universe_prices)} universe ETFs loaded.")

    bench_tk, bench_ac = load_benchmark_etf()
    if bench_tk is None:
        print("  WARNING: no ACWI / URTH / VT in history/ — single-ETF benchmark unavailable.")
        print("           Run `node fetch_benchmarks.js` to populate, then re-run attribution.py.")
    else:
        print(f"  Single-ETF benchmark: {bench_tk} ({len(bench_ac)} daily bars)")

    print("Building EW basket benchmark...")
    ew_ret = ew_basket_returns(universe_prices)
    print(f"  EW basket: {ew_ret.dropna().shape[0]} daily returns "
          f"({ew_ret.dropna().index[0].date()} -> {ew_ret.dropna().index[-1].date()})")

    if bench_ac is not None:
        bench_ret = benchmark_etf_returns(bench_ac)
    else:
        bench_ret = None

    print("Loading backtest results...")
    with open(RESULTS_PATH) as f:
        results = json.load(f)

    classes_map = class_by_ticker(results)

    # Cache restricted EW baskets so we don't rebuild for each strategy in a
    # variant family. Key: tuple(sorted(allowed_classes)) or None for full.
    ew_cache = {None: (ew_ret, len(universe_prices), sorted(universe_prices.keys()))}

    def get_ew(universe_filter):
        """Return (basket_series, n_tickers, ticker_list, label) for a filter."""
        if not universe_filter:
            s, n, tks = ew_cache[None]
            return s, n, tks, "EW basket (full universe)"
        classes = tuple(sorted(universe_filter.get("classes", [])))
        if classes not in ew_cache:
            s, n, tks = filtered_ew(universe_prices, classes_map, classes)
            ew_cache[classes] = (s, n, tks)
        s, n, tks = ew_cache[classes]
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
        strat_ew, ew_n, ew_tks, ew_label = get_ew(uf)
        if strat_ew is None:
            print(f"  {sname}: filtered EW basket is empty — falling back to full universe")
            strat_ew, ew_n, ew_tks, ew_label = get_ew(None)
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
        }
        if gross:
            print(f"  Gross: ann_ret={gross['ann_return']*100:.2f}%  "
                  f"vol={gross['ann_vol']*100:.2f}%  Sharpe={gross['sharpe']:.2f}")
        if ew_stats:
            print(f"  vs EW basket: alpha={ew_stats['alpha_ann']*100:.2f}%  "
                  f"beta={ew_stats['beta']:.2f}  R^2={ew_stats['rsq']:.3f}  "
                  f"resSharpe={ew_stats['resid_sharpe']:.2f}  t(a)={ew_stats['alpha_tstat']:.2f}")
        if acwi_stats:
            print(f"  vs {bench_tk:<5}: alpha={acwi_stats['alpha_ann']*100:.2f}%  "
                  f"beta={acwi_stats['beta']:.2f}  R^2={acwi_stats['rsq']:.3f}  "
                  f"resSharpe={acwi_stats['resid_sharpe']:.2f}  t(a)={acwi_stats['alpha_tstat']:.2f}")

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
