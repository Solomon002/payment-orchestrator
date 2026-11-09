# Routing Lab

> **Question:** which routing strategy should a Nigerian payment orchestrator use, and does tracking health per *bank* (not just per gateway) actually help?
>
> **Answer (in simulation):** bank-level health clearly helps when one bank fails; for hard outages a circuit breaker beats pure Thompson sampling; on normal days Thompson-style ordering is cheaper. The **hybrid** (breaker decides which routes are alive, Thompson sampling orders the healthy ones) matched the best success rate in every scenario and had the lowest fees, so it is the production default. It reacts more slowly to *slow* degradation, which is the main trade-off.

**Honesty first.** Everything below comes from a simulator with **illustrative, made-up parameters** (gateway success rates, fees, bank shares, outage shapes). It compares strategies under the *same* assumptions; it does not predict real-world numbers. No real gateway, bank or NIBSS data was used.

Run it yourself:

```powershell
pnpm lab
```

That regenerates the tables below, `docs/routing-lab/results.json`, and the charts on the dashboard's **Routing Lab** page.

## Why a lab

Routing rules like "trip below 80% success over 5 calls, cool down for 30 seconds" are usually picked by gut feel. Here the rules are pure functions in `packages/routing` (`breaker.ts`, `thompson.ts`, `hybrid.ts`) that **both** the production API and the simulator call. So the lab measures exactly the code that ships; only the storage differs (Redis in production, memory in the lab).

## The simulated world (`packages/routing/src/lab/model.ts`)

| Assumption | Value (illustrative) |
|---|---|
| Gateways | gw-a (1.5% fee, cap NGN 2,000, card 97% / transfer 96%, ~350 ms), gw-b (1.4%, 96.5% / 95.5%, ~400 ms), gw-c (1.0%, cap NGN 1,500, 95% / 94%, ~450 ms) |
| Banks | 6 banks with customer shares 22/20/18/15/15/10%; a bank-side failure rate of 0.5% on a normal day |
| Traffic | Poisson arrivals, 2 payments/s for 120 minutes (~14,400 per run); 60% card; amounts log-normal around NGN 8,000 |
| Failures | Each attempt draws "gateway works?" then "customer's bank works?". The failure carries its **scope** (gateway or bank), like a real error code would. Errors take 250 ms; timeouts waste 5 s |
| Failover | Up to 3 gateways per payment, one after another |
| Fail fast | If a strategy offers no gateway for a bank transfer, the customer is told "try card"; 50% of them do |

**Strategies compared** (`strategies.ts`):

| Id | What it does |
|---|---|
| `static` | Always the same gateway order. No learning; failover only. |
| `breaker` | The original Phase 3 design: circuit breaker per (gateway, method); every failure counts against it. |
| `breaker_bank` | Adds a breaker per (gateway, method, bank) and **attributes** failures to gateway or bank. |
| `thompson_v1` | Discounted Thompson sampling (Beta posteriors, 60 s half-life), two factors (gateway x bank), borrows bank evidence from other gateways, skips routes whose draw is below 50%. Unbounded exploration. |
| `thompson` | Same, with **bounded exploration**: a route the posterior thinks is dead gets at most one probe per 10 s. |
| `thompson_cost` | Same, but maximises expected merchant revenue P(success) x (amount - fee). |
| `hybrid` | `breaker_bank` decides which routes are alive and where probes go; `thompson_cost`-style draws order the healthy ones. |

**Statistics.** Each scenario x strategy runs on 8 seeds. Each seed's traffic is shared by every strategy (common random numbers), so differences come from the strategies, not from luckier traffic. Values are means with 95% Student-t confidence intervals. "Adapt" = minutes until traffic to the failing route fell to 25% of its pre-incident level (60 s trailing window); "Recover" = minutes after the incident until it returned to 50%.

## Findings

