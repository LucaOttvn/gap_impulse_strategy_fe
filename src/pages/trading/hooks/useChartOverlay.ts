import { useEffect, useMemo, useRef } from "react";
import { type IPriceLine, type ISeriesPrimitive, type Time } from "lightweight-charts";
import type { Candle, Order, Position, Symbol } from "../../../services/schemas";
import type { Timeframe } from "../constants";
import {
  addOrderOverlay,
  addPositionOverlay,
  clearPriceLines,
  type OverlayOpts,
  type SlTpMap,
} from "../chartPositionOverlays";
import { attachPlugins, detachPlugins, detachPrimitiveArrays } from "../chartPlugins";
import type { RtCtx } from "../chartRealtime";
import { useChallengeLevels } from "../useChallengeLevels";
import { drawGapsImpulseStrategy } from "@/services/utils/strategy";
import { highlightOpenWindow } from "@/services/utils/openWindow";
import type { ChartRefs } from "./useChartInstance";

interface ChartPrefsSlice {
  challengeOverlay: boolean;
  challengeDailyLossLine: boolean;
  challengeMaxDrawdownLine: boolean;
  challengeProfitTargetLine: boolean;
  overlayPositionsOnChart: boolean;
}

interface Args {
  chartRefs: ChartRefs;
  chartEpoch: number;
  colors: RtCtx["colors"];
  selectedSymbol: string;
  timeframe: Timeframe;
  symbolInfo?: Symbol;
  positions: Position[];
  orders: Order[];
  accountId?: string | null;
  accountEquity: number;
  tick?: {bid: number; ask: number; timestamp: number};
  candles: Candle[];
  /** Only used as a trigger — overlays rebuild when the series' data changes. */
  chartData: unknown[];
  activePlugins: string[];
  isDark: boolean;
  chartPrefs: ChartPrefsSlice;
}

/**
 * Everything drawn on top of the candles:
 *   • position / order price lines
 *   • chart plugins (session breaks etc.)
 *   • strategy primitives (gap-impulse + session-open band)
 *   • challenge-aware rule levels
 *
 * Returns `slTpLinesRef` — the map the drag hook reads to move SL/TP lines.
 */
export function useChartOverlays(args: Args) {
  const {
    chartRefs, chartEpoch, colors, selectedSymbol, timeframe, symbolInfo,
    positions, orders, accountId, accountEquity, tick, candles, chartData,
    activePlugins, isDark, chartPrefs,
  } = args;

  const { candle: candleSeriesRef } = chartRefs;

  // ── Refs owned by this hook ──
  const priceLineRef = useRef<IPriceLine[]>([]);
  const slTpLinesRef = useRef<SlTpMap>(new Map());
  const chartPluginsRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const strategyPrimitivesRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const dayOpenBandRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const dayLevelsRef = useRef<ISeriesPrimitive<Time>[]>([]);

  // ── Challenge-aware rule levels ──
  const challengeFlags = useMemo(
    () => ({
      enabled: chartPrefs.challengeOverlay && !!accountId,
      dailyLoss: chartPrefs.challengeDailyLossLine,
      maxDrawdown: chartPrefs.challengeMaxDrawdownLine,
      profitTarget: chartPrefs.challengeProfitTargetLine,
    }),
    [
      chartPrefs.challengeOverlay,
      chartPrefs.challengeDailyLossLine,
      chartPrefs.challengeMaxDrawdownLine,
      chartPrefs.challengeProfitTargetLine,
      accountId,
    ],
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

  // ── Position / order price lines ──
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
  }, [
    positions, orders, selectedSymbol, chartData, symbolInfo, colors,
    chartPrefs.overlayPositionsOnChart, candleSeriesRef,
  ]);

  // ── Strategy primitives (gap-impulse + NY session open band) ──
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || candles.length === 0) return;

    detachPrimitiveArrays(series, [
      strategyPrimitivesRef.current,
      dayOpenBandRef.current,
      dayLevelsRef.current,
    ]);

    strategyPrimitivesRef.current = drawGapsImpulseStrategy(series, candles);
    dayOpenBandRef.current = highlightOpenWindow(series, candles, {
      minutes: 15,
      timeZone: "America/New_York",
      fill: "rgba(255, 200, 50, 0.10)",
    });
  }, [candles, chartEpoch, candleSeriesRef]);

  // ── Chart plugins (session breaks etc.) ──
  const symbolCategory = symbolInfo?.category;
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    detachPlugins(series, chartPluginsRef.current);
    chartPluginsRef.current = [];
    attachPlugins(series, activePlugins, { isDark, timeframe, symbolCategory }, chartPluginsRef.current);
  }, [activePlugins, isDark, selectedSymbol, timeframe, symbolCategory, candleSeriesRef]);

  return { slTpLinesRef };
}