import { Candle } from "../schemas"

export interface StrategyCandle extends Candle {
  dayHigh: number
  dayLow: number
  orangeLine: number
  blueLine: number
  ema: number
  emaNewDay: boolean
}
