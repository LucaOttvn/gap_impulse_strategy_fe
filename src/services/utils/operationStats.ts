import type { OperationRecord } from "./strategy";

export interface OperationStats {
    /** Total number of operations the strategy opened. */
    total: number;
    /** Count of positions that closed by hitting the take-profit level. */
    tp: number;
    /** Count of positions that closed by hitting the stop-loss level. */
    sl: number;
    /** Count of positions that were force-closed at the end of the day. */
    dayEnd: number;
    /** Wins = TP hits + dayEnd closes with pnlPct > 0. */
    wins: number;
    /** Losses = SL hits + dayEnd closes with pnlPct < 0. */
    losses: number;
    /**
     * Wins / (wins + losses). Range 0..1.
     * Day-end closes at exactly break-even are excluded from both counts.
     * Returns 0 when no decided trades exist.
     */
    winRate: number;
    /** Sum of pnlPct across every operation. */
    totalPnlPct: number;
    /** Mean pnlPct across every operation. */
    avgPnlPct: number;
    /** Sum of pnlPct for TP-hit operations only. */
    grossWinPct: number;
    /** Sum of pnlPct for SL-hit operations only (negative). */
    grossLossPct: number;
    /**
     * Gross wins / |gross losses|. A classic "profit factor."
     * Returns Infinity if there are wins and zero losses.
     * Returns 0 if there are no wins.
     */
    profitFactor: number;
}

export function computeOperationStats(records: OperationRecord[]): OperationStats {
    let tp = 0;
    let sl = 0;
    let dayEnd = 0;
    let wins = 0;
    let losses = 0;
    let totalPnlPct = 0;
    let grossWinPct = 0;
    let grossLossPct = 0;

    for (const r of records) {
        totalPnlPct += r.pnlPct;

        if (r.outcome === "tp") {
            tp += 1;
            wins += 1;
            grossWinPct += r.pnlPct;
        } else if (r.outcome === "sl") {
            sl += 1;
            losses += 1;
            grossLossPct += r.pnlPct;
        } else {
            dayEnd += 1;
            if (r.pnlPct > 0) { wins += 1; grossWinPct += r.pnlPct; }
            else if (r.pnlPct < 0) { losses += 1; grossLossPct += r.pnlPct; }
            // exactly 0 counts as neither
        }
    }

    const decided = wins + losses;
    const profitFactor = grossLossPct === 0
        ? (grossWinPct > 0 ? Infinity : 0)
        : grossWinPct / Math.abs(grossLossPct);

    return {
        total: records.length,
        tp, sl, dayEnd,
        wins, losses,
        winRate: decided > 0 ? wins / decided : 0,
        totalPnlPct,
        avgPnlPct: records.length > 0 ? totalPnlPct / records.length : 0,
        grossWinPct,
        grossLossPct,
        profitFactor,
    };
}