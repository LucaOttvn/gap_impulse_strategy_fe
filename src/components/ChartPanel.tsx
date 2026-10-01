import { useQueryClient } from "@tanstack/react-query";
import {
  type CandlestickData,
  createSeriesMarkers, type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesMarker,
  type Time
} from "lightweight-charts";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartPreferences } from "../hooks/useChartPreferences.ts";
import { detectCrossings, playAlertBeep } from "../lib/chart-plugins/drawing-tools/line-alerts.ts";
import type { IndicatorType } from "../lib/indicators.ts";
import { cn } from "../lib/utils.ts";
import type { Candle, Order, Position, Symbol } from "../services/schemas.ts";
import { toast } from "../services/toast.ts";
import { CHART_COLORS, type DrawingLine, type DrawingTool, type MagnetMode, mergeChartColors, TF_INTERVAL_MS, type Timeframe } from "../pages/trading/constants.ts";
import { ChartContextMenu } from "./ChartContextMenu.tsx";
import { formatCountdown } from "../pages/trading/utils.ts";
import { useChartData } from "../pages/trading/chartData.ts";

import { attachPlugins, detachPlugins, detachPrimitiveArrays } from "../pages/trading/chartPlugins.ts";
import { addOrderOverlay, addPositionOverlay, clearPriceLines, type OverlayOpts, type SlTpMap } from "../pages/trading/chartPositionOverlays.ts";
import { buildReplayMarker } from "../pages/trading/chartReplayMarkers.ts";
import { applyBidAskLines, applyServerCandle, applyTick, legendFromSeries, reapplyLive, replayBufferedLive, requestGapRefetch, scheduleStaleRefetch, scrollOrFit, type RtCtx } from "../pages/trading/chartRealtime.ts";
import { type OhlcvLegend } from "../pages/trading/chartTypes.ts";
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
import { ChartRefs, useChartInstance } from "@/pages/trading/hooks/useChartInstance.ts";

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
  /** Called when the user scrolls near the oldest loaded bar. Parent fetches next page. */
  onLoadMoreHistory?: () => void;
  /** False once the parent's infinite query has no more pages. */
  canLoadMoreHistory?: boolean;
}

