// ═════════════════════════════════════════════════════════════════════════════
// chartHud.tsx — Presentational HUD overlays for the chart panel
// ═════════════════════════════════════════════════════════════════════════════
//
// PURPOSE
// -------
// Small, purely presentational React components that float on top of the chart
// canvas. They hold no state of their own and receive everything through props;
// extracting them keeps ChartPanel's render function small and lets each overlay
// document its own conditional-branching logic in one place.
//
// WHAT EACH COMPONENT DOES
// ------------------------
//   OhlcvCell / OhlcvLegendRow – Render the O/H/L/C values with green/red colour
//                       tinting and the correct number of decimal digits, plus
//                       the signed % change and (when present) the volume.
//   BidAskRow          – The secondary header line: current Bid / Ask / Spread
//                       (spread in pips), monospaced.
//   ChartLegendHeader  – The top-left legend: symbol name, timeframe, the OHLCV
//                       row (if enabled), the candle-close countdown (if enabled),
//                       and the Bid/Ask/Spread row (when a tick is present).
//   DrawingOverlays    – For the single currently-selected drawing, renders either
//                       the floating style toolbar or the settings dialog,
//                       depending on `showSettings`.
//   ObjectTreeOverlay  – A toggle button (bottom-left) plus the ObjectTreePanel
//                       listing every drawing on the symbol, wired to the
//                       selection / update / remove / reorder callbacks. Renders
//                       nothing when there are no drawings.
//
// These are used exclusively by ChartPanel.tsx.
// ═════════════════════════════════════════════════════════════════════════════

import {Clock, ListTree} from "lucide-react";
import {cn} from "../../lib/utils.ts";
import {DrawingFloatingToolbar, DrawingSettingsDialog} from "./DrawingToolsOverlay.tsx";
import {ObjectTreePanel} from "./ObjectTreePanel.tsx";
import type {OhlcvLegend, TickData} from "./chartTypes.ts";
import type {DrawingLine, Timeframe} from "./constants.ts";

// ── HUD presentational sub-components ────────────────────────────────────────
// Extracted so the legend's per-value colour ternaries live here instead of
// inflating the ChartPanel render function's cognitive complexity.

function OhlcvCell({label, value, digits, up, bold}: {label: string; value: number; digits: number; up: boolean; bold?: boolean}) {
  return (
    <>
      <span className="text-muted-foreground/70">{label}</span>
      <span className={cn(up ? "text-[#0ecb81]" : "text-[#f6465d]", bold ? "font-semibold" : "font-medium")}>{value.toFixed(digits)}</span>
    </>
  );
}

function OhlcvLegendRow({legend, pipDigits}: {legend: OhlcvLegend; pipDigits: number}) {
  const up = legend.c >= legend.o;
  return (
    <>
      <OhlcvCell label="O" value={legend.o} digits={pipDigits} up={up} />
      <OhlcvCell label="H" value={legend.h} digits={pipDigits} up={up} />
      <OhlcvCell label="L" value={legend.l} digits={pipDigits} up={up} />
      <OhlcvCell label="C" value={legend.c} digits={pipDigits} up={up} bold />
      <span className={cn("font-semibold", legend.change >= 0 ? "text-[#0ecb81]" : "text-[#f6465d]")}>
        {legend.change >= 0 ? "+" : ""}
        {legend.change.toFixed(2)}%
      </span>
      {legend.v > 0 && (
        <>
          <span className="text-muted-foreground/70">V</span>
          <span className="text-foreground/60">{legend.v.toLocaleString()}</span>
        </>
      )}
    </>
  );
}

function BidAskRow({tick, pipDigits}: {tick: TickData; pipDigits: number}) {
  const spread = ((tick.ask - tick.bid) * 10 ** pipDigits).toFixed(1);
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <span className="text-muted-foreground/50">Bid</span>
      <span className="text-[#0ecb81]/80">{tick.bid.toFixed(pipDigits)}</span>
      <span className="text-muted-foreground/50">Ask</span>
      <span className="text-[#f6465d]/80">{tick.ask.toFixed(pipDigits)}</span>
      <span className="text-muted-foreground/50">Spread</span>
      <span className="text-foreground/50">{spread}</span>
    </div>
  );
}

