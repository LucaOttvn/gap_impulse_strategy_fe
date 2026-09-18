import {
    ISeriesApi,
    Time,
    ISeriesPrimitive,
} from "lightweight-charts";
import { StepLinePrimitive } from "./primitives/stepLine";

export interface PlotLineOptions {
    color?: string;
    lineWidth?: number;
    lineStyle?: "solid" | "dashed" | "dotted";
    /**
     * "line" — connect consecutive values directly (Pine's default plot).
     * "step" — hold the previous value until the new one, then jump
     *          (like a running high/low).
     */
    mode?: "line" | "step";
}

export interface PlotLineHandle {
    /**
     * Append one point. Call once per candle. Pass null/undefined/NaN
     * to produce `na` (breaks the line into a new segment).
     */
    add(time: number, value: number | null | undefined): void;

    /** Flush the pending segment and return attached primitives. */
    finish(): ISeriesPrimitive<Time>[];
}

/**
 * This method creates a plot line that can be updated incrementally. It returns an object with two methods:
 * - `add(time, value)`: Call this method for each candle to add a new point to the line. If the value is null, undefined, or NaN, it will break the line into a new segment.
 * - `finish()`: Call this method when you are done adding points. It will flush any pending segments and return an array of attached primitives.
 * @param series 
 * @param options 
 * @returns 
 */
export function createPlotLine(
    series: ISeriesApi<"Candlestick">,
    options?: PlotLineOptions,
): PlotLineHandle {
    const color = options?.color ?? "#ffffff";
    const lineWidth = options?.lineWidth ?? 2;
    const lineStyle = options?.lineStyle ?? "solid";
    const mode = options?.mode ?? "line";

    const primitives: ISeriesPrimitive<Time>[] = [];
    let segment: { time: Time; value: number }[] = [];
    let prevValue: number | null = null;

    const flush = () => {
        if (segment.length >= 2) {
            const p = new StepLinePrimitive(
                segment,
                color,
                lineWidth,
                lineStyle,
            );
            series.attachPrimitive(p);
            primitives.push(p);
        }
        segment = [];
    };

    return {
        add(time, value) {
            // na → break the line, reset step memory
            if (value === null || value === undefined || !Number.isFinite(value)) {
                flush();
                prevValue = null;
                return;
            }

            if (mode === "step" && prevValue !== null && prevValue !== value) {
                // Hold the old value up to this bar, then jump.
                segment.push({ time: time as Time, value: prevValue });
            }

            segment.push({ time: time as Time, value });
            prevValue = value;
        },
        finish() {
            flush();
            return primitives;
        },
    };
}