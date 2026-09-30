import { useCallback, useState } from "react";
import { useChartDrawings } from "@/hooks/useChartDrawings.ts";
import type { IndicatorType } from "@/lib/indicators.ts";
import type { DrawingTool, Timeframe } from "../constants.ts";

/** Bundles the chart's interactive tools: indicators, active drawing tool, drawings. */
export function useChartTooling(selectedSymbol: string, timeframe: Timeframe) {
  const [activeIndicators, setActiveIndicators] = useState<IndicatorType[]>([]);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("none");
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const drawingsApi = useChartDrawings(selectedSymbol, timeframe);

  const toggleIndicator = useCallback((type: IndicatorType) => {
    setActiveIndicators((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }, []);

  const clearIndicators = useCallback(() => setActiveIndicators([]), []);

  const handleDrawingComplete = useCallback(() => setDrawingTool("none"), []);

  return {
    activeIndicators,
    setActiveIndicators,
    toggleIndicator,
    clearIndicators,
    showIndicatorMenu,
    setShowIndicatorMenu,
    drawingTool,
    setDrawingTool,
    handleDrawingComplete,
    ...drawingsApi,
  };
}