// PURPOSE
// -------
// All the pure functions that mutate the live lightweight-charts series. They
// were extracted from the ChartPanel effects so that each effect body stays
// small and readable; behaviour is byte-for-byte unchanged. Everything here is a
// "pure relocation": the functions operate on a shared `RtCtx` object that the
// caller (`ChartPanel.makeRtCtx`) builds from its refs + props, so nothing needs
// to be re-created per render.
//
// The module covers five families of work:
//   1. Live streaming            – applyServerCandle / applyTick / paint volumes
//   2. Bid / Ask / Mid price lines– applyBidAskLines + in-place upsert helpers
//   3. History (setData) replay  – liveBarFrom / legendFromSeries / scrollOrFit /
//                                  reapplyLive / replayBufferedLive / scheduleStaleRefetch
//   4. Staleness recovery        – requestGapRefetch (throttled REST refetch)
//   5. Legend interaction        – restoreLegendOnLeave (crosshair left series)
//
// WHAT EACH PIECE DOES
// --------------------
//   requestGapRefetch() – Triggers a REST refetch (query invalidation) when the
//                         live data falls more than ~1.5 intervals behind the
//                         wall clock. Throttled to ≤1 refetch per 3 s.
//   intervalSecOf()     – Timeframe → interval length in seconds.
//   paintServerVolume() – Paints the authoritative server volume bar for the
//                         current candle (and remembers it in legendVol).
//   applyServerCandle() – PRIMARY path: paints a server-aggregated CandleUpdate
//                         (authoritative OHLCV), guarding against a gap and
//                         updating the legend.
//   buildTickBar()      – Builds the tick-smoothed bar: continuation of the
//                         current bucket (extend H/L, move close) or a fresh
//                         bucket seeded at the previous close.
//   paintTickVolume()   – Seeds a new bucket's volume at 0 (so a fresh candle
//                         never inherits the previous full-height bar).
//   applyTick()         – SECONDARY path: mid-price tick smoothing between
//                         server CandleUpdate pulses (server overwrites next).
//   removePriceLineSafe()/upsertPriceLine() – Create-or-update a price line in
//                         place via applyOptions to avoid remove+create churn
//                         (which would flicker the chart at tick rate).
//   applyBidAskLines()  – Positions the Bid / Ask (and Mid when both are hidden)
//                         dashed price lines for the latest tick.
//   liveBarFrom()       – Converts a live candle to a chart bar (or null).
//   legendFromSeries()  – Derives the legend from the last of the chart/volume data.
//   scrollOrFit()       – Scrolls right if there are many bars, else fits content.
//   reapplyLive()       – Re-paints the latest live bar after a periodic refetch
//                         while preserving the viewport.
//   replayBufferedLive()– Paints a buffered live candle right after history is
//                         set, so the last bar isn't stuck at the historical close.
//   scheduleStaleRefetch() – If the freshest bar is >2 intervals old, schedules a
//                         single delayed refetch (throttled to 3 s) to close the gap.
//   restoreLegendOnLeave() – When the crosshair leaves the series, restores the
//                         legend to the latest live bar exactly once so it doesn't
//                         stay frozen on the last hovered candle.
//
// NOTE
// ----
//   RtCtx bundles the series refs, colour palette, timeframe, symbol, query client
//   and legend setter that every helper needs, so the caller builds it once and
//   the effect re-runs only when the underlying values change identity.
// ═════════════════════════════════════════════════════════════════════════════

import {useQueryClient} from "@tanstack/react-query";
import {LineStyle, type CandlestickData, type HistogramData, type IChartApi, type IPriceLine, type ISeriesApi, type Time} from "lightweight-charts";
import type {Dispatch, SetStateAction} from "react";
import {queryKeys} from "../../services/queries.ts";
import {CHART_COLORS, TF_INTERVAL_MS, type Timeframe} from "./constants.ts";
import {candleToLegend, type LiveCandleData, type OhlcvLegend, type TickData} from "./chartTypes.ts";
import {getCandleBucketTime, toUnixMs, toUnixSeconds} from "./utils.ts";

