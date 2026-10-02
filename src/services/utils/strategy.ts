import { ISeriesApi, Time, ISeriesPrimitive } from "lightweight-charts";
import { Candle } from "../schemas";
import { createPlotLine, PlotLineHandle } from "./plotLine";
import { Direction, Gap, handleGap } from "./gapsHandler";
import { createEMAHandler } from "./EMAHandler";
import { dayKey } from "./dayStarts";
import { handleOperation, openPosition, Operation } from "./positionHandler";

// The first N minutes of the trading day are ignored for gap detection.
export const OPENING_WINDOW_SEC = 15 * 60;

// ── Public options ────────────────────────────────────────
export interface GapsImpulseStrategyOptions {
    /** EMA period. Default 21. */
    emaPeriod?: number;
}

export interface Fibonacci {
    orangeLine: PlotLineHandle;
    blueLine: PlotLineHandle;
    direction: Direction;
    orangeLevel: number;
    blueLevel: number;
}

// ── Operation records ─────────────────────────────────────
// One record per position the strategy opens. Emitted when the position
// closes — either by hitting TP, hitting SL, or by being force-closed at
// the end of the trading day.

export type OperationOutcome = "tp" | "sl" | "dayEnd";

export interface OperationRecord {
    /** Unique id per record (uuid). */
    id: string;
    /** The NY trading day the position was opened on ("YYYY-MM-DD"). */
    dayKey: string;
    /** "bullish" = long, "bearish" = short. */
    direction: Direction;
    /** Which fib line triggered the entry. */
    entryLineName: "blue" | "orange";
    /** Price at which the position was opened. */
    entryPrice: number;
    /** Timestamp (seconds) of the bar at which the position was opened. */
    entryTime: number;
    /** Price at which the position was closed. */
    exitPrice: number;
    /** Timestamp (seconds) of the bar at which the position was closed. */
    exitTime: number;
    /** How the position closed. */
    outcome: OperationOutcome;
    /**
     * PnL as a percentage of entry price. Positive = profitable.
     *   +1 = +1% (TP hit on a long, or SL hit on a short)
     *   -1 = -1% (SL hit on a long, or TP hit on a short)
     *   anything else = dayEnd exit
     */
    pnlPct: number;
}

export interface StrategyResult {
    /** Every primitive attached to the series (fib lines, TP/SL rects, EMA). */
    primitives: ISeriesPrimitive<Time>[];
    /** One record for every operation the strategy opened and closed. */
    records: OperationRecord[];
}

/**
 * Returns every primitive that was attached to the series (so the caller
 * can detach them later) plus a list of records — one per closed operation.
 * The records are for stats (win rate, PnL), not for drawing.
 */
