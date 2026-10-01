import { Dispatch, SetStateAction, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type CandlestickData, type IPriceLine, type ISeriesApi, type Time } from "lightweight-charts";
import { detectCrossings, playAlertBeep } from "../../../lib/chart-plugins/drawing-tools/line-alerts";
import { toast } from "../../../services/toast";
import type { Candle } from "../../../services/schemas";
import type { DrawingLine, Timeframe } from "../constants";
import { TF_INTERVAL_MS } from "../constants";
import { useChartData as useCandleTransform } from "../chartData";
import {
  applyBidAskLines,
  applyServerCandle,
  applyTick,
  legendFromSeries,
  reapplyLive,
  replayBufferedLive,
  requestGapRefetch,
  scheduleStaleRefetch,
  scrollOrFit,
  type RtCtx,
} from "../chartRealtime";
import type { OhlcvLegend } from "../chartTypes";
import type { ChartRefs } from "./useChartInstance";

interface Args {
  chartRefs: ChartRefs;
  colors: RtCtx["colors"];
  timeframe: Timeframe;
  selectedSymbol: string;
  isReplaying: boolean;
  liveCandle?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  tick?: {bid: number; ask: number; timestamp: number};
  candles: Candle[];
  pipDigits: number;
  /** Pass `visibleDrawings` so alerts only fire for drawings shown on this TF. */
  drawings: DrawingLine[];
  showBidLine: boolean;
  showAskLine: boolean;
  /** From useChartLegend — the realtime helpers write the legend on every tick. */
  setLegend: Dispatch<SetStateAction<OhlcvLegend | null>>;
  /** Owned by ChartPanel; also read by useChartLegend. */
  lastCandleRef: React.RefObject<CandlestickData<Time> | null>;
  legendVolRef: React.RefObject<number>;
}

/**
 * The realtime pipeline: everything that turns raw candles / ticks / live
 * updates into what's drawn on the series. Owns the six effects that used
 * to sit scattered through ChartPanel:
 *
 *   1. bulk setData (initial load / refetch)
 *   2. live candle from server (applyServerCandle)
 *   3. tick smoothing between server pulses (applyTick)
 *   4. bid/ask price lines (applyBidAskLines)
 *   5. line-cross alerts
 *   6. staleness watchdog
 *
 * Returns the chart-ready `chartData`/`volumeData` so ChartPanel can hand
 * them to `useIndicators` without re-running the transform.
 */
export function useChartDataFlow(args: Args) {
  const {
    chartRefs, colors, timeframe, selectedSymbol, isReplaying,
    liveCandle, tick, candles, pipDigits, drawings,
    showBidLine, showAskLine, setLegend, lastCandleRef, legendVolRef,
  } = args;

  const qc = useQueryClient();
  const { chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef } = chartRefs;

  // Raw candles → series-ready arrays. Owned here now (was in ChartPanel).
  const { chartData, volumeData } = useCandleTransform(candles, colors);

  // ── Internal refs (all moved out of ChartPanel) ──
  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle>(undefined);
  const liveCandleTsRef = useRef<number>(0);
  const gapAtRef = useRef<number>(0);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);
  const alertMidRef = useRef<number | null>(null);
  const alertFiredRef = useRef<Map<string, number>>(new Map());

  // ── Bundle the refs/config the realtime helpers need ──
  const makeRtCtx = useCallback(
    (series: ISeriesApi<"Candlestick">): RtCtx => ({
      series,
      volume: volumeSeriesRef.current,
      lastCandle: lastCandleRef,
      liveCandleTs: liveCandleTsRef,
      legendVol: legendVolRef,
      gapAt: gapAtRef,
      bidLine: bidLineRef,
      askLine: askLineRef,
      midLine: midLineRef,
      colors,
      timeframe,
      symbol: selectedSymbol,
      qc,
      setLegend,
    }),
    [colors, timeframe, selectedSymbol, qc, setLegend, lastCandleRef, legendVolRef, volumeSeriesRef],
  );

  // Keep latest live candle in a ref — bulk-load reads it without re-running.
  useEffect(() => {
    latestLiveCandleRef.current = liveCandle;
  }, [liveCandle]);

  // ── 1. Bulk setData ──
  // Full replace of the series. `isNewChart` distinguishes a fresh
  // symbol/TF (fit the viewport) from a growing dataset (preserve it).
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || chartData.length === 0) return;

    const ctx = makeRtCtx(series);
    const loadKey = `${selectedSymbol}:${timeframe}`;
    const isNewChart = lastLoadKeyRef.current !== loadKey;

    series.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);
    lastCandleRef.current = chartData[chartData.length - 1] ?? null;
    setLegend(legendFromSeries(chartData, volumeData));

    const buffered = latestLiveCandleRef.current;
    if (!isNewChart) {
      reapplyLive(buffered, ctx);
      return;
    }

    scrollOrFit(chartRef.current, chartData.length);
    lastLoadKeyRef.current = loadKey;
    liveCandleTsRef.current = 0;
    replayBufferedLive(buffered, chartData, ctx);

    if (chartRef.current) {
      chartRef.current.priceScale("right").applyOptions({autoScale: false});
    }
    return scheduleStaleRefetch(chartData, ctx);
  }, [chartData, volumeData, selectedSymbol, timeframe, makeRtCtx, setLegend, candleSeriesRef, volumeSeriesRef, chartRef, lastCandleRef]);

  // ── 2. Live candle from server ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx, candleSeriesRef, lastCandleRef]);

  // ── 3. Tick smoothing ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx, candleSeriesRef]);

  // ── 4. Bid/ask price lines ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    applyBidAskLines(tick, {showBidLine, showAskLine}, makeRtCtx(series));
  }, [tick, showBidLine, showAskLine, makeRtCtx, candleSeriesRef]);

  // ── 5. Line-cross price alerts ──
  useEffect(() => {
    if (!tick) return;
    const mid = (tick.bid + tick.ask) / 2;
    const prev = alertMidRef.current;
    alertMidRef.current = mid;
    if (prev === null) return;
    const nowSec = Math.floor(tick.timestamp / 1000);
    const crossed = detectCrossings(drawings, prev, mid, nowSec, alertFiredRef.current);
    for (const d of crossed) {
      toast.info("Price alert", d.alertMessage ?? `${selectedSymbol} crossed your ${d.type} @ ${mid.toFixed(pipDigits)}`);
      playAlertBeep();
    }
  }, [tick, selectedSymbol, pipDigits, drawings]);

  // ── 6. Staleness watchdog ──
  useEffect(() => {
    if (isReplaying) return;
    const intervalSec = (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000;
    const id = setInterval(() => {
      if (!lastCandleRef.current) return;
      const staleSec = Date.now() / 1000 - (lastCandleRef.current.time as number);
      if (staleSec < intervalSec * 2) return;
      requestGapRefetch(gapAtRef, qc, selectedSymbol, timeframe);
    }, 30_000);
    return () => clearInterval(id);
  }, [selectedSymbol, timeframe, qc, isReplaying, lastCandleRef]);

  return { chartData, volumeData };
}