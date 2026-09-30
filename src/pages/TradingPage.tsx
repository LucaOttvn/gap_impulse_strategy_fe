import {useMemo} from "react";
import {useIsFeedConnected} from "../components/ConnectionIndicator.tsx";
import {MobileAccountBar, MobileTradingPanel} from "../components/MobileTradingPanel.tsx";
import {OrderConfirmDialog, OrderModifyDialog, PositionModifyDialog} from "../components/TradingDialogs.tsx";
import {NewsFeed as MarketNewsFeed} from "../components/TradingPowerFeatures.tsx";
import {TradingViewTechnicalAnalysis} from "../components/TradingViewWidgets.tsx";
import {useChartPreferences, updateChartPreferences} from "../hooks/useChartPreferences.ts";
import type {CreateJournalEntryInput, JournalEntry, UpdateJournalEntryInput} from "../services/api/journal.ts";
import {api} from "../services/api.ts";
import {useInfiniteCandles, useCreateJournalEntry, useDeleteJournalEntry, useJournalEntries, useOrders, usePositions, useSymbols, useUpdateJournalEntry} from "../services/queries.ts";
import type {Candle, PlaceOrderInput, Symbol} from "../services/schemas.ts";
import {useTradingStore} from "../services/store.tsx";
import {toast} from "../services/toast.ts";
import {BottomPanel} from "../components/BottomPanel.tsx";
import {ChartPanel} from "../components/ChartPanel.tsx";
import {ChartToolbar} from "../components/ChartToolbar.tsx";
import {REPLAY_ENABLED, type MagnetMode} from "./trading/constants.ts";
import {useReplayChartData} from "./trading/useReplayChartData.ts";
import {useReplayPlayback} from "./trading/useReplayPlayback.ts";
import {getPipDigits} from "./trading/utils.ts";
import {DOMPanel} from "@/components/DOMPanel.tsx";
import {MarketClosedBanner} from "@/components/MarketClosedBanner.tsx";
import {OrderPanel} from "@/components/OrderPanel.tsx";
import {ReplayScrubber} from "@/components/ReplayScrubber.tsx";
import {WatchlistPanel} from "@/components/WatchlistPanel.tsx";

// Extracted hooks — each owns one concern (see ./trading/hooks/).
import {useBottomPanelResize} from "./trading/hooks/useBottomPanelResize.ts";
import {useChartPlugins} from "./trading/hooks/useChartPlugins.ts";
import {useChartTooling} from "./trading/hooks/useChartTooling.ts";
import {useConfirmOrder} from "./trading/hooks/useConfirmOrder.ts";
import {useModifyPosition} from "./trading/hooks/useModifyPosition.ts";
import {useQuickOrder} from "./trading/hooks/useQuickOrder.ts";
import {useTickPriming} from "./trading/hooks/useTickPriming.ts";
import {useTimeframePersistence} from "./trading/hooks/useTimeframePersistence.ts";
import {useTradingAnalytics} from "./trading/hooks/useTradingAnalytics.ts";
import {useTradingLayout} from "./trading/hooks/useTradingLayout.ts";
import {useTradingState} from "./trading/hooks/useTradingState.ts";

/** Narrow an unknown error object down to a display message. */
function getErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as {message?: string}).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Request failed";
}

/**
 * Top-level trading page. Owns the layout (chart + bottom panel + right rail
 * + mobile sheet) and wires the extracted hooks together. Data fetching is
 * delegated to React Query hooks; interactive state lives in the hooks below.
 */
