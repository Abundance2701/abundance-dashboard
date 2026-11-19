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

---

## Phase 2 — 12/11/2026

### 1. New data
- **Holdings:** `data/holdings_2026-09.json`, a copy of the Abundance holdings pipeline output (`wbdata_2026-09.json`, portfolios as on 30/09/2026).
  - 500 funds from 26 AMCs. Not yet covered: HSBC, LIC, Union, ITI, JM, Bank of India, Samco, Taurus, JioBlackRock, Groww, and some others.
  - Index weights come from ICICI Prudential index fund/ETF portfolios on the same date.
- **Matching holdings to schemes:** name-key match, exact or a unique prefix.
  - Core 5 categories (Regular): 126 funds matched.
  - 0 matches where the holdings-file category disagreed with the scheme's category.
  - Every unmatched fund belongs to an AMC the pipeline does not cover.
- **Active share recomputed** with ½ × Σ|fund − index| on equity weights. It matches the pipeline's own figure exactly for the funds checked (e.g. Axis Large Cap 39.8, ABSL Flexi Cap 60.6).

### 2. Formulas (Node unit tests against independent checks)
| Test | Result |
|---|---|
| Style solver: exact 30/70 mix of two of four factors | 0.3000 / 0.7000 / 0 / 0, R² = 1.000000 |
| Style solver vs brute-force 1%-grid on 3 factors (noisy data) | solver 17.1/51.9/31.0, SSE 1.1848e-3 ≤ grid 17/52/31, SSE 1.1849e-3 |
| Style solver: series equal to one factor | 0 / 0 / 1 / 0 |
| Percentile ranks [5,1,3,–,2,4] and ties [1,2,2,3] | [100,0,50,–,25,75] and [0,50,50,100] |

- **Size mix sanity:** each category index regressed on Nifty 100 / Midcap 150 / Smallcap 250 gives the expected answer, with R² = 1.000:
  - Nifty 100: 100/0/0
  - Midcap 150: 0/100/0
  - Smallcap 250: 0/0/100
  - LargeMidcap 250: 50/50/0
  - Nifty 500: 71/19/10
- **Style overlap found:** the plain Nifty 100 comes out as "71% low-volatility" on the four style indices. The style indices overlap heavily, so the tool shows **tilt vs the fund's own index**, never absolute style levels.

### 3. Back-test (walk-forward, Regular plans, core 5 categories, 5-year window)
- **Method:** at each 31 October from 2014 to 2023, every fund with 5+ years of history was scored using data only up to that date. Each score was compared with the fund's lead over its Tier-1 TRI in the next 3 years.
- **Coverage:** 49 tests, 8–25 funds each.

| Picking by | Avg rank correlation with next-3Y lead | Positive in | Top ¼ − bottom ¼ (pts a year) |
|---|---|---|---|
| Overall score | −0.01 | 22 of 49 | −0.3 |
| Consistency part | 0.01 | 26 of 49 | −0.2 |
| Risk-adjusted part | −0.00 | 26 of 49 | −0.5 |
| Downside part | −0.04 | 21 of 49 | −0.0 |
| Best past 3Y return | −0.00 | 23 of 49 | −0.5 |

- By category, the score's correlation was: Large Cap +0.21, Large & Mid +0.11, Mid Cap −0.21, Small Cap −0.04, Flexi Cap −0.09.

**Does downside behaviour persist?** Same tests, measured over the next 3 years:

| Past → next 3 years | Avg correlation | Positive in |
|---|---|---|
| Down capture → down capture | 0.17 | 37 of 49 |
| Volatility → volatility | 0.14 | 33 of 49 |
| Downside part → max fall | 0.05 | 27 of 49 |
| Overall score → down capture | 0.07 | 30 of 49 |

- Small Cap shows the strongest downside persistence (down capture 0.45, volatility 0.34).

**Conclusion:**
- Past-performance measures, alone or combined, did **not** predict which funds beat their index over the next 3 years.
- Downside behaviour persists modestly.
- The score is therefore labelled a *track-record* score, not a forecast.

**Limits:**
- Survivorship: only funds alive today are included.
- Today's SEBI categories are applied to pre-2018 years.
- Small samples per test.

---

