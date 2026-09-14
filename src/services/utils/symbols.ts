import { Symbol } from "../schemas";

function stock(name: string, displayName: string, tickSize: number): Symbol {
  return {
    id: name,
    name,
    displayName,
    category: "STOCKS",
    contractSize: 1,
    tickSize,
    tickValue: tickSize,
    marginPercent: 1,
    maxLeverage: 100,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  };
}

export const SYMBOLS: Symbol[] = [
  stock("SPCX", "SpaceX", 0.01),
  stock("MU", "Micron", 0.01),
  stock("NVDA", "NVIDIA", 0.01),
  stock("PLTR", "Palantir", 0.01),
  stock("INTC", "Intel", 0.01),
  stock("AAPL", "Apple", 0.01),
  stock("TSLA", "Tesla", 0.01),
];