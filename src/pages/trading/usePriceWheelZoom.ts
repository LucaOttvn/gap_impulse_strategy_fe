// PURPOSE
// -------
// TradingView-style "scroll on the bars to stretch them vertically".
// lightweight-charts maps vertical wheel (deltaY) to TIME zoom by default —
// there is no option to map it to the price scale. This hook intercepts a
// plain vertical wheel over the main pane (capture phase, before the chart's
// own wheel handler) and re-maps it to a cursor-anchored price-scale zoom via
// the public priceScale().getVisibleRange()/setVisibleRange() API.
//
// WHAT EACH PIECE DOES
// --------------------
//   usePriceWheelZoom() – Attaches a non-passive capture-phase `wheel`
//                         listener on the chart container. A plain vertical
//                         wheel (no Ctrl/Meta/Shift, vertical dominates)
//                         over the main pane is consumed here and turned into
//                         a price-range zoom anchored at the cursor price.
//                         Everything else (pinch/Ctrl+wheel, horizontal
//                         scroll, wheel over the time axis) is left alone so
//                         the library's own time zoom/scroll keeps working.
//
// NOTE
// ----
//   The chart MUST keep handleScale.mouseWheel / handleScroll.mouseWheel
//   enabled: the interceptor only stopPropagation()s the gestures it owns,
//   and every other gesture still relies on the library handler. The hook
//   re-binds on `chartEpoch` so it never captures a destroyed chart instance.
// ═════════════════════════════════════════════════════════════════════════════

import {useEffect, type RefObject} from "react";
import type {IChartApi, ISeriesApi} from "lightweight-charts";

/** Pixels reserved for the time axis at the container bottom — wheel there stays time-zoom. */
const TIME_AXIS_RESERVE_PX = 28;
/** Zoom sensitivity: factor = exp(normDeltaY * SENSITIVITY), so one mouse notch (~100) ≈ 13 %. */
const WHEEL_SENSITIVITY = 0.0012;
/** Clamp a single wheel event so a rogue large delta can't collapse/explode the range. */
const MAX_NORM_DELTA = 200;

export function usePriceWheelZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  chartRef: RefObject<IChartApi | null>,
  candleSeriesRef: RefObject<ISeriesApi<"Candlestick"> | null>,
  chartEpoch: number,
): void {
  useEffect(() => {
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!container || !chart || !series) return;

    const onWheel = (e: WheelEvent) => {
      // Pinch-zoom (Ctrl/Meta+wheel) and Shift+wheel are time-zoom gestures —
      // let the library handle them.
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Horizontal intent (trackpad sideways / tilt wheel) is time scroll.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.deltaY === 0) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Outside the chart, or over the time axis → leave to the library.
      if (x < 0 || x > rect.width || y < 0 || y >= rect.height - TIME_AXIS_RESERVE_PX) return;

      const priceScale = chart.priceScale("right");
      const range = priceScale.getVisibleRange();
      if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
      const length = range.to - range.from;
      if (!(length > 0) || !Number.isFinite(length)) return;

      // Normalise line/page deltas to pixels so Firefox (lines) and trackpads agree.
      let normDelta = e.deltaY;
      if (e.deltaMode === 1) normDelta *= 32;
      else if (e.deltaMode === 2) normDelta *= Math.max(rect.height, 1);
      normDelta = Math.max(-MAX_NORM_DELTA, Math.min(MAX_NORM_DELTA, normDelta));
      if (normDelta === 0) return;

      // Anchor the zoom at the cursor price so the bar under the mouse stays put
      // (TradingView behaviour). Fall back to the range centre off-pane.
      const rawAnchor = series.coordinateToPrice(y);
      const anchor =
        typeof rawAnchor === "number" && Number.isFinite(rawAnchor) ? rawAnchor : (range.from + range.to) / 2;

      // Scroll up (deltaY < 0) → factor < 1 → range shrinks → bars grow taller.
      const factor = Math.exp(normDelta * WHEEL_SENSITIVITY);
      if (!Number.isFinite(factor) || factor <= 0) return;
      const newLength = length * factor;
      if (!(newLength > 0) || !Number.isFinite(newLength)) return;

      const ratio = (anchor - range.from) / length;
      const newFrom = anchor - ratio * newLength;
      const newTo = anchor + (1 - ratio) * newLength;
      if (!Number.isFinite(newFrom) || !Number.isFinite(newTo) || newFrom >= newTo) return;

      // setVisibleRange() also takes the scale out of autoScale — the first
      // wheel notch is what gives the user manual control, exactly like the
      // first price-axis drag does.
      priceScale.setVisibleRange({from: newFrom, to: newTo});

      // Consume before the chart's own (bubble-phase) wheel handler sees it,
      // otherwise the library would ALSO time-zoom on the same notch.
      e.preventDefault();
      e.stopPropagation();
    };

    // Capture phase is required: the library listens on its inner chart
    // element, so only an ancestor-capture listener can pre-empt it.
    // passive:false is required so preventDefault() actually stops page scroll.
    container.addEventListener("wheel", onWheel, {passive: false, capture: true});
    return () => {
      container.removeEventListener("wheel", onWheel, {capture: true} as EventListenerOptions);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chart/series/container live in refs; chartEpoch re-binds after every chart (re)create so the listener never captures a destroyed instance
  }, [chartEpoch]);
}
