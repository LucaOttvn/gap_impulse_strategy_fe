import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { Timeframe } from "../constants";
import { getMinMove } from "../utils";

/**
 * Shared handles to the three things this hook creates. Passed in by the
 * caller (rather than returned) so every other chart hook in the stack can
 * read the same refs without prop-drilling. The hook mutates them in place:
 * assigns on create, nulls on teardown.
 */
export interface ChartRefs {
  chart: React.RefObject<IChartApi | null>;
  candle: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  volume: React.RefObject<ISeriesApi<"Histogram"> | null>;
}

interface Args {
  containerRef: React.RefObject<HTMLDivElement | null>;
  chartRefs: ChartRefs;

  // ── Inputs that recreate the chart ────────────────────────────────────
  // Everything below is in the effect's dep array. Changing any of them
  // tears down the current chart and builds a fresh one. That's a heavy
  // operation (new canvas, new series, all other hooks re-attach), so this
  // list is deliberately as short as it can be.
  isDark: boolean;
  pipDigits: number;
  selectedSymbol: string;
  colors: {
    background: string; text: string; grid: string; crosshair: string;
    watermark: string; up: string; down: string;
  };

  // ── Input that does NOT recreate the chart ────────────────────────────
  // Timeframe only affects two create-time options (secondsVisible,
  // rightOffset) and the drawing manager's snap interval. It's read via a
  // ref so switching timeframes doesn't blow away the chart — the chart
  // just starts rendering whatever series data the parent feeds it.
  timeframe: Timeframe;
}

export function useChartInstance(args: Args) {
  const {
    containerRef, chartRefs,
    isDark, pipDigits, selectedSymbol, colors, timeframe,
  } = args;

  // Destructured out of chartRefs so we can write to them without the
  // `chartRefs.chart.current = ...` indirection.
  const { chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef } = chartRefs;

  // Read at chart-create time only. Kept in a ref so the effect doesn't
  // rebuild the chart when the user switches timeframes.
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

  // Bumped every time the effect recreates the chart. Other hooks
  // (legend, data flow, appearance, overlays) depend on this so they know
  // to detach from the old chart and re-attach to the new one.
  const [chartEpoch, setChartEpoch] = useState(0);

  useEffect(() => {
    // The container is rendered by the caller. If it isn't mounted yet,
    // there's nothing to attach a chart to — bail. (This shouldn't happen
    // in practice since the container is rendered synchronously, but the
    // guard also satisfies TS.)
    if (!containerRef.current) return;

    // Derived from pipDigits: the smallest price increment the series will
    // display. Used for tick alignment and price formatting.
    const minMove = getMinMove(pipDigits);

    // ── Chart ─────────────────────────────────────────────────────────
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: colors.grid, style: LineStyle.Dotted },
        horzLines: { color: colors.grid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed,
                    labelBackgroundColor: "#363a45", labelVisible: true },
        horzLine: { color: colors.crosshair, width: 1, style: LineStyle.Dashed,
                    labelBackgroundColor: "#363a45", labelVisible: true },
      },
      rightPriceScale: {
        borderColor: colors.grid,
        // Leave room at the bottom of the price scale for the volume
        // histogram, which draws on its own scale overlaid on the same pane.
        scaleMargins: { top: 0.06, bottom: 0.18 },
        autoScale: true,
        alignLabels: true,
        borderVisible: true,
        minimumWidth: 80,
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        // On 1m, show seconds and give the right edge a bit more offset so
        // the newest bar isn't glued to the axis.
        secondsVisible: timeframeRef.current === "1m",
        rightOffset: timeframeRef.current === "1m" ? 10 : 6,
        minBarSpacing: 0.5,
        borderVisible: true,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true,
                     axisPressedMouseMove: { time: true, price: true },
                     axisDoubleClickReset: { time: true, price: true } },
    });
    chartRef.current = chart;

    // ── Candle series ─────────────────────────────────────────────────
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.up, downColor: colors.down,
      borderUpColor: colors.up, borderDownColor: colors.down,
      wickUpColor: colors.up, wickDownColor: colors.down,
      // precision/minMove come from pipDigits: the series must format
      // prices to the instrument's tick size, not a fixed decimal count.
      priceFormat: { type: "price", precision: pipDigits, minMove },
      // The last-value label and the series' own price line would collide
      // with the bid/ask lines drawn elsewhere. Suppress both.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    candleSeriesRef.current = candleSeries;

    // ── Volume series ─────────────────────────────────────────────────
    // Its own price scale ("volume") so it can occupy the bottom band of
    // the chart without distorting the candle scale.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volumeSeriesRef.current = volumeSeries;

    // ── Auto-resize ───────────────────────────────────────────────────
    // lightweight-charts doesn't respond to CSS resizes on its own — the
    // canvas has a fixed pixel size set at create time. The ResizeObserver
    // keeps it in sync with the container.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(containerRef.current);

    // Signal other hooks that the chart exists. Runs *after* the refs are
    // assigned above, so any hook that fires off `chartEpoch` will find a
    // fully-initialised chart when it re-attaches.
    setChartEpoch((e) => e + 1);

    // ── Teardown ──────────────────────────────────────────────────────
    // Runs when a dep changes (rebuild) or the component unmounts. Order
    // matters a little: stop the observer first so it doesn't fire against
    // a destroyed chart, then remove the chart, then clear the refs so any
    // other hook reading them sees null rather than a dangling instance.
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // The dep array is deliberately narrow: refs are stable (their identity
    // never changes) and the timeframe is read through a ref. Only things
    // that genuinely require a fresh chart are listed. Do NOT add the refs
    // or `timeframe` here — you'll get an infinite rebuild loop, because
    // every render would re-trigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable;
    // the effect only re-runs on things that should recreate the chart.
  }, [isDark, pipDigits, selectedSymbol,
      colors.background, colors.text, colors.grid, colors.crosshair,
      colors.watermark, colors.up, colors.down]);

  // `chartEpoch` is the only thing the caller needs. The refs were passed
  // in, so they're already shared.
  return { chartEpoch };
}