export function TradingPage() {
  // Global trading store: selected symbol, live ticks, active account, replay.
  const {selectedSymbol, setSelectedSymbol, ticks, updateTick, activeAccountId, symbols: _storeSymbols, replayVersion, isReplaying} = useTradingStore();

  // Timeframe is per-symbol and persisted to localStorage.
  const [timeframe, handleTimeframeChange] = useTimeframePersistence(selectedSymbol);

  // Chart tooling: indicators, armed drawing tool, drawings + undo/redo.
  const {
    activeIndicators,
    setActiveIndicators,
    toggleIndicator,
    clearIndicators,
    drawingTool,
    setDrawingTool,
    handleDrawingComplete,
    drawings,
    addDrawing,
    updateDrawing,
    showIndicatorMenu,
    setShowIndicatorMenu,
    removeDrawing,
    clearDrawings,
    undo: undoDrawing,
    redo: redoDrawing,
  } = useChartTooling(selectedSymbol, timeframe);

  // Chart plugins, layout chrome, trading-mode state.
  const {activePlugins, togglePlugin, setPlugins} = useChartPlugins();
  const {height: bottomPanelHeight, handleResizeStart} = useBottomPanelResize();
  const {bottomTab, setBottomTab, rightPanel, setRightPanel, showRightPanel, toggleRightPanel, mobilePanelOpen, setMobilePanelOpen} = useTradingLayout();
  const {oneClick, toggleOneClick, soundMuted, toggleSoundMute, playTradeSound, modifyingPosition, setModifyingPosition, modifyingOrder, setModifyingOrder} = useTradingState();

  // Order confirmation dialog + funnel analytics.
  const {
    pending: confirmOrder,
    loading: confirmLoading,
    request: requestConfirm,
    confirm: confirmOrderSubmit,
    cancel: cancelConfirmOrder,
  } = useConfirmOrder(() => {
    playTradeSound();
    trackFirstTrade();
  });
  const {trackFirstTrade} = useTradingAnalytics();

  // ── Effects ──────────────────────────────────────────────────
  useTickPriming(selectedSymbol, updateTick);
  useReplayPlayback(activeAccountId ?? "");

  // ── Data ─────────────────────────────────────────────────────
  const {data: symbols = []} = useSymbols();
  const isFeedConnected = useIsFeedConnected();

  // ── Candles: infinite/paginated ────────────────────────────
  // One page per scroll-back. Initial page covers ~7d of 1m (or the per-TF
  // window defined in useInfiniteCandles). fetchNextPage fires when the user
  // scrolls near the oldest loaded bar.
  const {
    data: candlePages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteCandles(selectedSymbol, timeframe);

  // Flatten pages into one chronological array. Dedupe by timestamp because
  // page seams can overlap by one bar (see the -1ms in getNextPageParam).
  const candles: Candle[] = useMemo(() => {
    if (!candlePages) return [];
    const byTime = new Map<number, Candle>();
    for (const page of candlePages.pages) { 
      for (const c of page.candles) byTime.set(c.time, c);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [candlePages]);

  // Replay overrides the live candle array when active.
  const {replayCandles, replayTradeEvents} = useReplayChartData(activeAccountId);

  // Positions, orders, journal.
  const {data: positions = []} = usePositions(activeAccountId);
  const {data: orders = []} = useOrders(activeAccountId);
  const {data: journalData, isLoading: journalLoading} = useJournalEntries(activeAccountId);
  const createJournal = useCreateJournalEntry();
  const updateJournal = useUpdateJournalEntry();
  const deleteJournal = useDeleteJournalEntry();

  // ── Derived ──────────────────────────────────────────────────
  const chartPrefs = useChartPreferences();
  const tick = ticks[selectedSymbol];
  const symbolInfo = symbols.find((s) => s.name === selectedSymbol) as Symbol | undefined;
  const liveCandleUpdates = useTradingStore((s) => s.liveCandleUpdates);
  const liveCandle = liveCandleUpdates[`${selectedSymbol}:${timeframe}`];
  const pipDigits = useMemo(() => getPipDigits(symbolInfo, selectedSymbol), [symbolInfo, selectedSymbol]);
  const account = useTradingStore((s) => s.accounts.find((a) => a.id === activeAccountId));
  const isDark = !document.documentElement.classList.contains("light");

  const chartPositions = chartPrefs.overlayPositionsOnChart ? positions : [];
  const chartOrders = chartPrefs.overlayPositionsOnChart ? orders : [];
  const positionPnl = useMemo(() => positions.reduce((sum, position) => sum + (position.unrealizedPnl || 0), 0), [positions]);

  // ── Handlers ─────────────────────────────────────────────────
  const handleQuickOrder = useQuickOrder(activeAccountId, selectedSymbol, requestConfirm);
  const handleChartModifyPosition = useModifyPosition(activeAccountId, isFeedConnected);

  // Chart scroll-back trigger — asks the infinite query for the next page.
  const handleLoadMoreHistory = () => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  const cycleMagnetMode = () => {
    const order: MagnetMode[] = ["none", "weak", "strong"];
    const next = order[(order.indexOf(chartPrefs.magnetMode) + 1) % order.length] ?? "none";
    updateChartPreferences({magnetMode: next});
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Mobile Account Bar */}
      <div className="md:hidden">
        <MobileAccountBar balance={account?.balance ?? 0} equity={account?.equity ?? account?.balance ?? 0} margin={account?.margin ?? 0} pnl={positionPnl} />
      </div>

      {/* Top Toolbar */}
      <ChartToolbar
        selectedSymbol={selectedSymbol}
        symbols={symbols}
        onSymbolChange={setSelectedSymbol}
        timeframe={timeframe}
        onTimeframeChange={handleTimeframeChange}
        activeIndicators={activeIndicators}
        onToggleIndicator={toggleIndicator}
        showIndicatorMenu={showIndicatorMenu}
        onToggleIndicatorMenu={() => setShowIndicatorMenu((v) => !v)}
        drawingTool={drawingTool}
        onDrawingTool={setDrawingTool}
        drawings={drawings}
        onClearDrawings={clearDrawings}
        rightPanel={rightPanel}
        onRightPanel={setRightPanel}
        showRightPanel={showRightPanel}
        onToggleRightPanel={toggleRightPanel}
        tick={tick}
        symbolInfo={symbolInfo}
        isReplaying={isReplaying}
        replayAccountId={activeAccountId}
        activePlugins={activePlugins}
        onTogglePlugin={togglePlugin}
        onSetIndicators={setActiveIndicators}
        onSetPlugins={setPlugins}
        magnetMode={chartPrefs.magnetMode}
        onCycleMagnet={cycleMagnetMode}
        stayInDrawingMode={chartPrefs.stayInDrawingMode}
        onToggleStayInDrawingMode={() => updateChartPreferences({stayInDrawingMode: !chartPrefs.stayInDrawingMode})}
      />

      <MarketClosedBanner symbolInfo={symbolInfo} />

      {/* Main Layout */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 min-w-0">
          {/* Chart Area */}
          <div className="flex-1 min-h-[200px] relative">
            <ChartPanel
              candles={replayCandles ?? candles}
              selectedSymbol={selectedSymbol}
              timeframe={replayCandles ? "1m" : timeframe}
              isDark={isDark}
              activeIndicators={activeIndicators}
              drawingTool={drawingTool}
              drawings={drawings}
              onAddDrawing={addDrawing}
              onUpdateDrawing={updateDrawing}
              onRemoveDrawing={removeDrawing}
              onDrawingComplete={handleDrawingComplete}
              onDrawingToolSelect={setDrawingTool}
              onUndoDrawing={undoDrawing}
              onRedoDrawing={redoDrawing}
              magnetMode={chartPrefs.magnetMode}
              stayInDrawingMode={chartPrefs.stayInDrawingMode}
              positions={chartPositions}
              orders={chartOrders}
              tick={replayCandles ? undefined : tick}
              liveCandle={replayCandles ? undefined : liveCandle}
              pipDigits={pipDigits}
              symbolInfo={symbolInfo}
              onModifyPosition={handleChartModifyPosition}
              replayTradeEvents={replayTradeEvents}
              isReplaying={isReplaying}
              activePlugins={activePlugins}
              onTogglePlugin={togglePlugin}
              accountEquity={account?.equity ?? account?.balance ?? 0}
              accountId={activeAccountId}
              onQuickOrder={handleQuickOrder}
              onClearDrawings={clearDrawings}
              onClearIndicators={clearIndicators}
              // ── NEW: infinite-history wiring ──
              onLoadMoreHistory={handleLoadMoreHistory}
              canLoadMoreHistory={!!hasNextPage}
            />
          </div>

          {REPLAY_ENABLED && isReplaying && activeAccountId != null && <ReplayScrubber accountId={activeAccountId} />}

          {/* Resize Handle */}
          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            className="hidden md:flex h-1.5 cursor-row-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors group border-t border-border bg-secondary/40 touch-none"
          >
            <div className="w-8 h-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Bottom Panel */}
          <BottomPanel
            tab={bottomTab}
            onTabChange={setBottomTab}
            positions={positions}
            orders={orders}
            accountId={activeAccountId}
            onModifyPosition={setModifyingPosition}
            onModifyOrder={setModifyingOrder}
            onSelectPositionSymbol={setSelectedSymbol}
            onSelectOrderSymbol={setSelectedSymbol}
            height={bottomPanelHeight}
            isFeedConnected={isFeedConnected}
            journalEntries={((journalData as {entries?: JournalEntry[]} | undefined)?.entries ?? []) || []}
            journalLoading={journalLoading}
            onCreateJournal={(data: CreateJournalEntryInput) =>
              createJournal.mutate(data, {
                onSuccess: () => toast.success("Journal", "Entry saved"),
                onError: (err: unknown) => toast.error("Journal", getErrorMessage(err) || "Failed to save"),
              })
            }
            onUpdateJournal={(id: string, data: UpdateJournalEntryInput) =>
              updateJournal.mutate(
                {id, accountId: activeAccountId!, ...data},
                {
                  onSuccess: () => toast.success("Journal", "Entry updated"),
                  onError: (err: unknown) => toast.error("Journal", getErrorMessage(err) || "Failed to update"),
                },
              )
            }
            onDeleteJournal={(id: string) =>
              deleteJournal.mutate(
                {id, accountId: activeAccountId!},
                {
                  onSuccess: () => toast.success("Journal", "Entry deleted"),
                  onError: (err: unknown) => toast.error("Journal", getErrorMessage(err) || "Failed to delete"),
                },
              )
            }
          />
        </div>

        {/* Right Panel */}
        {showRightPanel && (
          <div className="hidden md:flex w-full md:w-[280px] xl:w-[320px] border-t md:border-t-0 md:border-l border-border flex-col bg-card overflow-hidden shrink-0 md:max-h-none">
            {rightPanel === "order" && (
              <OrderPanel
                symbol={selectedSymbol}
                symbolInfo={symbolInfo}
                tick={tick}
                accountId={activeAccountId}
                oneClick={oneClick}
                onToggleOneClick={toggleOneClick}
                onConfirmOrder={requestConfirm}
                accountBalance={account?.balance}
                isFeedConnected={isFeedConnected}
                soundMuted={soundMuted}
                onToggleMute={toggleSoundMute}
                onOrderSuccess={() => {
                  playTradeSound();
                  trackFirstTrade();
                }}
              />
            )}
            {rightPanel === "dom" && <DOMPanel symbol={selectedSymbol} tick={tick} />}
            {rightPanel === "watchlist" && (
              <WatchlistPanel
                symbols={symbols}
                ticks={ticks}
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
                oneClick={oneClick}
                accountId={activeAccountId}
                isFeedConnected={isFeedConnected}
              />
            )}
            {rightPanel === "news" && (
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                <MarketNewsFeed symbol={selectedSymbol} />
              </div>
            )}
            {rightPanel === "tv-analysis" && (
              <div className="flex-1 overflow-hidden">
                <TradingViewTechnicalAnalysis symbol={selectedSymbol} theme={isDark ? "dark" : "light"} interval={timeframe} width="100%" height="100%" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mobile Trading Panel */}
      <div className="md:hidden">
        {!mobilePanelOpen && (
          <button
            onClick={() => setMobilePanelOpen(true)}
            className="fixed bottom-20 right-4 z-40 bg-primary text-primary-foreground rounded-full w-14 h-14 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          >
            <span className="text-2xl font-bold">$</span>
          </button>
        )}
        {mobilePanelOpen && (
          <div className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto bg-card border-t border-border rounded-t-2xl shadow-2xl safe-area-bottom">
            <div className="flex justify-center py-1">
              <button onClick={() => setMobilePanelOpen(false)} className="w-10 h-1.5 rounded-full bg-muted-foreground/30" />
            </div>
            <MobileTradingPanel
              symbol={selectedSymbol}
              bid={tick?.bid}
              ask={tick?.ask}
              positions={positions || []}
              onPlaceOrder={(order) => {
                if (oneClick) {
                  api.placeOrder({...order, accountId: activeAccountId!} as PlaceOrderInput).catch(() => {});
                  setMobilePanelOpen(false);
                  return;
                }
                requestConfirm({
                  ...order,
                  _submit: () => api.placeOrder({...order, accountId: activeAccountId!} as PlaceOrderInput),
                });
                setMobilePanelOpen(false);
              }}
            />
          </div>
        )}
      </div>

      {/* Dialogs */}
      <PositionModifyDialog position={modifyingPosition} onClose={() => setModifyingPosition(null)} onSaved={() => setModifyingPosition(null)} tick={tick} isFeedConnected={isFeedConnected} />
      <OrderModifyDialog order={modifyingOrder} onClose={() => setModifyingOrder(null)} onSaved={() => setModifyingOrder(null)} tick={tick} />
      <OrderConfirmDialog isOpen={!!confirmOrder} order={confirmOrder} onConfirm={confirmOrderSubmit} onCancel={cancelConfirmOrder} tick={tick} symbolInfo={symbolInfo} loading={confirmLoading} />
    </div>
  );
}