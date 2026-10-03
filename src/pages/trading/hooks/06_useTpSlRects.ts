import { useEffect, useRef } from "react";
import type { ISeriesPrimitive, Time } from "lightweight-charts";
import type { ChartRefs } from "./useChartInstance";
import type { StrategyCandle } from "@/services/utils/01_interfaces";
import { GapRectanglePrimitive } from "@/services/utils/02_gapRect";

const TP_FILL = "rgba(34, 197, 94, 0.30)";
const SL_FILL = "rgba(239, 68, 68, 0.30)";

/**
 * Draws two rectangles per closed operation, anchored to the entry candle:
 *   • green zone from entry price up/down to TP
 *   • red zone from entry price up/down to SL
 * Both span horizontally from entry time to exit time.
 */
export function useTpSlRects(
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
      if (!c.tpSl) continue;
      const { entryTime, exitTime, entryPrice, tpPrice, slPrice } = c.tpSl;

      const tpRect = new GapRectanglePrimitive(
        entryTime as unknown as Time,
        exitTime as unknown as Time,
        Math.max(entryPrice, tpPrice),
        Math.min(entryPrice, tpPrice),
        TP_FILL,
        "transparent",
      );
      const slRect = new GapRectanglePrimitive(
        entryTime as unknown as Time,
        exitTime as unknown as Time,
        Math.max(entryPrice, slPrice),
        Math.min(entryPrice, slPrice),
        SL_FILL,
        "transparent",
      );

      series.attachPrimitive(tpRect);
      series.attachPrimitive(slRect);
      attached.push(tpRect, slRect);
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