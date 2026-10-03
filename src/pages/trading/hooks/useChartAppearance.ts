import { useEffect } from "react";
import type { Timeframe } from "../constants";
import type { RtCtx } from "../chartRealtime";
import type { ChartRefs } from "./useChartInstance";

interface ChartPrefsSlice {
  showWicks: boolean;
  showCandleBorders: boolean;
  showVolume: boolean;
  showGrid: boolean;
}

interface Args {
  chartRefs: ChartRefs;
  chartEpoch: number;
  colors: RtCtx["colors"];
  timeframe: Timeframe;
  chartPrefs: ChartPrefsSlice;
}

/**
 * Every visual property of the chart that can change at runtime without
 * recreating it: candle/wick/border colors, volume visibility, grid
 * visibility, and the timeframe-driven tick/formatter options.
 *
 * Re-runs when prefs change or when `chartEpoch` bumps (chart recreation).
 */
export function useChartAppearance({
  chartRefs,
  chartEpoch,
  colors,
  timeframe,
  chartPrefs,
}: Args) {
  const { chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef } = chartRefs;

  // Candle body/border/wick colors.
  useEffect(() => {
    const up = colors.up;
    const down = colors.down;
    candleSeriesRef.current?.applyOptions({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      wickVisible: chartPrefs.showWicks,
      borderVisible: chartPrefs.showCandleBorders,
    });
  }, [
    chartPrefs.showWicks,
    chartPrefs.showCandleBorders,
    colors.up,
    colors.down,
    chartEpoch,
    candleSeriesRef,
  ]);

  // Volume series visibility.
  useEffect(() => {
    volumeSeriesRef.current?.applyOptions({visible: chartPrefs.showVolume});
  }, [chartPrefs.showVolume, chartEpoch, volumeSeriesRef]);

  // Grid visibility.
  useEffect(() => {
    chartRef.current?.applyOptions({
      grid: {
        vertLines: {visible: chartPrefs.showGrid},
        horzLines: {visible: chartPrefs.showGrid},
      },
    });
  }, [chartPrefs.showGrid, chartEpoch, chartRef]);

  // Timeframe-driven time-scale options + localization.
  // Runs in place — never recreates the chart.
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: {
        secondsVisible: timeframe === "1m",
        rightOffset: timeframe === "1m" ? 10 : 6,
        minBarSpacing: 0.5,
        tickMarkFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return d.toLocaleTimeString("it-IT", {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
      localization: {
        timeFormatter: (time: number) => {
          const d = new Date(time * 1000);
          return d.toLocaleString("it-IT", {
            timeZone: "UTC",
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
    });
  }, [timeframe, chartRef]);
}