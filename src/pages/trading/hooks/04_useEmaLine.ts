import { useEffect, useRef } from "react";
import type { ISeriesPrimitive, Time } from "lightweight-charts";
import { createPlotLine } from "@/services/utils/plotLine";
import type { ChartRefs } from "./useChartInstance";
import type { StrategyCandle } from "@/services/utils/01_interfaces";

export function useEmaLine(
  chartRefs: ChartRefs,
  candles: StrategyCandle[],
  chartEpoch: number,
  color: string = "#a855f7",
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

    const ema = createPlotLine(series, { color, lineWidth: 1, mode: "line" });

    for (const c of candles) {
      if (c.emaNewDay) ema.add(c.time, null);       // break the line at session start
      ema.add(c.time, Number.isNaN(c.ema) ? null : c.ema);
    }

    const attached = ema.finish();
    primitivesRef.current = attached;

    return () => {
      for (const p of attached) {
        try { series.detachPrimitive(p); } catch { /* already detached */ }
      }
      primitivesRef.current = [];
    };
  }, [sig, chartEpoch, chartRefs.candle, color]);
}