import { ISeriesApi, ISeriesPrimitive, Time } from "lightweight-charts";
import { Candle } from "../schemas";
import { Direction } from "./gapsHandler";
import { GapRectanglePrimitive } from "./primitives";
import { Fibonacci } from "./strategy";
import { LabelPrimitive } from "./primitives/label";

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
    fib: Fibonacci,
    emaValue: number | null,
    candleSeries: ISeriesApi<"Candlestick">,
    primitives: ISeriesPrimitive<Time>[],
): void {
    if (
        currentOperation.currentlyOpen ||
        currentOperation.entryLevel?.price === undefined ||
        currentOperation.direction === undefined
    ) return;

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

    // ── Debug label ─────────────────────────────────────────
    // Snapshot of every variable that contributed to this entry.
    const whichLine =
        Math.abs(entry - fib.blueLevel) < Math.abs(entry - fib.orangeLevel) ? "blue" : "orange";
    const fmt = (n: number | null | undefined, p = 2) =>
        n === null || n === undefined ? "—" : n.toFixed(p);

    const label = new LabelPrimitive(
        t,
        entry,
        [
            `${isLong ? "LONG" : "SHORT"} @ ${fmt(entry)}`,
            `line: ${whichLine}`,
            `ema: ${fmt(emaValue)}`,
            `blue: ${fmt(fib.blueLevel)}`,
            `orange: ${fmt(fib.orangeLevel)}`,
            `H/L: ${fmt(currentCandle.high)} / ${fmt(currentCandle.low)}`,
            `gap dir: ${fib.direction}`,
        ],
        "rgba(15, 20, 30, 0.92)",
        "#e5e7eb",
        "#64748b",
        isLong ? "right" : "left",
    );
    // candleSeries.attachPrimitive(label);
    // primitives.push(label);

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
            openPosition(currentCandle, currentOperation, fib, emaValue, candleSeries, primitives);
        }
    }
}