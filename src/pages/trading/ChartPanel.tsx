// RESPONSIBILITY
// --------------
// Owns the chart panel: creating/destroying the lightweight-charts instance,
// wiring the ~15 effects that keep the chart in sync with live data, drawings,
// positions, plugins and UI state, and rendering the overlay HUD. It contains
// NO raw chart math or data transformation — every helper is split out
// into focused modules (see "SPLIT MODULES" below) to ensure readability.
//
// WHAT THIS COMPONENT DOES
// ------------------------
//   1. Chart lifecycle – creates the chart + candle/volume series the first
//      time (recreated only on theme / precision / symbol change; the chart
//      deliberately PERSISTS across timeframe switches so drawings never blink).
//   2. Live data       – paints server CandleUpdate / tick / bid-ask streams,
//      restores the legend after crosshair leave, runs a staleness watchdog.
//   3. History (infinite scroll) – subscribes a load-more handler that prepends
//      older candles when the user scrolls to the left edge.
//   4. Drawings        – creates the DrawingToolsManager, syncs tool/mode/equity
//      refs, clone / reorder / selection handlers, context menus and object tree.
//   5. Overlays        – positions/orders price-lines, SL/TP drag map, challenge
//      rule levels, news popup, strategy-drawing layers, plugin primitives.
//   6. UI state        – legend header, countdown, context menus, settings dialog,
//      drawing tool rail.
//
// SPLIT MODULES
// ------------------------------
//   chartTypes.ts            – shared types for live data / legend / replay events
//   chartHistoryLoader.ts    – scroll-triggered "infinite history" fetching
//   chartPlugins.ts          – ISeriesPrimitive plugin factories + attach/detach
//   chartRealtime.ts         – live series update / setData / bid-ask helpers
//   chartPositionOverlays.ts – position / SL / TP / order price-line overlays
//   chartReplayMarkers.ts    – replay trade-event marker builders
//   chartHud.tsx             – presentational HUD overlays (legend, tools, object tree)
//   chartData.ts             – candle → lightweight-charts rows + useChartData hook
//
// The remaining file is: props contract + effect wiring + JSX.
// ═════════════════════════════════════════════════════════════════════════════

import { useQueryClient } from "@tanstack/react-query";
import {
    CandlestickSeries,
    type CandlestickData,
    ColorType,
    CrosshairMode,
    createChart,
    createSeriesMarkers,
    HistogramSeries,
    type HistogramData,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type ISeriesPrimitive,
    LineStyle,
    type SeriesMarker,
    type Time,
} from "lightweight-charts";
import { Position } from "postcss";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartData } from "./chartData";
import { LoadMoreState, makeHistoryLoader } from "./chartHistoryLoader";
import { detachPrimitiveArrays, detachPlugins, attachPlugins } from "./chartPlugins";
import { SlTpMap, clearPriceLines, OverlayOpts, addPositionOverlay, addOrderOverlay } from "./chartPositionOverlays";
import { restoreLegendOnLeave, RtCtx, legendFromSeries, reapplyLive, scrollOrFit, replayBufferedLive, scheduleStaleRefetch, applyServerCandle, applyTick, requestGapRefetch, applyBidAskLines } from "./chartRealtime";
import { buildReplayMarker } from "./chartReplayMarkers";
import { OhlcvLegend, candleToLegend } from "./chartTypes";
import { Timeframe, DrawingTool, DrawingLine, MagnetMode, mergeChartColors, CHART_COLORS, TF_INTERVAL_MS } from "./constants";
import { getStyleDefaults, DRAWING_STYLES_EVENT } from "./drawingStyles";
import { useChallengeLevels } from "./useChallengeLevels";
import { useIndicators } from "./useIndicators";
import { useNewsOverlay } from "./useNewsOverlay";
import { useSlTpDrag } from "./useSlTpDrag";
import { formatCountdown, getMinMove } from "./utils";
import { ChartContextMenu } from "@/components/ChartContextMenu";
import { ChartLegendHeader, DrawingOverlays, ObjectTreeOverlay } from "@/components/ChartHud";
import { ChartSettingsDialog } from "@/components/ChartSettingsDialog";
import { DrawingToolRail } from "@/components/DrawingToolRail";
import { DrawingContextMenu } from "@/components/DrawingToolsOverlay";
import { NewsOverlay } from "@/components/NewsOverlay";
import { useChartPreferences } from "@/hooks/useChartPreferences";
import { detectCrossings, playAlertBeep } from "@/lib/chart-plugins/drawing-tools/line-alerts";
import { DrawingToolsManager } from "@/lib/chart-plugins/drawing-tools/manager";
import { IndicatorType } from "@/lib/indicators";
import { cn } from "@/lib/utils";
import { Candle, Order } from "@/services/schemas";
import { toast } from "@/services/toast";
import { drawGapsImpulseStrategy, highlightFirstMinutesOfDay, drawDayLevels } from "@/services/utils/customDrawingTools";


