# Routing Lab

## Results

<!-- RESULTS:START -->
_Generated 2026-11-09 02:33 UTC by `pnpm lab`: 8 seeds per cell, 2 payments/s for 120 simulated minutes (~14,400 payments per run). Values are mean ± 95% confidence interval across seeds._

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
