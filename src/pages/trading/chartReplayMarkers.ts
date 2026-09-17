// PURPOSE
// -------
// During session replay the chart overlays a marker at the candle where each
// recorded trade event happened. Each event is one of:
//
//   • "entry"     – a position was opened  → arrow above/below the bar (B = buy,
//                   S = sell; buy arrows point up, sell arrows point down).
//   • "exit"      – a position was closed  → a circle above a profitable exit
//                   (green, "+$…") or below a losing one (red, "-$…").
//   • "violation" – a rule was breached    → a red square labelled with the rule code.
//
// WHAT EACH PIECE DOES
// --------------------
//   entryMarker()   – Arrow marker for an entry, coloured by side.
//   exitMarker()    – Circle marker for an exit, coloured/positioned by P&L sign
//                     and labelled with the rounded dollar P&L.
//   buildReplayMarker() – Dispatcher: buckets the event's timestamp to the active
//                     timeframe (so the marker lands on the candle that was
//                     forming when the trade happened) and routes to the correct
//                     builder. Returns null for an unparseable timestamp.
//
// The caller (`ChartPanel`) collects these into a `SeriesMarker<Time>[]`, sorts
// them ascending by time (lightweight-charts requires it) and applies them via
// `createSeriesMarkers`. It also clears them when replay is no longer active.
// ═════════════════════════════════════════════════════════════════════════════

import type {SeriesMarker, Time} from "lightweight-charts";
import type {ReplayTradeEvent} from "./chartTypes.ts";
import type {Timeframe} from "./constants.ts";
import {getCandleBucketTime} from "./utils.ts";

// ── Marker builders ──────────────────────────────────────────────────────────

function entryMarker(ev: ReplayTradeEvent, time: Time): SeriesMarker<Time> {
  const isBuy = ev.side === "BUY";
  return {
    time,
    position: isBuy ? "belowBar" : "aboveBar",
    color: isBuy ? "#2196F3" : "#FF9800",
    shape: isBuy ? "arrowUp" : "arrowDown",
    text: isBuy ? "B" : "S",
  };
}

function exitMarker(ev: ReplayTradeEvent, time: Time): SeriesMarker<Time> {
  const profit = ev.pnl != null && ev.pnl >= 0;
  const text = ev.pnl != null ? `${ev.pnl >= 0 ? "+" : ""}$${Math.abs(ev.pnl).toFixed(0)}` : "Exit";
  return {
    time,
    position: profit ? "aboveBar" : "belowBar",
    color: profit ? "#0ecb81" : "#f6465d",
    shape: "circle",
    text,
  };
}

export function buildReplayMarker(ev: ReplayTradeEvent, timeframe: Timeframe): SeriesMarker<Time> | null {
  const evMs = new Date(ev.timestamp).getTime();
  if (Number.isNaN(evMs)) return null;
  const time = getCandleBucketTime(evMs, timeframe) as Time;
  if (ev.type === "entry") return entryMarker(ev, time);
  if (ev.type === "exit") return exitMarker(ev, time);
  return {
    time,
    position: "aboveBar",
    color: "#FF1744",
    shape: "square",
    text: ev.ruleCode ?? "Rule",
  };
}
