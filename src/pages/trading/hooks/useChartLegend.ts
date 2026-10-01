import { useEffect, useRef, useState } from "react";
import {
  type CandlestickData,
  type HistogramData,
  type Time,
} from "lightweight-charts";
import { TF_INTERVAL_MS, type Timeframe } from "../constants";
import { restoreLegendOnLeave } from "../chartRealtime";
import { candleToLegend, type OhlcvLegend } from "../chartTypes";
import { formatCountdown } from "../utils";
import type { ChartRefs } from "./useChartInstance";

interface Args {
  chartRefs: ChartRefs;
  /** Bumps when the chart is recreated — re-subscribes the crosshair handler. */
  chartEpoch: number;
  timeframe: Timeframe;
  /** Owned by ChartPanel because the realtime effects also read/write them. */
  lastCandleRef: React.RefObject<CandlestickData<Time> | null>;
  legendVolRef: React.RefObject<number>;
}

/**
 * OHLCV legend and candle-close countdown.
 *
 * Both are driven by external events (crosshair moves, a 1 Hz timer) and
 * live outside the React render cycle — this hook owns the state, the
 * crosshair subscription, and the countdown interval.
 */
export function useChartLegend({
  chartRefs,
  chartEpoch,
  timeframe,
  lastCandleRef,
  legendVolRef,
}: Args) {
  const [legend, setLegend] = useState<OhlcvLegend | null>(null);
  const [countdown, setCountdown] = useState("");
  // True once the legend has been restored to the latest bar after the
  // crosshair left the series — prevents re-setting on every off-series move.
  const legendRestoredRef = useRef(true);

  // ── Crosshair → OHLCV legend ──
  // Re-subscribed every time the chart is recreated (chartEpoch changes).
  // lightweight-charts disposes handlers when chart.remove() runs, so no
  // explicit unsubscribe is required.
  useEffect(() => {
    const chart = chartRefs.chart.current;
    const candleSeries = chartRefs.candle.current;
    const volumeSeries = chartRefs.volume.current;
    if (!chart || !candleSeries || !volumeSeries) return;

    chart.subscribeCrosshairMove((param) => {
      if (!param?.time) {
        restoreLegendOnLeave(legendRestoredRef, lastCandleRef, legendVolRef, setLegend);
        return;
      }
      legendRestoredRef.current = false;
      const data = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
      if (data) {
        const vol = param.seriesData.get(volumeSeries) as HistogramData<Time> | undefined;
        setLegend(candleToLegend(data, vol?.value || 0));
      }
    });
  }, [chartEpoch, chartRefs, lastCandleRef, legendVolRef]);

  // ── Candle close countdown ──
  // Ticks every second and recomputes "seconds until the current bucket
  // closes". Skipped for ≥1d timeframes (countdown is meaningless there).
  useEffect(() => {
    const intervalMs = TF_INTERVAL_MS[timeframe];
    if (!intervalMs || intervalMs >= 86_400_000) {
      setCountdown("");
      return;
    }
    const tick = () => {
      const now = Date.now();
      const currentBucketStart = Math.floor(now / intervalMs) * intervalMs;
      const nextBucketStart = currentBucketStart + intervalMs;
      const remainingSec = Math.max(0, (nextBucketStart - now) / 1000);
      setCountdown(formatCountdown(remainingSec));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timeframe]);

  return { legend, countdown, setLegend };
}