# RIVERS — What shipped & results

> Vammo · Data & Analytics — July 23, 2026

---

## What was implemented (last 72 hours)

Each change targets a **measured** failure mode.

**1. Reliable scheduling — the engine now runs itself.**
The engine is call-driven; it was triggered by open browser tabs, then by GitHub Actions schedules — which proved too lossy (GitHub throttles high-frequency schedules; on a busy day only 6 of ~48 runs fired, with 2.5h gaps). Final solution: **pg_cron inside Postgres** ticks the engine every 10 minutes. **261 ticks so far, zero failures, zero delays.** Coverage is now continuous — weekends and holidays included.

**2. Stock rule rewritten (was 6% precision).**
Investigation of 189 historical firings found two stacked causes: it flagged **cosmetic parts** (top boxes, windshield rubber, USB chargers — the shop releases the bike anyway), and "available stock" **ignored three deposit types plus intraday restocking** (we caught stock reading zero at 9am and 599 units by 3pm — parts sit in the receiving deposit until shelved). Now only **blocking parts** (drivetrain, brakes, wheels/steering) fire the rule, and stock counts everything physically at the base.

**3. Queue input fixed (the biggest over-trigger source).**
We decomposed on-site time into 6 segments from status events (30 days of completed orders, per base). Key finding: **floor customers effectively jump the queue** — median wait-for-mechanic is **4–5 minutes** — while the congestion rule summed the *entire* backlog including non-floor work. The queue input now counts only floor work ahead of the customer. Side findings: handback (ready→delivered) has a **P90 of 11 hours** at the largest base; non-floor orders wait a **median of 3+ hours** just to be diagnosed.

**4. Estimate recalibration — with an honest twist.**
We hypothesized the additive time model overestimates multi-part jobs (excess cases showed estimate 130 min vs 84 real). **Out-of-sample validation rejected the hypothesis** — that "1.68×" was selection bias (measured only on false positives, overestimated by construction). Population-wide (14,446 orders, temporal split), the model actually **overestimates small jobs** (1–3 parts) and is well calibrated on large ones. Shipped what the data supports: a per-part-count factor f(n) = [0.2, 0.42, 0.65, 0.91, 0.96, 1.0, 0.99, 1.0]. OOS: **MAE 29.2 → 28.3 min, decision metrics @180min unchanged.** Bonus: it deflates the queue input, further calming the congestion rule.

**5. Staged autonomy + per-rule monitoring.**
Autonomy is granted **per rule, by demonstrated precision**. Each suggestion carries an `acao_automatica` flag — true when the rule is on the high-precision list *and* the customer is physically waiting. Wide rules stay human-reviewed. A **daily monitor** recomputes per-rule trailing precision (did the bike actually exceed 3h?) and alerts if any auto rule drops below 70%; an env-var kill switch demotes any rule without a code change.

---

## Results

Accuracy is measured, not asserted: every suggestion is crossed bike-by-bike against what the workshop actually did and the real outcome — time until the bike was **ready** (not picked up; customers holding a loaner don't rush back, which distorted the old metric).

**26-day window (Jun 25 – Jul 20, ~2,300 orders):**

| Metric | Value |
|---|---|
| Workshop reserves captured | **~88%** |
| Of all bikes that breached 3h without a reserve, system had flagged | **91%** (106 of 116) |
| Total misses, investigated one-by-one | 10 — **none was a calculation error** (all traced to the engine not running at the right moment, now fixed, or the known tail issue) |

**Post-deploy (last 3 days, all fixes live):**

| Metric | Value |
|---|---|
| Scheduler | **261/261 ticks**, zero failures |
| Reformed rules (stock, congestion) | **zero false alarms** in production |
| Day-level capture rate | 7/8 |
| Per-rule trailing precision (auto rules) | waiting-without-diagnosis **100%** (43 cases) · critical cases **100%** (5) · flow anomaly **81%** (21) — none below the 70% alert floor |

**The remaining misses have exactly one profile:** long-tail complex services. The point-estimate model undercalls the tail (recall@180min ≈ 34%; right-censoring from training on completed orders is part of it) — and in one case the human offered a loaner **13 minutes after check-in, before any diagnosis existed**, i.e., before the model had any signal. Both point to the same next step: quantile-based estimates re-scored at milestones, starting at check-in.

---

*Every number above is reproducible from the decision log + warehouse queries. Full docs available on request.*