## Accuracy of style and size estimates — 12/11/2026
Core 5 categories, Regular plans.

- **Returns-based size mix vs actual holdings** (112 funds with both):
  - Median absolute gap: large 9.8 pts, mid 10.0 pts, small 5.2 pts.
  - 80th percentile: 20.6 / 16.1 / 12.9 pts.
  - Too rough, so it was **removed**. Company size now comes only from holdings.
- **Style-tilt stability** (146 funds), measured as the change in tilt vs own index when the 36-month window moves:
  - Moved 3 months: median 1.1–2.3 pts (80th percentile 2.1–4.7).
  - Moved 12 months: median 2.3–7.1 pts (80th percentile 3.1–14.2; quality and momentum are the noisiest).
  - So only tilts of **15+ pts** are shown as a "lean".
- **Market phases** changed:
  - Size leader each month = the best of Nifty 100 / Midcap 150 / Smallcap 250.
  - Style leader = the best of Value 50 / Quality 50 / Momentum 50 / Low Vol 30.
  - There is no NSE growth-style index, so growth-led months cannot be tagged.

### Style-shift column removed — 13/11/2026
"Style steady?" compared each fund's factor mix with its mix 3 years earlier. The indices themselves "shifted" just as much: Midcap 150 by 32 pts and Smallcap 250 by 35 pts (fund medians 39 and 28). So the column mostly measured market and model noise, not the fund, and it was removed.

## Phase 3 — Portfolio X-ray (18/11/2026)

**What was built:** a "Portfolio X-ray" page in `Fund_Selector.html`. Input: Excel/CSV upload, pasted rows, or funds added one by one (scheme name + current value). Names are matched to the AMFI fund list by word overlap; a match is accepted automatically only when the names share at least 80% of their words (Dice score); otherwise the advisor must pick the scheme from a short list. Unpicked rows are left out.

**Independent check (Python, straight from `data/holdings_2026-09.json`):** test portfolio of 6 funds with holdings (PPFAS Flexi ₹5 L, HDFC Flexi ₹4 L, ICICI Commodities ₹3 L, Nippon Small ₹2.5 L, Nippon Growth Mid ₹1.5 L, HDFC Balanced Advantage ₹3 L):

| Measure | Python | Tool |
|---|---|---|
| Equity looked through | ₹17,14,050 | ₹17.14 L |
| Distinct stocks | 481 | 481 |
| Effective number of stocks | 81.6 | 82 |
| Top-10 stock weight | 26.1% | 26% |
| Active share vs blended index | 43.7% | 44% |
| Overlap, HDFC Flexi vs HDFC BAF | 50.31% | 50% |

**Method notes:**
- Weights are % of the equity looked through (fund value × fund equity %). Holdings in the file are already normalised to the fund's equity.
- Blended index = each fund's category index (Tier-1 map), weighted by the client's equity in that fund. Hybrids use the index given in the holdings file (Nifty 500). Sectoral funds use Nifty 500 as a broad reference only.
- Balanced advantage equity is gross (hedged positions are not netted). Debt holdings are not analysed.
- Excess-return correlation: monthly (fund − own index TRI) over 36 months, with at least 24 common months needed.
- Market phases: equity funds held at today's weights against the same weights in each fund's own index. Funds without data in a month are dropped from both sides for that month.
- Rendering was checked at 1400 px and 390 px widths with mock NAV data. Live data was checked separately.

### Phase 3 v2 — verdicts and clean-up test (18/11/2026)
- Cut-offs (agreed with the user): same job = over 50% common stock weight, or excess-return correlation ≥ 0.7 (36 months); index-like = active share under 50%; weak record = ahead of own index in under 40% of 3-year periods (10 years, 24+ periods); too small = under 1% of the portfolio. Two of {same job, index-like, weak record}, or too small → exit candidate; one flag or a data gap → review.
- **Why 0.7:** in a real 34-fund client portfolio (18/11/2026), 496 fund pairs had a correlation. The median was 0.21, 78 pairs were ≥ 0.5, 33 were ≥ 0.6, and 13 were ≥ 0.7 (the top 3%). The highest was 0.84.
- **Mix scorecard:** the mix's monthly return is the value-weighted return of its equity funds, and the blended index uses the same weights on each fund's own TRI. When a fund has no data for a month, it is dropped from both sides for that month. The mix and index are compounded into month-end values, then run through the same `rolling3()` used for single funds.
- **Caveat shown on screen:** the before/after record is partly in-sample, because weak-record funds are chosen using the same 10 years.
- Same client test: 34 funds → 17 (all exit candidates removed). Different from index 35% → 37%; pairs doing the same job 27 → 4; largest fund house 27% → 39%. Record rows improved too, but that is in-sample.

