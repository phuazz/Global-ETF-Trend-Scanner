# Global ETF Trend Scanner

A research dashboard for trend-following on global ETFs, with an integrated backtest engine implementing three momentum strategies on a 56-ETF cross-asset universe.

## What's in here

- **`index.html`** — single-file dashboard. Six tabs: Market Pulse, Trade Setups, Exit Signals, Full Scanner, Performance, Signal Matrix, and Backtest.
- **`fetch_data.js`** — pulls fresh daily snapshot prices and momentum indicators from Yahoo Finance for ~56 ETFs across asset classes. Runs daily via GitHub Actions.
- **`fetch_history.js`** — pulls full price history (max-available monthly bars + 10 years of daily) per ticker. Runs weekly via GitHub Actions to support the backtest.
- **`backtest.js`** — engine that implements three strategies (Petr-style cross-sectional momentum, AQR-style TSMOM, multi-signal composite) with strict point-in-time discipline and AQR-grade execution semantics. Runs weekly.
- **`BACKTEST_METHODOLOGY.md`** — design spec for the backtest. Documents lookahead-bias prevention, vol-targeting math, regime-gate variants, the seven sins of backtesting, and the audit fixes that have been applied.
- **`data.json`**, **`backtest_results.json`** — committed outputs of the daily and weekly workflows respectively, so the dashboard works for every visitor without needing to run anything.

## Quick start (local development)

```sh
node fetch_data.js     # ~30 sec — pulls daily snapshot used by the scanner
node fetch_history.js  # ~1 min  — pulls full history needed by backtest
node backtest.js --startMonth=2005-01 --regimeMode=graduated --regimeScale=0.05 --weighting=equal --equityOnly
npx serve .            # serve the dashboard at http://localhost:3000
```

The arguments above are the recommended Petr config (cross-sectional momentum, equal-weight top-5, graduated regime gate, equity-only universe). Other modes:

| Flag | Default | Notes |
|---|---|---|
| `--startMonth=YYYY-MM` | (none) | Skip thin-universe early years (e.g., `2005-01`). |
| `--regimeMode=binary\|graduated` | `binary` | Graduated linearly scales exposure across the SMA boundary. |
| `--regimeScale=0.05` | 0.05 | Width of the graduated band (5% above/below SMA). |
| `--weighting=volTarget\|equal` | `volTarget` | Equal = 1/N per holding; volTarget = `0.10/σ`. |
| `--equityOnly` | off | Restrict universe to equity ETFs only (US/Intl/EM/Thematic). |
| `--costBps=N` | per-class default | Override the per-class transaction-cost map. |
| `--rfTicker=SHY` | `SHY` | ETF used as risk-free proxy for cash returns. |
| `--borrowBps=N` | 50 | Annual spread above rf paid when leveraged. |
| `--execMode=firstDayT1\|closeT` | `firstDayT1` | Default executes at first-trading-day-of-t+1 close (AQR convention). |

## Methodology

See [`BACKTEST_METHODOLOGY.md`](./BACKTEST_METHODOLOGY.md) for the full design rationale. Highlights:

- **Strict PIT discipline**: every signal at decision time *t* uses only data through *t-1*. Trades fill at the close of the first trading day of *t+1*.
- **No proxy backfill**: each ETF backtested only over its actual trading history.
- **Adjusted closes**: split- and dividend-adjusted (Yahoo `adjclose`).
- **Cash earns SHY**: 1-3y UST proxy for the risk-free rate. Leverage pays rf + 50 bps annual.
- **Per-class transaction costs**: 2 bps US Equity, 5 bps Intl, 8 bps EM/Commodity, 12 bps Alts/Thematic.
- **Audit-passed**: 15 robustness fixes documented in the methodology doc, including vol-estimator clipping, AQR realised-vol scalar, multi-signal cap-redistribute, deflated-Sharpe with realistic trial count.

## Strategies

1. **Petr Rotational Momentum** — cross-sectional rank by 12-1 momentum, regime-gated on SPY > 10-month SMA, top-N=5 holdings, vol-target or equal-weight sizing, monthly rebalance.
2. **TSMOM (AQR-style)** — time-series momentum per asset, sized so portfolio sum-of-|w|×σ ≤ 40% (the "everything correlated" cap). Available conservative or AQR-leveraged.
3. **Multi-signal composite** — z-score blend of momentum + trend + low-vol + skewness + kurtosis, regime-conditional weights, exponential signal decay (3-month half-life), partial turnover (τ=0.5).

All three on the same 56-ETF universe with consistent execution timing, costs, and rf treatment.

## Live dashboard

Hosted via GitHub Pages at: <https://phuazz.github.io/Global-ETF-Trend-Scanner/>

The dashboard auto-loads the latest `data.json` and `backtest_results.json` from the repo. The data is refreshed daily (scanner) and weekly (backtest) by GitHub Actions.

## License

MIT — research and personal-use. Not investment advice.