1. **Bank-level health is worth it.** With GTBank failing on every gateway, the gateway-only breaker scored **94.10% ± 0.39** overall success vs **97.75% ± 0.15** for `breaker_bank`. The gateway-only breaker kept tripping whole gateways (for every bank's customers) because of one bank's failures. On the other scenarios the two are equal within the confidence intervals, so the extra tracking costs nothing.
2. **In a hard rail outage, memory beats statistics.** NIBSS-style outage (transfers 95% timeouts everywhere): `breaker_bank` and `hybrid` ~91.8% overall success with p95 latency ~0.7 s; `thompson` 90.1% with p95 5 s; `static` 87.3% with p95 **15 s** (three timeouts in a row). The breaker's cooldown and consecutive-probe rules give it memory that a route is dead.
3. **The lab caught a flaw in my first bandit design.** `thompson_v1` never adapted to the NIBSS outage (89.3%): once traffic stopped, old failures decayed, the belief drifted back to "gateways usually work", and payments flooded the dead rail again. Bounded exploration (`thompson`) improved it to 90.1% and adapted, but a pure bandit still lacks the breaker's memory. That motivated the hybrid. On normal days `thompson` and `thompson_v1` are identical, so the fix is free.
4. **On a normal day, measured ordering is cheaper.** Every strategy reaches ~99.99% success thanks to failover, but fees differ: static 1.49%, breakers ~1.43%, Thompson variants and hybrid ~1.32% of volume, because they send more traffic to the cheaper gateway once they have evidence it is good enough. The price is ~25 ms more mean latency (gw-c is slower in this model).
5. **The hybrid's trade-offs.** It matches the best success rate in every scenario (within the CIs) and has the lowest fees, but:
   - it notices a **slow degradation** later (adapt 8.9 ± 3.0 min vs 1.5 ± 1.2 for `breaker_bank`), because the breaker only trips below 80% while Thompson keeps the slowly worsening route in the mix;
   - it recovers more slowly after a full gateway outage (3.1 vs 1.0 min);
   - its breakers change state a little more often on a normal day (18 vs 11), because more traffic goes to the lower-quality cheap gateway;
   - it keeps re-checking a route that failed for one bank when that bank works on other gateways (it borrows that evidence), costing an occasional failed first attempt (the customer still succeeds through failover).
6. **Static priority hides outages behind latency.** Its success rate is often fine (failover rescues payments) but customers wait for timeouts: p95 5.5 s in a gateway outage, 15 s in the NIBSS outage. Success rate alone would make it look acceptable.

**Decision:** `ROUTING_STRATEGY=hybrid` is the production default (ADR-015). `breaker` remains the safer choice if slow degradations matter more than fees.

**A bonus finding from the end-to-end demo:** switching the demo to the hybrid changed the gateway order and exposed a real double-charge bug in the payment path (an error in our own bookkeeping after a gateway had accepted a charge was treated as a gateway failure, so the payment failed over and was charged twice). It is fixed and covered by a regression test (ADR-016).

## Limitations

- Illustrative parameters; real gateways' failure patterns (correlated, bursty, partial) are richer than independent draws.
- Payments are processed one at a time (no concurrency between payments).
- Failure **scope** is assumed to be reported correctly by every gateway; in reality attribution may be wrong or missing (then everything counts as gateway-level, like `breaker`).
- The customer's chance of switching to card (50%) is a guess and drives part of the fail-fast benefit.
- One setting per strategy was tested, with no hyper-parameter search (deliberately, to avoid tuning the strategies to the scenarios).

## Results

<!-- RESULTS:START -->
_Generated 2026-11-09 03:07 UTC by `pnpm lab`: 8 seeds per cell, 2 payments/s for 120 simulated minutes (~14,400 payments per run). Values are mean ± 95% confidence interval across seeds._

### Normal day (`baseline`)

No incidents. Measures the cost of each strategy's exploration and its fees.

| Strategy | Success (all) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Breaker changes |
|---|---|---|---|---|---|---|---|
| **static** | 99.99% ± 0.01 | 1.041 ± 0.002 | 379 ms ± 1 | 626 ms ± 2 | 1.491% | NGN 11837.68 | - |
| **breaker** | 99.98% ± 0.01 | 1.044 ± 0.002 | 402 ms ± 3 | 663 ms ± 6 | 1.424% | NGN 11844.94 | 15 |
| **breaker_bank** | 99.99% ± 0.01 | 1.045 ± 0.002 | 402 ms ± 4 | 663 ms ± 8 | 1.428% | NGN 11844.74 | 11 |
| **thompson_v1** | 99.99% ± 0.01 | 1.048 ± 0.002 | 424 ms ± 2 | 697 ms ± 5 | 1.336% | NGN 11856.43 | - |
| **thompson** | 99.99% ± 0.01 | 1.048 ± 0.002 | 424 ms ± 2 | 697 ms ± 5 | 1.336% | NGN 11856.43 | - |
| **thompson_cost** | 99.99% ± 0.01 | 1.049 ± 0.002 | 427 ms ± 2 | 701 ms ± 4 | 1.318% | NGN 11858.91 | - |
| **hybrid** | 99.99% ± 0.01 | 1.050 ± 0.001 | 427 ms ± 2 | 701 ms ± 3 | 1.318% | NGN 11858.67 | 18 |

### Gateway outage (timeouts) (`gateway_outage`)

gw-a stops answering for 30 minutes (minutes 30-60); every call to it times out after 5s.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 99.92% ± 0.01 | 99.7% ± 0.1 | 1.291 ± 0.004 | 1639 ms ± 17 | 5535 ms ± 6 | 1.463% | NGN 11832.97 | never | never | - |
| **breaker** | 99.90% ± 0.01 | 99.7% ± 0.1 | 1.051 ± 0.002 | 441 ms ± 4 | 693 ms ± 6 | 1.387% | NGN 11841.97 | 0.8 ± 0.3 | 1.2 ± 0.6 | 171 |
| **breaker_bank** | 99.90% ± 0.03 | 99.7% ± 0.1 | 1.051 ± 0.003 | 441 ms ± 6 | 696 ms ± 8 | 1.378% | NGN 11840.57 | 0.8 ± 0.2 | 1.0 ± 0.3 | 155 |
| **thompson_v1** | 99.94% ± 0.01 | 99.8% ± 0.1 | 1.055 ± 0.002 | 464 ms ± 2 | 722 ms ± 2 | 1.310% | NGN 11852.89 | 1.0 ± 0.0 | 2.5 ± 0.6 | - |
| **thompson** | 99.94% ± 0.01 | 99.8% ± 0.1 | 1.055 ± 0.002 | 464 ms ± 2 | 722 ms ± 2 | 1.310% | NGN 11852.89 | 1.0 ± 0.0 | 2.5 ± 0.6 | - |
| **thompson_cost** | 99.93% ± 0.01 | 99.8% ± 0.1 | 1.056 ± 0.002 | 468 ms ± 1 | 725 ms ± 3 | 1.292% | NGN 11854.42 | 1.0 ± 0.1 | 2.0 ± 0.5 | - |
| **hybrid** | 99.91% ± 0.03 | 99.7% ± 0.1 | 1.057 ± 0.002 | 469 ms ± 2 | 726 ms ± 3 | 1.293% | NGN 11851.23 | 1.0 ± 0.1 | 3.1 ± 0.7 | 206 |

### NIBSS-style outage (`nibss_outage`)

Bank transfers fail on EVERY gateway for 45 minutes (95% time out); cards are unaffected.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 87.29% ± 0.30 | 14.8% ± 0.8 | 1.309 ± 0.005 | 2343 ms ± 42 | 15000 ms ± 0 | 1.486% | NGN 10326.65 | never | never | - |
| **breaker** | 91.72% ± 0.26 | 44.7% ± 0.8 | 0.972 ± 0.004 | 454 ms ± 4 | 694 ms ± 7 | 1.425% | NGN 10853.74 | 1.0 ± 0.0 | 0.8 ± 0.1 | 461 |
| **breaker_bank** | 91.78% ± 0.15 | 45.3% ± 1.0 | 0.975 ± 0.002 | 456 ms ± 4 | 700 ms ± 10 | 1.418% | NGN 10852.88 | 1.0 ± 0.1 | 0.6 ± 0.1 | 462 |
| **thompson_v1** | 89.33% ± 0.15 | 28.6% ± 0.7 | 1.025 ± 0.002 | 830 ms ± 5 | 5000 ms ± 0 | 1.333% | NGN 10582.89 | never | never | - |
| **thompson** | 90.14% ± 0.24 | 34.0% ± 0.5 | 1.011 ± 0.004 | 720 ms ± 3 | 5000 ms ± 0 | 1.341% | NGN 10679.44 | 11.1 ± 11.8 | 0.4 ± 0.1 | - |
| **thompson_cost** | 90.10% ± 0.23 | 33.7% ± 0.9 | 1.011 ± 0.003 | 722 ms ± 4 | 5000 ms ± 0 | 1.325% | NGN 10674.05 | 15.6 ± 10.1 | 0.4 ± 0.2 | - |
| **hybrid** | 91.81% ± 0.10 | 45.3% ± 0.8 | 0.979 ± 0.002 | 478 ms ± 1 | 733 ms ± 3 | 1.321% | NGN 10888.87 | 1.0 ± 0.0 | 0.7 ± 0.2 | 466 |

### One bank down everywhere (`bank_outage_everywhere`)

GTBank (058) transfers succeed only 15% of the time on every gateway for 50 minutes.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 97.67% ± 0.18 | 37.4% ± 1.6 | 1.098 ± 0.003 | 391 ms ± 1 | 712 ms ± 8 | 1.488% | NGN 11568.01 | never | never | - |
| **breaker** | 94.10% ± 0.39 | 36.4% ± 1.4 | 1.005 ± 0.005 | 390 ms ± 5 | 665 ms ± 9 | 1.412% | NGN 11149.84 | 3.8 ± 1.6 | 0.2 ± 0.1 | 529 |
| **breaker_bank** | 97.75% ± 0.15 | 39.5% ± 1.7 | 1.039 ± 0.003 | 401 ms ± 5 | 673 ms ± 9 | 1.415% | NGN 11588.06 | 2.1 ± 0.7 | 0.4 ± 0.2 | 487 |
| **thompson_v1** | 97.40% ± 0.16 | 30.0% ± 1.2 | 1.081 ± 0.001 | 428 ms ± 1 | 723 ms ± 3 | 1.335% | NGN 11549.98 | never | never | - |
| **thompson** | 97.40% ± 0.17 | 29.6% ± 1.5 | 1.081 ± 0.002 | 428 ms ± 2 | 724 ms ± 4 | 1.334% | NGN 11551.20 | never | never | - |
| **thompson_cost** | 97.39% ± 0.18 | 29.6% ± 2.9 | 1.082 ± 0.002 | 430 ms ± 2 | 728 ms ± 4 | 1.321% | NGN 11549.33 | never | never | - |
| **hybrid** | 97.84% ± 0.14 | 42.0% ± 1.4 | 1.044 ± 0.003 | 423 ms ± 2 | 706 ms ± 4 | 1.320% | NGN 11607.91 | 2.7 ± 1.6 | 0.5 ± 0.2 | 489 |

### One bank down on one gateway (`bank_outage_one_gateway`)

GTBank (058) transfers fail 90% of the time, but only through gw-a, for 50 minutes. Other banks on gw-a are fine.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 99.98% ± 0.01 | 99.8% ± 0.2 | 1.074 ± 0.001 | 389 ms ± 1 | 664 ms ± 2 | 1.487% | NGN 11837.64 | never | never | - |
| **breaker** | 99.94% ± 0.04 | 99.5% ± 0.4 | 1.047 ± 0.002 | 411 ms ± 3 | 680 ms ± 6 | 1.395% | NGN 11844.74 | 1.1 ± 0.4 | 2.6 ± 3.3 | 70 |
| **breaker_bank** | 99.97% ± 0.01 | 99.7% ± 0.2 | 1.049 ± 0.002 | 406 ms ± 3 | 672 ms ± 4 | 1.419% | NGN 11845.39 | 1.2 ± 0.5 | 2.2 ± 2.3 | 112 |
| **thompson_v1** | 99.98% ± 0.01 | 99.7% ± 0.2 | 1.056 ± 0.001 | 426 ms ± 1 | 705 ms ± 4 | 1.328% | NGN 11856.66 | 0.9 ± 0.6 | 0.9 ± 1.0 | - |
| **thompson** | 99.98% ± 0.01 | 99.7% ± 0.2 | 1.056 ± 0.001 | 426 ms ± 1 | 705 ms ± 4 | 1.328% | NGN 11856.66 | 0.9 ± 0.6 | 0.9 ± 1.0 | - |
| **thompson_cost** | 99.98% ± 0.01 | 99.7% ± 0.1 | 1.056 ± 0.003 | 430 ms ± 2 | 710 ms ± 5 | 1.314% | NGN 11857.73 | 2.6 ± 1.2 | 0.8 ± 0.6 | - |
| **hybrid** | 99.97% ± 0.01 | 99.6% ± 0.2 | 1.053 ± 0.002 | 429 ms ± 1 | 705 ms ± 2 | 1.316% | NGN 11857.81 | 2.1 ± 1.2 | 1.1 ± 0.8 | 114 |

### Flaky gateway (`flaky_gateway`)

gw-a cards drop to 55% success in 3-minute bursts every 12 minutes (minutes 20-110). Tests stability and flip-flopping.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 99.97% ± 0.01 | 99.9% ± 0.0 | 1.094 ± 0.001 | 395 ms ± 1 | 683 ms ± 3 | 1.485% | NGN 11836.34 | never | never | - |
| **breaker** | 99.95% ± 0.03 | 99.8% ± 0.1 | 1.048 ± 0.002 | 413 ms ± 4 | 682 ms ± 5 | 1.387% | NGN 11847.80 | 0.8 ± 0.1 | 2.6 ± 3.9 (never in 5/8) | 54 |
| **breaker_bank** | 99.98% ± 0.01 | 99.9% ± 0.1 | 1.048 ± 0.002 | 416 ms ± 4 | 684 ms ± 6 | 1.385% | NGN 11849.66 | 0.8 ± 0.1 (never in 1/8) | 2.2 ± 1.9 (never in 6/8) | 43 |
| **thompson_v1** | 99.98% ± 0.01 | 99.9% ± 0.1 | 1.054 ± 0.002 | 431 ms ± 2 | 710 ms ± 3 | 1.314% | NGN 11857.35 | 1.4 ± 0.1 (never in 1/8) | 1.9 ± 0.4 (never in 1/8) | - |
| **thompson** | 99.98% ± 0.01 | 99.9% ± 0.1 | 1.054 ± 0.002 | 431 ms ± 2 | 710 ms ± 3 | 1.314% | NGN 11857.35 | 1.4 ± 0.1 (never in 1/8) | 1.9 ± 0.4 (never in 1/8) | - |
| **thompson_cost** | 99.98% ± 0.01 | 99.9% ± 0.0 | 1.054 ± 0.002 | 433 ms ± 2 | 712 ms ± 3 | 1.304% | NGN 11858.65 | 1.3 ± 0.1 (never in 2/8) | 1.9 ± 0.3 (never in 2/8) | - |
| **hybrid** | 99.97% ± 0.02 | 99.8% ± 0.1 | 1.053 ± 0.002 | 433 ms ± 1 | 710 ms ± 2 | 1.299% | NGN 11858.80 | 1.2 ± 0.1 | 1.8 ± 0.4 | 81 |

### Slow degradation (`slow_degradation`)

gw-a cards slide from 97% to 60% success between minutes 20 and 70, stay there until 90, then recover.

| Strategy | Success (all) | Success (affected, during) | Attempts/payment | Mean latency | p95 latency | Fee rate | Net revenue/payment | Adapt (min) | Recover (min) | Breaker changes |
|---|---|---|---|---|---|---|---|---|---|---|
| **static** | 99.98% ± 0.01 | 100.0% ± 0.0 | 1.128 ± 0.004 | 405 ms ± 1 | 712 ms ± 2 | 1.481% | NGN 11837.82 | never | never | - |
| **breaker** | 99.87% ± 0.13 | 99.7% ± 0.4 | 1.049 ± 0.002 | 417 ms ± 4 | 687 ms ± 7 | 1.383% | NGN 11837.10 | 3.2 ± 2.3 (never in 1/8) | 2.6 ± 2.0 (never in 2/8) | 108 |
| **breaker_bank** | 99.94% ± 0.05 | 99.8% ± 0.1 | 1.050 ± 0.003 | 418 ms ± 3 | 688 ms ± 5 | 1.381% | NGN 11843.94 | 1.5 ± 1.2 | 1.9 ± 1.3 | 85 |
| **thompson_v1** | 99.97% ± 0.01 | 99.9% ± 0.0 | 1.056 ± 0.002 | 434 ms ± 1 | 713 ms ± 2 | 1.304% | NGN 11858.67 | 8.8 ± 3.0 | 3.1 ± 2.5 | - |
| **thompson** | 99.97% ± 0.01 | 99.9% ± 0.0 | 1.056 ± 0.002 | 434 ms ± 1 | 713 ms ± 2 | 1.304% | NGN 11858.67 | 8.8 ± 3.0 | 3.1 ± 2.5 | - |
| **thompson_cost** | 99.97% ± 0.01 | 99.9% ± 0.0 | 1.056 ± 0.002 | 436 ms ± 2 | 716 ms ± 4 | 1.292% | NGN 11860.33 | 8.0 ± 2.5 | 1.8 ± 0.8 | - |
| **hybrid** | 99.94% ± 0.02 | 99.9% ± 0.1 | 1.056 ± 0.002 | 436 ms ± 1 | 716 ms ± 3 | 1.291% | NGN 11856.13 | 8.9 ± 3.0 | 2.0 ± 1.2 | 131 |
<!-- RESULTS:END -->
