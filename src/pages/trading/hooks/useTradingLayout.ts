import { useCallback, useState } from "react";

export type BottomTab =
  | "positions"
  | "orders"
  | "history"
  | "journal"
  | "calendar"
  | "news"
  | "ai-trader";

export type RightPanel =
  | "order"
  | "dom"
  | "watchlist"
  | "news"
  | "ai-trader"
  | "tv-analysis";

/** Visibility/tab state for the surrounding page chrome. */
export function useTradingLayout() {
  const [bottomTab, setBottomTab] = useState<BottomTab>("positions");
  const [rightPanel, setRightPanel] = useState<RightPanel>("order");
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  const toggleRightPanel = useCallback(() => setShowRightPanel((v) => !v), []);

  return {
    bottomTab,
    setBottomTab,
    rightPanel,
    setRightPanel,
    showRightPanel,
    toggleRightPanel,
    mobilePanelOpen,
    setMobilePanelOpen,
  };
}