// ═══════════════════════════════════════════════════════════
// CHART PANEL (lightweight-charts)
// ═══════════════════════════════════════════════════════════
// The chart instance itself (chart + series + drawing manager) lives in
// useChartInstance. Everything below consumes those refs and drives data,
// overlays, appearance, and UI state on top.

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

  // ── Chart-instance refs (owned here, wired by the hook) ──
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const chartRefs: ChartRefs = useMemo(
    () => ({ chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef }),
    [],
  );

  // ── Refs used by overlays / realtime / alerts ──
  const lastGapRefetchAtRef = useRef<number>(0);
  const priceLineRef = useRef<IPriceLine[]>([]);
  const chartPluginsRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const bidLineRef = useRef<IPriceLine | null>(null);
  const askLineRef = useRef<IPriceLine | null>(null);
  const midLineRef = useRef<IPriceLine | null>(null);
  const slTpLinesRef = useRef<SlTpMap>(new Map());
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const lastLoadKeyRef = useRef<string>("");
  const latestLiveCandleRef = useRef<typeof liveCandle | undefined>(undefined);
  const liveCandleTsRef = useRef<number>(0);
  const legendVolRef = useRef<number>(0);

  // ── UI state ──
  const [legend, setLegend] = useState<OhlcvLegend | null>(null);
  const [countdown, setCountdown] = useState("");

  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{id: string; x: number; y: number} | null>(null);

  const drawingMenuOpenedRef = useRef(false);
  const [chartMenu, setChartMenu] = useState<{x: number; y: number; price: number | null} | null>(null);
  const [showChartSettings, setShowChartSettings] = useState(false);

  // ── Derived ──
  const chartPrefs = useChartPreferences();
  const colors = useMemo(
    () => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs),
    [isDark, chartPrefs],
  );
  const selectedDrawing = useMemo(
    () => (selectedDrawingIds.length === 1 ? (drawings.find((d) => d.id === selectedDrawingIds[0]) ?? null) : null),
    [drawings, selectedDrawingIds],
  );
  const visibleDrawings = useMemo(
    () => drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === timeframe)),
    [drawings, timeframe],
  );

  // ── Stable refs for the drawing-tool callbacks. These are the values the
  //    hook reads through its drawing manager, kept fresh on every render
  //    so the create-effect never needs to re-run when they change. ──
  const onAddDrawingRef = useRef(onAddDrawing);
  onAddDrawingRef.current = onAddDrawing;
  const onUpdateDrawingRef = useRef(onUpdateDrawing);
  onUpdateDrawingRef.current = onUpdateDrawing;
  const onRemoveDrawingRef = useRef(onRemoveDrawing);
  onRemoveDrawingRef.current = onRemoveDrawing;
  const onDrawingCompleteRef = useRef(onDrawingComplete);
  onDrawingCompleteRef.current = onDrawingComplete;
  const onDrawingToolSelectRef = useRef(onDrawingToolSelect);
  onDrawingToolSelectRef.current = onDrawingToolSelect;
  const onUndoDrawingRef = useRef(onUndoDrawing);
  onUndoDrawingRef.current = onUndoDrawing;
  const onRedoDrawingRef = useRef(onRedoDrawing);
  onRedoDrawingRef.current = onRedoDrawing;

  // ── Stable callbacks passed to the hook (all backed by useState setters,
  //    which React guarantees never change identity). ──
  const onDrawingMenuOpened = useCallback(() => { drawingMenuOpenedRef.current = true; }, []);
  const onDrawingContextMenu = useCallback((id: string, x: number, y: number) => {
    setSelectedDrawingIds([id]);
    setContextMenu({id, x, y});
  }, []);

  // ── Chart instance (created + managed by the hook) ──
  const { chartEpoch, drawingManagerRef } = useChartInstance({
    containerRef,
    chartRefs,
    isDark,
    pipDigits,
    selectedSymbol,
    colors,
    timeframe,
    drawingTool,
    magnetMode,
    stayInDrawingMode,
    accountEquity,
    drawings: visibleDrawings,
    onAddDrawingRef,
    onUpdateDrawingRef,
    onRemoveDrawingRef,
    onDrawingCompleteRef,
    onDrawingToolSelectRef,
    onUndoDrawingRef,
    onRedoDrawingRef,
    onDrawingMenuOpened,
    onDrawingSelectionChange: (ids) => {
      setSelectedDrawingIds(ids);
      setShowDrawingSettings(false);
    },
    onDrawingRequestSettings: (id) => {
      setSelectedDrawingIds([id]);
      setShowDrawingSettings(true);
    },
    onDrawingContextMenu,
    onLoadMoreHistory,
    canLoadMoreHistory,
  });

  // ── Extracted hooks ──
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

  // ── Handlers ──
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
  }, [drawingManagerRef]);

  useIndicators(chartRef, candleSeriesRef, chartData, activeIndicators, isDark);

  // ── Replay trade event markers ─────────────────────────────
  useEffect(() => {
    const series = candleSeriesRef.current;
    const markers: SeriesMarker<Time>[] = [];
    for (const ev of (replayTradeEvents || [])) {
      const marker = buildReplayMarker(ev, timeframe);
      if (marker) markers.push(marker);
    }

    if (!series) return;
    const markersPlugin = createSeriesMarkers(series, markers);
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

  // ── Strategy primitives ──
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

  // ── Timeframe change (in-place) ──
  useEffect(() => {
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
  }, [timeframe, drawingManagerRef]);

  // ── Realtime context bundle ──
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

  // ── Bulk candle load ──
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

  // ── Realtime candle from server ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !liveCandle || !lastCandleRef.current) return;
    applyServerCandle(liveCandle, makeRtCtx(series));
  }, [liveCandle, makeRtCtx]);

  // ── Tick-level smoothing ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || !tick) return;
    applyTick(tick, makeRtCtx(series));
  }, [tick, makeRtCtx]);

  // ── Line-cross price alerts ──
  const alertMidRef = useRef<number | null>(null);
  const alertFiredRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!tick) return;
    const mid = (tick.bid + tick.ask) / 2;
    const prev = alertMidRef.current;
    alertMidRef.current = mid;
    if (prev === null) return;
    const nowSec = Math.floor(tick.timestamp / 1000);
    const crossed = detectCrossings(visibleDrawings, prev, mid, nowSec, alertFiredRef.current);
    for (const d of crossed) {
      toast.info("Price alert", d.alertMessage ?? `${selectedSymbol} crossed your ${d.type} @ ${mid.toFixed(pipDigits)}`);
      playAlertBeep();
    }
  }, [tick, selectedSymbol, pipDigits, visibleDrawings]);

  // ── Staleness watchdog ──
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

  // ── Chart plugin overlays ──
  const symbolCategory = symbolInfo?.category;
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const series = candleSeriesRef.current;
    detachPlugins(series, chartPluginsRef.current);
    chartPluginsRef.current = [];
    attachPlugins(series, activePlugins, {isDark, timeframe, symbolCategory}, chartPluginsRef.current);
  }, [activePlugins, isDark, selectedSymbol, timeframe, symbolCategory]);

  // ── Bid/ask price lines ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    applyBidAskLines(tick, {showBidLine: chartPrefs.showBidLine, showAskLine: chartPrefs.showAskLine}, makeRtCtx(series));
  }, [tick, chartPrefs.showBidLine, chartPrefs.showAskLine, makeRtCtx]);

  // ── Position/order overlays ──
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

  // ── Render ──
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