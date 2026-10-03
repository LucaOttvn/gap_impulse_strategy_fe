import { useEffect, useRef } from "react";
import type { ISeriesPrimitive, Time } from "lightweight-charts";
import { createPlotLine } from "@/services/utils/plotLine";
import type { ChartRefs } from "./useChartInstance";
import type { StrategyCandle } from "@/services/utils/01_interfaces.ts";

/**
 * Draws the two fib step lines produced by the strategy: the orange line
 * (0.618 retracement) and the blue line (0.786 retracement). Values come
 * from the enriched StrategyCandle fields — NaN means "no fib yet on this
 * candle" (before the first qualifying gap of the day) and is passed
 * through as null so the step line breaks there.
 *
 * Unlike useDayLevels, this does NOT break at day boundaries. The strategy
 * keeps the same activeFib for the whole session, so the line should
 * continue until the day ends — the natural break happens because the
 * next day's early candles are NaN until a new gap forms.
 */
export function useFibLines(
  chartRefs: ChartRefs,
  candles: StrategyCandle[],
  chartEpoch: number,
) {
  const primitivesRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const lastSigRef = useRef("");

  const first = candles[0];
  const last = candles[candles.length - 1];
  const sig = (candles.length > 0 && first && last)
    ? `${candles.length}:${first.time}:${last.time}`
    : "";

  useEffect(() => {
    const series = chartRefs.candle.current;
    if (!series || candles.length === 0) return;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    // Detach whatever the previous run attached.
    for (const p of primitivesRef.current) series.detachPrimitive(p);
    primitivesRef.current = [];

    const orange = createPlotLine(series, { color: "#f59e0b", lineWidth: 1, mode: "step" });
    const blue   = createPlotLine(series, { color: "#22d3ee", lineWidth: 1, mode: "step" });

    for (const c of candles) {
      orange.add(c.time, Number.isNaN(c.orangeLine) ? null : c.orangeLine);
      blue.add(c.time,   Number.isNaN(c.blueLine)   ? null : c.blueLine);
    }

    const attached = [...orange.finish(), ...blue.finish()];
    primitivesRef.current = attached;

    return () => {
      for (const p of attached) {
        try { series.detachPrimitive(p); } catch { /* already detached */ }
      }
      primitivesRef.current = [];
    };
  }, [sig, chartEpoch, chartRefs.candle]);
}