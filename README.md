# polymarket-nvidia-ceo-forecast-01 entry

An empirical-quantile forecaster for the Yes prices of Polymarket's
"Next CEO of NVIDIA?" event, 240 minutes ahead, at quantiles
0.05 / 0.25 / 0.5 / 0.75 / 0.95. Node 22, standard library only, no network,
no model calls, fully deterministic (two runs write identical bytes).

## Method

- **Median = persistence.** The forecast median is the price at the checkpoint.
  Short-window means, EWMAs and mean-reversion centres all scored worse on the
  practice data, so the median stays where the price is.
- **Spread = empirical quantiles of past price changes.** For each horizon h,
  the quantiles of the market's own past h-minute changes over the last 6 hours
  (360 minutes). Prices move in steps with occasional jumps and strong
  reversion, so the true spread widens far slower than sqrt(h) and is
  heavy-tailed; the empirical distribution captures both. Normal bands with an
  RMS-estimated sigma scored far worse (loss > 1.1 vs 0.39 for the baseline).
- **Anchor horizons + interpolation.** Change quantiles are measured at 17
  anchor horizons (1..240 minutes) and linearly interpolated; rows are
  recentered so the median change is exactly 0, keeping the empirical
  asymmetry of the tails.
- **Shrinkage toward the pooled cross-section.** Each market's quantiles get
  weight n/(n+100) on its own n changes, the rest on the pooled quantiles of
  all the case's markets, so thin or newly listed markets borrow the
  cross-section's shape. An anchor with no changes anywhere carries the
  previous anchor's row forward; with no change data at all, the row falls
  back to the house baseline's normal band.

## Validation

There is no local grade for this competition (the server grades every entry),
so the entry was scored with an independent scorer against ground truth
recovered from the kit itself: each practice case's 240-minute answer window
is contained in the next case's file. On the five scorable practice cases
(p00–p04; p05's answers are not in the kit):

| | mean pinball loss |
|---|---|
| this entry | **0.324747** |
| house baseline (0.0025/sqrt-min bands) | 0.3925 |

It beats the baseline on every one of the five cases, and on all nine
checkpoints of an extended validation set (2-hourly checkpoints built by
truncating the p05 file: 0.347 vs 0.417 for the baseline), with 90% coverage
0.91 — close to the honest 0.9. A minimum-width floor on the bands was tried
and rejected: it worsened the practice loss monotonically.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out` per case.
Runs in ~0.1 s per case; outputs are ~240 KB, well under the 1 MiB cap.
