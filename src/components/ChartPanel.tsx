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
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartPreferences } from "../hooks/useChartPreferences.ts";
import { detectCrossings, playAlertBeep } from "../lib/chart-plugins/drawing-tools/line-alerts.ts";
import { DrawingToolsManager } from "../lib/chart-plugins/drawing-tools/manager.ts";
import type { IndicatorType } from "../lib/indicators.ts";
import { cn } from "../lib/utils.ts";
import type { Candle, Order, Position, Symbol } from "../services/schemas.ts";
import { toast } from "../services/toast.ts";
import { CHART_COLORS, type DrawingLine, type DrawingTool, type MagnetMode, mergeChartColors, TF_INTERVAL_MS, type Timeframe } from "../pages/trading/constants.ts";
import { ChartContextMenu } from "./ChartContextMenu.tsx";
import { DRAWING_STYLES_EVENT, getStyleDefaults } from "../pages/trading/drawingStyles.ts";
import { formatCountdown, getMinMove } from "../pages/trading/utils.ts";
import { useChartData } from "../pages/trading/chartData.ts";

import { attachPlugins, detachPlugins, detachPrimitiveArrays } from "../pages/trading/chartPlugins.ts";
import { addOrderOverlay, addPositionOverlay, clearPriceLines, type OverlayOpts, type SlTpMap } from "../pages/trading/chartPositionOverlays.ts";
import { buildReplayMarker } from "../pages/trading/chartReplayMarkers.ts";
import { applyBidAskLines, applyServerCandle, applyTick, legendFromSeries, reapplyLive, replayBufferedLive, requestGapRefetch, restoreLegendOnLeave, scheduleStaleRefetch, scrollOrFit, type RtCtx } from "../pages/trading/chartRealtime.ts";
import { candleToLegend, type OhlcvLegend } from "../pages/trading/chartTypes.ts";
import { useChallengeLevels } from "../pages/trading/useChallengeLevels.ts";
import { useIndicators } from "../pages/trading/useIndicators.ts";
import { usePriceWheelZoom } from "../pages/trading/usePriceWheelZoom.ts";
import { useSlTpDrag } from "../pages/trading/useSlTpDrag.ts";
import { ChartLegendHeader, DrawingOverlays, ObjectTreeOverlay } from "./ChartHud.tsx";
import { ChartSettingsDialog } from "./ChartSettingsDialog.tsx";
import { DrawingToolRail } from "./DrawingToolRail.tsx";
import { DrawingContextMenu } from "./DrawingToolsOverlay.tsx";
import { drawGapsImpulseStrategy } from "@/services/utils/strategy.ts";
import { highlightOpenWindow } from "@/services/utils/openWindow.ts";

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
  onDrawingComplete?: () => void;
  onDrawingToolSelect?: (t: DrawingTool) => void;
  onUndoDrawing?: () => void;
  onRedoDrawing?: () => void;
  magnetMode?: MagnetMode;
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
  onTogglePlugin?: (id: string) => void;
  accountEquity?: number;
  accountId?: string | null;
  onQuickOrder?: (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => void;
  onClearDrawings?: () => void;
  onClearIndicators?: () => void;
  isReplaying?: boolean;
  // ── NEW: infinite-history hooks ──
  /** Called when the user scrolls near the oldest loaded bar. Parent fetches next page. */
  onLoadMoreHistory?: () => void;
  /** False once the parent's infinite query has no more pages. */
  canLoadMoreHistory?: boolean;
}