// ── Props ────────────────────────────────────────────────────

export interface ChartPanelProps {
  candles: Candle[];
  selectedSymbol: string;
  timeframe: Timeframe;
  isDark: boolean;
  activeIndicators: IndicatorType[];
  drawingTool: DrawingTool;
  drawings: DrawingLine[];
  onAddDrawing: (d: DrawingLine) => void;
  onUpdateDrawing?: (d: DrawingLine) => void;
  onRemoveDrawing?: (id: string) => void;
  /** Called when a drawing completes/cancels so the parent can disarm the tool. */
  onDrawingComplete?: () => void;
  /** Alt+T/H/F/R keyboard shortcut pressed — arm the given tool. */
  onDrawingToolSelect?: (t: DrawingTool) => void;
  onUndoDrawing?: () => void;
  onRedoDrawing?: () => void;
  /** Snap drawing anchors to candle O/H/L/C — off / weak (near) / strong (always). */
  magnetMode?: MagnetMode;
  /** Keep the drawing tool armed after each placement. */
  stayInDrawingMode?: boolean;
  positions: Position[];
  orders: Order[];
  tick?: {bid: number; ask: number; timestamp: number};
  liveCandle?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };
  pipDigits: number;
  symbolInfo?: Symbol;
  onModifyPosition?: (positionId: string, mods: {takeProfit?: number | null; stopLoss?: number | null}) => void;
  replayTradeEvents?: Array<{
    id: string;
    type: "entry" | "exit" | "violation";
    timestamp: string;
    symbolName: string | null;
    side: string | null;
    price: number | null;
    pnl: number | null;
    ruleCode?: string;
  }>;
  activePlugins?: string[];
  /** Toggle a chart plugin (session breaks etc.) — used by the settings dialog. */
  onTogglePlugin?: (id: string) => void;
  /** Account equity — feeds the position tool's $-risk / size readout. */
  accountEquity?: number;
  /** Active account — enables the challenge-aware level overlay. */
  accountId?: string | null;
  /** Context-menu quick order at the clicked price (opens the confirm dialog). */
  onQuickOrder?: (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => void;
  /** Context-menu "Remove N drawings". */
  onClearDrawings?: () => void;
  /** Context-menu "Remove N indicators". */
  onClearIndicators?: () => void;
  /**
   * Session replay is active — candles are a historical slice, so the
   * staleness watchdog must not treat the old last-bar as a data gap.
   */
  isReplaying?: boolean;
}

// ═══════════════════════════════════════════════════════════
// CHART PANEL (lightweight-charts)
// ═══════════════════════════════════════════════════════════