// ── Staleness recovery ─────────────────────────────────────────────────────
// Shared by the live-candle and tick-smoothing effects so either path can
// trigger a REST refetch when the chart falls more than 1.5 intervals behind
// wall-clock. Throttled to ≤1 refetch per 3 s across both callers.
export function requestGapRefetch(refAtRef: {current: number}, qc: ReturnType<typeof useQueryClient>, symbol: string, timeframe: string): void {
  const now = Date.now();
  if (now - refAtRef.current <= 3_000) return;
  refAtRef.current = now;
  qc.invalidateQueries({queryKey: queryKeys.market.candles(symbol, timeframe)});
}

// ── Real-time series update helpers ──────────────────────────────────────────
type ChartColors = (typeof CHART_COLORS)["dark"];
type Ref<T> = {current: T};
export interface RtCtx {
  series: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram"> | null;
  lastCandle: Ref<CandlestickData<Time> | null>;
  liveCandleTs: Ref<number>;
  legendVol: Ref<number>;
  gapAt: Ref<number>;
  bidLine: Ref<IPriceLine | null>;
  askLine: Ref<IPriceLine | null>;
  midLine: Ref<IPriceLine | null>;
  colors: ChartColors;
  timeframe: Timeframe;
  symbol: string;
  qc: ReturnType<typeof useQueryClient>;
  setLegend: Dispatch<SetStateAction<OhlcvLegend | null>>;
}

