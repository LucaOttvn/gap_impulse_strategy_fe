import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { Direction } from "./gapsHandler";
import { GapRectanglePrimitive } from "./primitives";

// No new positions are opened at or after this hour, in the strategy's
// reference timezone. The hour is read from the candle's timestamp,
// not from the browser's clock, so the rule holds no matter where the
// code runs.
const NO_OPEN_AFTER_HOUR = 18;
const TZ = "Europe/Rome";

export interface Operation {
    currentlyOpen: boolean;
    completed: boolean;   // ← new
    entryLevel: EntryLevel | undefined;
    direction: Direction;
    tpRect?: GapRectanglePrimitive;
    slRect?: GapRectanglePrimitive;
}

export interface EntryLevel {
    price: number
    lineName: "blue" | "orange" | undefined
}

// "2026-09-26T15:30:00"

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
    currentOperation.entryLevel.lineName = undefined;

}

export function handleOperation(
    currentCandle: Candle,
    currentOperation: Operation
): void {
    if (!currentOperation.tpRect || !currentOperation.slRect) return

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
        currentOperation.completed = true;
    }
}