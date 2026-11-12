# Fund Selector — Validation log

Every number in the Fund Selector is computed from source data. This file records how the data and formulas were checked. Add a new dated section after every phase or data change.

---

## Phase 1 — 12/11/2026

### 1. Index data (NSE Total Return Index)
- **Source:** niftyindices.com, endpoint `/Backpage/getTotalReturnIndexString`. Fetched by the GitHub Action `tri-data.yml` every weekday (19:10 IST) into `data/tri_monthly.json`. Each fetch's outcome is logged in `data/tri_status.json`.
- **Coverage:** 38 indices (broad, style, sector), daily history from 2005 (a few later, e.g. Nifty India Defence from 2018), stored as month-end values.
- **Cross-check vs AMFI:** daily TRI on the same dates AMFI uses (30/10/2026, compared with AMFI's Fund Performance tool):

| Index (TRI) | 1Y here / AMFI | 3Y | 5Y | 10Y |
|---|---|---|---|---|
| Nifty 100 | −8.694 / −8.694 | 9.084 / 9.075 | 7.222 / 7.214 | 11.717 / 11.710 |
| Nifty LargeMidcap 250 | −6.472 / −6.472 | 11.530 / 11.519 | 10.601 / 10.589 | 13.788 / 13.780 |
| Nifty Midcap 150 | −4.366 / −4.366 | 13.819 / 13.805 | 13.839 / 13.823 | 15.649 / 15.640 |
| Nifty Smallcap 250 | −3.150 / −3.150 | 12.354 / 12.342 | 13.115 / 13.099 | 13.337 / 13.329 |
| Nifty 500 | −7.341 / −7.341 | 10.215 / 10.206 | 8.813 / 8.803 | 12.514 / 12.507 |
| Nifty 500 Multicap 50:25:25 | −6.044 / −6.044 | 11.263 / 11.253 | 10.507 / 10.495 | 13.294 / 13.287 |

  - 1Y matches exactly.
  - 3/5/10Y differ by at most 0.016 pts. The cause is the day-count: AMFI compounds over actual days including leap days; a check by hand on the Nifty 100 3Y figure closes the gap to about 0.003 pts.
- **Month-end store:** the Oct-2026 month-end value equals the daily value of 30/10/2026 (last trading day). Example: Nifty 100 TRI 33,276.75.

### 2. Category → benchmark map (Tier 1)
| Category | Benchmark | Source |
|---|---|---|
| Large Cap | Nifty 100 TRI | HSBC "The Asset" factsheet Apr-2026; AMFI list reported by Business Standard 31/03/2022 |
| Large & Mid Cap | Nifty LargeMidcap 250 TRI | HSBC factsheet Apr-2026 |
| Mid Cap | Nifty Midcap 150 TRI | HSBC factsheet Apr-2026; Business Standard 31/03/2022 |
| Small Cap | Nifty Smallcap 250 TRI | HSBC factsheet Apr-2026 |
| Multi Cap | Nifty 500 Multicap 50:25:25 TRI | HSBC factsheet Apr-2026 |
| Flexi / Focused / Value / ELSS | Nifty 500 TRI | HSBC factsheet Apr-2026 |
| Contra | Nifty 500 TRI | Kotak Contra factsheet Sep-2026 ("Tier 1: Nifty 500 TRI") |
| Dividend Yield | Nifty 500 TRI | Tata Dividend Yield factsheet 30/09/2026 |
| Sectoral / Thematic | Nifty 500 TRI (broad reference only) | Each fund has its own sector benchmark; not yet mapped |

AMFI's Fund Performance data (30/10/2026) shows the same Nifty benchmarks for Large, Large & Mid, Flexi, Multi, Mid and Small Cap (the other categories were not checked there). Some AMCs use the BSE equivalent (e.g. BSE 100 TRI); the tool uses the Nifty Tier-1 index for all funds in a category so every fund is compared with one common yardstick.

### 3. Fund NAV data (tigzig API → AMFI NAVs)
- Compared with AMFI Fund Performance (Regular plans, to 30/10/2026), same dates and day-count as AMFI.
- **84 of 84 funds** in Large, Mid and Small Cap were matched on their 30/10/2026 NAV. That gives 288 return figures.

| Category | Funds | Figures compared | Mean gap | Max gap |
|---|---|---|---|---|
| Large Cap | 30 | 109 | 0.014 pts | 0.73 pts (LIC MF Large Cap 5Y) |
| Mid Cap | 29 | 97 | 0.003 pts | 0.09 pts |
| Small Cap | 25 | 82 | 0.010 pts | 0.45 pts (Sundaram Small Cap 10Y) |

- **Differences above 0.05 pts** are all schemes whose fund house took over another fund house. AMFI may report a different predecessor's history. These are flagged ⚠ in the tool:
  - HSBC Large Cap 10Y
  - LIC MF Large Cap 5Y and 10Y
  - Sundaram Mid Cap 10Y
  - Sundaram Small Cap 5Y and 10Y
- **Missing long history:** some merged schemes' NAV series start at the merger date. The tool shows "—" for those periods; nothing is estimated. Examples: Baroda BNP Paribas Large/Mid Cap (from 14/03/2022); HSBC Midcap/Small Cap (from 28/11/2022).
- No splices found: the largest one-day NAV moves in these series fall on real market days (19/05/2009, 23/03/2020, 04/06/2024).

### 4. Formulas (unit-tested against an independent Python implementation)
| Test | Tool | Python |
|---|---|---|
| Up / down capture, 6-month hand example | 85.614 / 100.000 | 85.614 / 100.000 |
| CAGR of a 12%-a-year series over 5Y | 12.000% | 12.000% |
| Rolling 3Y: 12% fund vs 10% index | 85 windows, 100% beat, lead +2.00 | as expected |
| Beta (fund = 1.5 × index) | 1.500 | 1.500 |
| Jensen alpha, tracking error, info ratio, volatility | 3.157 / 3.664 / 0.887 / 10.993 | 3.157 / 3.664 / 0.887 / 10.993 |
| Max fall (100→120→90→110) | −25.0% | −25.0% |

Capture method follows Morningstar: geometric average of returns in months the benchmark rose (fell), fund ÷ benchmark × 100.

### 5. Research: do capture ratios persist? (Phase 1 step 1.7)
- **Method:** consecutive non-overlapping 3-year windows ending Oct-2017, Oct-2020, Oct-2023 and Oct-2026, all measured against the Tier-1 TRI. For each pair of windows, the Spearman rank correlation across the funds alive in both (11–27 funds per category).
- **Universe:** Regular plans in Large, Large & Mid, Flexi, Mid and Small Cap. That gives 15 category-pairs.

| Measure in window A → same measure in window B | Average correlation (15 pairs) | Pairs > 0 |
|---|---|---|
| Down capture | +0.09 | 10 of 15 |
| Up capture | +0.08 | — |
| Capture ratio (up ÷ down) | −0.04 | — |
| Excess return vs TRI | −0.09 | — |
| Low down capture in A → excess return in B | −0.05 | — |

Reading the results:
- Down capture is the most persistent trait, but only weakly. A fund's defensiveness is partly a lasting style.
- Capture ratio and past outperformance show **no** persistence. If anything, past winners slightly lagged in the next 3 years.

Caveats:
- Small samples, so single correlations below about ±0.4 are not statistically meaningful.
- Only funds alive today are included (survivorship).
- Only three window-pairs.

**Implications for Phase 2:**
1. Do not score funds mainly on past 3Y returns or capture ratio.
2. Use down capture as a behaviour/fit trait (risk-profile matching and diversification), not as a predictor of returns.
3. Every score must pass the back-test before it is used.