function intervalSecOf(tf: Timeframe): number {
  return (TF_INTERVAL_MS[tf] ?? 60_000) / 1000;
}
// Paint the authoritative server volume bar for the current candle.
function paintServerVolume(live: LiveCandleData, barTime: Time, ctx: RtCtx): void {
  if (!ctx.volume || live.volume == null) return;
  ctx.legendVol.current = live.volume;
  try {
    ctx.volume.update({
      time: barTime,
      value: live.volume,
      color: live.close >= live.open ? ctx.colors.volumeUp : ctx.colors.volumeDown,
    });
  } catch {
    /* safe to ignore */
  }
}
// Primary: server-aggregated CandleUpdate (authoritative OHLCV).
export function applyServerCandle(live: LiveCandleData, ctx: RtCtx): void {
  const ts = toUnixSeconds(live.timestamp);
  if (Number.isNaN(ts) || ts <= 0 || !ctx.lastCandle.current) return;
  if (ts - (ctx.lastCandle.current.time as number) > intervalSecOf(ctx.timeframe) * 1.5) {
    requestGapRefetch(ctx.gapAt, ctx.qc, ctx.symbol, ctx.timeframe);
  }
  const bar: CandlestickData<Time> = {
    time: ts as Time,
    open: live.open,
    high: live.high,
    low: live.low,
    close: live.close,
  };
  ctx.lastCandle.current = bar;
  ctx.liveCandleTs.current = toUnixMs(live.timestamp);
  try {
    ctx.series.update(bar);
  } catch {
    /* timestamp older than series — safe to ignore */
  }
  paintServerVolume(live, ts as Time, ctx);
  ctx.setLegend(candleToLegend(bar, live.volume || 0));
}
// Build the tick-smoothed bar for the current bucket (continuation or fresh).
function buildTickBar(prev: CandlestickData<Time>, isContinuation: boolean, bucketTime: Time, mid: number, ctx: RtCtx): CandlestickData<Time> | null {
  if (isContinuation) {
    return {
      time: bucketTime,
      open: prev.open,
      high: Math.max(prev.high, mid),
      low: Math.min(prev.low, mid),
      close: mid,
    };
  }
  if ((bucketTime as number) <= (prev.time as number)) return null;
  if ((bucketTime as number) - (prev.time as number) > intervalSecOf(ctx.timeframe) * 1.5) {
    requestGapRefetch(ctx.gapAt, ctx.qc, ctx.symbol, ctx.timeframe);
  }
  const seedOpen = prev.close;
  return {
    time: bucketTime,
    open: seedOpen,
    high: Math.max(seedOpen, mid),
    low: Math.min(seedOpen, mid),
    close: mid,
  };
}
// A new bucket has no aggregated volume yet — seed it at 0 so a fresh candle
// never inherits the previous bar's full-height volume.
function paintTickVolume(bar: CandlestickData<Time>, isContinuation: boolean, bucketTime: Time, ctx: RtCtx): void {
  if (!ctx.volume) return;
  if (!isContinuation) ctx.legendVol.current = 0;
  try {
    ctx.volume.update({
      time: bucketTime,
      value: ctx.legendVol.current,
      color: bar.close >= bar.open ? ctx.colors.volumeUp : ctx.colors.volumeDown,
    });
  } catch {
    /* safe to ignore */
  }
}
// Secondary: tick smoothing between server CandleUpdate pulses.
export function applyTick(tick: TickData, ctx: RtCtx): void {
  if (!tick.timestamp) return;
  const tickMs = toUnixMs(tick.timestamp);
  if (ctx.liveCandleTs.current && tickMs <= ctx.liveCandleTs.current) return;
  const prev = ctx.lastCandle.current;
  if (!prev) return;
  const mid = (tick.bid + tick.ask) / 2;
  const bucketTime = getCandleBucketTime(tickMs, ctx.timeframe) as Time;
  const isContinuation = prev.time === bucketTime;
  const bar = buildTickBar(prev, isContinuation, bucketTime, mid, ctx);
  if (!bar) return;
  ctx.lastCandle.current = bar;
  try {
    ctx.series.update(bar);
  } catch {
    /* safe to ignore */
  }
  paintTickVolume(bar, isContinuation, bucketTime, ctx);
  ctx.setLegend((prevLegend) => ({
    ...candleToLegend(bar, 0),
    v: isContinuation ? (prevLegend?.v ?? 0) : 0,
  }));
}
function removePriceLineSafe(ref: Ref<IPriceLine | null>, series: ISeriesApi<"Candlestick">): void {
  if (!ref.current) return;
  try {
    series.removePriceLine(ref.current);
  } catch {
    /* ignore */
  }
  ref.current = null;
}
// Move an existing price line in place (applyOptions) or create it — avoids the
// remove+create churn that flickers the chart at tick rate.
function upsertPriceLine(ref: Ref<IPriceLine | null>, series: ISeriesApi<"Candlestick">, enabled: boolean, opts: Parameters<ISeriesApi<"Candlestick">["createPriceLine"]>[0]): void {
  if (!enabled) {
    removePriceLineSafe(ref, series);
    return;
  }
  if (ref.current) {
    try {
      ref.current.applyOptions(opts);
      return;
    } catch {
      ref.current = null;
    }
  }
  ref.current = series.createPriceLine(opts);
}
export function applyBidAskLines(tick: TickData | undefined, prefs: {showBidLine: boolean; showAskLine: boolean}, ctx: RtCtx): void {
  const series = ctx.series;
  if (!tick) {
    removePriceLineSafe(ctx.bidLine, series);
    removePriceLineSafe(ctx.askLine, series);
    removePriceLineSafe(ctx.midLine, series);
    return;
  }
  upsertPriceLine(ctx.bidLine, series, prefs.showBidLine, {
    price: tick.bid,
    color: ctx.colors.bidLine,
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "Bid",
    axisLabelColor: ctx.colors.bidLabelBg,
    axisLabelTextColor: "#ffffff",
  });
  upsertPriceLine(ctx.askLine, series, prefs.showAskLine, {
    price: tick.ask,
    color: ctx.colors.askLine,
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "Ask",
    axisLabelColor: ctx.colors.askLabelBg,
    axisLabelTextColor: "#ffffff",
  });
  // Mid line only when both bid+ask are hidden — otherwise it overlaps them.
  upsertPriceLine(ctx.midLine, series, !prefs.showBidLine && !prefs.showAskLine, {
    price: (tick.bid + tick.ask) / 2,
    color: "#7aa2ff99",
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: "",
    axisLabelColor: "#3b5ab5",
    axisLabelTextColor: "#ffffff",
  });
}
// ── Server-data (setData) helpers ────────────────────────────────────────────
// Extracted from the historical-fetch / periodic-sync effect so its body stays
// under the complexity limit. Pure relocations — behaviour is unchanged.

