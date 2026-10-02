import { useEffect, useState } from "react";
import { TradingPage } from "./pages/TradingPage.tsx";
import { StrategyBacktestPage } from "./pages/StrategyBacktestPage.tsx";
import { useAuthStore, useTradingStore } from "./services/store.tsx";

export function App() {
  const [ready, setReady] = useState(false);
  const demoLogin = useAuthStore((s) => s.demoLogin);
  const loadSymbols = useTradingStore((s) => s.loadSymbols);
  const loadAccounts = useTradingStore((s) => s.loadAccounts);
  const view = useTradingStore((s) => s.view);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      await demoLogin();
      localStorage.setItem("is_demo", "false");
      useAuthStore.setState({ isDemo: false });
      await Promise.all([loadSymbols(), loadAccounts()]);
      if (!cancelled) setReady(true);
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [demoLogin, loadSymbols, loadAccounts]);

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a0a] text-neutral-400">
        Loading OpenCharts…
      </div>
    );
  }

  if (view === "backtest") return <StrategyBacktestPage />;
  return <TradingPage />;
}