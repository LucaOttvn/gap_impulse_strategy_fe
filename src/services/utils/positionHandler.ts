import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { Direction } from "./gapsHandler";
import { GapRectanglePrimitive } from "./primitives";
import { Fibonacci } from "./strategy";

// No new positions are opened at or after this hour, in the strategy's
// reference timezone. The hour is read from the candle's timestamp,
// not from the browser's clock, so the rule holds no matter where the
// code runs.
const NO_OPEN_AFTER_HOUR = 18;
const TZ = "America/New_York";

// Cached formatters — Intl.DateTimeFormat construction is expensive,
// so we build one per timezone and reuse it across candles.
const hourFormatterCache = new Map<string, Intl.DateTimeFormat>();
export function hourInZone(unixSeconds: number, tz: string): number {
    let f = hourFormatterCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "2-digit",
            hourCycle: "h23",
        });
        hourFormatterCache.set(tz, f);
    }
    return parseInt(f.format(new Date(unixSeconds * 1000)), 10);
}

export interface Operation {
    currentlyOpen: boolean;
    entryLevel: EntryLevel | undefined;
    direction: Direction;
    tpRect?: GapRectanglePrimitive;
    slRect?: GapRectanglePrimitive;
}

export interface EntryLevel {
    price: number
    lineName: "blue" | "orange" | undefined
}

function openPosition(
    currentCandle: Candle,
    currentOperation: Operation,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
): void {
    if (
        currentOperation.currentlyOpen ||
        currentOperation.entryLevel?.price === undefined ||
        currentOperation.direction === undefined
    ) return;

    // ── Time cutoff ────────────────────────────────────────
    // Refuse to open any position at or after NO_OPEN_AFTER_HOUR.
    // This covers both the immediate path and the pending path,
    // since both ultimately land here.
    if (hourInZone(currentCandle.time, TZ) >= NO_OPEN_AFTER_HOUR) return;

    const entry = currentOperation.entryLevel.price;
    const isLong = currentOperation.direction === "bullish";
    const tp = isLong ? entry * 1.01 : entry * 0.99;
    const sl = isLong ? entry * 0.99 : entry * 1.01;
    const t = currentCandle.time as Time;

    const tpRect = new GapRectanglePrimitive(t, t, tp, entry, "rgba(34, 197, 94, 0.35)", "transparent");
    const slRect = new GapRectanglePrimitive(t, t, entry, sl, "rgba(239, 68, 68, 0.35)", "transparent");

    candleSeries.attachPrimitive(tpRect);
    candleSeries.attachPrimitive(slRect);
    primitives.push(tpRect, slRect);

    currentOperation.tpRect = tpRect;
    currentOperation.slRect = slRect;
    currentOperation.currentlyOpen = true;
    currentOperation.entryLevel.lineName = undefined;
}

export function handleOperation(
    currentCandle: Candle,
    currentOperation: Operation,
    fib: Fibonacci,
    emaValue: number | null,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
): void {
    // ── Already open: extend + check TP/SL ──────────────────
    if (currentOperation.currentlyOpen && currentOperation.tpRect && currentOperation.slRect) {
        const t = currentCandle.time as Time;
        currentOperation.tpRect.setEndTime(t);
        currentOperation.slRect.setEndTime(t);

        const entry = currentOperation.entryLevel?.price!;
        const isLong = currentOperation.direction === "bullish";
        const tp = isLong ? entry * 1.01 : entry * 0.99;
        const sl = isLong ? entry * 0.99 : entry * 1.01;
        const hitTp = isLong ? currentCandle.high >= tp : currentCandle.low <= tp;
        const hitSl = isLong ? currentCandle.low <= sl : currentCandle.high >= sl;

        if (hitTp || hitSl) {
            currentOperation.currentlyOpen = false;
        }
        return;
    }

    // ── Pending: waiting for price to touch the target line ─
    if (currentOperation.entryLevel?.lineName && currentOperation.direction) {
        const isLong = currentOperation.direction === "bullish";
        const target =
            currentOperation.entryLevel?.lineName === "orange" ? fib.orangeLevel : fib.blueLevel;

        const touched = isLong ? currentCandle.low <= target : currentCandle.high >= target;

        if (touched) {
            currentOperation.entryLevel.price = target;
            openPosition(currentCandle, currentOperation, candleSeries, primitives);
        }
    }
}