// ═══════════════════════════════════════════════════════════
// CHART PANEL (lightweight-charts)
// ═══════════════════════════════════════════════════════════
// The chart is created ONCE per (symbol, theme, pipDigits) and mutated
// imperatively afterwards. Timeframe changes and appearance tweaks do NOT
// recreate the chart — they call .applyOptions()/setData() instead.
//
// Historical extension: the parent owns the paginated source. When the user
// scrolls near the left edge, we call `onLoadMoreHistory()`; the parent
// fetches the next page and passes a bigger `candles` array back down.

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
  onLoadMoreHistory,
  canLoadMoreHistory = false,
}: ChartPanelProps) {
  const queryClient = useQueryClient();
  const lastGapRefetchAtRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLineRef = useRef<IPriceLine[]>([]);
  const drawingManagerRef = useRef<DrawingToolsManager | null>(null);
  const timeframeRef = useRef(timeframe);
  const chartPluginsRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);

  // SL/TP drag-to-edit state
  const slTpLinesRef = useRef<SlTpMap>(new Map());

  // Bumps on every chart recreation so listener-binding hooks re-attach.
  const [chartEpoch, setChartEpoch] = useState(0);

  // OHLCV legend + countdown state
  const [legend, setLegend] = useState<OhlcvLegend | null>(null);
  const [countdown, setCountdown] = useState("");
  const legendRestoredRef = useRef(true);

  const chartPrefs = useChartPreferences();
  const colors = useMemo(() => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs), [isDark, chartPrefs]);

  // Stable refs for the load-more callbacks — kept fresh every render so the
  // range-change handler (installed once per chart) always sees current values.
  const onLoadMoreHistoryRef = useRef(onLoadMoreHistory);
  onLoadMoreHistoryRef.current = onLoadMoreHistory;
  const canLoadMoreHistoryRef = useRef(canLoadMoreHistory);
  canLoadMoreHistoryRef.current = canLoadMoreHistory;

  // Drawing selection state
  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{id: string; x: number; y: number} | null>(null);

  // Chart-wide context menu + settings dialog
  const drawingMenuOpenedRef = useRef(false);
  const [chartMenu, setChartMenu] = useState<{x: number; y: number; price: number | null} | null>(null);
  const [showChartSettings, setShowChartSettings] = useState(false);
  const selectedDrawing = useMemo(() => (selectedDrawingIds.length === 1 ? (drawings.find((d) => d.id === selectedDrawingIds[0]) ?? null) : null), [drawings, selectedDrawingIds]);

  // Drawings shown on this chart.
  const visibleDrawings = useMemo(() => drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === timeframe)), [drawings, timeframe]);

  // Stable refs so the chart-create effect doesn't re-run on unstable props.
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

  // Clone selected drawing, offset 5 bars right.
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

  const handleReorderDrawing = useCallback(
    (d: DrawingLine, dir: "front" | "back") => {
      const zs = drawings.map((x) => x.zIndex ?? 0);
      const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
      onUpdateDrawing?.({...d, zIndex});
    },
    [drawings, onUpdateDrawing],
  );

  const handleObjectTreeSelect = useCallback((d: DrawingLine) => {
    drawingManagerRef.current?.setSelection([d.id]);
  }, []);

  // ── Extracted hooks ────────────────────────────────────────
  // `candles` already includes all loaded pages — no merge needed.
  const {chartData, volumeData} = useChartData(candles, colors);

  const dragPrice = useSlTpDrag(containerRef, chartRef, candleSeriesRef, slTpLinesRef, drawingTool, onModifyPosition, pipDigits, symbolInfo, chartEpoch);

  usePriceWheelZoom(containerRef, chartRef, candleSeriesRef, chartEpoch);

  // Challenge-aware rule levels.
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
    chart.priceScale("right").applyOptions({autoScale: false});
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
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    markersPlugin.setMarkers(markers);
    return () => {
      markersPlugin.setMarkers([]);
    };
  }, [replayTradeEvents, timeframe]);

  // ── Candle close countdown ─────────────────────────────────
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
  // Runs on theme / pipDigits / symbol change — NOT timeframe.
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
      lastValueVisible: false,
      priceLineVisible: false,
      priceLineWidth: 1,
      priceLineColor: "",
      priceLineStyle: LineStyle.Dotted,
    });
    candleSeriesRef.current = candleSeries;

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {type: "volume"},
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: {top: 0.85, bottom: 0},
    });
    volumeSeriesRef.current = volumeSeries;

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

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(containerRef.current);

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

    // ── Infinite-history scroll trigger ──
    // The parent owns the paginated source. When the user is within ~20 bars
    // of the oldest loaded bar, ask for the next page via the ref-based
    // callback (installed once per chart, always reads the latest prop).
    const handleRangeChange = (range: { from: number; to: number } | null) => {
      if (!range) return;
      if (range.from < 20 && canLoadMoreHistoryRef.current) {
        onLoadMoreHistoryRef.current?.();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange as never);

    setChartEpoch((e) => e + 1);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange as never);
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
      lastCandleRef.current = null;
      legendVolRef.current = 0;
      liveCandleTsRef.current = 0;
      lastGapRefetchAtRef.current = 0;
    };
  }, [isDark, pipDigits, colors.background, colors.text, colors.grid, colors.crosshair, colors.watermark, colors.up, colors.down, selectedSymbol]);

  // ── Live appearance settings (no chart recreation) ──
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
    if (!series || candles.length === 0) return;

    detachPrimitiveArrays(series, [strategyPrimitivesRef.current, dayOpenBandRef.current, dayLevelsRef.current]);

    strategyPrimitivesRef.current = drawGapsImpulseStrategy(series, candles);
    dayOpenBandRef.current = highlightOpenWindow(series, candles, {
      minutes: 15,
      timeZone: "America/New_York",
      fill: "rgba(255, 200, 50, 0.10)",
    });
  }, [candles, chartEpoch]);

  //////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  // ── Timeframe change (in-place) ──
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
          const d = new Date((time as number) * 1000);
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
    drawingManagerRef.current?.updateTimeframe(timeframe, (TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000);
  }, [timeframe]);

  // ── Refs for smooth real-time streaming ────────────────
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle | undefined>(undefined);
  const liveCandleTsRef = useRef<number>(0);
  const legendVolRef = useRef<number>(0);

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

  useEffect(() => {
    latestLiveCandleRef.current = liveCandle;
  }, [liveCandle]);

  // ── Bulk candle load (initial fetch / periodic refetch) ──
  // NOTE: chartData grows as pages are appended. `isNewChart` distinguishes a
  // fresh symbol/TF (fit viewport) from a growing dataset (preserve viewport).
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
  }, [chartData, volumeData, selectedSymbol, timeframe, makeRtCtx]);

  // ── Real-time candle updates ──────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx]);

  // ── Line-cross price alerts ──────────────────────────────
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

  // ── Staleness watchdog ────────────────────────────────────
  useEffect(() => {
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
  const symbolCategory = symbolInfo?.category;
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const series = candleSeriesRef.current;
    detachPlugins(series, chartPluginsRef.current);
    chartPluginsRef.current = [];
    attachPlugins(series, activePlugins, {isDark, timeframe, symbolCategory}, chartPluginsRef.current);
  }, [activePlugins, isDark, selectedSymbol, timeframe, symbolCategory]);

  // ── Live bid/ask price tracking lines ──────────────────────
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

      {/* Selected-drawing toolbar / settings dialog */}
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

      {/* Per-drawing context menu */}
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

      {/* Object tree */}
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

      {/* Chart-wide context menu */}
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
        hasAccount={!!accountId}
      />

      <div ref={containerRef} className="w-full h-full" onContextMenu={handleChartContextMenu} />

      <DrawingToolRail drawingTool={drawingTool} onDrawingTool={(t) => onDrawingToolSelect?.(t)} />
    </div>
  );
}