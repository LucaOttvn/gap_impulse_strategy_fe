// ═════════════════════════════════════════════════════════════════════════════
// chartPositionOverlays.ts — Position / order price-line overlays + SL/TP map
// ═════════════════════════════════════════════════════════════════════════════
//
// PURPOSE
// -------
// Renders the trading overlays drawn as horizontal price lines on the chart:
// open-position entry lines and, per position, its Take-Profit and Stop-Loss
// lines. These overlays come from the account's live `positions` and `orders`
// arrays, so they are re-painted (clear + re-add) every time either changes.
//
// The SL/TP lines are also registered in a shared `SlTpMap` so the drag-to-edit
// hook (`useSlTpDrag`) can locate a line by positionId+field and snap it to the
// cursor. Keeping that registry here, next to where the lines are created, keeps
// the two halves of the feature consistent.
//
// WHAT EACH PIECE DOES
// --------------------
//   SlTpField / SlTpEntry / SlTpMap – Types describing one SL-or-TP price line and
//                              the map (key = "<positionId>:<tp|sl>") that links it
//                              to its position for drag-editing.
//   OverlayOpts            – Bundle of the symbol filter, colour palette and
//                              contract size used to compute $ P&L per line.
//   clearPriceLines()      – Removes every overlay price line from the series
//                              (guarded so stale refs can't throw).
//   addSlTpLine()          – Creates one SL or TP dashed line for a position,
//                              labels it with the projected $ P&L, and registers it
//                              in the drag map.
//   addPositionOverlay()   – Draws a position: a dotted entry line labelled
//                              "buy/sell <qty>", plus its TP and SL lines when set.
//                              The P&L for each target is computed from the entry
//                              price × direction × quantity × contract size.
//   addOrderOverlay()      – Draws a dashed "PENDING" order line labelled with
//                              side / type / quantity (only for pending orders on
//                              this symbol).
//
// NOTE
// ----
// The caller re-runs this whole block whenever positions/orders/symbol/chart-data
// change and the "overlay positions" preference is enabled, so the overlays always
// mirror the latest account state.
// ═════════════════════════════════════════════════════════════════════════════

import {LineStyle, type IPriceLine, type ISeriesApi} from "lightweight-charts";
import type {Order, Position} from "../../services/schemas.ts";
import type {ChartColors} from "./constants.ts";

// ── Position / order overlay helpers ─────────────────────────────────────────

type SlTpField = "takeProfit" | "stopLoss";
interface SlTpEntry {
  line: IPriceLine;
  price: number;
  positionId: string;
  field: SlTpField;
  side: string;
  entryPrice: number;
  quantity: number;
}
export type SlTpMap = Map<string, SlTpEntry>;
export interface OverlayOpts {
  symbol: string;
  colors: ChartColors;
  contractSize: number;
}

export function clearPriceLines(series: ISeriesApi<"Candlestick">, list: IPriceLine[]): void {
  for (const pl of list) {
    try {
      series.removePriceLine(pl);
    } catch {
      /* ignore */
    }
  }
}

// One SL or TP line for a position, registered in the drag-to-edit map.
function addSlTpLine(series: ISeriesApi<"Candlestick">, pos: Position, field: SlTpField, price: number, pnl: number, out: IPriceLine[], map: SlTpMap, colors: ChartColors): void {
  const isTp = field === "takeProfit";
  const line = series.createPriceLine({
    price,
    color: isTp ? colors.tpLine : colors.slLine,
    lineWidth: 2,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `${isTp ? "TP" : "SL"}  ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
  });
  out.push(line);
  map.set(`${pos.id}:${isTp ? "tp" : "sl"}`, {
    line,
    price,
    positionId: pos.id,
    field,
    side: pos.side,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
  });
}

export function addPositionOverlay(series: ISeriesApi<"Candlestick">, pos: Position, opts: OverlayOpts, out: IPriceLine[], map: SlTpMap): void {
  if (pos.symbolName !== opts.symbol || !Number.isFinite(pos.entryPrice)) return;
  out.push(
    series.createPriceLine({
      price: pos.entryPrice,
      color: pos.side === "LONG" ? opts.colors.up : opts.colors.down,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: `${pos.side === "LONG" ? "buy" : "sell"} ${pos.quantity.toFixed(2)}`,
    }),
  );
  const direction = pos.side === "LONG" ? 1 : -1;
  const pnlAt = (target: number) => parseFloat(((target - pos.entryPrice) * direction * pos.quantity * opts.contractSize).toFixed(2));
  if (typeof pos.takeProfit === "number" && Number.isFinite(pos.takeProfit)) {
    addSlTpLine(series, pos, "takeProfit", pos.takeProfit, pnlAt(pos.takeProfit), out, map, opts.colors);
  }
  if (typeof pos.stopLoss === "number" && Number.isFinite(pos.stopLoss)) {
    addSlTpLine(series, pos, "stopLoss", pos.stopLoss, pnlAt(pos.stopLoss), out, map, opts.colors);
  }
}

export function addOrderOverlay(series: ISeriesApi<"Candlestick">, ord: Order, symbol: string, orderColor: string, out: IPriceLine[]): void {
  if (ord.symbolName !== symbol || ord.status !== "PENDING" || !Number.isFinite(ord.price as number)) {
    return;
  }
  out.push(
    series.createPriceLine({
      price: ord.price as number,
      color: orderColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `[P] ${ord.side} ${ord.type} ${ord.quantity}`,
    }),
  );
}
