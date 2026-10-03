import { useEffect, useRef } from "react";
import type { ISeriesPrimitive, Time } from "lightweight-charts";
import { createPlotLine } from "@/services/utils/plotLine";
import type { ChartRefs } from "./useChartInstance";
import { StrategyCandle } from "@/services/utils/01_interfaces";

interface DayLevelsOpts {
  highColor?: string;
  lowColor?: string;
  lineWidth?: number;
}

/**
 * Draws two step lines onto the candle series: the running day high and the
 * running day low. Each line is a single staircase that resets at every
 * session boundary — no line connects across days.
 *
 * The running records are computed here from each candle's `high`/`low`,
 * NOT read from `candle.dayHigh` / `candle.dayLow`. Step mode holds the
 * previous value horizontally and only jumps when the running record is
 * actually broken, which is what makes the line track the record across
 * the session.
 */
export function useDayLevels(
  chartRefs: ChartRefs,
  candles: StrategyCandle[],
  chartEpoch: number,
  opts?: DayLevelsOpts,
) {
  const primitivesRef = useRef<ISeriesPrimitive<Time>[]>([]);
  const lastSigRef = useRef("");

  // Cheap range signature — re-run only when the visible range actually
  // changes, not on every render (candles array is a fresh reference each
  // time the sliding window recomputes).
  const first = candles[0];
  const last = candles[candles.length - 1];
  const sig = (candles.length > 0 && first && last)
    ? `${candles.length}:${first.time}:${last.time}`
    : "";

  const highColor = opts?.highColor ?? "#ffffff";
  const lowColor  = opts?.lowColor  ?? "#ffffff";
  const lineWidth = opts?.lineWidth ?? 1;

  useEffect(() => {
    const series = chartRefs.candle.current;
    if (!series || candles.length === 0) return;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    // Detach whatever the previous run attached.
    for (const p of primitivesRef.current) {
      series.detachPrimitive(p);
    }
    primitivesRef.current = [];

    // Two independent step lines. Step mode holds the previous value
    // horizontally and jumps vertically when it changes — exactly what a
    // running high/low looks like.
    const highLine = createPlotLine(series, { color: highColor, lineWidth, mode: "step" });
    const lowLine  = createPlotLine(series, { color: lowColor,  lineWidth, mode: "step" });

    // NOTE: StrategyCandle doesn't carry a dayKey, so we fall back to the
    // UTC day bucket. If the strategy computes day boundaries using
    // America/New_York, add a `dayKey` field to StrategyCandle and use it
    // here instead — otherwise the line will break at the wrong candle.
    let prevKey: string | undefined;
    let runningHigh = -Infinity;
    let runningLow  = Infinity;

    for (const c of candles) {
      const key = String(Math.floor(c.time / 86_400));

      if (prevKey !== undefined && key !== prevKey) {
        // New day: break both lines and reset the running records so the
        // first candle of the new day starts a fresh staircase.
        highLine.add(c.time, null);
        lowLine.add(c.time, null);
        runningHigh = -Infinity;
        runningLow  = Infinity;
      }
      prevKey = key;

      // Only the candle that sets a new record moves the line. On every
      // other candle the step primitive continues the previous level, so
      // the visual is a horizontal segment until the record is broken.
      if (c.high > runningHigh) runningHigh = c.high;
      if (c.low  < runningLow)  runningLow  = c.low;

      highLine.add(c.time, runningHigh);
      lowLine.add(c.time, runningLow);
    }

    // finish() flushes the tail and returns every primitive attached during
    // this run — that's our handle for detaching later.
    const attached = [...highLine.finish(), ...lowLine.finish()];
    primitivesRef.current = attached;

    return () => {
      for (const p of attached) {
        try { series.detachPrimitive(p); } catch { /* already detached */ }
      }
      primitivesRef.current = [];
    };
  }, [sig, chartEpoch, chartRefs.candle, highColor, lowColor, lineWidth]);
}