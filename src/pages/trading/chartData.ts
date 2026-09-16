// ═════════════════════════════════════════════════════════════════════════════
// chartData.ts — Candle → lightweight-charts data conversion + useChartData hook
// ═════════════════════════════════════════════════════════════════════════════
//
// PURPOSE
// -------
// Converts the raw `Candle[]` the server/API returns into the two parallel
// arrays lightweight-charts expects — the candlestick series data and the volume
// histogram data — and exposes them through the `useChartData` hook.
//
// The conversion normalises timestamps, discards invalid rows, sorts ascending
// and de-duplicates, so the chart always receives clean, time-ordered input
// regardless of how the data source formats timestamps.
//
// WHAT EACH PIECE DOES
// --------------------
//   CandleRow     – Internal row shape: candlestick fields + a `volume` field.
//   secOrMsToMs() – Treats values below 1e12 as seconds and at/above as ms.
//   candleTimeSec()– Normalises a raw candle's timestamp (number seconds, number
//                   ms, or an ISO string) to unix seconds; NaN if unparseable.
//   toCandleRow() – Maps a raw Candle to a CandleRow (numbers coerced, volume
//                   defaulting to 0).
//   dedupeByTime()– Keeps the last row for each timestamp (input must already be
//                   sorted ascending).
//   useChartData()– The hook: sorts by time, drops invalid/zero rows, de-dupes,
//                   then splits into `chartData` (candles) and `volumeData`
//                   (histogram with per-bar up/down colouring).
//
// Memoised on the input candles + the volume colours, so re-renders of the parent
// don't recompute the whole conversion unless the data actually changed.
// ═════════════════════════════════════════════════════════════════════════════

import {useMemo} from "react";
import type {CandlestickData, HistogramData, Time} from "lightweight-charts";
import type {Candle} from "../../services/schemas.ts";

// ── Local helper: Build chart data (candles + volume) ────────

type CandleRow = CandlestickData<Time> & {volume: number};

// Treat values below 1e12 as seconds, at/above as milliseconds.
function secOrMsToMs(v: number): number {
  return v < 1_000_000_000_000 ? v * 1000 : v;
}

// Normalise a raw candle's timestamp (seconds, ms, or ISO string) to unix seconds.
function candleTimeSec(c: Candle): number {
  let tMs = NaN;
  if (typeof c.time === "number" && c.time > 0) tMs = secOrMsToMs(c.time);
  else if (typeof c.timestamp === "number" && c.timestamp > 0) tMs = secOrMsToMs(c.timestamp);
  else if (typeof c.timestamp === "string") tMs = Date.parse(c.timestamp);
  return Number.isNaN(tMs) ? NaN : Math.floor(tMs / 1000);
}

function toCandleRow(c: Candle): CandleRow {
  return {
    time: candleTimeSec(c) as Time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume) || 0,
  };
}

// Keep the last row for each timestamp (input must be time-sorted ascending).
function dedupeByTime(sorted: CandleRow[]): CandleRow[] {
  const out: CandleRow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1];
    if (!next || (cur.time as number) !== (next.time as number)) out.push(cur);
  }
  return out;
}

export function useChartData(candles: Candle[], colors: {volumeUp: string; volumeDown: string}) {
  return useMemo(() => {
    const sorted = candles
      .map(toCandleRow)
      .filter((c) => !Number.isNaN(c.time as number) && (c.time as number) > 0)
      .sort((a, b) => (a.time as number) - (b.time as number));
    const deduped = dedupeByTime(sorted);

    const chartData: CandlestickData<Time>[] = deduped.map(({volume: _v, ...rest}) => rest);
    const volumeData: HistogramData<Time>[] = deduped.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? colors.volumeUp : colors.volumeDown,
    }));

    return {chartData, volumeData};
  }, [candles, colors.volumeUp, colors.volumeDown]);
}
