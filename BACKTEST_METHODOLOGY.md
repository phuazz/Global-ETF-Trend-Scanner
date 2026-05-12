# Backtest Methodology — Trend & Momentum on the ETF Universe

This document is the design spec for the backtest module added to the Global ETF Trend Scanner. It is deliberately long. The point of a backtest is not to produce a flattering number — it is to estimate what a strategy *would have* returned to a real investor, with all the frictions and data limitations that imply. The vast majority of published backtests are wrong because of mistakes covered here. We will explicitly list the mistakes and the countermeasures we adopt.

The document is organised so that each strategy variant has a self-contained spec, but they share a common data layer and execution model described in sections 2–4.

---

## 1. Strategy reference

### 1.1 Petr Podhajský's "smart-beta" sleeve (LinkedIn, April 2026)

> One of my "smart beta" sleeves is just US + Canada rotational momentum:
> - rank stocks by momentum
> - require a positive regime, like index > MA200
> - once a month buy the strongest X names
> - hold for 1 month
> - size by volatility targeting

That is the entire strategy. Five rules. No machine learning, no factor zoo. The reason it has worked for decades is precisely because there is nothing to overfit. Our job is to translate the spec faithfully to the ETF universe, not to "improve" it.

### 1.2 Jirong's additions (WhatsApp)

1. **Universe construction is the trickiest part.** Getting a *non-look-ahead universe* is hard for retail. Survivorship and forward-fill bias creep in through universe selection more often than through any other channel.
2. **Diversify across signals.** Different signals work in different regimes. A multi-signal stack is more robust than any single signal.
3. **Account for signal half-life.** A 12-month momentum signal does not become "wrong" the instant a new month tick arrives. Decay your signal exposure rather than discrete-rebalancing every month.
4. **Don't do 100% turnover at every rebalance.** Trade gradually toward the target portfolio. Saves cost and reduces noise.
5. **Start with cheap signals.** Price, returns, volume, volatility, skewness, kurtosis. These are the building blocks. Avoid expensive alt-data until cheap signals are exhausted.

### 1.3 AQR-style TSMOM (Moskowitz, Ooi & Pedersen 2012; AQR Managed Futures)

- **Time-series momentum**, not cross-sectional ranks: each asset is judged against itself. Long if its own 12-1 trailing return is positive, short (or flat) if negative.
- **Per-asset volatility targeting.** Each instrument is sized so its *own* contribution to portfolio vol is constant. Position weight ∝ σ_target / σ_asset.
- **Portfolio gross cap of ~40% assumed correlation = 1.** Sum of |w_i × σ_i| is capped at the portfolio target vol. This is the conservative "everything correlates in a crisis" assumption.
- **Realized-to-total vol ratio.** Because real-world correlations are below 1, the ex-post realized portfolio vol is typically 0.4–0.7× the ex-ante "all-correlated" vol. AQR uses this scalar to decide how much *gross leverage* to actually run. You can run hotter than the conservative cap because you know your actual diversification benefit.

These will all be implemented below.

---

## 2. The seven sins of backtesting (and our countermeasures)

| # | Sin | Mechanism | Countermeasure used here |
|---|---|---|---|
| 1 | **Lookahead bias** | Decisions made at time *t* use information that was not available until later. | Strict timeline: compute signal on close of *t*, execute at open or close of *t+1*. Vol estimates use only data through *t*. |
| 2 | **Survivorship bias** | Universe contains only assets that exist *today*; failed/delisted assets are silently absent. | We use ETFs with persistent existence, but still filter by inception-date PIT (Section 3.4) so an ETF that launched in 2017 cannot influence the 2010 portfolio. |
| 3 | **Backfill / proxy bias** | Replacing missing ETF history with an underlying index proxy. | **Banned.** We backtest each ETF only over its actual trading history. No "if SHLD had existed in 2005…" experiments. |
| 4 | **Total-return vs price-only confusion** | Some series include dividends, some don't. Mixing them inflates returns. | Always use Yahoo's `adjclose` (split- *and* dividend-adjusted). Document this and verify on a known dividend-payer. |
| 5 | **Selection bias / data snooping** | Trying many parameter combinations and reporting the best. | Fix one canonical parameter set (lookback = 12-1 months, hold = top-N=5, regime = SPY > 10-month SMA). Sensitivity analysis is reported as a *cloud*, not as a chosen point. Compute Bailey/López de Prado's deflated Sharpe to penalise the selection. |
| 6 | **Cost-free trading** | Ignoring spread, commissions, slippage. | Apply 5 bps each side as a baseline ETF cost; sensitivity test up to 20 bps. |
| 7 | **Path-dependent leakage** | Using full-sample statistics (mean, sd) inside the backtest. | All statistics (z-scores, sigma estimates, regime thresholds) are *expanding-window* or *rolling-window* — never full-sample. |

