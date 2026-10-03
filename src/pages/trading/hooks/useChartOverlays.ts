import { useRef } from "react";
import type { OperationRecord } from "@/services/utils/strategy";
import type { SlTpMap } from "../chartPositionOverlays";
import type { ChartRefs } from "./useChartInstance";

interface ChartPrefsSlice {
  challengeOverlay: boolean;
  challengeDailyLossLine: boolean;
  challengeMaxDrawdownLine: boolean;
  challengeProfitTargetLine: boolean;
  overlayPositionsOnChart: boolean;
}

interface Args {
  chartRefs: ChartRefs;
  chartEpoch: number;
  colors: unknown;
  selectedSymbol: string;
  timeframe: string;
  symbolInfo?: unknown;
  positions: unknown[];
  orders: unknown[];
  accountId?: string | null;
  accountEquity: number;
  tick?: { bid: number; ask: number; timestamp: number };
  candles: unknown[];
  chartData: unknown[];
  activePlugins: string[];
  isDark: boolean;
  chartPrefs: ChartPrefsSlice;
  onRecordsChange?: (records: OperationRecord[]) => void;
}

export function useChartOverlays(_args: Args) {
  // Kept for API compatibility. Always empty.
  const slTpLinesRef = useRef<SlTpMap>(new Map());
  const recordsRef = useRef<OperationRecord[]>([]);

  return { slTpLinesRef, recordsRef };
}