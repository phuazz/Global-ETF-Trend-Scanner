# Global ETF Trend Scanner

A research dashboard for trend-following on global ETFs, with an integrated backtest engine implementing three momentum strategies on a 56-ETF cross-asset universe.

## What's in here

- **`index.html`** — single-file dashboard. Tabs: Market Pulse, Trade Setups, Exit Signals, Full Scanner, Performance, Signal Matrix, Backtest, and Event Studies.
- **`fetch_data.js`** — pulls fresh daily snapshot prices and momentum indicators from Yahoo Finance for ~56 ETFs across asset classes. Runs daily via GitHub Actions.
- **`fetch_history.js`** — pulls full price history (max-available monthly bars + 10 years of daily) per ticker. Runs weekly via GitHub Actions to support the backtest.
- **`backtest.js`** — engine that implements three strategies (Petr-style cross-sectional momentum, AQR-style TSMOM, multi-signal composite) with strict point-in-time discipline and AQR-grade execution semantics. Runs weekly.
- **`BACKTEST_METHODOLOGY.md`** — design spec for the backtest. Documents lookahead-bias prevention, vol-targeting math, regime-gate variants, the seven sins of backtesting, and the audit fixes that have been applied.
- **`events.js`** — SentimentTrader-style event scenario engine. For each pre-registered event in `events/catalogue.json` it finds every historical trigger, collapses clustered triggers into independent *episodes*, and measures the forward-return distribution at fixed horizons against the unconditional baseline, with a random-entry Monte Carlo significance test, regime split, and max-adverse-excursion. Writes `events_results.json`. Runs weekly (it reads `history/`).
- **`events_live.js`** — lightweight daily scan. Fetches a 2-year window, computes the same indicators as the study, and reports whether any catalogue event is firing now. Writes `events_live.json` for the Market Pulse "Live Events" strip. Runs daily.
- **`events/catalogue.json`** — the pre-registered event library. Every event must carry a written `rationale` (the economic mechanism) or the engine refuses to run it — this is the discipline that stops event studies degenerating into data mining.
- **`data.json`**, **`events_live.json`** (daily), **`backtest_results.json`**, **`events_results.json`** (weekly) — committed workflow outputs, so the dashboard works for every visitor without needing to run anything.

## Quick start (local development)

```sh
node fetch_data.js     # ~30 sec — pulls daily snapshot used by the scanner
node fetch_history.js  # ~1 min  — pulls full history needed by backtest
node backtest.js --startMonth=2005-01 --regimeMode=graduated --regimeScale=0.05 --weighting=equal --equityOnly
node events.js         # ~5 sec — event studies from events/catalogue.json -> events_results.json
node events_live.js    # ~30 sec — daily live-event scan -> events_live.json
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

## Event studies

The Event Studies tab answers a different question from the backtest: "after a specific condition fires, what has the asset historically done?" It is a conditioning layer for sizing conviction and framing risk, not a standalone signal. Run it with `node events.js` (after `fetch_history.js`); it reads `events/catalogue.json` and writes `events_results.json`.

The format is deliberately hard to fool, because event studies are the most seductive form of data mining. Three countermeasures, one per silent-failure mode:

1. **Pseudo-replication.** Triggers within `clusterDays` collapse into one *episode*; the headline is the episode count, and significance is a random-entry Monte Carlo that preserves the same overlap structure and sample size as the conditional set.
2. **Look-ahead.** Every indicator is computed causally; entry is the close of the trigger day (the conventional event-study timing, mildly optimistic versus the backtest's `firstDayT1` fill — stated on the card).
3. **Multiple testing.** The number of event × horizon cells screened is recorded and surfaced; a catalogue event without a written `rationale` is not admitted.

Each card also splits episodes by the SPY-200d-SMA regime and reports median favourable/adverse excursion (the path, not just the endpoint). Two events ship today: a replication of the published SPY "RSI overbought → sub-50 in 3 days" study (which the engine correctly flags as underpowered — only ~5 episodes in the 10-year daily window, all in one regime), and a cross-asset breadth crossing across the full 56-ETF universe, a participation signal a single-index desk cannot construct.

**Cadence.** The study is split from the live scan because each has a different natural frequency. The study (`events.js`) is input-bound on `history/`, so it refreshes weekly; the live scan (`events_live.js`) fetches its own 2-year window daily and answers "is any event firing right now?", surfacing as the **Live Events** strip at the top of Market Pulse (ACTIVE / ARMED / BELOW / QUIET). The two share trigger definitions — change one in `events/catalogue.json` and both pick it up — but the live scan keeps its own copy of the detection logic because it runs on freshly fetched in-memory bars rather than the weekly on-disk history.

## Live dashboard

Hosted via GitHub Pages at: <https://phuazz.github.io/Global-ETF-Trend-Scanner/>

The dashboard auto-loads the latest committed JSON from the repo. Two GitHub Actions keep it fresh: a **daily** job ([`refresh.yml`](.github/workflows/refresh.yml)) runs `fetch_data.js` + `events_live.js` (scanner snapshot + live-event flags), and a **weekly** job ([`weekly.yml`](.github/workflows/weekly.yml)) runs `fetch_history.js` → `fetch_benchmarks.js` → `backtest.js` → `attribution.py` → `events.js` (full history, backtest, attribution, and event study).

## License

MIT — research and personal-use. Not investment advice.