## Phase 4 — Build portfolio (18/11/2026)
- **Inputs:** client, lumpsum and/or SIP, plan, minimum fund size (default ₹500 Cr), and the advisor's equity split (categories, %, funds per category). Optionally, the client's current X-ray keepers count as already chosen.
- **Candidates:** every active Growth scheme in the category and plan (no ETFs), with share classes de-duplicated as in Fund Lab. Each needs a Fund Lab peer score (5+ years of history, same window), a fund size at or above the floor, and is not index-like (active share under 50% excludes it). ✕ Avoid funds are never picked; ★ Prefer funds go first. Funds whose AMC is in the holdings data rank before funds without it (their overlap can be checked); then by peer score.
- **Pairing checks:** within a category, over 35% common stock weight (Abundance's own norm) or same-bets correlation ≥ 0.7. Across categories, over 50% or correlation ≥ 0.7. At most 2 funds per fund house; when a house has more, its lowest-scored unpreferred keeper gives way and that category refills.
- **Amounts:** category share × amount, split equally across the category's picks. Lumpsum is rounded down to ₹1,000 and SIP to ₹500; the rounding remainder goes to the first fund.
- **Hand-off:** writes the Portfolio Generator's own saved state (`ab_state`: name, date, type, lump/sip rows with name, category, amount). The page asks before replacing a portfolio in progress, then opens the generator.
- **"Your calls"** (★ Prefer / ✕ Avoid) are saved in this browser (`abundance_fs_calls_v1`), keyed by the scheme's core name so Regular and Direct share one call. They apply in the X-ray and the builder, and can be exported or imported as JSON.
- **X-ray change:** the fund-house limit now drops each house's *lowest-scored* keeper, instead of letting bigger categories claim the slots first. This fixes Nippon Growth Mid Cap (score 83) being merged while weaker Nippon funds were kept.
- Checked with mock data at 1400 px and 390 px (no page overflow). The hand-off state was checked in the browser. Live data was tested separately.

## Client review — replaces the X-ray verdicts and Phase 4 (19/11/2026)
Phase 4 (Build portfolio) and the planned Phase 5 were dropped at the user's request. The X-ray became one review: target → where it stands → what to do → the funds.

**Risk-profile bands** (proposed defaults, editable on screen; stored in the browser as `abundance_review_bands_v1`). Equity is % of the whole portfolio; large / mid / small are % of the Indian stocks the funds own (AMC holdings look-through). Midpoints add to 100.

| Profile | Equity | Large | Mid | Small |
|---|---|---|---|---|
| Conservative | 20–40 | 68–82 | 13–23 | 3–11 |
| Moderately conservative | 40–55 | 58–72 | 17–27 | 8–18 |
| Moderate | 55–70 | 48–62 | 22–32 | 13–23 |
| Moderately aggressive | 70–85 | 40–54 | 25–35 | 18–28 |
| Aggressive | 85–100 | 33–47 | 27–37 | 23–33 |

Suggested profile = age only (from the statement's date of birth): under 35 aggressive, 35–44 moderately aggressive, 45–54 moderate, 55–64 moderately conservative, 65+ conservative. The advisor changes it.

**Fund status:** Act = behind its category TRI over 1 year and by over 1 pt a year over 2 years (month-end; smaller gaps are noise — added after the live test showed 0.0–0.3 pt lags being flagged), or a fund-manager change in the last 6 months (from `data/fund_news.json`, when present). Watch = behind by over 1 pt over 1 year; smaller gaps count as level. Clutter = under 1% of the portfolio, a twin of a fund kept in the same job (over 50% common stock weight or same-bets correlation ≥ 0.7), or more funds in the job than Abundance usually holds (flexi, mid, small 2–3; large, large & mid 1–2; sectoral 1). Within a job, keepers are chosen in this order: favoured, then status, then share of 3-year periods ahead of the index, then value. Favoured funds are never clutter.

**Plan rules:**
- SIPs first (no tax, no exit load): stop SIPs in Act / Clutter funds and start them where the money is going.
- Money from funds being exited goes where the allocation needs it: debt if equity is above its ceiling; else the short segment if theirs is over its ceiling; else the best fund doing the same job (twin kept, favoured, Fine, Watch).
- Corrections only bring a band back to 2 points inside the edge it crossed (minimum tax), not to the middle.
- Units are sold lot by lot from the detailed statement: long-term lots at a loss first, then long-term lots with the smallest gain per rupee. Units under a year old are never sold (20% tax on gains, and usually an exit load); they are listed with the date they turn long-term (purchase date + 1 year + 1 day).
- Equity long-term gains are kept within ₹1,25,000 a financial year (Section 112A; unchanged by Budget 2026 for FY 2026-27), less what the advisor enters as already booked. Debt and other funds' gains are shown but not counted against that limit.

**Statement parsing (Wealth Elite):** the detailed statement has, under each scheme, a "Sr. No." header and one row per transaction. Units still held are the rows whose "Abs. Rtn." is not "N.A." ("Remaining …" rows are part-sold lots). Their "Cur. Value" and "Gain / Loss" are used as they are. The latest "SIP Purchase" gives the SIP amount (Amount + stamp duty); a SIP counts as active if its last instalment was within 40 days of the statement date. Date of birth, client name and statement date come from the header rows.

**Checks with a real client statement (Pinaki Chakraborty, 19/11/2026, 26 rows, 22 funds, ₹93.05 L):**
- Every scheme's held lots add up to its "Cur. Value" (e.g. Kotak Large Cap ₹7,02,384; PGIM Flexi Cap ₹11,03,849).
- The tool's lot picker was checked against a separate Python script reading the same file: Kotak Large Cap, tax-free sale this FY = ₹5,02,462 with ₹1,25,000 gain, and ₹1,00,501 left in units under a year old. Both gave identical figures.
- Look-through: 100% of equity money looked through; large 49%, mid 27%, small 24% of stocks.
- The summary statement (no lots) runs, and the plan says unit-level detail is missing.

**Valuation back-test (small-cap lean):** month-end P/E (NSE, `data/pe_monthly.json`, new `scripts/pe_update.py` in the TRI workflow). Signal = Midcap 100 or Smallcap 100 P/E ÷ Nifty 100 P/E, as a percentile of its own history *up to that month* (5 years of history needed first). Outcome = the next 12/24/36 months' return of Midcap 150 or Smallcap 250 TRI minus Nifty 100 TRI, a year.

| Test | Months | Rank correlation | Expensive (top fifth) | Middle | Cheap (bottom fifth) |
|---|---|---|---|---|---|
| Small, 12 months | 104 | −0.52 | −11.3 (n=16) | −0.5 | +25.2 (n=22) |
| Small, 24 months | 92 | −0.66 | −13.0 (n=16) | +3.3 | +13.8 (n=22) |
| Small, 36 months | 80 | −0.60 | −9.4 (n=16) | +6.4 | +9.9 (n=22) |
| Mid, 12 months | 178 | −0.35 | +2.6 (n=88) | +10.0 | — (n=1) |
| Mid, 24 months | 166 | −0.49 | +2.0 (n=76) | +9.1 | — (n=1) |
| Mid, 36 months | 154 | −0.48 | +2.7 (n=68) | +8.6 | — (n=1) |

- Small caps: dearer was consistently followed by worse relative returns; 75–88% of "expensive" months were followed by small caps lagging. **Used**, but only to aim at the lower or upper part of the small-cap band, never outside it.
- Mid caps: the direction is the same but weaker. Mid caps' P/E has re-rated upward, so half the months count as "expensive", and they still beat large caps by 2–3 points a year. **Shown for information only.**
- Caveat: the windows overlap, so there are only a few independent episodes (Smallcap 100 P/E starts in 2011). Treat this as a gentle lean, not a forecast.
