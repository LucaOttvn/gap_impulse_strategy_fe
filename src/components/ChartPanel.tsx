import {
  type CandlestickData,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChartPreferences } from "../hooks/useChartPreferences.ts";
import type { IndicatorType } from "../lib/indicators.ts";
import { cn } from "../lib/utils.ts";
import type { Candle, Order, Position, Symbol } from "../services/schemas.ts";
import { toast } from "../services/toast.ts";
import { CHART_COLORS, type DrawingLine, type DrawingTool, type MagnetMode, mergeChartColors, TF_INTERVAL_MS, type Timeframe } from "../pages/trading/constants.ts";
import { ChartContextMenu } from "./ChartContextMenu.tsx";
import { buildReplayMarker } from "../pages/trading/chartReplayMarkers.ts";
import { useIndicators } from "../pages/trading/useIndicators.ts";
import { usePriceWheelZoom } from "../pages/trading/usePriceWheelZoom.ts";
import { useSlTpDrag } from "../pages/trading/useSlTpDrag.ts";
import { ChartLegendHeader, DrawingOverlays, ObjectTreeOverlay } from "./ChartHud.tsx";
import { ChartSettingsDialog } from "./ChartSettingsDialog.tsx";
import { DrawingToolRail } from "./DrawingToolRail.tsx";
import { DrawingContextMenu } from "./DrawingToolsOverlay.tsx";
import { ChartRefs, useChartInstance } from "@/pages/trading/hooks/useChartInstance.ts";
import { useChartLegend } from "@/pages/trading/hooks/useChartLegend.ts";
import { useChartDataFlow } from "@/pages/trading/hooks/useChartDataFlow.ts";
import { useChartAppearance } from "@/pages/trading/hooks/useChartAppearance.ts";
import { useSlidingCandles } from "@/pages/trading/hooks/useSlidingCandles.ts";
import { useChartOverlays } from "@/pages/trading/hooks/useChartOverlays.ts";

export interface ChartPanelProps {
  /** Every loaded candle, oldest → newest. The sliding window slices this. */
  allCandles: Candle[];
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
    open: number; high: number; low: number; close: number; volume: number; timestamp: number;
  };
  pipDigits: number;
  symbolInfo?: Symbol;
  onModifyPosition?: (positionId: string, mods: {takeProfit?: number | null; stopLoss?: number | null}) => void;
  replayTradeEvents?: Array<{
    id: string; type: "entry" | "exit" | "violation"; timestamp: string;
    symbolName: string | null; side: string | null; price: number | null;
    pnl: number | null; ruleCode?: string;
  }>;
  activePlugins?: string[];
  onTogglePlugin?: (id: string) => void;
  accountEquity?: number;
  accountId?: string | null;
  onQuickOrder?: (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => void;
  onClearDrawings?: () => void;
  onClearIndicators?: () => void;
  isReplaying?: boolean;
  /** Called by the sliding window when the user scrolls past the oldest loaded bar. */
  onLoadMoreHistory?: () => void;
  /** False once the infinite query has no more history. */
  canLoadMoreHistory?: boolean;
}

