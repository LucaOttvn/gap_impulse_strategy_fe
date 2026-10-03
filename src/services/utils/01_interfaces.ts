import { Candle } from "../schemas"

export interface StrategyCandle extends Candle {
  dayHigh: number
  dayLow: number
}
