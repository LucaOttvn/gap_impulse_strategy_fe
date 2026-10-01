import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "../../../services/schemas";
import type { ChartRefs } from "./useChartInstance";

interface Args {
  chartRefs: ChartRefs;
  /** Every loaded candle, oldest → newest. */
  allCandles: Candle[];
  /** Bumps when the chart is recreated — resets the window. */
  chartEpoch: number;
  /** Called when the user has scrolled past the oldest loaded bar. */
  onNeedOlder?: () => void;
  /** False once the cache has no more history. */
  canLoadOlder?: boolean;
}

const WINDOW_SIZE = 10_000;   // max bars the chart ever renders
const LOW_WATER = 2_000;      // distance from an edge before we slide
const SLIDE_BARS = 3_000;     // how far the window shifts per slide

/**
 * Bounds the number of candles the chart actually renders.
 *
 * React Query caches every loaded page — potentially hundreds of thousands
 * of bars. But setData, indicators, strategy primitives and every re-render
 * are all O(bars), so the chart only sees a moving window of WINDOW_SIZE
 * bars at a time.
 *
 * The window is defined by `rightOffset` — how many bars from the newest end
 * of `allCandles` the window's right edge sits. 0 = the newest WINDOW_SIZE
 * bars. As the user scrolls near an edge, the window slides.
 *
 * When the user reaches the oldest loaded bar and `canLoadOlder` is true,
 * `onNeedOlder` is called — the parent fetches the next page and the window
 * has more to slide into.
 */
export function useSlidingCandles(args: Args): Candle[] {
  const { chartRefs, allCandles, chartEpoch, onNeedOlder, canLoadOlder = false } = args;

  const [rightOffset, setRightOffset] = useState(0);
  const rightOffsetRef = useRef(rightOffset);
  rightOffsetRef.current = rightOffset;

  const allCandlesRef = useRef(allCandles);
  allCandlesRef.current = allCandles;

  const onNeedOlderRef = useRef(onNeedOlder);
  onNeedOlderRef.current = onNeedOlder;
  const canLoadOlderRef = useRef(canLoadOlder);
  canLoadOlderRef.current = canLoadOlder;

  // When older pages are prepended to `allCandles`, the array grows at the
  // front. Bump `rightOffset` by the same delta so the window keeps rendering
  // the same bars instead of jumping forward.
  const prevLenRef = useRef(allCandles.length);
  const prevFirstTimeRef = useRef<number | undefined>(
    allCandles[0]?.time as unknown as number | undefined,
  );
  useEffect(() => {
    const prevLen = prevLenRef.current;
    const prevFirst = prevFirstTimeRef.current;
    const currLen = allCandles.length;
    const currFirst = allCandles[0]?.time as unknown as number | undefined;

    prevLenRef.current = currLen;
    prevFirstTimeRef.current = currFirst;

    if (currLen === 0) {
      setRightOffset(0);
      return;
    }
    if (
      prevFirst !== undefined &&
      currFirst !== undefined &&
      currFirst < prevFirst &&
      currLen > prevLen
    ) {
      setRightOffset((o) => o + (currLen - prevLen));
    }
  }, [allCandles]);

  // Fresh chart (symbol / timeframe switch) — reset to the newest window.
  useEffect(() => {
    setRightOffset(0);
  }, [chartEpoch]);

  // The slice the chart actually renders.
  const visibleCandles = useMemo(() => {
    if (allCandles.length === 0) return [];
    const end = Math.max(0, allCandles.length - rightOffset);
    const start = Math.max(0, end - WINDOW_SIZE);
    return allCandles.slice(start, end);
  }, [allCandles, rightOffset]);

  // Scroll handler — slides the window or asks for more history.
  useEffect(() => {
    const chart = chartRefs.chart.current;
    if (!chart) return;

    let rafId: number | null = null;
    const handler = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const range = chart.timeScale().getVisibleLogicalRange();
        if (!range) return;

        const total = allCandlesRef.current.length;
        const offset = rightOffsetRef.current;
        const canSlideLeft = offset < total - WINDOW_SIZE;
        const canSlideRight = offset > 0;

        if (range.from < LOW_WATER) {
          // Near left edge — slide toward older bars, or fetch if we're
          // already at the oldest loaded bar.
          if (canSlideLeft) {
            setRightOffset((o) =>
              Math.min(o + SLIDE_BARS, Math.max(0, total - WINDOW_SIZE)),
            );
          } else if (canLoadOlderRef.current) {
            onNeedOlderRef.current?.();
          }
        } else if (range.to > WINDOW_SIZE - LOW_WATER) {
          // Near right edge — slide toward newer bars.
          if (canSlideRight) {
            setRightOffset((o) => Math.max(0, o - SLIDE_BARS));
          }
        }
      });
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [chartRefs, chartEpoch]);

  return visibleCandles;
}