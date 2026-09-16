// PURPOSE
// -------
// The chart supports a set of toggleable "plugins" — lightweight-charts
// `ISeriesPrimitive` overlays drawn on top of the candle series. Each plugin is
// identified by a string id (e.g. "crosshair", "session", "session-breaks",
// "bands", "tooltip", "delta-tooltip") and is constructed by a factory. This
// module owns:
//
//   • the plugin factories themselves (with their per-plugin config),
//   • the generic `buildPlugin(id, ctx)` dispatcher,
//   • the attach/detach helpers that sync a list of primitives onto a series,
//   • the shared `detachPrimitiveArrays` used by the strategy-drawing overlays.
//
// The "plugin context" (PluginBuildCtx) carries the theme (isDark), the current
// timeframe, and the symbol category, because several plugins change behaviour
// based on those (e.g. session-breaks are intraday-only and reset at a
// market-specific time).
//
// WHAT EACH PIECE DOES
// --------------------
//   getForexSessionColor()   – Returns a faint background tint for the "session"
//                              highlighting plugin based on the UTC hour (Asia →
//                              amber, London → blue, NY overlap → red). Purely a
//                              colour lookup.
//   forexSessionHighlighter()– Adapts the colour function to lightweight-charts'
//                              (date: Time) => string signature.
//   buildSessionBreaks()     – Builds the SessionBreaks primitive; returns null
//                              on daily+ timeframes (every bar is already a full
//                              session). Equities/indices reset at 09:30 New York
//                              (RTH open); everything else resets at 00:00 UTC.
//   PLUGIN_FACTORIES / buildPlugin() – Map of plugin id → factory; the dispatcher
//                              returns the primitive or null for unknown ids.
//   attachPlugins()          – Builds each requested plugin and attaches it to the
//                              series, pushing it onto the caller's `list` so it
//                              can be detached later. Skips primitives that fail.
//   detachPlugins()          – Detaches every primitive in the caller's list from
//                              the series (guarded so a stale ref can't throw).
//   detachPrimitiveArrays()  – Detaches and empties several arrays of primitives
//                              at once (used by the strategy-drawing overlays so
//                              they can be rebuilt on every data change).
//
// The caller (`ChartPanel`) re-runs attach/detach whenever `activePlugins` or the
// theme/symbol/timeframe changes, keeping the live series in sync with the UI.
// ═════════════════════════════════════════════════════════════════════════════

import type {ISeriesApi, ISeriesPrimitive, Time} from "lightweight-charts";
import {BandsIndicator} from "../../lib/chart-plugins/bands-indicator/bands-indicator.ts";
import {DeltaTooltipPrimitive} from "../../lib/chart-plugins/delta-tooltip/delta-tooltip.ts";
import {CrosshairHighlightPrimitive} from "../../lib/chart-plugins/highlight-bar-crosshair/highlight-bar-crosshair.ts";
import {SessionBreaks} from "../../lib/chart-plugins/session-breaks/session-breaks.ts";
import {SessionHighlighting} from "../../lib/chart-plugins/session-highlighting/session-highlighting.ts";
import {TooltipPrimitive} from "../../lib/chart-plugins/tooltip/tooltip.ts";
import {TF_INTERVAL_MS, type Timeframe} from "./constants.ts";

// ── Chart plugin overlays ─────────────────────────────────────────────────────

function getForexSessionColor(utcHour: number): string {
  if (utcHour >= 22 || utcHour < 8) return "rgba(255,200,50,0.04)";
  if (utcHour >= 8 && utcHour < 16) return "rgba(50,200,255,0.04)";
  if (utcHour >= 13) return "rgba(255,80,80,0.04)";
  return "transparent";
}

const forexSessionHighlighter = (date: Time): string => getForexSessionColor(new Date((date as number) * 1000).getUTCHours());

interface PluginBuildCtx {
  isDark: boolean;
  timeframe: Timeframe;
  symbolCategory?: string;
}

const EQUITY_CATEGORY = /stock|equit|share|etf|index|indices/i;

// Session breaks are intraday-only — on daily+ charts every bar is already a
// full session. Equities/indices reset at 09:30 New York (RTH open); forex,
// crypto and everything else reset at 00:00 UTC.
function buildSessionBreaks(ctx: PluginBuildCtx): ISeriesPrimitive<Time> | null {
  const intervalMs = TF_INTERVAL_MS[ctx.timeframe] ?? 60_000;
  if (intervalMs >= 86_400_000) return null;
  return new SessionBreaks({
    color: ctx.isDark ? "rgba(130, 150, 190, 0.5)" : "rgba(90, 110, 150, 0.45)",
    sessionStart: EQUITY_CATEGORY.test(ctx.symbolCategory ?? "") ? "ny-0930" : "utc-midnight",
  });
}

const PLUGIN_FACTORIES: Record<string, (ctx: PluginBuildCtx) => ISeriesPrimitive<Time> | null> = {
  crosshair: ({isDark}) =>
    new CrosshairHighlightPrimitive({
      color: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
    }),
  session: () => new SessionHighlighting(forexSessionHighlighter),
  "session-breaks": buildSessionBreaks,
  bands: () => new BandsIndicator(),
  tooltip: () => new TooltipPrimitive({}),
  "delta-tooltip": () => new DeltaTooltipPrimitive({}),
};

function buildPlugin(id: string, ctx: PluginBuildCtx): ISeriesPrimitive<Time> | null {
  return PLUGIN_FACTORIES[id]?.(ctx) ?? null;
}
export function detachPlugins(series: ISeriesApi<"Candlestick">, list: ISeriesPrimitive<Time>[]): void {
  for (const p of list) {
    try {
      series.detachPrimitive(p);
    } catch {
      /* stale ref */
    }
  }
}

export function attachPlugins(series: ISeriesApi<"Candlestick">, ids: string[], ctx: PluginBuildCtx, list: ISeriesPrimitive<Time>[]): void {
  for (const id of ids) {
    const p = buildPlugin(id, ctx);
    if (p) {
      try {
        series.attachPrimitive(p);
        list.push(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Detach and empty several arrays of primitives from the series at once.
 * Used by the strategy-drawing overlays so they can be torn down and rebuilt
 * whenever the underlying candle data changes. Each primitive is detached in a
 * try/catch because a stale ref may point at a primitive that belonged to a
 * previously destroyed series.
 */
export function detachPrimitiveArrays(series: ISeriesApi<"Candlestick">, primitiveArrays: ISeriesPrimitive<Time>[][]): void {
  if (!series) return;
  for (const arr of primitiveArrays) {
    for (const p of arr) {
      try {
        series.detachPrimitive(p);
      } catch {
        /* primitive belonged to a stale series — safe to ignore */
      }
    }
    arr.length = 0;
  }
}
