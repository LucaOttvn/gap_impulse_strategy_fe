import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChartRefs } from "./useChartInstance";
import { StrategyCandle } from "@/services/utils/01_interfaces";

interface Args {
  chartRefs: ChartRefs;
  /** Every loaded candle, oldest → newest. */
  allCandles: StrategyCandle[];
  /** Bumps when the chart is recreated — resets the window. */
  chartEpoch: number;
  /** Called when the user has scrolled past the oldest loaded bar. */
  onNeedOlder?: () => void;
  /** False once the cache has no more history. */
  canLoadOlder?: boolean;
  /** True while a page fetch is in flight — gates further onNeedOlder calls. */
  isFetchingOlder?: boolean;
}

const WINDOW_SIZE = 10_000;   // max bars the chart ever renders
const LOW_WATER = 2_000;      // distance from an edge before we slide
const SLIDE_BARS = 3_000;     // how far the window shifts per slide

/**
 * Bounds the number of candles the chart actually renders.
 *
 * `rightOffset` is anchored to the NEWEST end of `allCandles`. Slice =
 * allCandles[len - rightOffset - WINDOW_SIZE .. len - rightOffset].
 *
 * Because the anchor is the newest end, prepending older bars does NOT
 * require adjusting rightOffset — the slice still contains the same bars.
 * (The previous version bumped rightOffset by the prepend amount, which
 * shifted the slice one full page past the user's viewport on every fetch.)
 */
export function useSlidingCandles(args: Args): StrategyCandle[] {
  const {
    chartRefs, allCandles, chartEpoch,
    onNeedOlder, canLoadOlder = false, isFetchingOlder = false,
  } = args;

  const [rightOffset, setRightOffset] = useState(0);
  const rightOffsetRef = useRef(rightOffset);
  rightOffsetRef.current = rightOffset;

  const allCandlesRef = useRef(allCandles);
  allCandlesRef.current = allCandles;

  const onNeedOlderRef = useRef(onNeedOlder);
  onNeedOlderRef.current = onNeedOlder;
  const canLoadOlderRef = useRef(canLoadOlder);
  canLoadOlderRef.current = canLoadOlder;
  const isFetchingOlderRef = useRef(isFetchingOlder);
  isFetchingOlderRef.current = isFetchingOlder;

  // Reset the window on chart recreation (symbol / timeframe switch).
  useLayoutEffect(() => {
    setRightOffset(0);
  }, [chartEpoch]);

  const visibleCandles = useMemo(() => {
    if (allCandles.length === 0) return [];
    const end = Math.max(0, allCandles.length - rightOffset);
    const start = Math.max(0, end - WINDOW_SIZE);
    return allCandles.slice(start, end);
  }, [allCandles, rightOffset]);

  // Scroll handler — slides the window or fetches when it hits the edge.
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
          // Clamp the slide so the user's viewport stays inside the new
          // slice. Without this, the slide can push the slice past the
          // user's view, and the setVisibleRange restore in
          // useChartDataFlow fails — chart auto-fits (zoom out).
          const maxSlide = Math.max(0, WINDOW_SIZE - range.to - 1);
          const delta = Math.min(SLIDE_BARS, maxSlide);
          if (canSlideLeft && delta > 0) {
            setRightOffset((o) => Math.min(o + delta, Math.max(0, total - WINDOW_SIZE)));
          } else if (canLoadOlderRef.current && !isFetchingOlderRef.current) {
            onNeedOlderRef.current?.();
          }
        } else if (range.to > WINDOW_SIZE - LOW_WATER) {
          const maxSlide = Math.max(0, range.from);
          const delta = Math.min(SLIDE_BARS, maxSlide);
          if (canSlideRight && delta > 0) {
            setRightOffset((o) => Math.max(0, o - delta));
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