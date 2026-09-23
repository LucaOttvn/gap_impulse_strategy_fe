import { ISeriesApi, Time, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { createPlotLine, PlotLineHandle } from "./plotLine";
import { Direction, Gap, handleGap } from "./gapsHandler";
import { createEMAHandler } from "./EMAHandler";
import { dayKey } from "./dayStarts";
import { handleOperation, Operation } from "./positionHandler";
import { LabelPrimitive } from "./primitives/label";

// The first N minutes of the trading day are ignored for gap detection.
export const OPENING_WINDOW_SEC = 15 * 60;
export const MIN_GAP_SIZE = 0

// ── Public options ────────────────────────────────────────
// Everything configurable about the strategy lives here. Callers pass
// a partial object; anything omitted falls back to the defaults below.
export interface GapsImpulseStrategyOptions {
    /** EMA period. Default 21. */
    emaPeriod?: number;
}
export interface Fibonacci {
    orangeLine: PlotLineHandle;
    blueLine: PlotLineHandle;
    direction: Direction;
    orangeLevel: number
    blueLevel: number
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
    const emaLine = createPlotLine(candleSeries, { color: "#a855f7", mode: "line" })
    const computeEma = createEMAHandler(emaPeriod);
    let currentOperation: Operation | undefined

    // Running extremes for the current day. Seeded on the first candle
    // of each day, then updated as new extremes are made. We use
    // -Infinity / Infinity (rather than 0) so the very first candle
    // always sets them, regardless of price scale.
    let runningHigh = -Infinity;
    let runningLow = Infinity;
    let currentDayStart: {
        time: number
        dateKey: string
    } | null = null;

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
    let activeFib: Fibonacci | null = null;

    // Flush every open handle at the end of a day (or the series).
    // `finish()` is what actually attaches the accumulated segment to
    // the series — until it runs, the points are held in memory and
    // nothing is drawn.
    const finishDay = () => {
        primitives.push(...dayHighLine.finish());
        primitives.push(...dayLowLine.finish());
        if (activeFib) {
            primitives.push(...activeFib.orangeLine.finish());
            primitives.push(...activeFib.blueLine.finish());
        }
    };

    // ── Main loop ───────────────────────────────────────────
    for (let i = 0; i < candles.length; i += 1) {
        const first = candles[i];
        const third = candles[i + 2];

        if (!first || !third) continue;

        const todayKey = dayKey(first.time, "America/New_York");

        // currentDayStart === null => detect first candle ever
        // todayKey !== currentDayStart.dateKey => detect day change
        if (currentDayStart === null || todayKey !== currentDayStart.dateKey) {
            // Close out yesterday's lines, if any.
            if (currentDayStart !== null) finishDay();
            currentDayStart = {
                time: first.time,
                dateKey: todayKey
            };

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
            currentOperation = undefined
        } else {
            // Not a new day: extend the running extremes if this candle
            // broke them. This is what makes the day-high/low lines
            // "step" upward/downward as the session progresses.
            if (first.high > runningHigh) runningHigh = first.high;
            if (first.low < runningLow) runningLow = first.low;
        }

        // ── EMA update ──────────────────────────────────────
        const currentEMA = computeEma(first);
        if (currentEMA.newDay) {
            // Flush the previous day's segment so the line stops there.
            // `null` is `na` in createPlotLine's API.
            emaLine.add(first.time, null);
        }
        emaLine.add(first.time, currentEMA.value);

        // ── Gap detection ───────────────────────────────────
        let newGap: Gap | null = handleGap(first, third, currentDayStart.time, candleSeries, primitives, runningHigh, runningLow, MIN_GAP_SIZE);

        // Handle first gap of the day
        if (newGap && !activeFib) {
            activeFib = {
                orangeLine: createPlotLine(candleSeries, { color: "#f59e0b", mode: "step" }),
                blueLine: createPlotLine(candleSeries, { color: "#22d3ee", mode: "step" }),
                direction: newGap?.direction ?? "bullish",
                orangeLevel: 0,
                blueLevel: 0
            };
        }

        dayHighLine.add(first.time, runningHigh);
        dayLowLine.add(first.time, runningLow);

        // --- OPERATION SECTION ---
        if (activeFib === null) continue;

        const height = runningHigh - runningLow;

        if (activeFib.direction === "bullish") {
            activeFib.orangeLevel = runningLow + height * 0.618;
            activeFib.blueLevel = runningLow + height * 0.786;
        } else if (activeFib.direction === "bearish") {
            activeFib.orangeLevel = runningHigh - height * 0.618;
            activeFib.blueLevel = runningHigh - height * 0.786;
        }

        activeFib.orangeLine.add(third.time, activeFib.orangeLevel);
        activeFib.blueLine.add(third.time, activeFib.blueLevel);

        // ── Entry trigger ───────────────────────────────────────
        // If an operation hasn't been defined yet, start to set it
        if (currentOperation === undefined) {
            if (activeFib.direction === "bullish") {
                // Detect blue line touch
                if (third.low <= activeFib.blueLevel) {

                    // const label = new LabelPrimitive(
                    //     third.time as Time,
                    //     third.high,
                    //     [
                    //         `Blue level touched`,
                    //         new Date(third.time * 1000).toISOString(),
                    //     ],
                    //     "rgba(15, 20, 30, 0.92)",
                    //     "#e5e7eb",
                    //     "#64748b",
                    // );
                    // candleSeries.attachPrimitive(label);
                    // primitives.push(label);
                    if (currentEMA !== null && currentEMA.value > activeFib.blueLevel) {
                        // Immediate blue entry.
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: {
                                price: activeFib.blueLevel,
                                lineName: "blue"
                            },
                            direction: "bullish"
                        }
                    } else {
                        // Wait for orange.
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: {
                                price: activeFib.orangeLevel,
                                lineName: "orange"
                            },
                            direction: "bullish"
                        }
                        continue
                    }
                }
            } else if (activeFib.direction === "bearish") { }
        }

        if (currentOperation) {
            handleOperation(third, currentOperation, activeFib, currentEMA.value, candleSeries, primitives);
        }

        // Hand off whenever we're pending or open.
        // if (currentOperation.entryPrice !== undefined || currentOperation.pendingLine) {
        //     handleOperation(third, currentOperation, activeFib, currentEMA, candleSeries, primitives);
        //     continue;
        // }
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