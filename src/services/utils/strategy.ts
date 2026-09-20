import { ISeriesApi, Time, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { createPlotLine } from "./plotLine";
import { handleGap } from "./gapsHandler";

// The first N minutes of the trading day are ignored for gap detection.
export const OPENING_WINDOW_SEC = 15 * 60;

// ── Public options ────────────────────────────────────────
// Everything configurable about the strategy lives here. Callers pass
// a partial object; anything omitted falls back to the defaults below.
export interface GapsImpulseStrategyOptions {
    /** EMA period. Default 21. */
    emaPeriod?: number;
}

/**
 * Returns every primitive that was attached to the series so the
 * caller can later detach them (e.g. when reloading data or switching
 * symbols). Primitives are never garbage-collected automatically —
 * if you forget to detach, they'll keep drawing on the old series.
 */
export function drawGapsImpulseStrategy(
    candleSeries: ISeriesApi<"Candlestick">,
    candles: Candle[],
    options?: GapsImpulseStrategyOptions,
): ISeriesPrimitive<Time>[] {

    const primitives: ISeriesPrimitive<Time>[] = [];
    const emaPeriod = options?.emaPeriod ?? 21;

    let dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
    let dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });

    // Running extremes for the current day. Seeded on the first candle
    // of each day, then updated as new extremes are made. We use
    // -Infinity / Infinity (rather than 0) so the very first candle
    // always sets them, regardless of price scale.
    let runningHigh = -Infinity;
    let runningLow = Infinity;
    let currentDayStart: number | null = null;

    // ── Fibonacci lines (one direction per day) ─────────────
    // The first valid gap of the day decides the direction
    //
    // Once a direction is locked in, later gaps of either kind still
    // produce rectangles but do NOT switch or add fib lines — the
    // "first gap wins" rule. The lock resets at each day boundary.
    //
    // The handles start as `null` because they must only exist once
    // a gap has been detected. Before that, no fib line should be
    // drawn at all.
    type FibDirection = "bullish" | "bearish";
    let activeFib: FibDirection | null = null;
    let fib618: ReturnType<typeof createPlotLine> | null = null;
    let fib786: ReturnType<typeof createPlotLine> | null = null;

    // ── EMA state ───────────────────────────────────────────
    // `EMA_K` is the smoothing constant: 2 / (period + 1).
    const EMA_K = 2 / (emaPeriod + 1);
    const emaLine = createPlotLine(candleSeries, { color: "#a855f7", mode: "line" })
    let emaValue: number | null = null; // null until the seed is ready
    let emaSeedSum = 0;
    let emaSeedCount = 0;

    // Flush every open handle at the end of a day (or the series).
    // `finish()` is what actually attaches the accumulated segment to
    // the series — until it runs, the points are held in memory and
    // nothing is drawn.
    const finishDay = () => {
        primitives.push(...dayHighLine.finish());
        primitives.push(...dayLowLine.finish());
        if (fib618) primitives.push(...fib618.finish());
        if (fib786) primitives.push(...fib786.finish());
    };

    // ── Main loop ───────────────────────────────────────────
    for (let i = 0; i < candles.length; i += 1) {
        const first = candles[i];
        const third = candles[i + 2];

        if (!first) continue;

        const today = new Date(first.time).getDay();

        // Detect day change
        if (today !== currentDayStart) {
            // Close out yesterday's lines, if any.
            if (currentDayStart !== null) finishDay();
            currentDayStart = today

            // Fresh handles for the new day. The old ones have already
            // been `finish()`ed, so they're now inert and can be dropped.
            dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
            dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });

            // Seed the running extremes with this candle. Without this,
            // the first candle would compare its high/low against the
            // previous day's running values, which is wrong.
            runningHigh = first.high;
            runningLow = first.low;

            // Reset the fib lock. Whichever gap we detect next — bullish
            // or bearish — will claim the direction for the whole day.
            activeFib = null;
            fib618 = null;
            fib786 = null;
        } else {
            // Not a new day: extend the running extremes if this candle
            // broke them. This is what makes the day-high/low lines
            // "step" upward/downward as the session progresses.
            if (first.high > runningHigh) runningHigh = first.high;
            if (first.low < runningLow) runningLow = first.low;
        }

        // ── EMA update ──────────────────────────────────────
        if (emaLine) {
            if (emaValue === null) {
                // Warm-up phase: accumulate closes until we have enough
                // for the initial SMA. No point is emitted during this
                // phase, so the line simply starts on bar `emaPeriod`.
                emaSeedSum += first.close;
                emaSeedCount += 1;
                if (emaSeedCount === emaPeriod) {
                    emaValue = emaSeedSum / emaPeriod;
                    emaLine.add(first.time, emaValue);
                }
            } else {
                // Steady state: standard exponential smoothing.
                emaValue = first.close * EMA_K + emaValue * (1 - EMA_K);
                emaLine.add(first.time, emaValue);
            }
        }

        // ── Gap detection ───────────────────────────────────

        if (third) handleGap(first, third, currentDayStart, candleSeries, primitives, activeFib, fib618, fib786);


        // ── Feed every plot ─────────────────────────────────
        // Even on candles where nothing interesting happened, every
        // open plot needs a data point. `mode: "step"` will detect
        // whether the value changed and emit a hold-then-jump pair
        // automatically — we don't need to special-case it here.
        const height = runningHigh - runningLow;

        dayHighLine.add(first.time, runningHigh);
        dayLowLine.add(first.time, runningLow);

        // Fib lines only exist after a gap has activated them. Before
        // that, `activeFib` is null and both handles are null, so this
        // block silently does nothing.
        //
        // Note the fib levels are re-derived every candle from the
        // *current* running extremes, not frozen at gap-detection time.
        // This means they keep sliding as the day's high/low expand,
        // which matches Pine's behavior when `dayHigh`/`dayLow` are
        // declared with `var` and updated across the session.
        if (activeFib === "bullish" && fib618 && fib786) {
            fib618.add(first.time, runningLow + height * 0.618);
            fib786.add(first.time, runningLow + height * 0.786);
        } else if (activeFib === "bearish" && fib618 && fib786) {
            fib618.add(first.time, runningHigh - height * 0.618);
            fib786.add(first.time, runningHigh - height * 0.786);
        }
    }

    // Flush whatever was still open on the final day. Without this,
    // the last day's lines would never be attached to the series.
    if (currentDayStart !== null) finishDay();

    // The EMA spans the entire series, so it gets exactly one
    // `finish()` here — never inside the day-boundary block. If it
    // were flushed per-day, we'd get N disconnected EMA segments
    // instead of one smooth line across the whole dataset.
    if (emaLine) primitives.push(...emaLine.finish());

    return primitives;
}