export function ChartPanel({
  candles,
  selectedSymbol,
  timeframe,
  isDark,
  activeIndicators,
  drawingTool,
  drawings,
  onAddDrawing,
  onUpdateDrawing,
  onRemoveDrawing,
  onDrawingComplete,
  onDrawingToolSelect,
  onUndoDrawing,
  onRedoDrawing,
  magnetMode = "none",
  stayInDrawingMode = false,
  positions,
  orders,
  tick,
  liveCandle,
  pipDigits,
  symbolInfo,
  onModifyPosition,
  replayTradeEvents,
  activePlugins = [],
  onTogglePlugin,
  accountEquity = 0,
  accountId,
  onQuickOrder,
  onClearDrawings,
  onClearIndicators,
  isReplaying = false,
}: ChartPanelProps) {
  const queryClient = useQueryClient();
  const lastGapRefetchAtRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Scroll-triggered historical extension — older bars prepended as the user
  // scrolls left past what the initial deep-fetch already loaded.
  const [historicalExtra, setHistoricalExtra] = useState<Candle[]>([]);
  const loadMoreRef = useRef<LoadMoreState>({
    loading: false,
    noMoreData: false,
    lastFetchedBeforeMs: 0,
    fetchFromMs: 0,
  });
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLineRef = useRef<IPriceLine[]>([]);
  const drawingManagerRef = useRef<DrawingToolsManager | null>(null);
  // Current timeframe mirrored in a ref so the persistent chart's history
  // loader always fetches the active TF (the chart is no longer recreated on
  // TF change — see the TF-change effect below).
  const timeframeRef = useRef(timeframe);
  const chartPluginsRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);

  // ── SL/TP drag-to-edit state ──
  const slTpLinesRef = useRef<SlTpMap>(new Map());

  // Increments every time the chart instance is (re)created. Hooks that bind
  // DOM/series listeners (SL/TP drag, challenge levels) depend on this so they
  // re-bind against the live chart — without it they'd capture null refs on
  // mount (the create-effect runs after them) and never attach.
  const [chartEpoch, setChartEpoch] = useState(0);

  // OHLCV legend state
  const [legend, setLegend] = useState<OhlcvLegend | null>(null);
  // Candle countdown state
  const [countdown, setCountdown] = useState("");
  // True once the legend has been restored to the latest bar after the crosshair
  // left the series — prevents re-setting (and re-rendering) on every off-series
  // mouse move while the cursor sits outside the plotted data.
  const legendRestoredRef = useRef(true);

  const chartPrefs = useChartPreferences();
  // Theme palette with the user's Chart Settings color overrides applied.
  // Everything downstream (chart options, bid/ask lines, position overlays,
  // volume bars) reads from this merged object.
  const colors = useMemo(() => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs), [isDark, chartPrefs]);

  // Reset historical extension whenever symbol or timeframe changes so stale
  // out-of-range candles from the previous view are never mixed into new data.
  useEffect(() => {
    setHistoricalExtra([]);
    loadMoreRef.current = {
      loading: false,
      noMoreData: false,
      lastFetchedBeforeMs: 0,
      fetchFromMs: 0,
    };
    lastGapRefetchAtRef.current = 0;
  }, [selectedSymbol, timeframe]);

  // ── Drawing selection (floating toolbar / settings dialog / object tree) ──
  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{id: string; x: number; y: number} | null>(null);

  // ── Chart-wide context menu + settings dialog ──
  // When a right-click lands on a drawing the DrawingToolsManager opens the
  // drawing menu and sets this flag synchronously (native listeners fire before
  // React's delegated onContextMenu), so the chart menu stays closed.
  const drawingMenuOpenedRef = useRef(false);
  const [chartMenu, setChartMenu] = useState<{x: number; y: number; price: number | null} | null>(null);
  const [showChartSettings, setShowChartSettings] = useState(false);
  // The style toolbar / settings dialog only apply to a single selection.
  const selectedDrawing = useMemo(() => (selectedDrawingIds.length === 1 ? (drawings.find((d) => d.id === selectedDrawingIds[0]) ?? null) : null), [drawings, selectedDrawingIds]);

  // Drawings actually shown on this chart: not hidden, and either visible on
  // all timeframes or scoped to the current one.
  const visibleDrawings = useMemo(() => drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === timeframe)), [drawings, timeframe]);

  // Stable refs so the chart-create effect doesn't re-run on every parent render
  // when these props are unstable (e.g. inline onAddDrawing).
  const drawingToolRef = useRef(drawingTool);
  const drawingsRef = useRef(visibleDrawings);
  const magnetRef = useRef(magnetMode);
  const stayInModeRef = useRef(stayInDrawingMode);
  const accountEquityRef = useRef(accountEquity);
  const styleDefaultsRef = useRef(getStyleDefaults());
  const onAddDrawingRef = useRef(onAddDrawing);
  const onUpdateDrawingRef = useRef(onUpdateDrawing);
  const onRemoveDrawingRef = useRef(onRemoveDrawing);
  const onDrawingCompleteRef = useRef(onDrawingComplete);
  const onDrawingToolSelectRef = useRef(onDrawingToolSelect);
  const onUndoDrawingRef = useRef(onUndoDrawing);
  const onRedoDrawingRef = useRef(onRedoDrawing);
  useEffect(() => {
    drawingToolRef.current = drawingTool;
    drawingManagerRef.current?.setTool(drawingTool);
  }, [drawingTool]);
  useEffect(() => {
    drawingsRef.current = visibleDrawings;
    drawingManagerRef.current?.setDrawings(visibleDrawings);
  }, [visibleDrawings]);
  useEffect(() => {
    magnetRef.current = magnetMode;
    drawingManagerRef.current?.setMagnetMode(magnetMode);
  }, [magnetMode]);
  useEffect(() => {
    accountEquityRef.current = accountEquity;
    drawingManagerRef.current?.setAccountEquity(accountEquity);
  }, [accountEquity]);
  useEffect(() => {
    const refresh = () => {
      styleDefaultsRef.current = getStyleDefaults();
      drawingManagerRef.current?.setStyleDefaults(styleDefaultsRef.current);
    };
    window.addEventListener(DRAWING_STYLES_EVENT, refresh);
    return () => window.removeEventListener(DRAWING_STYLES_EVENT, refresh);
  }, []);
  useEffect(() => {
    stayInModeRef.current = stayInDrawingMode;
    drawingManagerRef.current?.setStayInDrawingMode(stayInDrawingMode);
  }, [stayInDrawingMode]);
  useEffect(() => {
    onAddDrawingRef.current = onAddDrawing;
    onUpdateDrawingRef.current = onUpdateDrawing;
    onRemoveDrawingRef.current = onRemoveDrawing;
    onDrawingCompleteRef.current = onDrawingComplete;
    onDrawingToolSelectRef.current = onDrawingToolSelect;
    onUndoDrawingRef.current = onUndoDrawing;
    onRedoDrawingRef.current = onRedoDrawing;
  });

  // Clone the selected drawing, offset 5 bars right so the copy is visible.
  const handleCloneDrawing = useCallback(() => {
    const d = selectedDrawing;
    if (!d) return;
    const offsetSec = ((TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000) * 5;
    onAddDrawing({
      ...d,
      id: crypto.randomUUID(),
      time: d.time != null ? d.time + offsetSec : undefined,
      time2: d.time2 != null ? d.time2 + offsetSec : undefined,
    });
  }, [selectedDrawing, timeframe, onAddDrawing]);

  // Z-order: bring to front = above the current max, send to back = below min.
  const handleReorderDrawing = useCallback(
    (d: DrawingLine, dir: "front" | "back") => {
      const zs = drawings.map((x) => x.zIndex ?? 0);
      const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
      onUpdateDrawing?.({...d, zIndex});
    },
    [drawings, onUpdateDrawing],
  );

  // Object-tree row click → select on the chart (no-op for drawings that are
  // hidden or scoped off this timeframe, since the manager doesn't know them).
  const handleObjectTreeSelect = useCallback((d: DrawingLine) => {
    drawingManagerRef.current?.setSelection([d.id]);
  }, []);

  // ── Extracted hooks ────────────────────────────────────────
  // Merge scroll-loaded historical extension (older) with the live data (newer).
  // useChartData deduplicates by timestamp, so overlap is safe.
  const allCandles = useMemo(() => (historicalExtra.length === 0 ? candles : [...historicalExtra, ...candles]), [historicalExtra, candles]);
  const {chartData, volumeData} = useChartData(allCandles, colors);

  const {newsConfig, setNewsConfig, showNewsConfigDialog, setShowNewsConfigDialog, newsPopup, setNewsPopup} = useNewsOverlay(containerRef, chartRef, selectedSymbol, isDark, chartData);

  const dragPrice = useSlTpDrag(containerRef, chartRef, candleSeriesRef, slTpLinesRef, drawingTool, onModifyPosition, pipDigits, symbolInfo, chartEpoch);

  // ── Challenge-aware rule levels (daily loss / max DD / profit target) ──
  const challengeFlags = useMemo(
    () => ({
      enabled: chartPrefs.challengeOverlay && !!accountId,
      dailyLoss: chartPrefs.challengeDailyLossLine,
      maxDrawdown: chartPrefs.challengeMaxDrawdownLine,
      profitTarget: chartPrefs.challengeProfitTargetLine,
    }),
    [chartPrefs.challengeOverlay, chartPrefs.challengeDailyLossLine, chartPrefs.challengeMaxDrawdownLine, chartPrefs.challengeProfitTargetLine, accountId],
  );
  useChallengeLevels({
    accountId,
    selectedSymbol,
    positions,
    tick,
    contractSize: symbolInfo?.contractSize || 100000,
    accountEquity,
    candleSeriesRef,
    flags: challengeFlags,
    chartEpoch,
  });

  // ── Chart context-menu actions ──
  const handleChartContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (drawingMenuOpenedRef.current) {
      drawingMenuOpenedRef.current = false;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = candleSeriesRef.current?.coordinateToPrice(e.clientY - rect.top);
    const price = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    setChartMenu({x: e.clientX, y: e.clientY, price});
  }, []);

  const handleResetView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().resetTimeScale();
    chart.priceScale("right").applyOptions({autoScale: true});
    chart.timeScale().scrollToRealTime();
  }, []);

  const handleCopyPrice = useCallback(
    (price: number) => {
      const text = price.toFixed(pipDigits);
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast.success("Copied", text))
        .catch(() => toast.error("Copy failed", "Clipboard unavailable"));
    },
    [pipDigits],
  );

  const handleAddAlert = useCallback(
    (price: number) => {
      const rounded = parseFloat(price.toFixed(pipDigits));
      onAddDrawing({
        id: crypto.randomUUID(),
        type: "horizontal",
        price: rounded,
        color: "#f0b90b",
        alertEnabled: true,
        createdTf: timeframe,
      });
      toast.info("Alert set", `${selectedSymbol} at ${rounded}`);
    },
    [onAddDrawing, pipDigits, timeframe, selectedSymbol],
  );

  useIndicators(chartRef, candleSeriesRef, chartData, activeIndicators, isDark);

  // ── Replay trade event markers ─────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    const markers: SeriesMarker<Time>[] = [];
    for (const ev of (replayTradeEvents || [])) {
      const marker = buildReplayMarker(ev, timeframe);
      if (marker) markers.push(marker);
    }

    if (!series || !markers) return;
    const markersPlugin = createSeriesMarkers(series, markers);
    if (!series) return;
    if (!replayTradeEvents || replayTradeEvents.length === 0) {
      markersPlugin.setMarkers([]);
      return;
    }
    // lightweight-charts requires markers sorted by time ascending
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersPlugin.setMarkers(markers);
    return () => {
      markersPlugin.setMarkers([]);
    };
  }, [replayTradeEvents, timeframe]);

  // ── Candle close countdown timer ───────────────────────────
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

  // ── Create / destroy the chart instance ────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const minMove = getMinMove(pipDigits);

    const chart = createChart(containerRef.current, {
      layout: {
        background: {type: ColorType.Solid, color: colors.background},
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: {color: colors.grid, style: LineStyle.Dotted},
        horzLines: {color: colors.grid, style: LineStyle.Dotted},
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: colors.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#363a45",
          labelVisible: true,
        },
        horzLine: {
          color: colors.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#363a45",
          labelVisible: true,
        },
      },
      rightPriceScale: {
        borderColor: colors.grid,
        scaleMargins: {top: 0.06, bottom: 0.18},
        autoScale: true,
        alignLabels: true,
        borderVisible: true,
        entireTextOnly: false,
        ticksVisible: true,
        minimumWidth: 80,
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        secondsVisible: timeframeRef.current === "1m",
        rightOffset: timeframeRef.current === "1m" ? 10 : 6,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        borderVisible: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {time: true, price: true},
        axisDoubleClickReset: {time: true, price: true},
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: {
        type: "price",
        precision: pipDigits,
        minMove,
      },
      // Hide the candle's own last-value label and default close price-line.
      // Candle close is the mid price ((bid+ask)/2) — with a 1-pip spread that
      // sits half a pip below Ask, so the mid label stacks visually next to
      // the Ask label and rounds to the same 5-decimal string. The explicit
      // Bid/Ask price lines below are the authoritative right-edge prices for
      // trading; the mid label is redundant and creates the "misaligned" look.
      lastValueVisible: false,
      priceLineVisible: false,
      priceLineWidth: 1,
      priceLineColor: "",
      priceLineStyle: LineStyle.Dotted,
    });
    candleSeriesRef.current = candleSeries;

    // Volume histogram at the bottom of the chart
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {type: "volume"},
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: {top: 0.85, bottom: 0},
    });
    volumeSeriesRef.current = volumeSeries;

    // Subscribe to crosshair move for OHLCV legend
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

    // Handle resize
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(containerRef.current);

    // Interactive drawing layer (place / preview / select / drag / delete) —
    // callbacks go through refs so the create-effect doesn't depend on them.
    const drawingManager = new DrawingToolsManager({
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
        onSelectionChange: (ids) => {
          setSelectedDrawingIds(ids);
          setShowDrawingSettings(false);
        },
        onRequestSettings: (id) => {
          setSelectedDrawingIds([id]);
          setShowDrawingSettings(true);
        },
        onContextMenu: (id, clientX, clientY) => {
          drawingMenuOpenedRef.current = true;
          setSelectedDrawingIds([id]);
          setContextMenu({id, x: clientX, y: clientY});
        },
        onSelectTool: (t) => onDrawingToolSelectRef.current?.(t),
        onUndo: () => onUndoDrawingRef.current?.(),
        onRedo: () => onRedoDrawingRef.current?.(),
      },
    });
    drawingManager.setDrawings(drawingsRef.current);
    drawingManager.setTool(drawingToolRef.current);
    drawingManager.setMagnetMode(magnetRef.current);
    drawingManager.setStyleDefaults(styleDefaultsRef.current);
    drawingManager.setStayInDrawingMode(stayInModeRef.current);
    drawingManagerRef.current = drawingManager;

    // Subscribe to time-scale scrolling so we can load older bars when the
    // user scrolls past the leftmost loaded candle (infinite history pattern).
    // `historyLoadCancelled` guards against a stale fetch resolving after a
    // symbol/timeframe/theme change: the cleanup sets it to true before
    // unsubscribing so any in-flight `onLoaded` callback is silently dropped.
    let historyLoadCancelled = false;
    const handleRangeChange = makeHistoryLoader(selectedSymbol, timeframeRef, candleSeriesRef, loadMoreRef, (bars) => {
      if (!historyLoadCancelled) setHistoricalExtra((prev) => [...bars, ...prev]);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);

    // Signal listener-binding hooks that a live chart instance now exists.
    setChartEpoch((e) => e + 1);

    return () => {
      historyLoadCancelled = true;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      ro.disconnect();
      drawingManager.destroy();
      drawingManagerRef.current = null;
      setSelectedDrawingIds([]);
      setShowDrawingSettings(false);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      bidLineRef.current = null;
      askLineRef.current = null;
      midLineRef.current = null;
      chartPluginsRef.current = [];
      // Clear per-chart state so it doesn't bleed into the recreated chart
      // (theme toggle also destroys/recreates the chart instance).
      lastCandleRef.current = null;
      legendVolRef.current = 0;
      liveCandleTsRef.current = 0;
      loadMoreRef.current = {
        loading: false,
        noMoreData: false,
        lastFetchedBeforeMs: 0,
        fetchFromMs: 0,
      };
      lastGapRefetchAtRef.current = 0;
    };
  }, [isDark, pipDigits, colors.background, colors.text, colors.grid, colors.crosshair, colors.watermark, colors.up, colors.down, selectedSymbol]); // Re-create on theme / precision / symbol change — NOT timeframe (the
  // chart persists across TF switches so drawings never blink out; the
  // TF-change effect below updates the live state in place, TradingView-style).

  // ── Live appearance settings (no chart recreation) ──
  useEffect(() => {
    // `colors` already carries the user's overrides (mergeChartColors).
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
  }, [chartPrefs.candleUpColor, chartPrefs.candleDownColor, chartPrefs.showWicks, chartPrefs.showCandleBorders, colors.up, colors.down, chartEpoch]);

  useEffect(() => {
    volumeSeriesRef.current?.applyOptions({visible: chartPrefs.showVolume});
  }, [chartPrefs.showVolume, chartEpoch]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      grid: {
        vertLines: {visible: chartPrefs.showGrid},
        horzLines: {visible: chartPrefs.showGrid},
      },
    });
  }, [chartPrefs.showGrid, chartEpoch]);

  //////////////////////// STRATEGY DRAWING SECTION //////////////////////////////////////////////////////////////
  const strategyPrimitivesRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const dayOpenBandRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const dayLevelsRef = useRef<ISeriesPrimitive<Time>[]>([]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || allCandles.length === 0) return;

    detachPrimitiveArrays(series, [strategyPrimitivesRef.current, dayOpenBandRef.current, dayLevelsRef.current]);

    strategyPrimitivesRef.current = drawGapsImpulseStrategy(series, allCandles);
    dayOpenBandRef.current = highlightFirstMinutesOfDay(series, allCandles, {
      minutes: 15,
      timeZone: "America/New_York",
      fill: "rgba(255, 200, 50, 0.10)",
    });
    dayLevelsRef.current = drawDayLevels(series, allCandles, {
      timeZone: "America/New_York",
      highColor: "#ffffff",
      lowColor: "#ffffff",
      lineWidth: 2,
    });
  }, [allCandles, chartEpoch]);

  // Primitive detach/rebuild for the strategy layers is handled by the shared
  // `detachPrimitiveArrays` helper from ./chartPlugins.ts (see call above).

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  // Timeframe change — the chart instance is NOT recreated (so drawings stay
  // attached); instead we update the persistent chart's options and re-point
  // the drawing manager's interval/createdTf at the new TF in place.
  useEffect(() => {
    timeframeRef.current = timeframe;
    chartRef.current?.applyOptions({
      timeScale: {
        secondsVisible: timeframe === "1m",
        rightOffset: timeframe === "1m" ? 10 : 6,
        minBarSpacing: 0.5,
        tickMarkFormatter: (time: any) => {
          const d = new Date((time as number) * 1000);
          return d.toLocaleTimeString("it-IT", {
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },

      localization: {
        timeFormatter: (time: any) => {
          // `time` here is the *shifted* UTC timestamp, so just format as UTC.
          const d = new Date((time as number) * 1000);
          return d.toLocaleString("it-IT", {
            timeZone: "UTC", // <- important: shifted time is already Rome
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
    });
    drawingManagerRef.current?.updateTimeframe(timeframe, (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000);
  }, [timeframe]);

  // ── Refs for smooth real-time streaming ────────────────
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle | undefined>(undefined);
  // Authoritative server candle timestamp, normalised to unix MILLISECONDS —
  // used to ignore ticks that pre-date the latest server CandleUpdate (those can
  // pollute H/L after a WS flush delivers a buffered tick *after* its
  // corresponding aggregated candle). Stored in ms so the tick guard compares
  // like-for-like regardless of whether the server emits seconds or ms.
  const liveCandleTsRef = useRef<number>(0);
  // Last known volume — needed to keep the volume bar coloured during tick
  // smoothing without overwriting the value with 0.
  const legendVolRef = useRef<number>(0);

  // Bundle the refs/config the real-time helpers need. Memoised so the live
  // effects can depend on `makeRtCtx` directly — it changes identity exactly when
  // colors / timeframe / symbol / queryClient change, so re-run timing matches
  // listing those values individually (refs and setLegend are stable).
  const makeRtCtx = useCallback(
    (series: ISeriesApi<"Candlestick">): RtCtx => ({
      series,
      volume: volumeSeriesRef.current,
      lastCandle: lastCandleRef,
      liveCandleTs: liveCandleTsRef,
      legendVol: legendVolRef,
      gapAt: lastGapRefetchAtRef,
      bidLine: bidLineRef,
      askLine: askLineRef,
      midLine: midLineRef,
      colors,
      timeframe,
      symbol: selectedSymbol,
      qc: queryClient,
      setLegend,
    }),
    [colors, timeframe, selectedSymbol, queryClient],
  );

  // Keep latest live candle in a ref (avoids stale closure in setData effect)
  useEffect(() => {
    latestLiveCandleRef.current = liveCandle;
  }, [liveCandle]);

  // Update candle data from server (historical fetch / periodic sync)
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
      // Periodic refetch — preserve viewport, re-apply latest live data.
      reapplyLive(buffered, ctx);
      return;
    }

    scrollOrFit(chartRef.current, chartData.length);
    lastLoadKeyRef.current = loadKey;
    liveCandleTsRef.current = 0;
    replayBufferedLive(buffered, chartData, ctx);
    return scheduleStaleRefetch(chartData, ctx);
  }, [chartData, volumeData, selectedSymbol, timeframe, makeRtCtx]);

  // ── Real-time candle updates ──────────────────────────

  // Primary: server-aggregated CandleUpdate events (OHLCV from candle aggregator).
  // No client-side throttle — the WS layer already batches at ~50ms; throttling
  // again here just adds latency without reducing render work (lightweight-charts
  // batches DOM writes internally and series.update is O(1)). The guard below
  // skips painting until history exists so a live WS candle can't render alone.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx]);

  // Secondary: tick-based smoothing between server CandleUpdate pulses.
  // Server CandleUpdate is authoritative — when it arrives next it will
  // overwrite this tick-merged bar via series.update.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx]);

  // ── Line-cross price alerts (client-side, in-session) ──────────
  // Fire a toast + beep when the live mid price crosses an alert-enabled
  // horizontal line or trendline. Drawings are read from a ref so this runs
  // only on tick changes.
  const alertMidRef = useRef<number | null>(null);
  const alertFiredRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!tick) return;
    const mid = (tick.bid + tick.ask) / 2;
    const prev = alertMidRef.current;
    alertMidRef.current = mid;
    if (prev === null) return;
    const nowSec = Math.floor(tick.timestamp / 1000);
    const crossed = detectCrossings(drawingsRef.current, prev, mid, nowSec, alertFiredRef.current);
    for (const d of crossed) {
      toast.info("Price alert", d.alertMessage ?? `${selectedSymbol} crossed your ${d.type} @ ${mid.toFixed(pipDigits)}`);
      playAlertBeep();
    }
  }, [tick, selectedSymbol, pipDigits]);

  // ── Staleness watchdog ────────────────────────────────────────
  // Guards against the case where CandleUpdates stop arriving entirely
  // (data-provider disconnect, aggregator restart). Both the live-candle and
  // tick effects only run when their props change, so this interval is the
  // only recovery path when neither prop is updating.
  useEffect(() => {
    // Replay shows a historical slice — its last bar is hours or days old by
    // design, so the staleness check would fire a refetch loop. Skip it.
    if (isReplaying) return;
    const intervalSec = (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000;
    const id = setInterval(() => {
      if (!lastCandleRef.current) return;
      const staleSec = Date.now() / 1000 - (lastCandleRef.current.time as number);
      if (staleSec < intervalSec * 2) return;
      requestGapRefetch(lastGapRefetchAtRef, queryClient, selectedSymbol, timeframe);
    }, 30_000);
    return () => clearInterval(id);
  }, [selectedSymbol, timeframe, queryClient, isReplaying]);

  // ── Chart plugin overlays ──────────────────────────────────
  // Re-runs when active plugins change or the chart is recreated (isDark /
  // symbol / timeframe), so primitives are always attached to the live series.
  const symbolCategory = symbolInfo?.category;
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const series = candleSeriesRef.current;
    detachPlugins(series, chartPluginsRef.current);
    chartPluginsRef.current = [];
    attachPlugins(series, activePlugins, {isDark, timeframe, symbolCategory}, chartPluginsRef.current);
  }, [activePlugins, isDark, selectedSymbol, timeframe, symbolCategory]);

  // ── Live bid/ask price tracking lines ──────────────────────
  // applyBidAskLines moves the existing price lines in-place (applyOptions) or
  // creates them — remove+create would force two full chart redraws per tick.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    applyBidAskLines(tick, {showBidLine: chartPrefs.showBidLine, showAskLine: chartPrefs.showAskLine}, makeRtCtx(series));
  }, [tick, chartPrefs.showBidLine, chartPrefs.showAskLine, makeRtCtx]);

  // ── Position/order overlays ────────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const lines = priceLineRef.current;
    clearPriceLines(series, lines);
    priceLineRef.current = [];
    slTpLinesRef.current.clear();
    if (!chartPrefs.overlayPositionsOnChart) return;

    const opts: OverlayOpts = {
      symbol: selectedSymbol,
      colors,
      contractSize: symbolInfo?.contractSize || 100000,
    };
    for (const pos of positions) {
      addPositionOverlay(series, pos, opts, priceLineRef.current, slTpLinesRef.current);
    }
    for (const ord of orders) {
      addOrderOverlay(series, ord, selectedSymbol, colors.orderLine, priceLineRef.current);
    }
  }, [positions, orders, selectedSymbol, chartData, symbolInfo, colors, chartPrefs.overlayPositionsOnChart]);

  return (
    <div className="relative w-full h-full">
      {/* OHLCV Legend Overlay */}
      <ChartLegendHeader
        selectedSymbol={selectedSymbol}
        timeframe={timeframe}
        legend={legend}
        countdown={countdown}
        tick={tick}
        pipDigits={pipDigits}
        showOhlcLegend={chartPrefs.showOhlcLegend}
        showCountdown={chartPrefs.showCountdown}
      />

      {/* Drag-to-edit tooltip */}
      {dragPrice && (
        <div className="absolute left-1/2 -translate-x-1/2 z-20 pointer-events-none" style={{top: dragPrice.y - 32}}>
          <div
            className={cn(
              "px-2 py-1 rounded text-[11px] font-mono font-bold shadow-lg border",
              dragPrice.field === "TP" ? "bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40" : "bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/40",
            )}
          >
            {dragPrice.field} → {dragPrice.price.toFixed(pipDigits)}
            <span className={dragPrice.pnlUsd >= 0 ? "ml-1.5 text-[#0ecb81]" : "ml-1.5 text-[#f6465d]"}>
              {dragPrice.pnlUsd >= 0 ? "+" : ""}${dragPrice.pnlUsd.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Selected-drawing floating toolbar / settings dialog */}
      <DrawingOverlays
        drawing={selectedDrawing}
        showSettings={showDrawingSettings}
        currentTf={timeframe}
        onUpdate={(d) => onUpdateDrawing?.(d)}
        onClone={handleCloneDrawing}
        onRemove={() => selectedDrawing && onRemoveDrawing?.(selectedDrawing.id)}
        onOpenSettings={() => setShowDrawingSettings(true)}
        onCloseSettings={() => setShowDrawingSettings(false)}
      />

      {contextMenu && selectedDrawing && (
        <DrawingContextMenu
          drawing={selectedDrawing}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onSettings={() => setShowDrawingSettings(true)}
          onDuplicate={handleCloneDrawing}
          onReorder={(dir) => handleReorderDrawing(selectedDrawing, dir)}
          onToggleLock={() => onUpdateDrawing?.({...selectedDrawing, locked: !selectedDrawing.locked})}
          onToggleAlert={() => onUpdateDrawing?.({...selectedDrawing, alertEnabled: !selectedDrawing.alertEnabled})}
          onRemove={() => onRemoveDrawing?.(selectedDrawing.id)}
        />
      )}

      {/* Object tree: toggle button + panel listing every drawing on the symbol */}
      <ObjectTreeOverlay
        drawings={drawings}
        selectedIds={selectedDrawingIds}
        pipDigits={pipDigits}
        currentTf={timeframe}
        open={showObjectTree}
        onToggle={() => setShowObjectTree((v) => !v)}
        onSelect={handleObjectTreeSelect}
        onUpdate={(d) => onUpdateDrawing?.(d)}
        onRemove={(id) => onRemoveDrawing?.(id)}
        onReorder={handleReorderDrawing}
      />

      {/* News overlay (popup, config dialog, button) */}
      <NewsOverlay
        newsConfig={newsConfig}
        setNewsConfig={setNewsConfig}
        showNewsConfigDialog={showNewsConfigDialog}
        setShowNewsConfigDialog={setShowNewsConfigDialog}
        newsPopup={newsPopup}
        setNewsPopup={setNewsPopup}
        isDark={isDark}
        pipDigits={pipDigits}
        containerRef={containerRef}
      />

      {/* Chart-wide right-click menu (TradingView-style) */}
      {chartMenu && (
        <ChartContextMenu
          x={chartMenu.x}
          y={chartMenu.y}
          price={chartMenu.price}
          pipDigits={pipDigits}
          symbol={selectedSymbol}
          tick={tick}
          drawingsCount={visibleDrawings.length}
          indicatorsCount={activeIndicators.length}
          onClose={() => setChartMenu(null)}
          onResetView={handleResetView}
          onCopyPrice={handleCopyPrice}
          onAddAlert={handleAddAlert}
          onQuickOrder={onQuickOrder}
          onOpenObjectTree={() => setShowObjectTree(true)}
          onRemoveAllDrawings={onClearDrawings}
          onClearIndicators={onClearIndicators}
          onOpenSettings={() => setShowChartSettings(true)}
        />
      )}

      <ChartSettingsDialog
        open={showChartSettings}
        onClose={() => setShowChartSettings(false)}
        prefs={chartPrefs}
        isDark={isDark}
        activePlugins={activePlugins}
        onTogglePlugin={onTogglePlugin}
        onOpenNewsConfig={() => setShowNewsConfigDialog(true)}
        hasAccount={!!accountId}
      />

      {/* Chart container — cursor is managed imperatively by DrawingToolsManager */}
      <div ref={containerRef} className="w-full h-full" onContextMenu={handleChartContextMenu} />

      {/* Left vertical tool rail (TradingView-style grouped flyouts) */}
      <DrawingToolRail drawingTool={drawingTool} onDrawingTool={(t) => onDrawingToolSelect?.(t)} />
    </div>
  );
}
