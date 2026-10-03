import { type CandlestickData, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { useMemo, useRef } from "react";
import { useChartPreferences } from "../hooks/useChartPreferences.ts";
import type { IndicatorType } from "../lib/indicators.ts";
import type { Order, Position, Symbol } from "../services/schemas.ts";
import { CHART_COLORS, type DrawingLine, type DrawingTool, type MagnetMode, mergeChartColors, type Timeframe } from "../pages/trading/constants.ts";
import { ChartLegendHeader } from "./ChartHud.tsx";
import { ChartRefs, useChartInstance } from "@/pages/trading/hooks/useChartInstance.ts";
import { useChartLegend } from "@/pages/trading/hooks/useChartLegend.ts";
import { useChartDataFlow } from "@/pages/trading/hooks/useChartDataFlow.ts";
import { useChartAppearance } from "@/pages/trading/hooks/useChartAppearance.ts";
import { useSlidingCandles } from "@/pages/trading/hooks/useSlidingCandles.ts";
import { useDayLevels } from "@/pages/trading/hooks/01_useDayLevels.ts";
import { StrategyCandle } from "@/services/utils/01_interfaces.ts";
import { useFibLines } from "@/pages/trading/hooks/03_useFibLines.ts";
import { useEmaLine } from "@/pages/trading/hooks/04_useEmaLine.ts";
import { useGapRects } from "@/pages/trading/hooks/05_useGapRect.ts";
import { useTpSlRects } from "@/pages/trading/hooks/06_useTpSlRects.ts";

interface ChartPanelProps {
  allCandles: StrategyCandle[];
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
  /** True while a page fetch is in flight — gates further onLoadMoreHistory calls. */
  isFetchingOlder?: boolean;
  /** True while candles are loading — either the first page or a scroll-back
   *  fetch. Drives the blurred loading overlay that covers the chart. */
  isLoadingCandles?: boolean;
  /** Called by the sliding window when the user scrolls past the oldest loaded bar. */
  onLoadMoreHistory?: () => void;
  /** False once the infinite query has no more history. */
  canLoadMoreHistory?: boolean;
}

/**
 * ChartPanel — bare candle chart with strategy overlays.
 *
 * Draws:
 *   • day high / day low step lines (from per-candle dayHigh/dayLow)
 *   • fib step lines after a qualifying gap (from per-candle orangeLine/blueLine)
 *
 * Everything is driven by fields the backend already enriched onto each
 * StrategyCandle, so nothing here re-runs strategy logic.
 */
export function ChartPanel(props: ChartPanelProps) {
  const {
    allCandles,
    selectedSymbol,
    timeframe,
    isDark,
    tick,
    liveCandle,
    pipDigits,
    isReplaying = false,
    isFetchingOlder = false,
    isLoadingCandles = false,
    onLoadMoreHistory,
    canLoadMoreHistory = false,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const chartRefs: ChartRefs = useMemo(() => ({chart: chartRef, candle: candleSeriesRef, volume: volumeSeriesRef}), []);
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);
  const legendVolRef = useRef<number>(0);

  const chartPrefs = useChartPreferences();
  const colors = useMemo(() => mergeChartColors(isDark ? CHART_COLORS.dark : CHART_COLORS.light, chartPrefs), [isDark, chartPrefs]);

  // Chart instance
  const {chartEpoch} = useChartInstance({
    containerRef,
    chartRefs,
    isDark,
    pipDigits,
    selectedSymbol,
    colors,
    timeframe,
  });

  // Sliding window
  const visibleCandles = useSlidingCandles({
    chartRefs,
    allCandles,
    chartEpoch,
    onNeedOlder: onLoadMoreHistory,
    canLoadOlder: canLoadMoreHistory,
    isFetchingOlder,
  });

  // Day high / low overlays
  useDayLevels(chartRefs, visibleCandles, chartEpoch, {
    lineWidth: 2,
  });

  // Fib overlays
  useFibLines(chartRefs, visibleCandles, chartEpoch);
  useEmaLine(chartRefs, visibleCandles, chartEpoch)
  useGapRects(chartRefs, visibleCandles, chartEpoch);
  useTpSlRects(chartRefs, visibleCandles, chartEpoch);

  // Legend + countdown
  const {legend, countdown, setLegend} = useChartLegend({
    chartRefs,
    chartEpoch,
    timeframe,
    lastCandleRef,
    legendVolRef,
  });

  // Realtime data pipeline
  useChartDataFlow({
    chartRefs,
    colors,
    timeframe,
    selectedSymbol,
    isReplaying,
    liveCandle,
    tick,
    candles: visibleCandles,
    pipDigits,
    drawings: [],
    showBidLine: chartPrefs.showBidLine,
    showAskLine: chartPrefs.showAskLine,
    setLegend,
    lastCandleRef,
    legendVolRef,
  });

  // Appearance
  useChartAppearance({
    chartRefs,
    chartEpoch,
    colors,
    timeframe,
    chartPrefs,
  });

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

      {isLoadingCandles && (
        <div className="absolute inset-0 z-40 flex items-center justify-center backdrop-blur-sm bg-background/50">
          <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-card border border-border shadow-2xl">
            <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            <span className="text-xs font-mono text-muted-foreground">loading candles…</span>
          </div>
        </div>
      )}

      {/* The chart container. Kept as the last child so the overlay and
          header absolutely-position on top of it. */}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}