---

## 3. Data layer

### 3.1 Source

Yahoo Finance via the v8 chart API (already used by `fetch_data.js`). Free, but the back-of-house warning applies: Yahoo occasionally has small corruptions in the early years of a series. We mitigate with a sanity filter (Section 3.5).

### 3.2 What we fetch

For each of the 56 tickers in `fetch_data.js::UNI`:

- **Daily** bars at `range=max, interval=1d` — gives us inception-date through today, with `open, high, low, close, adjclose, volume`.
- **Monthly** bars at `range=max, interval=1mo` — used for monthly-rebalance strategies.

We store one JSON per ticker under `history/<ticker>.json`. Refreshed weekly (or on demand), not daily, since the universe rarely changes.

### 3.3 Adjusted vs unadjusted prices

- **For return calculations and sizing**: use `adjclose` everywhere. This is split- and dividend-adjusted. The *level* of adjclose is meaningless; only its returns matter.
- **For regime filters that humans naturally express on the un-adjusted chart** (e.g., "SPY above its 200-day MA"): use `close` with a forward-only split adjustment. In practice, for SPY/QQQ/etc., MA crossovers using `adjclose` and split-adjusted `close` give nearly identical signals and we use `adjclose` for both consistency and simplicity.

### 3.4 Point-in-time universe

Each ticker has an inception date `t0_i`. The universe at time *t* is `{i : t0_i + 12 months ≤ t}`. The 12-month buffer is required because we use 12-month momentum — newer ETFs are not eligible until they have a full year of trading history.

This is much weaker than a true PIT universe of stock-level constituents (which Jirong correctly flagged as the hardest part for retail). For ETFs the universe is naturally more stable — but we still respect inception dates rigorously. The cost: backtests for the early years (pre-2010) run on a thinner universe, primarily SPY/QQQ/IWM/EFA/EEM/TLT/IEF/LQD/HYG/GLD/SLV/USO/DBA/UNG/VNQ + currency ETFs.

### 3.5 Sanity filters on raw data

Before any data enters the backtest:
1. Drop bars where `adjclose ≤ 0` or `volume < 0`.
2. Flag any single-day return greater than ±50% — usually a corporate action artefact. Investigate; if confirmed bogus, fill from the un-adjusted series.
3. Require ≥ 250 daily bars before a ticker becomes eligible (separate from the 12-month inception buffer).
4. Cross-check: the ticker's reported price at `T-end` must match `data.json`'s last snapshot within 1%.

### 3.6 What we deliberately do not do

- **No proxy backfill.** SHLD did not exist in 2005, so it does not appear in any 2005 portfolio. Period.
- **No reconstruction of "ETF would have tracked index X".** That introduces the worst kind of look-ahead — the *strategy designer's* knowledge of what worked.
- **No filling of missing data with the asset-class average.** A missing day is dropped; the backtest just doesn't trade that day.
- **No fitting of any parameter on the same data we report performance on.** This is the cardinal rule.

---

## 4. Execution model and timing convention

This is the most under-appreciated source of bias. Pin it down once and use the same convention everywhere.

**Default (`execMode=firstDayT1`):**
- Signal computed at close of last trading day of month *t*.
- Trade executes at close of *first* trading day of month *t+1* (one-day lag).
- Holding-period return = `close(last day of t+1) / close(first day of t+1) - 1`.

This is the AQR/published-research convention. It costs the strategy the first day's average drift of month *t+1* (typically a few bps per month per holding) but is implementable for a real investor — you can place a limit-on-close at the first day's close. Trying to execute at the literal *open* of month *t+1* (the cheaper option) is not implementable for retail without slippage you can't model.

**Legacy (`execMode=closeT`):** signal and execution both at close of *t*. Slightly more flattering to the strategy but inconsistent with how anyone could actually trade it. Available behind the flag for comparison only.

**Cost model:**
- Per-class default bps map (one-way): US Equity 2, Intl 5, EM 8, FI 3, Commodity 8, RE 5, Currency 6, Alternatives 12, Thematic 12. Override globally with `--costBps=N`.
- Cost applied as `Σ |Δw_i| × bps_i / 10000` deducted from the rebalance-month return.

