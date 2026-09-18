import {
    CandlestickData,
    CandlestickSeriesOptions,
    CandlestickStyleOptions,
    DeepPartial,
    ISeriesApi,
    ISeriesPrimitive,
    SeriesOptionsCommon,
    Time,
    WhitespaceData,
} from "lightweight-charts";
import { Candle } from "../schemas";
import { dayKey } from "./dayStarts";
import { StepLinePrimitive } from "./primitives/stepLine";

// ── Day levels ─────────────────────────────────────────────
export interface DayLevelPoints {
    startTime: number;
    endTime: number;
    highPoints: { time: number; value: number }[];
    lowPoints: { time: number; value: number }[];
}

/** Given a fully-computed day, return the timestamp to stop drawing at. */
export type StopTimeResolver = (day: DayLevelPoints) => number | undefined;

export interface DayLevelsOptions {
    timeZone?: string;
    highColor?: string;
    lowColor?: string;
    lineWidth?: number;
    lineStyle?: "solid" | "dashed" | "dotted";
    /**
     * When to stop drawing the levels.
     *
     * - `undefined` (default): draw to the last candle of the day.
     * - `number`: a single timestamp applied to every day. It is clamped
     *   to `[day.startTime, day.endTime]`, so days entirely before the
     *   timestamp are unaffected and days entirely after it collapse to
     *   their first bar.
     * - `(day) => number | undefined`: per-day decision. Return
     *   `undefined` to fall back to the default (end of day).
     */
    stopTime?: number | StopTimeResolver;
}

/**
 * Truncate a step-point series at `stopAt` and append a carried-forward
 * point so the rendered line always ends exactly at `stopAt`.
 */
function truncateTo(
    points: { time: number; value: number }[],
    stopAt: number,
): { time: number; value: number }[] {
    if (points.length === 0) return points;

    const result: { time: number; value: number }[] = [];
    let lastValue = points[0]!.value;

    for (const p of points) {
        if (p.time > stopAt) break;
        result.push(p);
        lastValue = p.value;
    }

    if (result.length === 0) {
        // stopAt fell before the first point; emit a single carried value.
        result.push({ time: stopAt, value: lastValue });
    } else if (result[result.length - 1]!.time < stopAt) {
        // Extend flat from the last extreme to the stop time.
        result.push({ time: stopAt, value: lastValue });
    }

    return result;
}

function computeDayLevelPoints(
    candles: Candle[],
    timeZone: string,
    resolveStopTime?: StopTimeResolver,
): DayLevelPoints[] {
    if (candles.length === 0) return [];

    const out: DayLevelPoints[] = [];
    let key = "";
    let startTime = candles[0]!.time;
    let endTime = candles[0]!.time;
    let high = -Infinity;
    let low = Infinity;
    let highPoints: { time: number; value: number }[] = [];
    let lowPoints: { time: number; value: number }[] = [];

    const flush = () => {
        if (key === "") return;

        // Full, untruncated day — this is what the resolver sees, so it
        // can inspect the entire day's evolution before deciding.
        const day: DayLevelPoints = {
            startTime,
            endTime,
            highPoints,
            lowPoints,
        };

        const requested = resolveStopTime?.(day);
        const stopAt =
            requested === undefined
                ? endTime
                : Math.max(startTime, Math.min(endTime, requested));

        if (stopAt !== endTime) {
            day.endTime = stopAt;
            day.highPoints = truncateTo(highPoints, stopAt);
            day.lowPoints = truncateTo(lowPoints, stopAt);
        }

        out.push(day);
    };

    for (const c of candles) {
        const k = dayKey(c.time, timeZone);

        if (k !== key) {
            flush();

            key = k;
            startTime = c.time;
            endTime = c.time;
            high = c.high;
            low = c.low;
            highPoints = [{ time: c.time, value: high }];
            lowPoints = [{ time: c.time, value: low }];
        } else {
            endTime = c.time;

            if (c.high > high) {
                highPoints.push({ time: c.time, value: high });
                high = c.high;
                highPoints.push({ time: c.time, value: high });
            }
            if (c.low < low) {
                lowPoints.push({ time: c.time, value: low });
                low = c.low;
                lowPoints.push({ time: c.time, value: low });
            }
        }
    }

    flush();
    return out;
}

// ── Public entry point: day high / low step lines ──────────
export function drawDayLevels(
    candleSeries: ISeriesApi<
        "Candlestick",
        Time,
        CandlestickData<Time> | WhitespaceData<Time>,
        CandlestickSeriesOptions,
        DeepPartial<CandlestickStyleOptions & SeriesOptionsCommon>
    >,
    candles: Candle[],
    options?: DayLevelsOptions,
): ISeriesPrimitive<Time>[] {
    const timeZone = options?.timeZone ?? "America/New_York";
    const highColor = options?.highColor ?? "#ffffff";
    const lowColor = options?.lowColor ?? "#ffffff";
    const lineWidth = options?.lineWidth ?? 2;
    const lineStyle = options?.lineStyle ?? "solid";

    const stopOpt = options?.stopTime;
    const resolveStopTime: StopTimeResolver | undefined =
        typeof stopOpt === "function"
            ? stopOpt
            : typeof stopOpt === "number"
              ? () => stopOpt
              : undefined;

    const days = computeDayLevelPoints(candles, timeZone, resolveStopTime);
    const primitives: ISeriesPrimitive<Time>[] = [];

    for (const day of days) {
        if (day.highPoints.length >= 2) {
            const highPrimitive = new StepLinePrimitive(
                day.highPoints.map((p) => ({
                    time: p.time as Time,
                    value: p.value,
                })),
                highColor,
                lineWidth,
                lineStyle,
            );
            candleSeries.attachPrimitive(highPrimitive);
            primitives.push(highPrimitive);
        }

        if (day.lowPoints.length >= 2) {
            const lowPrimitive = new StepLinePrimitive(
                day.lowPoints.map((p) => ({
                    time: p.time as Time,
                    value: p.value,
                })),
                lowColor,
                lineWidth,
                lineStyle,
            );
            candleSeries.attachPrimitive(lowPrimitive);
            primitives.push(lowPrimitive);
        }
    }

    return primitives;
} 