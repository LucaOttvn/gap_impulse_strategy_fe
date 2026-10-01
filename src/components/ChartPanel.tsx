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
// The five extracted hooks — each owns one concern:
import { ChartRefs, useChartInstance } from "@/pages/trading/hooks/useChartInstance.ts";
import { useChartLegend } from "@/pages/trading/hooks/useChartLegend.ts";
import { useChartDataFlow } from "@/pages/trading/hooks/useChartDataFlow.ts";
import { useChartAppearance } from "@/pages/trading/hooks/useChartAppearance.ts";
import { useChartOverlays } from "@/pages/trading/hooks/useChartOverlays.ts";

// ── Props ────────────────────────────────────────────────────
// This is the entire input surface of the chart. It's big because the chart
// does a lot — but every prop maps 1:1 to something the hooks above need.

export interface ChartPanelProps {
  // Data
  candles: Candle[];
  selectedSymbol: string;
  timeframe: Timeframe;
  isDark: boolean;
  activeIndicators: IndicatorType[];

  // Drawing state + mutations
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

  // Position / order overlays
  positions: Position[];
  orders: Order[];
  onModifyPosition?: (positionId: string, mods: {takeProfit?: number | null; stopLoss?: number | null}) => void;

  // Live data
  tick?: {bid: number; ask: number; timestamp: number};
  liveCandle?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
  };

  // Symbol metadata
  pipDigits: number;
  symbolInfo?: Symbol;

  // Replay
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
  isReplaying?: boolean;

  // Plugins + settings
  activePlugins?: string[];
  onTogglePlugin?: (id: string) => void;

  // Account (challenge levels + risk display)
  accountEquity?: number;
  accountId?: string | null;

  // Chart context-menu actions
  onQuickOrder?: (side: "BUY" | "SELL", type: "LIMIT" | "STOP", price: number) => void;
  onClearDrawings?: () => void;
  onClearIndicators?: () => void;

  // Infinite-history scroll trigger (optional — parent owns the paginated source)
  onLoadMoreHistory?: () => void;
  canLoadMoreHistory?: boolean;
}

