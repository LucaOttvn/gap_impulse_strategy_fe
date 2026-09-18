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
// One entry per calendar day (in the target timezone), holding
// the running high/low as step points so the rendered line
// mimics the Pine `var` pattern: flat until a new extreme is
// made, then a step to the new level.
export interface DayLevelPoints {
    startTime: number;
    endTime: number;
    highPoints: { time: number; value: number }[];
    lowPoints: { time: number; value: number }[];
}

function computeDayLevelPoints(
    candles: Candle[],
    timeZone: string,
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

        // Extend the line to the end of the day with the final running
        // value, so the level visually persists until the last bar.
        const lastHigh = highPoints[highPoints.length - 1]!;
        if (lastHigh.time !== endTime) {
            highPoints.push({ time: endTime, value: lastHigh.value });
        }

        const lastLow = lowPoints[lowPoints.length - 1]!;
        if (lastLow.time !== endTime) {
            lowPoints.push({ time: endTime, value: lastLow.value });
        }

        out.push({ startTime, endTime, highPoints, lowPoints });
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
                // Step: hold old level until this bar, then jump up.
                highPoints.push({ time: c.time, value: high });
                high = c.high;
                highPoints.push({ time: c.time, value: high });
            }
            if (c.low < low) {
                // Step: hold old level until this bar, then jump down.
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
    options?: {
        timeZone?: string;
        highColor?: string;
        lowColor?: string;
        lineWidth?: number;
        lineStyle?: "solid" | "dashed" | "dotted";
    },
): ISeriesPrimitive<Time>[] {
    const timeZone = options?.timeZone ?? "America/New_York";
    const highColor = options?.highColor ?? "#ffffff";
    const lowColor = options?.lowColor ?? "#ffffff";
    const lineWidth = options?.lineWidth ?? 2;
    const lineStyle = options?.lineStyle ?? "solid";

    const days = computeDayLevelPoints(candles, timeZone);
    const primitives: ISeriesPrimitive<Time>[] = [];

    for (const day of days) {
        // A single point can't form a line, so skip days with < 2 samples.
        // (Can only happen if a day has exactly one candle and no new
        // extreme is set — practically impossible but safe to guard.)
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