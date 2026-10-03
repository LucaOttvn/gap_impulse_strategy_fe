import { useMemo } from "react";
import { useSymbols } from "../services/queries.ts";
import type { Symbol } from "../services/schemas.ts";
import { TIMEFRAMES, type Timeframe } from "./trading/constants.ts";
import { useStrategyBacktest } from "./trading/hooks/useStrategyBacktest.ts";
import type { OperationRecord } from "../services/utils/strategy.ts";
import type { OperationStats } from "../services/utils/operationStats.ts";
import { useTradingStore } from "@/services/store.tsx";
import { useTimeframePersistence } from "./trading/hooks/useTimeframePersistence.ts";

// ...rest of the component unchanged, using `setSymbol` and `setTimeframe`
// where it previously called the local setters.
// ── Helpers ─────────────────────────────────────────────

function fmtPrice(n: number): string {
  // 5 decimals for FX-style, drop trailing zeros for equities.
  return n.toFixed(5).replace(/\.?0+$/, "");
}

function fmtPct(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDayKey(dayKey: string): string {
  // dayKey is already "YYYY-MM-DD".
  return dayKey;
}

// ── Sub-components ──────────────────────────────────────

function StatCard({label, value, tone}: {label: string; value: string; tone?: "pos" | "neg" | "neutral"}) {
  const toneClass = tone === "pos" ? "text-[#0ecb81]" : tone === "neg" ? "text-[#f6465d]" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function StatsHeader({stats}: {stats: OperationStats}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
      <StatCard label="Total Trades" value={String(stats.total)} />
      <StatCard label="Win Rate" value={`${(stats.winRate * 100).toFixed(1)}%`} tone={stats.winRate >= 0.5 ? "pos" : "neg"} />
      <StatCard label="Wins / Losses" value={`${stats.wins} / ${stats.losses}`} />
      <StatCard label="TP / SL / EOD" value={`${stats.tp} / ${stats.sl} / ${stats.dayEnd}`} />
      <StatCard label="Profit Factor" value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)} tone={stats.profitFactor >= 1 ? "pos" : "neg"} />
    </div>
  );
}

function OutcomeBadge({outcome}: {outcome: OperationRecord["outcome"]}) {
  const cls = outcome === "tp" ? "bg-[#0ecb81]/20 text-[#0ecb81]" : outcome === "sl" ? "bg-[#f6465d]/20 text-[#f6465d]" : "bg-muted text-muted-foreground";
  const label = outcome === "tp" ? "TP" : outcome === "sl" ? "SL" : "EOD";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

function DirectionBadge({direction}: {direction: OperationRecord["direction"]}) {
  const cls = direction === "bullish" ? "text-[#0ecb81]" : "text-[#f6465d]";
  return <span className={`text-[11px] font-semibold ${cls}`}>{direction === "bullish" ? "LONG" : "SHORT"}</span>;
}

function EntryLineBadge({line}: {line: OperationRecord["entryLineName"]}) {
  const cls = line === "blue" ? "bg-[#22d3ee]/20 text-[#22d3ee]" : "bg-[#f59e0b]/20 text-[#f59e0b]";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{line.toUpperCase()}</span>;
}

function OperationsTable({records}: {records: OperationRecord[]}) {
  if (records.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">No operations in this range.</div>;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="border-b border-border bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Day</th>
              <th className="px-3 py-2 text-left">Entry Time</th>
              <th className="px-3 py-2 text-left">Direction</th>
              <th className="px-3 py-2 text-left">Entry Line</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Exit</th>
              <th className="px-3 py-2 text-left">Exit Time</th>
              <th className="px-3 py-2 text-center">Outcome</th>
              <th className="px-3 py-2 text-right">PnL %</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className="border-b border-border/40 last:border-b-0 hover:bg-secondary/20">
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{fmtDayKey(r.dayKey)}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{fmtDate(r.entryTime)}</td>
                <td className="px-3 py-1.5">
                  <DirectionBadge direction={r.direction} />
                </td>
                <td className="px-3 py-1.5">
                  <EntryLineBadge line={r.entryLineName} />
                </td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtPrice(r.entryPrice)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtPrice(r.exitPrice)}</td>
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{fmtDate(r.exitTime)}</td>
                <td className="px-3 py-1.5 text-center">
                  <OutcomeBadge outcome={r.outcome} />
                </td>
                <td className={`px-3 py-1.5 text-right font-mono font-semibold ${r.pnlPct >= 0 ? "text-[#0ecb81]" : "text-[#f6465d]"}`}>{fmtPct(r.pnlPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────

export function StrategyBacktestPage() {
  const {data: symbols = []} = useSymbols();

  // Same persisted state as the trading page — switching views keeps the
  // symbol and timeframe in sync, and a reload restores the last pair.
  const symbol = useTradingStore((s) => s.selectedSymbol);
  const setSymbol = useTradingStore((s) => s.setSelectedSymbol);
  const [timeframe, setTimeframe] = useTimeframePersistence(symbol);

  const {data, isLoading, isError, error} = useStrategyBacktest(symbol, timeframe);

  const symbolOptions = useMemo(() => symbols.filter((s: Symbol) => s.isActive).map((s) => s.name), [symbols]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header / controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
        <h1 className="text-sm font-semibold">Strategy Backtest</h1>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Symbol</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded border border-border bg-background px-2 py-1 font-mono text-xs">
            {symbolOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} className="rounded border border-border bg-background px-2 py-1 font-mono text-xs">
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </label>

        {data && (
          <span className="ml-auto text-[11px] font-mono text-muted-foreground">
            {data.barCount.toLocaleString()} bars · {new Date(data.rangeFrom).toISOString().slice(0, 10)} → {new Date(data.rangeTo).toISOString().slice(0, 10)}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading && <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Running backtest…</div>}

        {isError && <div className="flex h-40 items-center justify-center text-sm text-[#f6465d]">Backtest failed: {String((error as Error)?.message ?? error)}</div>}

        {data && !isLoading && (
          <div className="space-y-4">
            <StatsHeader stats={data.stats} />
            <OperationsTable records={data.records} />
          </div>
        )}
      </div>
    </div>
  );
}