// ═══════════════════════════════════════════════════════════
// CHART PANEL (lightweight-charts)
// ═══════════════════════════════════════════════════════════
//
// This component is an orchestrator over
// five hooks, each with a single responsibility:
//
//   useChartInstance   — chart + series + drawing manager lifecycle.
//                        Only re-runs when the chart itself must be rebuilt
//                        (theme toggle, pip precision, symbol switch).
//
//   useChartLegend     — crosshair → OHLCV legend + candle-close countdown.
//
//   useChartDataFlow   — the realtime pipeline: bulk setData, live candle
//                        from the server, tick smoothing, bid/ask price
//                        lines, alert detection, staleness watchdog.
//
//   useChartOverlays   — everything drawn on top of the candles: position
//                        and order price lines, chart plugins, strategy
//                        primitives, challenge-aware rule levels.
//
//   useChartAppearance — runtime-switchable visual properties: candle
//                        colors, wicks, borders, volume visibility, grid
//                        visibility, timeframe formatting.
//
// ChartPanel itself owns:
//   • The five chart-related refs (container, chart, candle series, volume
//     series) and the shared `lastCandleRef` / `legendVolRef`.
//   • All UI state: which drawing is selected, which dialog is open, the
//     two right-click menus.
//   • The handlers that touch that UI state.
//   • The render.
//
// Hook call order matters: later hooks depend on earlier ones.

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
  // ── Chart-instance refs ──
  // Declared here rather than inside useChartInstance so the other four hooks
  // can share them. The hook wires the actual instances into them.
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  // Memoized so its identity never changes — otherwise every hook that takes
  // `chartRefs` would re-run on every render.
  const chartRefs: ChartRefs = useMemo(
    () => ({ chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef }),
    [],
  );

  // ── Refs shared between useChartLegend + useChartDataFlow ──
  // useChartDataFlow writes them (on setData, on live updates). useChartLegend
  // reads them when the crosshair leaves the plot (to restore the legend to
  // the latest bar). They must live here so both hooks see the same objects.
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const legendVolRef = useRef<number>(0);

  // ── UI state ──
  // Pure React state — never touched by the chart hooks. Each one drives a
  // piece of the render below.
  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([]);
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
  const [showObjectTree, setShowObjectTree] = useState(false);
  const [contextMenu, setContextMenu] = useState<{id: string; x: number; y: number} | null>(null);

  // The native contextmenu handler fires before React's onContextMenu. When
  // the drawing manager opens its own menu, it sets this ref synchronously,
  // and the chart-wide menu handler reads it to decide not to open its own.
  const drawingMenuOpenedRef = useRef(false);

  const [chartMenu, setChartMenu] = useState<{x: number; y: number; price: number | null} | null>(null);
  const [showChartSettings, setShowChartSettings] = useState(false);

  // ── Derived ──
  // User color overrides merged onto the current theme's base palette.
  const chartPrefs = useChartPreferences();
  const colors = useMemo(
    () => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs),
    [isDark, chartPrefs],
  );

  // The drawing whose floating toolbar / context menu should show. Only
  // meaningful when exactly one drawing is selected.
  const selectedDrawing = useMemo(
    () => (selectedDrawingIds.length === 1 ? (drawings.find((d) => d.id === selectedDrawingIds[0]) ?? null) : null),
    [drawings, selectedDrawingIds],
  );

  // Drawings actually drawn on this chart: not hidden, and either visible on
  // all timeframes or scoped to the current one.
  const visibleDrawings = useMemo(
    () => drawings.filter((d) => !d.hidden && (d.visibility !== "tf" || d.createdTf === timeframe)),
    [drawings, timeframe],
  );

  // ── Stable refs for the drawing-tool callbacks ──
  // The DrawingToolsManager is created once per chart. It holds closures over
  // these callbacks. If they changed identity on every render, we'd have to
  // either recreate the manager (expensive) or manually re-seed it. Mirroring
  // them into refs lets the manager always read the latest version.
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

  // ── Stable callbacks passed to the hook ──
  // These are useCallback'd so useChartInstance doesn't see new identities on
  // every render (which would force it to re-run its create-effect).
  const onDrawingMenuOpened = useCallback(() => { drawingMenuOpenedRef.current = true; }, []);
  const onDrawingContextMenu = useCallback((id: string, x: number, y: number) => {
    setSelectedDrawingIds([id]);
    setContextMenu({id, x, y});
  }, []);

  // ── 1. Chart instance ──
  // Creates the chart + series + drawing manager. Returns `chartEpoch`, which
  // bumps on every chart recreation — every hook below depends on it so they
  // can re-attach to the fresh chart. Also returns `drawingManagerRef` so the
  // object tree overlay can call setSelection() on it.
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

  // ── 2. Legend + countdown ──
  // Crosshair hover → OHLCV readout in the top-left. Countdown timer ticks
  // every second and resets at each candle close. Returns `setLegend` so the
  // realtime helpers in useChartDataFlow can write to the same state.
  const { legend, countdown, setLegend } = useChartLegend({
    chartRefs,
    chartEpoch,
    timeframe,
    lastCandleRef,
    legendVolRef,
  });

  // ── 3. Realtime data pipeline ──
  // Everything that turns raw candles / ticks / live updates into what's
  // drawn on the series. Returns `chartData` (candles in lightweight-charts
  // shape) so useIndicators below can compute on it without re-transforming.
  const { chartData } = useChartDataFlow({
    chartRefs,
    colors,
    timeframe,
    selectedSymbol,
    isReplaying,
    liveCandle,
    tick,
    candles,
    pipDigits,
    drawings: visibleDrawings,   // alerts fire only for drawings shown on this TF
    showBidLine: chartPrefs.showBidLine,
    showAskLine: chartPrefs.showAskLine,
    setLegend,
    lastCandleRef,
    legendVolRef,
  });

  // ── 4. Overlays ──
  // Position/order price lines, chart plugins, strategy primitives, and
  // challenge-aware rule levels. Returns `slTpLinesRef` — the map that the
  // drag hook (below) reads to move SL/TP handles.
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
    candles,
    chartData,          // trigger: overlays rebuild when series data changes
    activePlugins,
    isDark,
    chartPrefs,
  });

  // ── 5. Appearance ──
  // Candle colors, wicks, borders, volume visibility, grid visibility, and
  // timeframe formatting. All update in place — never recreate the chart.
  useChartAppearance({
    chartRefs,
    chartEpoch,
    colors,
    timeframe,
    chartPrefs,
    drawingManagerRef,
  });

  // ── Extracted hooks ──
  // Drag-to-edit SL/TP. Returns a tooltip payload while dragging, else null.
  const dragPrice = useSlTpDrag(
    containerRef,
    chartRef,
    candleSeriesRef,
    slTpLinesRef,
    drawingTool,
    onModifyPosition,
    pipDigits,
    symbolInfo,
    chartEpoch,
  );

  // Wheel-over-bars → cursor-anchored price zoom (TradingView-style).
  usePriceWheelZoom(containerRef, chartRef, candleSeriesRef, chartEpoch);

  // ── Handlers ──
  // All handlers below are useCallback'd so they don't cause re-renders of
  // children that take them as props.

  // Right-click on the chart. Opens the chart-wide menu with the clicked
  // price — unless the drawing manager opened its own menu first, in which
  // case we swallow the event (the flag is set synchronously by the manager).
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

  // Reset the visible range and disable autoscale (autoscale stays off after
  // the initial fit so user pan/zoom gestures don't get overridden).
  const handleResetView = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().resetTimeScale();
    chart.priceScale("right").applyOptions({autoScale: false});
    chart.timeScale().scrollToRealTime();
  }, []);

  // Copy a price to the clipboard, formatted to the symbol's precision.
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

  // "Add alert here" from the chart menu: creates a horizontal line with
  // alertEnabled=true and toasts the level.
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

  // Z-order: "front" = above the current max, "back" = below the current min.
  const handleReorderDrawing = useCallback(
    (d: DrawingLine, dir: "front" | "back") => {
      const zs = drawings.map((x) => x.zIndex ?? 0);
      const zIndex = dir === "front" ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1;
      onUpdateDrawing?.({...d, zIndex});
    },
    [drawings, onUpdateDrawing],
  );

  // Object-tree row click → select on the chart.
  const handleObjectTreeSelect = useCallback((d: DrawingLine) => {
    drawingManagerRef.current?.setSelection([d.id]);
  }, [drawingManagerRef]);

  // Indicator overlays (SMA / EMA / RSI / etc.) — pure side-effect hook.
  // Takes `chartData` rather than `candles` so it doesn't have to re-run the
  // candle→series transform that useChartDataFlow already did.
  useIndicators(chartRef, candleSeriesRef, chartData, activeIndicators, isDark);

  // ── Replay trade event markers ──
  // Renders entry/exit/violation markers on the candle series during replay.
  // Markers must be sorted by time ascending before setMarkers().
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

  // ── Render ──
  // Nothing below computes data. Every value here is either a prop, a piece
  // of local UI state, or an output of a hook called above.
  return (
    <div className="relative w-full h-full">
      {/* OHLCV legend (top-left) + candle-close countdown */}
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

      {/* Drag-to-edit SL/TP tooltip — follows the cursor while dragging */}
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

      {/* Floating toolbar + settings dialog for the selected drawing */}
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

      {/* Per-drawing right-click menu */}
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

      {/* Object tree: toggle button + panel listing every drawing */}
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

      {/* Chart settings dialog (colors, wicks, grid, plugins, etc.) */}
      <ChartSettingsDialog
        open={showChartSettings}
        onClose={() => setShowChartSettings(false)}
        prefs={chartPrefs}
        isDark={isDark}
        activePlugins={activePlugins}
        onTogglePlugin={onTogglePlugin}
        hasAccount={!!accountId}
      />

      {/* The actual chart canvas. The hooks above attach everything to it via
          the refs. The cursor is managed imperatively by DrawingToolsManager. */}
      <div ref={containerRef} className="w-full h-full" onContextMenu={handleChartContextMenu} />

      {/* Left-side vertical tool rail (TradingView-style) */}
      <DrawingToolRail drawingTool={drawingTool} onDrawingTool={(t) => onDrawingToolSelect?.(t)} />
    </div>
  );
}