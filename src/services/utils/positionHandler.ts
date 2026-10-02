import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { Direction } from "./gapsHandler";
import { GapRectanglePrimitive } from "./primitives";

// No new positions are opened at or after this hour, in the strategy's
// reference timezone. The hour is read from the candle's timestamp,
// not from the browser's clock, so the rule holds no matter where the
// code runs.
const NO_OPEN_AFTER_HOUR = 18;

export interface Operation {
    currentlyOpen: boolean;
    completed: boolean;
    entryLevel: EntryLevel | undefined;
    direction: Direction;
    tpRect?: GapRectanglePrimitive;
    slRect?: GapRectanglePrimitive;
    // ── Fields captured for the operation record ──
    /** Timestamp of the bar at which the position was opened. */
    entryTime?: number;
    /** Which fib line triggered the entry. */
    entryLineName?: "blue" | "orange";
    /** Entry price, copied from entryLevel.price at open time. */
    openPrice?: number;
}

export interface EntryLevel {
    price: number
    lineName: "blue" | "orange" | undefined
}

/**
 * Return shape for handleOperation when a position closes.
 * `outcome` distinguishes a TP hit from an SL hit; `exitPrice` is
 * the level that was touched.
 */
export interface OperationClose {
    outcome: "tp" | "sl";
    exitPrice: number;
}

export function openPosition(
    currentCandle: Candle,
    currentOperation: Operation,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
): void {
    if (
        currentOperation.entryLevel?.price === undefined ||
        currentOperation.direction === undefined
    ) return;

    // ── Time cutoff ────────────────────────────────────────
    const date = new Date(currentCandle.time * 1000)
    const iso = new Date(date).toISOString();       // "2026-09-26T15:30:00.000Z"
    const time = iso.slice(11, 19);                  // "15:30:00"
    const hour = parseInt(time.split(':')[0]!, 10);

    if (hour >= NO_OPEN_AFTER_HOUR) return

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

    // ── Capture metadata for the record ──
    // Save the entry line name BEFORE it's cleared below, so the emitted
    // record can say whether this position came from a blue or orange touch.
    currentOperation.entryLineName = currentOperation.entryLevel.lineName;
    currentOperation.openPrice = entry;
    currentOperation.entryTime = currentCandle.time as number;

    currentOperation.entryLevel.lineName = undefined;
}

export function handleOperation(
    currentCandle: Candle,
    currentOperation: Operation,
): OperationClose | null {
    if (!currentOperation.tpRect || !currentOperation.slRect) return null;

    const t = currentCandle.time as Time;
    currentOperation.tpRect.setEndTime(t);
    currentOperation.slRect.setEndTime(t);

    const entry = currentOperation.entryLevel?.price;
    if (entry === undefined) return null;

    const isLong = currentOperation.direction === "bullish";
    const tp = isLong ? entry * 1.01 : entry * 0.99;
    const sl = isLong ? entry * 0.99 : entry * 1.01;
    const hitTp = isLong ? currentCandle.high >= tp : currentCandle.low <= tp;
    const hitSl = isLong ? currentCandle.low <= sl : currentCandle.high >= sl;

    if (hitTp || hitSl) {
        currentOperation.currentlyOpen = false;
        currentOperation.completed = true;
        return {
            outcome: hitTp ? "tp" : "sl",
            exitPrice: hitTp ? tp : sl,
        };
    }
    return null;
}