export function drawGapsImpulseStrategy(
    candleSeries: ISeriesApi<"Candlestick">,
    candles: Candle[],
    options?: GapsImpulseStrategyOptions,
): StrategyResult {

    const primitives: ISeriesPrimitive<Time>[] = [];
    const records: OperationRecord[] = [];
    const emaPeriod = options?.emaPeriod ?? 21;

    let dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
    let dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
    const emaLine = createPlotLine(candleSeries, { color: "#a855f7", mode: "line" })
    const computeEma = createEMAHandler(emaPeriod);
    let currentOperation: Operation | undefined

    // Running extremes for the current day.
    let runningHigh = -Infinity;
    let runningLow = Infinity;
    let currentDayStart: {
        time: number
        dateKey: string
    } | null = null;

    // Active fib for the day.
    let activeFib: Fibonacci | null = null;

    const finishDay = () => {
        primitives.push(...dayHighLine.finish());
        primitives.push(...dayLowLine.finish());
        if (activeFib) {
            primitives.push(...activeFib.orangeLine.finish());
            primitives.push(...activeFib.blueLine.finish());
        }
    };

    // ── Emit a record when an operation closes ──
    // Called from three places:
    //   1. handleOperation returns a TP/SL hit
    //   2. The day boundary is crossed while a position is still open
    //   3. The loop ends while a position is still open
    const emitRecord = (
        op: Operation,
        exitPrice: number,
        exitTime: number,
        outcome: OperationOutcome,
    ) => {
        if (
            op.openPrice === undefined ||
            op.entryTime === undefined ||
            op.entryLineName === undefined
        ) return;

        const entry = op.openPrice;
        // Long:  profit = (exit - entry) / entry
        // Short: profit = (entry - exit) / entry
        const pnlPct = op.direction === "bullish"
            ? ((exitPrice - entry) / entry) * 100
            : ((entry - exitPrice) / entry) * 100;

        records.push({
            id: crypto.randomUUID(),
            dayKey: currentDayStart?.dateKey ?? "",
            direction: op.direction,
            entryLineName: op.entryLineName,
            entryPrice: entry,
            entryTime: op.entryTime,
            exitPrice,
            exitTime,
            outcome,
            pnlPct,
        });
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

            // Close out any operation still open from the previous day.
            // The last candle of that day is `candles[i - 1]`.
            const prevCandle = i > 0 ? candles[i - 1] : null;
            if (
                prevCandle &&
                currentOperation &&
                currentOperation.currentlyOpen &&
                !currentOperation.completed
            ) {
                emitRecord(
                    currentOperation,
                    prevCandle.close,
                    prevCandle.time as number,
                    "dayEnd",
                );
            }

            // Close out yesterday's lines, if any.
            if (currentDayStart !== null) finishDay();
            currentDayStart = {
                time: first.time,
                dateKey: todayKey
            };

            dayHighLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });
            dayLowLine = createPlotLine(candleSeries, { color: "#ffffff", mode: "step" });

            runningHigh = first.high;
            runningLow = first.low;

            activeFib = null;
            currentOperation = undefined
        } else {
            if (first.high > runningHigh) runningHigh = first.high;
            if (first.low < runningLow) runningLow = first.low;
        }

        // ── EMA update ──────────────────────────────────────
        const currentEMA = computeEma(first);
        if (currentEMA.newDay) {
            emaLine.add(first.time, null);
        }
        emaLine.add(first.time, currentEMA.value);

        // ── Gap detection ───────────────────────────────────
        let newGap: Gap | null = handleGap(first, third, currentDayStart.time, candleSeries, primitives, runningHigh, runningLow);

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
        if (currentOperation === undefined) {
            if (activeFib.direction === "bullish") {
                if (third.low <= activeFib.blueLevel) {
                    if (currentEMA !== null && currentEMA.value > activeFib.blueLevel) {
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: {
                                price: activeFib.blueLevel,
                                lineName: "blue"
                            },
                            direction: "bullish",
                            completed: false
                        }
                        openPosition(third, currentOperation, candleSeries, primitives)
                        continue
                    } else {
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: {
                                price: activeFib.orangeLevel,
                                lineName: "orange"
                            },
                            direction: "bullish",
                            completed: false
                        }
                        continue
                    }
                }
            } else if (activeFib.direction === "bearish") {
                if (third.high >= activeFib.blueLevel) {
                    if (currentEMA !== null && currentEMA.value < activeFib.blueLevel) {
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: {
                                price: activeFib.blueLevel,
                                lineName: "blue"
                            },
                            direction: "bearish",
                            completed: false
                        }
                        openPosition(third, currentOperation, candleSeries, primitives)
                        continue
                    }
                    else {
                        currentOperation = {
                            currentlyOpen: false,
                            entryLevel: undefined,
                            direction: "bearish",
                            completed: false
                        }
                        continue
                    }
                }
            }
        }

        if (!currentOperation) continue
        if (currentOperation.completed) continue

        // Detect orange line touch
        if (!currentOperation.currentlyOpen && currentOperation.direction === "bullish") {
            if (third.low <= activeFib.orangeLevel) {
                currentOperation.entryLevel = {
                    price: activeFib.orangeLevel,
                    lineName: "orange"
                }
                openPosition(third, currentOperation, candleSeries, primitives)
            }
        }
        if (!currentOperation.currentlyOpen && currentOperation.direction === "bearish") {
            if (third.high >= activeFib.orangeLevel) {
                currentOperation.entryLevel = {
                    price: activeFib.orangeLevel,
                    lineName: "orange"
                }
                openPosition(third, currentOperation, candleSeries, primitives)
            }
        }

        // ── Handle TP/SL ──
        const close = handleOperation(third, currentOperation);
        if (close) {
            emitRecord(currentOperation, close.exitPrice, third.time as number, close.outcome);
        }
    }

    // ── After the loop: close any still-open operation ──
    const lastCandle = candles[candles.length - 1];
    if (
        lastCandle &&
        currentOperation &&
        currentOperation.currentlyOpen &&
        !currentOperation.completed
    ) {
        emitRecord(
            currentOperation,
            lastCandle.close,
            lastCandle.time as number,
            "dayEnd",
        );
    }

    if (currentDayStart !== null) finishDay();
    if (emaLine) primitives.push(...emaLine.finish());

    return { primitives, records };
}