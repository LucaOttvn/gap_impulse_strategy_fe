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
import { DrawingLine, DrawingTool, MagnetMode, TF_INTERVAL_MS, Timeframe } from "../constants";
import { DrawingToolsManager } from "@/lib/chart-plugins/drawing-tools/manager";
import { getStyleDefaults, DRAWING_STYLES_EVENT } from "../drawingStyles";
import { getMinMove } from "../utils";

export interface ChartRefs {
  chart: React.RefObject<IChartApi | null>;
  candle: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  volume: React.RefObject<ISeriesApi<"Histogram"> | null>;
}

interface Args {
  // Persistent refs shared with the other hooks.
  containerRef: React.RefObject<HTMLDivElement | null>;
  chartRefs: ChartRefs;

  // Values the chart instance is created with. Changing any of these
  // recreates the whole chart (and bumps chartEpoch).
  isDark: boolean;
  pipDigits: number;
  selectedSymbol: string;
  colors: { background: string; text: string; grid: string; crosshair: string;
            watermark: string; up: string; down: string };

  // Values the DrawingToolsManager reads continuously. Changing these does
  // NOT recreate the chart — we mirror them into refs the manager checks
  // on every interaction.
  timeframe: Timeframe;
  drawingTool: DrawingTool;
  magnetMode: MagnetMode;
  stayInDrawingMode: boolean;
  accountEquity: number;
  drawings: DrawingLine[];

  // Drawing callbacks. Passed as refs by the parent so the create-effect
  // doesn't depend on their identity.
  onAddDrawingRef: React.RefObject<(d: DrawingLine) => void>;
  onUpdateDrawingRef: React.RefObject<((d: DrawingLine) => void) | undefined>;
  onRemoveDrawingRef: React.RefObject<((id: string) => void) | undefined>;
  onDrawingCompleteRef: React.RefObject<(() => void) | undefined>;
  onDrawingToolSelectRef: React.RefObject<((t: DrawingTool) => void) | undefined>;
  onUndoDrawingRef: React.RefObject<(() => void) | undefined>;
  onRedoDrawingRef: React.RefObject<((() => void) | undefined) | undefined>;

  // Drawing UI callbacks (already stable — provided by ChartPanel's useState).
  onDrawingMenuOpened: () => void;
  onDrawingSelectionChange: (ids: string[]) => void;
  onDrawingRequestSettings: (id: string) => void;
  onDrawingContextMenu: (id: string, x: number, y: number) => void;
}

export function useChartInstance(args: Args) {
  const {
    containerRef, chartRefs,
    isDark, pipDigits, selectedSymbol, colors,
    timeframe, drawingTool, magnetMode, stayInDrawingMode, accountEquity, drawings,
    onAddDrawingRef, onUpdateDrawingRef, onRemoveDrawingRef, onDrawingCompleteRef,
    onDrawingToolSelectRef, onUndoDrawingRef, onRedoDrawingRef,
    onDrawingMenuOpened, onDrawingSelectionChange, onDrawingRequestSettings,
    onDrawingContextMenu,
  } = args;

  const { chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef } = chartRefs;

  // Timeframe is read at chart-create time (for `secondsVisible`, `rightOffset`,
  // and the drawing manager's snap interval). Keeping it in a ref lets the
  // create-effect see the current TF without listing it as a dependency —
  // otherwise the chart would be torn down and rebuilt on every TF switch.
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;

  // Values the DrawingToolsManager reads on every user interaction. Mirrored
  // into refs so the create-effect doesn't need to re-run when they change.
  const drawingToolRef = useRef(drawingTool); drawingToolRef.current = drawingTool;
  const drawingsRef = useRef(drawings); drawingsRef.current = drawings;
  const magnetRef = useRef(magnetMode); magnetRef.current = magnetMode;
  const stayInModeRef = useRef(stayInDrawingMode); stayInModeRef.current = stayInDrawingMode;
  const accountEquityRef = useRef(accountEquity); accountEquityRef.current = accountEquity;

  // The DrawingToolsManager instance. Exposed to ChartPanel so the object-tree
  // UI can call setSelection() on it.
  const drawingManagerRef = useRef<DrawingToolsManager | null>(null);

  // Bumps on every chart recreation. Other hooks depend on this to re-attach
  // their crosshair/range subscriptions to the fresh chart.
  const [chartEpoch, setChartEpoch] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const minMove = getMinMove(pipDigits);

    // ── 1. Create the chart ───────────────────────────────────
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
        scaleMargins: { top: 0.06, bottom: 0.18 },
        autoScale: true,
        alignLabels: true,
        borderVisible: true,
        minimumWidth: 80,
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
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

    // ── 2. Candle series ──────────────────────────────────────
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.up, downColor: colors.down,
      borderUpColor: colors.up, borderDownColor: colors.down,
      wickUpColor: colors.up, wickDownColor: colors.down,
      priceFormat: { type: "price", precision: pipDigits, minMove },
      // The bid/ask price lines are authoritative at the right edge — hide
      // the series' own last-value and price-line.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    candleSeriesRef.current = candleSeries;

    // ── 3. Volume series ──────────────────────────────────────
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volumeSeriesRef.current = volumeSeries;

    // ── 4. Auto-resize ────────────────────────────────────────
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(containerRef.current);

    // ── 5. Drawing manager ────────────────────────────────────
    const manager = new DrawingToolsManager({
      chart,
      series: candleSeries,
      container: containerRef.current,
      intervalSec: (TF_INTERVAL_MS[timeframeRef.current] ?? 60_000) / 1000,
      timeframe: timeframeRef.current,
      accountEquity: accountEquityRef.current,
      callbacks: {
        onAdd: (d) => onAddDrawingRef.current(d),
        onUpdate: (d) => onUpdateDrawingRef.current?.(d),
        onRemove: (id) => onRemoveDrawingRef.current?.(id),
        onToolFinished: () => onDrawingCompleteRef.current?.(),
        onSelectionChange: onDrawingSelectionChange,
        onRequestSettings: onDrawingRequestSettings,
        onContextMenu: (id, x, y) => { onDrawingMenuOpened(); onDrawingContextMenu(id, x, y); },
        onSelectTool: (t) => onDrawingToolSelectRef.current?.(t),
        onUndo: () => onUndoDrawingRef.current?.(),
        onRedo: () => onRedoDrawingRef.current?.(),
      },
    });

    // Seed with the current state so nothing is empty until the first prop change.
    manager.setDrawings(drawingsRef.current);
    manager.setTool(drawingToolRef.current);
    manager.setMagnetMode(magnetRef.current);
    manager.setStyleDefaults(getStyleDefaults());
    manager.setStayInDrawingMode(stayInModeRef.current);
    drawingManagerRef.current = manager;

    // Drawing style defaults live in a separate store that emits a window
    // event when they change. Refresh the manager whenever it fires.
    const onStyleChange = () => manager.setStyleDefaults(getStyleDefaults());
    window.addEventListener(DRAWING_STYLES_EVENT, onStyleChange);

    // ── 7. Signal other hooks that the chart exists ───────────
    setChartEpoch((e) => e + 1);

    // ── 8. Teardown ───────────────────────────────────────────
    return () => {
      window.removeEventListener(DRAWING_STYLES_EVENT, onStyleChange);
      ro.disconnect();
      manager.destroy();
      drawingManagerRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable;
    // the effect only re-runs on things that should recreate the chart.
  }, [isDark, pipDigits, selectedSymbol,
      colors.background, colors.text, colors.grid, colors.crosshair,
      colors.watermark, colors.up, colors.down]);

  return { chartEpoch, drawingManagerRef };
}