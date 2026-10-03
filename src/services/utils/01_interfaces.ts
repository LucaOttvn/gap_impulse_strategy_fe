import { Candle } from "../schemas"
import { Direction } from "./gapsHandler"

export interface StrategyCandle extends Candle {
  dayHigh: number
  dayLow: number
  orangeLine: number
  blueLine: number
  ema: number
  emaNewDay: boolean
  gap: Gap | null
  tpSl: TpSlRect | null
}

export interface Gap {
  startTime: number; // unix seconds — left edge of the rectangle
  endTime: number;   // unix seconds — right edge of the rectangle
  topPrice: number;  // upper edge
  bottomPrice: number; // lower edge
  direction: Direction
}

export interface TpSlRect {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  direction: "bullish" | "bearish";
  outcome: "tp" | "sl" | "dayEnd";
}