// Symbol / timeframe / OHLCV / countdown header in the chart's top-left corner.
// Extracted so the visibility branching doesn't inflate ChartPanel's CC.
export function ChartLegendHeader({
  selectedSymbol,
  timeframe,
  legend,
  countdown,
  tick,
  pipDigits,
  showOhlcLegend,
  showCountdown,
}: {
  selectedSymbol: string;
  timeframe: Timeframe;
  legend: OhlcvLegend | null;
  countdown: string;
  tick?: TickData;
  pipDigits: number;
  showOhlcLegend: boolean;
  showCountdown: boolean;
}) {
  return (
    <div className="absolute top-2 left-3 z-10 pointer-events-none select-none">
      <div className="flex items-center gap-2 text-[11px] font-mono leading-none mb-1">
        <span className="text-foreground font-bold text-[13px] tracking-tight">{selectedSymbol}</span>
        <span className="text-muted-foreground font-medium">{timeframe}</span>
        {legend && showOhlcLegend && <OhlcvLegendRow legend={legend} pipDigits={pipDigits} />}
        {countdown && showCountdown && (
          <span className="text-muted-foreground/60 flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5 opacity-50" />
            {countdown}
          </span>
        )}
      </div>
      {/* Secondary info row: Bid / Ask / Spread */}
      {tick && <BidAskRow tick={tick} pipDigits={pipDigits} />}
    </div>
  );
}

// Floating toolbar / settings dialog for the currently selected drawing.
// Extracted so the selection branching doesn't inflate ChartPanel's CC.
export function DrawingOverlays({
  drawing,
  showSettings,
  currentTf,
  onUpdate,
  onClone,
  onRemove,
  onOpenSettings,
  onCloseSettings,
}: {
  drawing: DrawingLine | null;
  showSettings: boolean;
  currentTf: string;
  onUpdate: (d: DrawingLine) => void;
  onClone: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
}) {
  if (!drawing) return null;
  if (showSettings) {
    return <DrawingSettingsDialog drawing={drawing} currentTf={currentTf} onUpdate={onUpdate} onRemove={onRemove} onClose={onCloseSettings} />;
  }
  return <DrawingFloatingToolbar drawing={drawing} onUpdate={onUpdate} onClone={onClone} onRemove={onRemove} onOpenSettings={onOpenSettings} />;
}

// Object-tree toggle button + panel. Extracted so the open/close branching
// doesn't inflate ChartPanel's cognitive complexity.
export function ObjectTreeOverlay({
  drawings,
  selectedIds,
  pipDigits,
  currentTf,
  open,
  onToggle,
  onSelect,
  onUpdate,
  onRemove,
  onReorder,
}: {
  drawings: DrawingLine[];
  selectedIds: string[];
  pipDigits: number;
  currentTf: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (d: DrawingLine) => void;
  onUpdate: (d: DrawingLine) => void;
  onRemove: (id: string) => void;
  onReorder: (d: DrawingLine, dir: "front" | "back") => void;
}) {
  if (drawings.length === 0) return null;
  return (
    <>
      <button
        type="button"
        title="Object tree (drawings)"
        onClick={onToggle}
        className={cn("absolute bottom-2 left-2 z-10 p-1.5 rounded-md border border-border bg-card/90 shadow", open ? "text-primary" : "text-muted-foreground hover:text-foreground")}
      >
        <ListTree className="h-3.5 w-3.5" />
      </button>
      {open && (
        <ObjectTreePanel
          drawings={drawings}
          selectedIds={selectedIds}
          pipDigits={pipDigits}
          currentTf={currentTf}
          onSelect={onSelect}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onReorder={onReorder}
          onClose={onToggle}
        />
      )}
    </>
  );
}