export function ChartPanel({
  allCandles,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const chartRefs: ChartRefs = useMemo(
    () => ({ chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef }),
    [],
  );

  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const legendVolRef = useRef<number>(0);

  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{id: string; x: number; y: number} | null>(null);

  const drawingMenuOpenedRef = useRef(false);
  const [chartMenu, setChartMenu] = useState<{x: number; y: number; price: number | null} | null>(null);
  const [showChartSettings, setShowChartSettings] = useState(false);

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

  const onAddDrawingRef = useRef(onAddDrawing); onAddDrawingRef.current = onAddDrawing;
  const onUpdateDrawingRef = useRef(onUpdateDrawing); onUpdateDrawingRef.current = onUpdateDrawing;
  const onRemoveDrawingRef = useRef(onRemoveDrawing); onRemoveDrawingRef.current = onRemoveDrawing;
  const onDrawingCompleteRef = useRef(onDrawingComplete); onDrawingCompleteRef.current = onDrawingComplete;
  const onDrawingToolSelectRef = useRef(onDrawingToolSelect); onDrawingToolSelectRef.current = onDrawingToolSelect;
  const onUndoDrawingRef = useRef(onUndoDrawing); onUndoDrawingRef.current = onUndoDrawing;
  const onRedoDrawingRef = useRef(onRedoDrawing); onRedoDrawingRef.current = onRedoDrawing;

  const onDrawingMenuOpened = useCallback(() => { drawingMenuOpenedRef.current = true; }, []);
  const onDrawingContextMenu = useCallback((id: string, x: number, y: number) => {
    setSelectedDrawingIds([id]);
    setContextMenu({id, x, y});
  }, []);

  // ── 1. Chart instance ──
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
  });

  // ── 2. Sliding window ──
  // Bounds what the chart actually renders. `allCandles` (the React Query
  // cache) can be arbitrarily large; `visibleCandles` is at most 10k bars.
  const visibleCandles = useSlidingCandles({
    chartRefs,
    allCandles,
    chartEpoch,
    onNeedOlder: onLoadMoreHistory,
    canLoadOlder: canLoadMoreHistory,
  });

  // ── 3. Legend + countdown ──
  const { legend, countdown, setLegend } = useChartLegend({
    chartRefs,
    chartEpoch,
    timeframe,
    lastCandleRef,
    legendVolRef,
  });

  // ── 4. Realtime data pipeline ──
  const { chartData } = useChartDataFlow({
    chartRefs,
    colors,
    timeframe,
    selectedSymbol,
    isReplaying,
    liveCandle,
    tick,
    candles: visibleCandles,
    pipDigits,
    drawings: visibleDrawings,
    showBidLine: chartPrefs.showBidLine,
    showAskLine: chartPrefs.showAskLine,
    setLegend,
    lastCandleRef,
    legendVolRef,
  });

  // ── 5. Overlays ──
  const { slTpLinesRef } = useChartOverlays({
    chartRefs,
    chartEpoch,
    colors,
    selectedSymbol,
    timeframe,
    symbolInfo,
    positions,
    orders,
    accountId,
    accountEquity,
    tick,
    candles: visibleCandles,
    chartData,
    activePlugins,
    isDark,
    chartPrefs,
  });

  // ── 6. Appearance ──
  useChartAppearance({ chartRefs, chartEpoch, colors, timeframe, chartPrefs, drawingManagerRef });

  const dragPrice = useSlTpDrag(containerRef, chartRef, candleSeriesRef, slTpLinesRef, drawingTool, onModifyPosition, pipDigits, symbolInfo, chartEpoch);
  usePriceWheelZoom(containerRef, chartRef, candleSeriesRef, chartEpoch);

  const handleChartContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (drawingMenuOpenedRef.current) { drawingMenuOpenedRef.current = false; return; }
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

  const handleCopyPrice = useCallback((price: number) => {
    const text = price.toFixed(pipDigits);
    void navigator.clipboard?.writeText(text)
      .then(() => toast.success("Copied", text))
      .catch(() => toast.error("Copy failed", "Clipboard unavailable"));
  }, [pipDigits]);

  const handleAddAlert = useCallback((price: number) => {
    const rounded = parseFloat(price.toFixed(pipDigits));
    onAddDrawing({
      id: crypto.randomUUID(), type: "horizontal", price: rounded,
      color: "#f0b90b", alertEnabled: true, createdTf: timeframe,
    });
    toast.info("Alert set", `${selectedSymbol} at ${rounded}`);
  }, [onAddDrawing, pipDigits, timeframe, selectedSymbol]);

  const handleCloneDrawing = useCallback(() => {
    const d = selectedDrawing;
    if (!d) return;
    const offsetSec = ((TF_INTERVAL_MS[timeframe] ?? 60_000) / 1000) * 5;
    onAddDrawing({
      ...d, id: crypto.randomUUID(),
      time: d.time != null ? d.time + offsetSec : undefined,
      time2: d.time2 != null ? d.time2 + offsetSec : undefined,
    });
  }, [selectedDrawing, timeframe, onAddDrawing]);

  const handleReorderDrawing = useCallback((d: DrawingLine, dir: "front" | "back") => {
    const zs = drawings.map((x) => x.zIndex ?? 0);
    const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
    onUpdateDrawing?.({...d, zIndex});
  }, [drawings, onUpdateDrawing]);

  const handleObjectTreeSelect = useCallback((d: DrawingLine) => {
    drawingManagerRef.current?.setSelection([d.id]);
  }, [drawingManagerRef]);

  useIndicators(chartRef, candleSeriesRef, chartData, activeIndicators, isDark);

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
    return () => { markersPlugin.setMarkers([]); };
  }, [replayTradeEvents, timeframe]);

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
          <div className={cn(
            "px-2 py-1 rounded text-[11px] font-mono font-bold shadow-lg border",
            dragPrice.field === "TP" ? "bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40" : "bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/40",
          )}>
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