**Cash and leverage (audit fix #2 / #3):**
- Cash position (`1 - gross`) earns the monthly return of the **SHY ETF** (1–3y UST) by default. Configurable via `--rfTicker`.
- Leveraged exposure (`gross > 1`) pays `rf + borrowBps/year` on the borrowed portion. Default spread = 50 bps annualised. Configurable via `--borrowBps`.
- Effect: cash-heavy strategies (Petr in bear regimes) now compound a real risk-free yield. Leveraged strategies (TSMOM AQR) carry the funding cost they'd actually face.

---

## 5. Strategy 1 — Petr-style rotational momentum

### 5.1 Specification

| Parameter | Value | Notes |
|---|---|---|
| Universe | All eligible tickers in `fetch_data.js::UNI` (56), filtered to ETFs in equity-like classes by default | Optional flag to restrict to "US Equity" + "Intl Equity" + "EM Equity" to mirror Petr's stock setup. |
| Bar frequency | Monthly | |
| Signal | 12-1 momentum: `r(t-12 → t-1)` (skip the most recent month to avoid the 1-month reversal effect) | Robustness: also test 6-1, 9-1, 12-0 (see §11). |
| Regime gate | SPY (or asset's own benchmark) above its 10-month SMA computed on monthly closes. Off-regime → 100% cash. | Equivalent to the daily 200-day MA, but cleaner on monthly bars. |
| Selection | Top *N = 5* by 12-1 momentum among regime-on tickers | |
| Sizing | **Vol-target each holding** to 10% annualised vol, then equal-risk weight, then renormalise to 100% gross. Cap each position at 30% gross. | Detailed below. |
| Rebalance | Last trading day of each month, fill on next open | |
| Hold | One month | |
| Cost | 5 bps each side (each ticker traded) | |

### 5.2 Volatility targeting math (per-holding)

For each held ticker *i*, the realised daily-return volatility over the trailing 60 trading days is:

```
σ̂_i,t = sqrt( 252 × var( r_i over last 60 days ending at t-1 ) )
```

Use 60 days because (a) it adapts faster than 1-year vol, (b) it is much less noisy than the 20-day version, and (c) it is what AQR uses in published TSMOM work. Optionally use the EWMA estimator with 60-day half-life for extra responsiveness.

The weight is:

```
w̃_i = σ_target / σ̂_i,t       (σ_target = 10%)
```

Stack the top-N: `W̃ = Σ w̃_i`. Then normalize:

```
w_i = w̃_i / W̃                   if W̃ > 1   (de-lever to 100% gross)
w_i = w̃_i                         otherwise (allow up to 100% gross with cash residual)
```

Hard-cap any single `w_i` at 0.30. Redistribute excess proportionally.

### 5.3 Why this differs slightly from Petr's stock version

Petr is on individual stocks and explicitly says "size by volatility targeting" without caps. With ETFs we're already diversified inside each holding, so the realised vols are lower, which would mechanically push weights to the cap. The 30% cap is to prevent the portfolio from becoming "100% TLT" during bond-bull years — a degenerate outcome.

### 5.4 Equity-only variant (`petr_eq`)

Petr's literal spec is on individual stocks within a single asset class. Ranking equity ETFs against bond ETFs against gold on the same 12-1 momentum scale is apples-to-oranges — they have different risk-premia, different return autocorrelation profiles, and different macro drivers. The `petr_eq` variant restricts the eligible universe to US Equity + Intl Equity + EM Equity + Thematic (29 ETFs), keeping the mechanism identical but removing the cross-asset-class noise.

Empirically, this delivered an in-sample (2016–2026) gross Sharpe of 0.51, vs 0.54 for the universe-wide Petr — essentially a wash. The attribution-layer test was more revealing: against the class-matched EW basket of 29 equity ETFs, the equity-only variant's residual Sharpe was 0.04 (universe-wide Petr managed 0.14 against the full-universe EW). The R² against the matched basket rose from 0.28 to 0.39 — the strategy is more correlated with its peer benchmark when the benchmark contains the same names. The implication is uncomfortable but clean: the apparent alpha of the universe-wide Petr in this window was coming from asset-class selection (equities outperformed bonds and commodities), not from within-class momentum skill. The matched benchmark exposes this. Next-step experiments — e.g. extending the sample to include 2000–02 / 2008–09, or running per-class momentum sleeves combined risk-parity-style — are deferred.

---

## 6. Strategy 2 — AQR-style time-series momentum (TSMOM) with 40% vol target

### 6.1 Specification

| Parameter | Value | Notes |
|---|---|---|
| Universe | All 56 ETFs subject to PIT inception filter | Diversification across asset classes is the whole point. |
| Signal | sign( 12-1 month return for asset *i* ) | +1 long, −1 short. |
| Short capability flag | `allowShort: true` for futures-like (IEF/TLT/BND/UUP/FXE/FXY/etc., commodities, currencies); `false` for equity ETFs (most retail brokers don't easily short equity ETFs). | This is a real-world friction. We document it; the report shows both versions. |
| Per-asset vol target | σ_asset = 20% annualised | |
| Portfolio cap | Sum of \|w_i\| × σ̂_i ≤ σ_portfolio_target (default 40%) | Equivalent to "if everything correlated +1, my portfolio vol would be ≤ 40%". |
| Rebalance | Monthly | |
| Cost | 5 bps each side | |

### 6.2 Per-asset sizing

For each asset *i* in the eligible universe at time *t*:

```
sign_i,t   = +1 if r_i(t-12 → t-1) > 0 else (−1 if allowShort_i else 0)
σ̂_i,t      = trailing 60-day annualised realised vol
w_raw_i,t  = sign_i,t × ( σ_asset / σ̂_i,t )      (σ_asset = 20%)
```

So a quiet asset (σ̂ = 8%) gets a 2.5× scale; a wild one (σ̂ = 50%) gets 0.4×. Each contributes ~20% of vol to the portfolio if its sign is on.

### 6.3 The 40% portfolio cap (Jirong's specific point)

The "everything correlated" sum is:

```
GrossVol_t = Σ_i |w_raw_i,t| × σ̂_i,t = Σ_i 1{sign_i ≠ 0} × σ_asset
           = (n_active_t) × σ_asset
```

If 20 assets are signal-on and σ_asset = 20%, GrossVol = 400%. Way over 40%. We scale all weights by:

```
k_t = min( 1, σ_portfolio_target / GrossVol_t )
w_i,t = k_t × w_raw_i,t
```

This is the "AQR conservative cap." It is what Jirong called "TSMOM total volatility of 40% assuming everything is correlated."

### 6.4 Realised-to-total vol scalar (Jirong's second point)

In reality, the TSMOM portfolio's realised vol is much lower than 40% because the assets are not all correlated +1. The realised vol of a sample TSMOM portfolio capped this way is typically 10–18%. So AQR (and Jirong) point out:

```
ratio_t = σ̂_portfolio_realised / σ̂_portfolio_assumed_correlated
```

Where `σ̂_portfolio_assumed_correlated = Σ |w_i| × σ̂_i` (the conservative number), and `σ̂_portfolio_realised` is the actual ex-post 60-day vol of the live portfolio.

You can run hotter — leveraging up — by *dividing* the conservative weights by this ratio:

```
w_final,i,t = w_i,t / ratio_t
```

Effect: gross exposure is scaled up so the *realised* portfolio vol equals the target (40%). This is the "TSMOM is run at 10–15× exposure on capital" effect that managed-futures funds exhibit.

For the backtest we report **two versions**:
1. **Conservative** — 40% sum-of-abs-vol cap, no leverage adjustment. This is what a retail investor would actually run unless very brave.
2. **AQR-equivalent** — divides by `ratio_t` (estimated on a 1-year rolling window of the conservative portfolio's realised vol vs its conservative GrossVol). Targets 40% realised vol. Requires meaningful leverage and is reported with a clear "this assumes you can lever 5–10×" disclaimer.

### 6.5 Why TSMOM is a useful complement to Petr's strategy

Petr's strategy is *cross-sectional* — you're picking the strongest in a peer group. TSMOM is *time-series* — even if everything is mediocre, if your trailing return is positive, you're long. Cross-sectional momentum without a regime filter goes long the "least bad" assets in a bear market; TSMOM correctly goes flat. They diversify each other meaningfully. Many practitioners run both.

---

## 7. Strategy 3 — Multi-signal combination

This implements Jirong's recommendation: build a stack of cheap, fast-to-compute signals; blend them; condition on regime; decay slowly; trade gradually.

### 7.1 The cheap signal catalogue

All signals computed on monthly bars (or daily, then resampled) using only data through time *t-1*.

| ID | Signal | Definition | Direction | Notes |
|---|---|---|---|---|
| MOM12 | 12-1 momentum | `r(t-12 → t-1)` | + | Workhorse. |
| MOM6 | 6-1 momentum | `r(t-6 → t-1)` | + | Faster mom. |
| MOM3 | 3-1 momentum | `r(t-3 → t-1)` | + | Captures regime shifts. |
| TREND | Distance from 10-month SMA | `(p_t-1 − SMA10) / SMA10` | + | Smooth trend filter. |
| LOWVOL | Inverse 60-day vol | `1 / σ̂_60d` | + | "Betting against beta"; lower vol earns risk-adjusted premium. |
| SKEW | 60-day return skewness | `skew(r_60d)` | − | Negative-skew assets carry premium (people pay to avoid them); going *long* low-skew = harvest premium. |
| KURT | 60-day return kurtosis | `kurt(r_60d) − 3` | − | Excess kurtosis = fat tails; we'd rather avoid. Sign uncertain — test both. |
| VOLUME | Volume change vs trailing 12m | `vol_3m / vol_12m` | + | Rising volume confirms trend. |
| RANGE | (P_high_60d − P_low_60d) / P_t-1 | inverse | − | Wide range = chop. Treat with caution. |
| AC1 | Daily-return AR(1) over 60d | as-is | + | Positive autocorrelation = trending; negative = mean-reverting. |

(Skew and kurt directions are debated. We test directional sign empirically per-asset-class, holding out the first half of the sample for fitting.)

### 7.2 Z-score normalisation

Within each cross-section at time *t*, for each signal *s*:

```
z_s,i,t = ( raw_s,i,t − median_t(raw_s) ) / MAD_t(raw_s)
```

Median and MAD (median absolute deviation) are used instead of mean/sd because they handle outliers gracefully. Cross-sectional only — never z-score against the asset's own history (that would inject fitting).

### 7.3 Composite score

Default: equal-weight combo across signals after z-scoring. Direction-aware (positive z if the signal direction is +, negative z if −).

```
C_i,t = (1/|S|) × Σ_s direction_s × z_s,i,t
```

### 7.4 Regime conditioning

Define a single global regime indicator `R_t ∈ {RiskOn, RiskOff}` from SPY's 10-month MA position. (Could be enriched with VIX percentile, breadth, but keep it cheap.)

Different signals dominate in different regimes:

| Signal | RiskOn weight | RiskOff weight |
|---|---|---|
| MOM12, MOM6 | 1.0 | 0.5 |
| MOM3 | 0.5 | 1.0 |
| TREND | 1.0 | 1.0 |
| LOWVOL | 0.5 | 1.5 |
| SKEW | 1.0 | 0.5 |
| KURT | 0.0 | 1.0 |

These weights are themselves *not* fitted from data — they're priors based on published research (Asness; AQR risk-on/off). We do not optimise them. Sensitivity analysis later shows the strategy is not highly dependent on exact values.

### 7.5 Signal half-life (Jirong's point)

Don't snap to today's score. Apply an exponential moving average to the composite, with half-life *h* months:

```
α = 1 − 0.5^(1/h)        # for h = 3, α ≈ 0.206
C̃_i,t = α × C_i,t + (1−α) × C̃_i,t-1
```

Default `h = 3`. Robustness: test 1, 3, 6.

### 7.6 Partial turnover (Jirong's point)

Once the *target* portfolio is computed at month-end *t*:

```
target_i,t   = scaled top-K from C̃, vol-targeted as in §5.2
```

Instead of trading from `current_i` to `target_i` in one step, trade only a fraction `τ` toward target each month:

```
w_i,t = (1 − τ) × w_i,t-1 + τ × target_i,t
```

Default `τ = 0.5` ⇒ ~2-month half-life of the actual portfolio. Costs roughly halve, and the strategy tolerates noisy month-to-month signal flips. Robustness: test τ ∈ {0.25, 0.33, 0.5, 0.66, 1.0}.

### 7.7 Equity-only variant (`multi_eq`)

The same within-asset-class restriction applied to Petr (§5.4) is also applied to the multi-signal composite. The universe is narrowed to US/Intl/EM Equity + Thematic (29 ETFs); signals, weights, and regime conditioning are unchanged.

The empirical result is the same direction as `petr_eq` but more stark: gross Sharpe of 0.67 (vs 0.72 for the universe-wide composite), and a residual Sharpe of **−0.12** against the class-matched EW basket. The R² rises to 0.88 — the equity-only composite is essentially a higher-correlation, slightly worse version of buying the equity EW basket. The universe-wide composite's headline 0.19 residual Sharpe vs the full-universe EW was, on this evidence, mostly asset-class allocation rather than signal skill. As with Petr, this is a clean negative result, not a fatal one — the regime filter still cuts drawdown, and the 2016–2026 sample is a cherry-picked period for buy-everything-and-hold strategies. See §11/§12 for the deferred next-step experiments.

---

## 8. Transaction cost model

| Layer | Default | Sensitivity |
|---|---|---|
| Per-trade spread + commission | 5 bps (one-way) | 0, 5, 10, 20 bps |
| Market impact (size-dependent) | 0 (assume ≤ $1m AUM, not impact-bound) | not modelled |
| Taxes | 0 (assume IRA / TFSA / tax-advantaged) | flagged as a real-world adjustment |

Cost applied as: at each rebalance, deduct `cost_bps × |Δw_i|` from portfolio NAV for each asset *i* that changes weight. So a 50% turnover at 5 bps deducts 25 bps from monthly return.

---

## 9. Performance reporting

For each strategy variant, compute and report:

- **CAGR** since inception (of the strategy, not the universe — first month with at least 1 holding).
- **Annualised vol** (monthly returns × √12).
- **Sharpe ratio** (excess of cash; we use 0% RF as a default, document the choice).
- **Sortino ratio** (downside-only vol).
- **Max drawdown** and **Calmar** (CAGR / |MaxDD|).
- **Hit rate** (% positive months) and **monthly skew**.
- **Turnover** (annualised sum of |Δw|).
- **Average # holdings**.
- **Bailey/López de Prado deflated Sharpe** — penalises for the number of trials we ran.

Plus visualisations:
- Equity curve vs SPY benchmark (log scale).
- Drawdown chart.
- Rolling 12-month return.
- Monthly returns heatmap (year × month).
- Weight evolution (stacked area of holdings over time).

---

## 10. Benchmark-relative attribution

A headline Sharpe of 0.7 on the multi-signal composite tells you the strategy is profitable. It does not tell you whether the profit came from the signal or from passive beta to the universe. This section documents the additive layer that decomposes each strategy's gross return into market beta and residual alpha — the difference between "I built a momentum signal" and "I bought ACWI and gave it a different name".

The artefacts are: `fetch_benchmarks.js` (pulls ACWI / URTH / VT into `history/`), `attribution.py` (runs the regressions and writes back to `backtest_results.json`), and a Backtest-tab card in `index.html` that renders the comparison table, the decision flag, and the rolling residual Sharpe chart. None of the existing strategy logic in `backtest.js` is changed by this layer.

### 10.1 The regression

For each strategy *s* and each benchmark *b*, run the daily OLS

```
r_s,t = α_s,b + β_s,b × r_b,t + ε_s,b,t
```

where `r_s,t` is the strategy's daily P&L return on date *t* and `r_b,t` is the benchmark's daily return on the same date. Fit with `statsmodels.OLS` (not `numpy.lstsq` — we want the standard errors and t-statistics that come with the OLS object). The regression runs over the strategy's full daily-return window. Reported, annualised:

- α — `params['const'] × 252`
- β — `params['x']`
- Residual standard deviation — `np.std(resid, ddof=2) × √252`
- Residual Sharpe — α / residual std (zero risk-free rate, consistent with §9)
- α t-statistic from the regression's standard errors
- R² as a complementary read on how much of the strategy is explained by passive beta

Residual Sharpe — annualised alpha divided by annualised residual stdev — is the key number. It answers: *if I hedged out my beta exposure, what Sharpe would the leftover have?*

### 10.2 Two benchmarks: equal-weighted basket and ACWI

We regress each strategy against two benchmarks because each answers a different question.

**Equal-weighted basket, class-matched to the strategy's eligible universe.** Built in `attribution.py::filtered_ew` as the cross-sectional mean of daily returns over the ETFs whose class is in the strategy's `universeFilter` (or the full universe if the strategy has no filter). For unrestricted strategies (Petr, TSMOM, the multi-signal composite) this is the 56-ETF universe basket; for equity-only variants (§5.4, §7.7) it is the 29-ETF equity basket. This is the *stricter* test, because the EW basket is constructed from the same names the strategy is allowed to trade. If the strategy is just a noisier version of "buy everything in your universe", its alpha against EW will be near zero. The decision flag uses this column.

The class-matched construction is critical for restricted strategies. A universe-wide EW basket includes assets the restricted strategy is forbidden from holding (bonds, commodities), so a high "alpha vs universe EW" for an equity-only strategy would mostly reflect asset-class allocation rather than signal skill. The matched basket isolates the signal value. Concretely: the universe-wide Petr's 0.14 residual Sharpe against the 56-ETF EW basket collapsed to 0.04 for `petr_eq` against the 29-ETF equity EW, because the matched test no longer rewards "I happened to hold equities while bonds were flat".

**ACWI as a single-ETF proxy** (with URTH then VT as fallbacks; whichever loads first wins). This is what an investor would actually consider as the alternative — buy one ETF, go home. It is a *looser* test because ACWI is global equity only and our universe spans bonds, commodities, and currencies. A strategy can post a strong alpha against ACWI simply by holding TLT through a bond bull market, which is not signal value. We report it because it is the benchmark the investor will compare against in practice.

If a strategy looks strong vs ACWI but flat vs EW, the value-add is asset-class selection, not signal. That is a legitimate finding, but it is a different product from "we have a momentum edge".

### 10.3 The daily-rebalanced reconstruction

`backtest.js` runs at monthly cadence: weights are set at the close of the last trading day of month *t*, executed at the close of the first trading day of month *t+1*, and held buy-and-hold for the rest of the month. That convention is correct for the backtest itself (§4) — it matches how a real investor would trade and pays the implementable cost of the one-day fill lag.

For the daily regression we cannot use the buy-and-hold within-month return path. The reason is the AQR-leveraged TSMOM variant, which runs at ~5× gross exposure. Within a single month, an asset that triples then halves does not return to where it started — the buy-and-hold path through high volatility produces compounding distortion that has nothing to do with the strategy's signal. Run the regression on those returns and β explodes, α flips sign month-to-month, and the OLS R² collapses. We saw exactly this in an earlier prototype and rejected it.

`buildDailyReturns()` in `backtest.js` therefore reconstructs the daily P&L assuming the *target* monthly weights are held flat in dollar terms within the month — equivalent to a daily rebalance back to monthly targets. Under unit gross this is a near-identical path to buy-and-hold within the month; under leveraged gross it strips out the within-month compounding effect that would otherwise contaminate the regression. The reconstruction does not change any reported strategy statistic in §9 — `equity`, `weightSnapshots`, the monthly heatmap, and the CAGR/Sharpe/MaxDD figures are all unchanged.

Output field: `strategies[k].dailyReturns` is the daily-rebalanced reconstruction, written alongside the unchanged monthly `equity` series. `strategies[k].weightHistory` holds the full monthly target weights so the daily reconstruction is reproducible.

### 10.4 Rolling residual Sharpe

A full-sample alpha hides regime shifts. A strategy that earned a 1.5 residual Sharpe vs EW in 2014–2018 and 0.0 since 2020 looks fine on a single-window read; rolling exposes the decay.

The rolling window is **756 trading days** (three years), sampled every **21 trading days** (one month). For each window, refit the OLS, compute the residual Sharpe, and record the value at the window's end date. The series is stored at `attribution[strategy].rollingResidualSharpe_vsEW`.

Three years is short enough to capture genuine regime changes (a strategy that stopped working in 2021 will show up by 2024) and long enough that the alpha estimate is not pure noise (n ≈ 756 daily observations gives a usable t-statistic and a stable residual stdev). A one-year window adds noise without information; a five-year window smooths over the decay we are trying to detect. Step size of one month is the natural rebalance cadence and keeps the rendered series compact for the dashboard chart.

The chart overlays a 50%-of-full-sample-residual-Sharpe threshold line; rolling values below the line are flagged with a red dot. The 50% threshold is a soft warning, not a hard rule — a single window dipping below is normal; two years living there means the strategy has stopped working.

### 10.5 Decision-flag thresholds

The dashboard renders a coloured flag based on the ratio `residual_sharpe_vsEW / gross_sharpe`:

| Ratio | Flag | Reading |
|---|---|---|
| > 0.7 | green | Signal adds real value beyond benchmark exposure. The strategy is not just delivering market beta. |
| 0.3 – 0.7 | amber | Mixed. Some of the gross Sharpe is real alpha; some is passive beta. Worth running, but understand the dependence. |
| < 0.3 | red | The signal is largely a repackaged benchmark exposure. Reconsider before deploying. |

The ratio is computed against the **EW basket** residual Sharpe — the stricter benchmark of the two. Using EW means a strategy that passes this test is delivering alpha relative to *the same names it trades*; using ACWI would let strategies pass on asset-class allocation alone, which is a different and weaker claim.

The thresholds (0.7 / 0.3) are priors, not estimates. They are deliberately wide and asymmetric: anything above 0.7 should be unambiguously net-positive (most well-documented published strategies sit at 0.4–0.6 against their natural benchmark, so 0.7 is a high bar), and anything below 0.3 should be unambiguously flagged. The amber band absorbs the realistic case where a strategy has genuine signal but rides correlated factors. As with the rolling threshold in §10.4, these are decision aids — the final call is qualitative.

### 10.6 Long-sample monthly OLS

The daily OLS regression is statistically powerful (~2,500 daily observations per strategy) but bounded by Yahoo's `interval=1d` history, which only reaches back ~10 years. The 2016–2026 window is structurally unfavourable for trend / momentum strategies — it is overwhelmingly risk-on, missing the 2000–02 tech-bust and 2008–09 GFC regimes where these strategies historically earn their keep. A 10-year alpha estimate over such a regime says little about a 30-year alpha estimate over a balanced sample.

`attribution.py` therefore also runs the same regression on **monthly returns** built from the strategy's `equity` series (back to 1994) and the universe's monthly bars (back to inception per ticker). Output is stored at `attribution[strategy].monthly` with the same `{gross, vsEW, vsACWI}` shape as the daily layer, plus a `range` field giving the window. Annualisation uses 12 periods/year. Minimum sample size is 24 months.

The monthly variant is a *complement* to the daily, not a replacement:

- **Daily** is the high-resolution test. The OLS standard errors are tight, so small residual Sharpes are statistically defensible. But the window is narrow.
- **Monthly** is the long-window test. The standard errors are wider (~12 vs 252 observations per year), so a borderline alpha is harder to call significant — but the sample includes regimes the daily window cannot reach.

When the two disagree, the answer is usually "the daily window is unrepresentative". For example, `petr_eq` showed a daily residual Sharpe of 0.04 against the matched EW basket (effectively zero) but a monthly residual Sharpe of 0.32 with t(α)=1.77 over 385 months — well into the amber band and approaching statistical significance. The 2016–2026 daily window simply missed the regimes where the strategy adds value.

The dashboard renders both tables in the attribution card, daily on top and monthly underneath, so the user can see disagreements at a glance.

---

## 11. Robustness battery

This is the most overlooked part of any backtest. A strategy that is fragile to a parameter change is probably curve-fit.

1. **Parameter sweep.** Compute the Sharpe surface across (lookback, top-N, vol-target). Report the *median* Sharpe across the cloud, not the peak. If median Sharpe ≪ peak, the headline is curve-fit.
2. **Walk-forward.** Re-estimate any data-driven parameter on a 5-year rolling window; backtest on the next 1 year out-of-sample; concatenate.
3. **Cost stress.** Recompute Sharpe at 0 / 5 / 10 / 20 bps. A strategy that needs < 5 bps to work is non-investable.
4. **Sub-period stability.** Performance in 2008–2012, 2013–2017, 2018–2022, 2023–today. Any single bad sub-period flagged.
5. **Asset-class subsetting.** Performance if equities-only / commodities-only / bonds-only excluded.
6. **Bootstrap.** Block-bootstrap monthly returns (block size 12) 1000× to get a Sharpe distribution; report 5th–95th percentile. A strategy with a 5th-percentile Sharpe < 0 has very high uncertainty.
7. **Deflated Sharpe** (Bailey & López de Prado 2014):
   ```
   DSR = ( (SR − E[SR_max]) × √(N − 1) ) / √(1 − γ × SR + (κ−1)/4 × SR²)
   ```
   where E[SR_max] is the expected max Sharpe over the number of trials; γ, κ are skew/kurtosis of monthly returns.

---

## 12. What "good" looks like (reasonable expectations)

A correctly-implemented version of these strategies on the ETF universe should produce, roughly:

| Strategy | CAGR | Vol | Sharpe | Max DD |
|---|---|---|---|---|
| Petr-style rotational | 8–13% | 10–14% | 0.6–1.0 | 15–25% |
| TSMOM conservative (40% cap) | 5–9% | 6–10% | 0.5–0.9 | 8–18% |
| TSMOM AQR-equivalent (geared) | 12–18% | 18–24% | 0.6–1.0 | 25–40% |
| Multi-signal combo | 9–14% | 9–13% | 0.7–1.1 | 12–22% |
| SPY benchmark (same period) | 9–12% | 15–18% | 0.5–0.7 | 30–55% |

If the backtest produces CAGR > 25% or Sharpe > 1.5 on this universe, **assume a bug**. The most common bugs are: (a) using same-day close for both signal and execution, (b) using `close` instead of `adjclose` so dividends are double-counted, (c) selecting a universe that includes assets only after we know they survived. Re-audit data and timing before celebrating.

---

## 13. What we are *not* doing in v1, on purpose

- **No options or leverage products.** We will compute the AQR-leveraged number but not actually backtest holding 3× ETFs.
- **No intraday execution.** Monthly close-to-open fills only.
- **No factor regression** (e.g., Fama-French controls). Useful but not the point right now.
- **No machine-learning signals.** Cheap signals first, per Jirong.
- **No live-trading hooks.** Backtest only. Live wiring is a separate decision.

These are all reasonable next-step extensions. Document them; defer them.

---

## 14. Implementation roadmap

| Step | Artefact | Status |
|---|---|---|
| 1 | This document (`BACKTEST_METHODOLOGY.md`) | done |
| 2 | `fetch_history.js` — fetches and stores per-ticker daily + monthly history under `history/` | done |
| 3 | `backtest.js` — implements the three strategies, writes `backtest_results.json` | done |
| 4 | `index.html` Backtest tab — visualises `backtest_results.json` | done |
| 5 | GitHub Actions workflow refresh — run history fetch weekly, backtest on demand | follow-up |
| 6 | Robustness battery (§11) | partial; full version deferred |
| 7 | Benchmark-relative attribution (`fetch_benchmarks.js`, `attribution.py`, dashboard card) (§10) | done |
| 8 | Equity-only variants (`petr_eq`, `multi_eq`) with class-matched EW basket in attribution (§5.4, §7.7, §10.2) | done |
| 9 | Extend sample to include 2000–02 / 2008–09 with thinner pre-2010 universe (§5.4, §7.7) | follow-up |
| 10 | Per-class momentum sleeves combined risk-parity-style (deferred per §5.4) | follow-up |

---

## References

- Moskowitz, T., Ooi, Y. H., & Pedersen, L. H. (2012). *Time series momentum.* Journal of Financial Economics.
- Asness, C., Moskowitz, T., & Pedersen, L. H. (2013). *Value and momentum everywhere.* Journal of Finance.
- AQR Capital. *Managed Futures: A practical guide to volatility targeting.* (Various white papers.)
- Bailey, D. & López de Prado, M. (2014). *The deflated Sharpe ratio.* Journal of Portfolio Management.
- Jegadeesh, N. & Titman, S. (1993). *Returns to buying winners and selling losers.* Journal of Finance.
- Faber, M. (2007). *A quantitative approach to tactical asset allocation.* (The 10-month SMA paper.)
- Antonacci, G. (2014). *Dual Momentum Investing.* (Cross-sectional + time-series momentum hybrid.)
