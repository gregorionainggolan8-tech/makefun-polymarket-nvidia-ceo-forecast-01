// polymarket-nvidia-ceo-forecast-01 entry (Node 22, standard library only): an empirical-quantile
// forecaster for Polymarket's "Next CEO of NVIDIA?" Yes prices.
//
// Method (validated on the kit's practice cases, scored against the prices the later cases' files
// hold: mean pinball loss 0.325 over the five scorable practice cases, vs 0.393 for the house
// baseline's fixed 0.0025/sqrt-minute bands, beating it on every case):
//
//   - The median is persistence: the price stays at its last value. Mean, EWMA and mean-reversion
//     centres all scored worse on the practice data, so the median is the checkpoint price.
//   - The spread is empirical, not normal: for each horizon h, the quantiles of the market's own
//     past h-minute price changes, taken over the last 6 hours (360 minutes) of its history.
//     Prediction-market prices move in steps with occasional jumps and strong reversion, so the
//     true spread widens far slower than sqrt(h) and is heavy-tailed; the empirical distribution
//     captures both, where a normal band with an RMS sigma scored far worse.
//   - Quantiles are computed at anchor horizons and linearly interpolated between them; the rows
//     are recentered so the median change is exactly 0 (persistence), keeping the empirical
//     asymmetry of the upper and lower tails.
//   - Each market's quantiles are shrunk toward the pooled quantiles of all the case's markets
//     (weight n/(n+100) on the market's own n changes), so thin or newly listed markets borrow
//     the cross-section's shape instead of trusting a handful of moves. An anchor with no changes
//     anywhere carries the previous anchor's row forward (never a zero-width band), and with no
//     change data at all the row falls back to the house baseline's normal band.
//
// Everything is a pure function of the case file: no network, no model calls, no randomness, no
// clock reads, so two runs write identical bytes. Reads every <id>.in in the input directory (the
// grader runs one case at a time) and writes <id>.out per case: {"forecasts":[{"id","q"}]}, 240
// rows of five non-decreasing numbers in [0,1], rounded to 6 decimals.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, used only by the degenerate-history fallback. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** The fallback spread, in price units per square-root minute (the house baseline's). */
const FALLBACK_SIGMA = 0.0025;
/** Anchor horizons (minutes) at which the empirical change distribution is measured. */
const ANCHORS = [1, 2, 3, 4, 5, 6, 8, 10, 14, 20, 30, 45, 60, 90, 120, 180, 240];
/** How many recent minutes of prices feed the change distribution (6 hours). */
const WINDOW = 360;
/** Shrinkage strength: a market's own quantiles get weight n/(n+SHRINK_K). */
const SHRINK_K = 100;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** The tau-quantile of a sorted array, by linear interpolation (type 7). */
function quantile(sorted: number[], tau: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] as number;
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) * (hi - pos) + (sorted[hi] as number) * (pos - lo);
}

/** Sorted h-minute changes of a price series, for every anchor horizon. */
function anchorDiffs(prices: number[]): Map<number, number[]> {
  const p = prices.slice(-WINDOW);
  const out = new Map<number, number[]>();
  for (const h of ANCHORS) {
    const diffs: number[] = [];
    for (let j = 0; j + h < p.length; j++) diffs.push((p[j + h] as number) - (p[j] as number));
    diffs.sort((a, b) => a - b);
    out.set(h, diffs);
  }
  return out;
}

/**
 * One market's quantile rows of *changes* at every anchor: its own empirical quantiles shrunk
 * toward the pooled cross-market quantiles, recentered so the median change is 0 (persistence).
 * An anchor with no changes anywhere (a history shorter than the anchor) carries the previous
 * anchor's row forward, so bands never collapse to zero width; with no anchor holding any
 * change at all, the row is the house baseline's normal band at that horizon.
 */
function anchorRows(own: Map<number, number[]>, pooled: Map<number, number[]>): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  let prev: number[] | null = null;
  for (const h of ANCHORS) {
    const d = own.get(h) as number[];
    const pd = pooled.get(h) as number[];
    let row: number[];
    if (d.length === 0 && pd.length === 0) {
      row = prev ?? Z.map((z) => z * FALLBACK_SIGMA * Math.sqrt(h));
    } else {
      const n = d.length;
      const w = n / (n + SHRINK_K);
      row = QUANTILES.map((tau) => {
        const qOwn = n > 0 ? quantile(d, tau) : null;
        const qPool = pd.length > 0 ? quantile(pd, tau) : 0;
        return qOwn === null ? qPool : w * qOwn + (1 - w) * qPool;
      });
    }
    const med = row[2] as number;
    const centered = row.map((v) => v - med);
    rows.set(h, centered);
    prev = centered;
  }
  return rows;
}

/** The change row at horizon h, linearly interpolated between the bracketing anchors. */
function rowAt(rows: Map<number, number[]>, h: number): number[] {
  let a0 = ANCHORS[0] as number;
  let a1 = ANCHORS[ANCHORS.length - 1] as number;
  for (const a of ANCHORS) {
    if (a <= h) a0 = a;
    if (a >= h) {
      a1 = a;
      break;
    }
  }
  const r0 = rows.get(a0) as number[];
  const r1 = rows.get(a1) as number[];
  if (a0 === a1) return r0;
  const t = (h - a0) / (a1 - a0);
  return r0.map((v, j) => v * (1 - t) + (r1[j] as number) * t);
}

/** The forecast of one market: horizon rows of the five quantiles around its last price. */
function forecast(m: CaseMarket, horizon: number, own: Map<number, number[]>, pooled: Map<number, number[]>): number[][] {
  const rows = anchorRows(own, pooled);
  const x = m.prices.length > 0 ? (m.prices[m.prices.length - 1] as number) : 0.5;
  const out: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const row = rowAt(rows, h).map((v) => price6(x + v));
    for (let j = 1; j < row.length; j++) {
      if ((row[j] as number) < (row[j - 1] as number)) row[j] = row[j - 1] as number;
    }
    out.push(row);
  }
  return out;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  // Pooled change distributions: every market's diffs at each anchor, sorted.
  const pooled = new Map<number, number[]>();
  const perMarket = new Map<string, Map<number, number[]>>();
  for (const m of c.markets) {
    const diffs = anchorDiffs(m.prices);
    perMarket.set(m.id, diffs);
    for (const h of ANCHORS) {
      const all = pooled.get(h) ?? [];
      all.push(...(diffs.get(h) as number[]));
      pooled.set(h, all);
    }
  }
  for (const h of ANCHORS) (pooled.get(h) as number[]).sort((a, b) => a - b);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes, perMarket.get(m.id) as Map<number, number[]>, pooled) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
