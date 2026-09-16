// PURPOSE
// ------
// A single source of truth for the small set of shapes that are shared across
// more than one chart module. Keeping them here (instead of re-declaring them
// in every file) means the various effects and components that feed the chart
// always agree on the exact data contracts:
//
//   • chartRealtime.ts  – live streaming / history-setData helpers
//   • chartHud.tsx      – the OHLCV / bid-ask legend header
//   • chartReplayMarkers.ts – replay trade-event markers
//   • ChartPanel.tsx    – the component itself (legend state, props typing)
//
// WHAT EACH EXPORT MEANS
// ----------------------
//   LiveCandleData   – A single real-time candle as pushed by the websocket
//                      layer (authoritative OHLCV from the candle aggregator).
//                      `timestamp` is in unix MILLISECONDS.
//
//   TickData         – A single raw bid/ask quote tick. `timestamp` is in unix
//                      MILLISECONDS. Used for the tick-smoothed "live bar" and
//                      for the Bid / Ask / Spread price lines.
//
//   ReplayTradeEvent – One trade event shown as a marker during session replay
//                      ("entry" | "exit" | "violation"). Mirrors the shape the
//                      parent passes in as `replayTradeEvents`.
//
//   OhlcvLegend      – The normalised OHLC + volume + percent-change object the
//                      chart keeps in state and feeds to the legend header. The
//                      percent change is derived here once so the crosshair,
//                      candle and tick paths all produce an identical legend.
//
//   candleToLegend() – Pure converter: turns a lightweight-charts candlestick
//                      row (plus a volume figure) into an OhlcvLegend, computing
//                      the signed % change relative to the bar's open. Returns
//                      change 0 when the open is 0 to avoid divide-by-zero.
//
// NOTE
// ----
// This file contains no logic other than the trivial `candleToLegend` mapping;
// it exists purely to avoid duplicate/divergent type declarations across the
// chart module family.
// ═════════════════════════════════════════════════════════════════════════════

import type {CandlestickData, Time} from "lightweight-charts";

/** A single real-time candle pushed by the websocket layer (unix ms timestamp). */
export type LiveCandleData = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
};

/** A single raw bid/ask quote tick (unix ms timestamp). */
export type TickData = {bid: number; ask: number; timestamp: number};

/** One replay trade event rendered as a series marker during session replay. */
export type ReplayTradeEvent = {
  id: string;
  type: "entry" | "exit" | "violation";
  timestamp: string;
  symbolName: string | null;
  side: string | null;
  price: number | null;
  pnl: number | null;
  ruleCode?: string;
};

/** Normalised OHLCV + signed percent-change object fed to the legend header. */
export interface OhlcvLegend {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  change: number;
}

/**
 * Build an OhlcvLegend from a lightweight-charts candlestick row and a volume
 * figure, deriving the signed % change relative to the bar's open (0 when the
 * open is 0, to avoid a divide-by-zero).
 */
export function candleToLegend(c: CandlestickData<Time>, volume: number): OhlcvLegend {
  const change = c.open ? ((c.close - c.open) / c.open) * 100 : 0;
  return {o: c.open, h: c.high, l: c.low, c: c.close, v: volume, change};
}