function liveBarFrom(live: LiveCandleData): CandlestickData<Time> | null {
  const ts = toUnixSeconds(live.timestamp);
  if (Number.isNaN(ts) || ts <= 0) return null;
  return {time: ts as Time, open: live.open, high: live.high, low: live.low, close: live.close};
}

export function legendFromSeries(chartData: CandlestickData<Time>[], volumeData: HistogramData<Time>[]): OhlcvLegend | null {
  const last = chartData[chartData.length - 1];
  if (!last) return null;
  const vol = volumeData.length > 0 ? (volumeData[volumeData.length - 1]?.value ?? 0) : 0;
  return candleToLegend(last, vol);
}

export function scrollOrFit(chart: IChartApi | null, barCount: number): void {
  const ts = chart?.timeScale();
  if (!ts) return;
  if (barCount > 150) ts.scrollToPosition(8, false);
  else ts.fitContent();
}

// Re-apply the latest live bar after a periodic refetch (viewport preserved).
export function reapplyLive(live: LiveCandleData | undefined, ctx: RtCtx): void {
  if (!live) return;
  const bar = liveBarFrom(live);
  if (!bar) return;
  try {
    ctx.series.update(bar);
  } catch {
    /* safe to ignore */
  }
  ctx.lastCandle.current = bar;
}

// Replay the buffered live candle immediately after history is painted so the
// last bar isn't stuck at the final historical close until the next tick.
export function replayBufferedLive(buffered: LiveCandleData | undefined, chartData: CandlestickData<Time>[], ctx: RtCtx): void {
  if (!buffered) return;
  const liveTs = toUnixSeconds(buffered.timestamp);
  const lastHistBarSec = (chartData[chartData.length - 1]?.time as number) ?? 0;
  if (Number.isNaN(liveTs) || liveTs <= 0 || liveTs < lastHistBarSec) return;
  const liveBar = liveBarFrom(buffered);
  if (!liveBar) return;
  try {
    ctx.series.update(liveBar);
    ctx.lastCandle.current = liveBar;
    ctx.liveCandleTs.current = toUnixMs(buffered.timestamp);
  } catch {
    /* safe to ignore — timestamp may be older than series */
  }
}

// If the freshest bar is >2 intervals stale, schedule one delayed refetch to
// close the gap before any live CandleUpdate paints over it. Throttled to 3 s.
export function scheduleStaleRefetch(chartData: CandlestickData<Time>[], ctx: RtCtx): (() => void) | undefined {
  const lastBarSec = (chartData[chartData.length - 1]?.time as number) ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (lastBarSec <= 0 || nowSec - lastBarSec <= intervalSecOf(ctx.timeframe) * 2) return undefined;
  const now = Date.now();
  if (now - ctx.gapAt.current <= 3_000) return undefined;
  ctx.gapAt.current = now;
  const {symbol, timeframe, qc} = ctx;
  const timer = window.setTimeout(() => {
    qc.invalidateQueries({queryKey: queryKeys.market.candles(symbol, timeframe)});
  }, 1_500);
  return () => window.clearTimeout(timer);
}
// ── Chart interaction handlers ───────────────────────────────────────────────

// Crosshair left the series — restore the legend to the latest live bar exactly
// once so it doesn't stay frozen on the last hovered candle.
export function restoreLegendOnLeave(restored: Ref<boolean>, lastCandle: Ref<CandlestickData<Time> | null>, legendVol: Ref<number>, setLegend: Dispatch<SetStateAction<OhlcvLegend | null>>): void {
  if (!restored.current && lastCandle.current) {
    setLegend(candleToLegend(lastCandle.current, legendVol.current));
  }
  restored.current = true;
}
