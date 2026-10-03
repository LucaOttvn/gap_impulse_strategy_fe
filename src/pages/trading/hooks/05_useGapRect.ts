import { useEffect, useRef } from "react";
import type { ISeriesPrimitive, Time } from "lightweight-charts";
import type { ChartRefs } from "./useChartInstance";
import type { StrategyCandle } from "@/services/utils/01_interfaces";
import { GapRectanglePrimitive } from "@/services/utils/02_gapRect";

// Colors mirror the old FE strategy code:
//   bullish gap → blue
//   bearish gap → yellow
const BULL_FILL = "#00fff7";
const BEAR_FILL = "#edff00";

export function useGapRects(
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

    for (const p of primitivesRef.current) series.detachPrimitive(p);
    primitivesRef.current = [];

    const attached: ISeriesPrimitive<Time>[] = [];

    for (const c of candles) {
      if (!c.gap) continue;
      const fill = c.gap.direction === "bullish" ? BULL_FILL : BEAR_FILL;
      const prim = new GapRectanglePrimitive(
        c.gap.startTime as Time,
        c.gap.endTime as Time,
        c.gap.topPrice,
        c.gap.bottomPrice,
        fill,
        "transparent",
      );
      series.attachPrimitive(prim);
      attached.push(prim);
    }

    primitivesRef.current = attached;

    return () => {
      for (const p of attached) {
        try { series.detachPrimitive(p); } catch { /* already detached */ }
      }
      primitivesRef.current = [];
    };
  }, [sig, chartEpoch, chartRefs.candle]);
}