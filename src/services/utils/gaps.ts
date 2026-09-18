import { ISeriesApi, Time, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { computeDayStartTimes } from "./dayStarts";
import { GapRectanglePrimitive } from "./primitives";
import { createPlotLine } from "./plotLine";

// ── Gap model ──────────────────────────────────────────────
interface Gap {
    startTime: number; // unix seconds
    endTime: number;
    topPrice: number;
    bottomPrice: number;
    direction: "bullish" | "bearish";
}

const OPENING_WINDOW_SEC = 15 * 60;

export function drawGapsImpulseStrategy(
    candleSeries: ISeriesApi<"Candlestick">,
    candles: Candle[],
): ISeriesPrimitive<Time>[] {
    const tz = "America/New_York";
    const dayStartTimes = computeDayStartTimes(candles, tz);
    const primitives: ISeriesPrimitive<Time>[] = [];

    // ── Day high/low lines (always drawn) ───────────────────
    let dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
    let dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
    let runningHigh = -Infinity;
    let runningLow = Infinity;
    let currentDayStart = -1;

    // ── Fibonacci lines (one direction per day) ─────────────
    // The first gap of the day decides the direction; once set, no
    // other fib direction can be activated until the day rolls over.
    type FibDirection = "bullish" | "bearish";
    let activeFib: FibDirection | null = null;
    let fib618: ReturnType<typeof createPlotLine> | null = null;
    let fib786: ReturnType<typeof createPlotLine> | null = null;

    const finishDay = () => {
        primitives.push(...dayHighLine.finish());
        primitives.push(...dayLowLine.finish());
        if (fib618) primitives.push(...fib618.finish());
        if (fib786) primitives.push(...fib786.finish());
    };

    for (let i = 0; i < candles.length; i += 1) {
        const first = candles[i];
        if (!first) continue;

        const dayStart = dayStartTimes[i]!;

        // ── Day boundary ────────────────────────────────────
        if (dayStart !== currentDayStart) {
            if (currentDayStart !== -1) finishDay();
            currentDayStart = dayStart;

            // Recreate day-extreme lines.
            dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
            dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
            runningHigh = first.high;
            runningLow = first.low;

            // Reset the fib state — nothing active yet.
            activeFib = null;
            fib618 = null;
            fib786 = null;
        } else {
            if (first.high > runningHigh) runningHigh = first.high;
            if (first.low < runningLow) runningLow = first.low;
        }

        // ── Gap detection ───────────────────────────────────
        const third = candles[i + 2];
        const pastOpeningWindow =
            third && third.time >= dayStartTimes[i + 2]! + OPENING_WINDOW_SEC;

        if (third && pastOpeningWindow) {
            const isBullishGap = first.high < third.low;
            const isBearishGap = first.low > third.high;

            if (isBullishGap) {
                // Always draw the gap rectangle.
                drawGap(
                    {
                        startTime: first.time,
                        endTime: third.time,
                        topPrice: third.low,
                        bottomPrice: first.high,
                        direction: "bullish",
                    },
                    candleSeries,
                    primitives,
                );

                // Activate bullish fibs if nothing is active yet.
                if (!activeFib) {
                    activeFib = "bullish";
                    fib618 = createPlotLine(candleSeries, { color: "#f59e0b", mode: "step" });
                    fib786 = createPlotLine(candleSeries, { color: "#22d3ee", mode: "step" });
                }
            } else if (isBearishGap) {
                drawGap(
                    {
                        startTime: first.time,
                        endTime: third.time,
                        topPrice: first.low,
                        bottomPrice: third.high,
                        direction: "bearish",
                    },
                    candleSeries,
                    primitives,
                );

                if (!activeFib) {
                    activeFib = "bearish";
                    fib618 = createPlotLine(candleSeries, { color: "#f59e0b", mode: "step" });
                    fib786 = createPlotLine(candleSeries, { color: "#22d3ee", mode: "step" });
                }
            }
        }

        // ── Feed every plot ─────────────────────────────────
        const height = runningHigh - runningLow;

        dayHighLine.add(first.time, runningHigh);
        dayLowLine.add(first.time, runningLow);

        if (activeFib === "bullish" && fib618 && fib786) {
            fib618.add(first.time, runningLow + height * 0.618);
            fib786.add(first.time, runningLow + height * 0.786);
        } else if (activeFib === "bearish" && fib618 && fib786) {
            fib618.add(first.time, runningHigh - height * 0.618);
            fib786.add(first.time, runningHigh - height * 0.786);
        }
    }

    // Flush the last day.
    if (currentDayStart !== -1) finishDay();

    return primitives;
}

function drawGap(
    gap: Gap,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
) {
    const isBull = gap.direction === "bullish";

    const primitive = new GapRectanglePrimitive(
        gap.startTime as Time,
        gap.endTime as Time,
        gap.topPrice,
        gap.bottomPrice,
        isBull ? "rgba(40, 62, 255, 0.8)" : "rgba(253, 218, 62, 0.7)",
        "transparent",
    );
    candleSeries.attachPrimitive(primitive);
    primitives.push(primitive);
}