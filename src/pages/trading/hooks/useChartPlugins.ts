import { useCallback, useState } from "react";
import {
  getChartPreferencesFromStorage,
  updateChartPreferences,
} from "@/hooks/useChartPreferences.ts";

/** Active chart plugins (session breaks etc.), synced to user preferences. */
export function useChartPlugins() {
  const [activePlugins, setActivePlugins] = useState<string[]>(
    () => getChartPreferencesFromStorage().activePlugins,
  );

  const togglePlugin = useCallback((id: string) => {
    setActivePlugins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      updateChartPreferences({ activePlugins: next });
      return next;
    });
  }, []);

  /** Replace the whole list at once (used by template load). */
  const setPlugins = useCallback((ids: string[]) => {
    setActivePlugins(ids);
    updateChartPreferences({ activePlugins: ids });
  }, []);

  return { activePlugins, togglePlugin, setPlugins };
}