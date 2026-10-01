import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type CandlestickData, type IPriceLine, type ISeriesApi, type Time } from "lightweight-charts";
import { detectCrossings, playAlertBeep } from "../../../lib/chart-plugins/drawing-tools/line-alerts";
import { toast } from "../../../services/toast";
import type { Candle } from "../../../services/schemas";
import type { DrawingLine, Timeframe } from "../constants";
import { TF_INTERVAL_MS } from "../constants";
import { useChartData as useCandleTransform } from "../chartData";
import {
  applyBidAskLines, applyServerCandle, applyTick, legendFromSeries,
  reapplyLive, replayBufferedLive, requestGapRefetch, scheduleStaleRefetch,
  scrollOrFit, type RtCtx,
} from "../chartRealtime";
import type { OhlcvLegend } from "../chartTypes";
import type { ChartRefs } from "./useChartInstance";

interface Args {
  chartRefs: ChartRefs;
  colors: RtCtx["colors"];
  timeframe: Timeframe;
  selectedSymbol: string;
  isReplaying: boolean;
  liveCandle?: { open: number; high: number; low: number; close: number; volume: number; timestamp: number };
  tick?: { bid: number; ask: number; timestamp: number };
  candles: Candle[];
  pipDigits: number;
  drawings: DrawingLine[];
  showBidLine: boolean;
  showAskLine: boolean;
  setLegend: Dispatch<SetStateAction<OhlcvLegend | null>>;
  lastCandleRef: React.RefObject<CandlestickData<Time> | null>;
  legendVolRef: React.RefObject<number>;
}

export function useChartDataFlow(args: Args) {
  const {
    chartRefs, colors, timeframe, selectedSymbol, isReplaying,
    liveCandle, tick, candles, pipDigits, drawings,
    showBidLine, showAskLine, setLegend, lastCandleRef, legendVolRef,
  } = args;

  const qc = useQueryClient();
  const { chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef } = chartRefs;

  const { chartData, volumeData } = useCandleTransform(candles, colors);

  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle>(undefined);
  const liveCandleTsRef = useRef<number>(0);
  const gapAtRef = useRef<number>(0);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);
  const alertMidRef = useRef<number | null>(null);
  const alertFiredRef = useRef<Map<string, number>>(new Map());

  const lastDataSigRef = useRef<string>("");
  const dataSig = chartData.length === 0
    ? ""
    : `${selectedSymbol}:${timeframe}:${chartData.length}:${chartData[chartData.length - 1]!.time}`;

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
      colors, timeframe, symbol: selectedSymbol, qc, setLegend,
    }),
    [colors, timeframe, selectedSymbol, qc, setLegend, lastCandleRef, legendVolRef, volumeSeriesRef],
  );

  useEffect(() => { latestLiveCandleRef.current = liveCandle; }, [liveCandle]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || chartData.length === 0) return;
    if (dataSig === lastDataSigRef.current) return;
    lastDataSigRef.current = dataSig;

    const ctx = makeRtCtx(series);
    const loadKey = `${selectedSymbol}:${timeframe}`;
    const isNewChart = lastLoadKeyRef.current !== loadKey;

    const chart = chartRef.current;
    const prevRange = chart && !isNewChart ? chart.timeScale().getVisibleRange() : null;

    series.setData(chartData);
    volumeSeriesRef.current?.setData(volumeData);
    lastCandleRef.current = chartData[chartData.length - 1] ?? null;
    setLegend(legendFromSeries(chartData, volumeData));
    console.log('[flow] prevRange', prevRange, 'newBounds', chartData[0]?.time, chartData[chartData.length - 1]?.time);

    // Restore the visible range, CLAMPED to the new data's time bounds.
    // Without clamping, setVisibleRange throws when the previous view
    // contained bars sliced out by the window shift — the old code caught
    // the throw and let the chart auto-fit (the "too big zoom").
    if (prevRange && chart) {
      const newFirst = chartData[0]!.time as unknown as number;
      const newLast = chartData[chartData.length - 1]!.time as unknown as number;
      const from = Math.max(prevRange.from as unknown as number, newFirst);
      const to = Math.min(prevRange.to as unknown as number, newLast);
      if (from < to) {
        try {
          chart.timeScale().setVisibleRange({ from: from as Time, to: to as Time });
        } catch {
          // Clamped range still rejected — leave the chart where it landed.
        }
      }
    }

    const buffered = latestLiveCandleRef.current;
    if (!isNewChart) { reapplyLive(buffered, ctx); return; }

    scrollOrFit(chartRef.current, chartData.length);
    lastLoadKeyRef.current = loadKey;
    liveCandleTsRef.current = 0;
    replayBufferedLive(buffered, chartData, ctx);

    if (chartRef.current) {
      chartRef.current.priceScale("right").applyOptions({ autoScale: false });
    }
    return scheduleStaleRefetch(chartData, ctx);
  }, [dataSig, volumeData, selectedSymbol, timeframe, makeRtCtx, setLegend,
      candleSeriesRef, volumeSeriesRef, chartRef, lastCandleRef]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx, candleSeriesRef, lastCandleRef]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx, candleSeriesRef]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    applyBidAskLines(tick, { showBidLine, showAskLine }, makeRtCtx(series));
  }, [tick, showBidLine, showAskLine, makeRtCtx, candleSeriesRef]);

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