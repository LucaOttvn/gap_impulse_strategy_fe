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

// ── Detection ──────────────────────────────────────────────
// Scans every group of 3 candles [i, i+1, i+2].
// Compares candle i (first) with candle i+2 (third).
//   bullish: high[first] < low[third]
//   bearish: low[first]  > high[third]
//
// A gap is rejected when its third candle is still inside the opening
// window (first N minutes of the day in the target timezone). Because
// candles are time-ordered, if the third is inside the window then so
// are the first two — one check covers all three.
const OPENING_WINDOW_SEC = 15 * 60;

// ── Public entry point: gap rectangles ─────────────────────
// Attaches one rectangle primitive per detected gap.
// Returns the primitives so the caller can detach them on cleanup.
export function drawGapsImpulseStrategy(
    candleSeries: ISeriesApi<"Candlestick">,
    candles: Candle[],
): ISeriesPrimitive<Time>[] {
    const tz = "America/New_York";
    const dayStartTimes = computeDayStartTimes(candles, tz);
    const primitives: ISeriesPrimitive<Time>[] = [];

    // ── Running day-high line state ─────────────────────────
    // One plot handle per day. On a day change we finish the current
    // handle and start a fresh one, so the line breaks cleanly rather
    // than dropping vertically from yesterday's high to today's.
    let dayHighLine = createPlotLine(candleSeries, {
        color: "#ffffff",
        mode: "step",
    });
    let runningHigh = -Infinity;
    let currentDayStart = -1;

    // ── Running day-low line state ──────────────────────────
    // Mirrors the high line: reset per day, step mode, its own handle.
    let dayLowLine = createPlotLine(candleSeries, {
        color: "#ffffff",
        mode: "step",
    });
    let runningLow = Infinity;

    for (let i = 0; i < candles.length; i += 1) {
        const first = candles[i];
        if (!first) continue;

        // ── Day boundary ────────────────────────────────────
        const dayStart = dayStartTimes[i]!;

        if (dayStart !== currentDayStart) {
            // Close yesterday's lines and start today's.
            if (currentDayStart !== -1) {
                primitives.push(...dayHighLine.finish());
                primitives.push(...dayLowLine.finish());
            }

            currentDayStart = dayStart;

            dayHighLine = createPlotLine(candleSeries, {
                color: "#ffffff",
                mode: "step",
            });
            runningHigh = first.high;

            dayLowLine = createPlotLine(candleSeries, {
                color: "#ffffff",
                mode: "step",
            });
            runningLow = first.low;
        } else {
            if (first.high > runningHigh) runningHigh = first.high;
            if (first.low < runningLow) runningLow = first.low;
        }

        // `mode: "step"` emits the hold-then-jump pair automatically
        // when the running value changes, so we always add one point here.
        dayHighLine.add(first.time, runningHigh);
        dayLowLine.add(first.time, runningLow);

        // ── Gap detection (needs i+2) ────────────────────────
        const third = candles[i + 2];
        if (!third) continue;

        if (third.time < dayStartTimes[i + 2]! + OPENING_WINDOW_SEC) continue;

        if (first.high < third.low) {
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
        } else if (first.low > third.high) {
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
        }
    }

    // Flush whatever day was still open.
    if (currentDayStart !== -1) {
        primitives.push(...dayHighLine.finish());
        primitives.push(...dayLowLine.finish());
    }

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
        isBull ? "rgba(40, 62, 255, 0.8)" : "rgba(253, 218, 62, 0.7)", // fill
        "transparent", // border
    );
    candleSeries.attachPrimitive(primitive);
    primitives.push(primitive);
}