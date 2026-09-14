# OpenCharts Frontend API Contract

The terminal talks to exactly one object: `api`, exported from
`src/services/api.ts`. Every network call, every piece of state the UI needs,
goes through it. Swapping backends means reimplementing this object — nothing
else in the UI changes.

This document is a reference for that contract. It is derived from
`src/services/demo/api.ts`, which is the demo implementation the shipped app
uses.

---

## How the object is wired

```ts
// src/services/api.ts
export const api = new Proxy(demoApi, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return () => Promise.resolve(null); // benign fallback
  },
});
```

Two consequences you must know:

1. **Any method not implemented resolves to `null`** instead of throwing. A
   typo'd method name fails silently. If the UI reads a property off the
   result (e.g. `login().accessToken`), you get a
   `Cannot read properties of null` far away from the cause.
2. **`Object.keys(api)` enumerates every method** the app knows about,
   because `keys` is forwarded to the target.

To migrate to a real backend: spread `demoApi` into your own object and
override methods one at a time. Override a method only once its real
implementation is proven.

---

## Return shape conventions

- Almost everything is **async** — every method returns a `Promise`.
- List endpoints return **either a bare array or a paginated envelope**
  `{ data, total, page, pageSize, totalPages }`. Check each below.
- Types referenced but not defined here (`Candle`, `Symbol`, `Order`,
  `Position`, `DrawingLine`, `PlaceOrderArgs`) are defined in
  `src/services/schemas.ts` and `src/pages/trading/constants.ts`. **Those are
  the authoritative definitions** — this doc only names them.

---

## Auth

| Method | Args | Returns |
|---|---|---|
| `login` | — | `{ accessToken, refreshToken, user }` |
| `demoLogin` | — | `{ accessToken, refreshToken, user }` |
| `register` | — | `{ accessToken, refreshToken, user }` |
| `completeMfaLogin` | — | `{ accessToken, refreshToken, user }` |
| `logout` | — | `{ success: true }` |
| `refreshToken` | — | `{ accessToken, refreshToken }` |
| `getMyProfile` | — | `User` |
| `getMe` | — | `User` |

`User` in demo: `{ id, email, firstName, lastName, roles, status, createdAt }`.

**Boot dependency:** the app calls `demoLogin` (or `login`) during startup and
reads `.accessToken` off the result. If you stub auth, return this shape or
the app crashes before rendering.

---

## Accounts

| Method | Args | Returns |
|---|---|---|
| `getMyAccounts` | — | `Account[]` |
| `getAccount` | — | `Account` |
| `getEquityHistory` | — | `EquityPoint[]` |
| `getLedger` | — | `{ data, total, page, pageSize, totalPages }` |
| `getAccountStats` | — | `{ totalTrades, winRate, avgWin, avgLoss, profitFactor, bestTrade, worstTrade }` |
| `setAccountLabel` | — | `{ success: true }` |
| `getAccountMetrics` | — | see below |

`getAccountMetrics` returns a flat object consumed by the risk/metrics panel:

```
accountId, equity, balance, freeMargin, marginUsed, floatingPnl, dailyPnl,
ddDaily, ddDailyMax, ddTotal, ddTotalMax, ddTrailing, ddTrailingMax,
trailingDrawdownFloor, trailingDrawdownPeak, trailingDrawdownMode,
trailingDrawdownTrailMode, trailingDrawdownFloorLocked,
trailingDrawdownTrailToBreakeven, profitTargetPercent, profitTargetProgress,
minTradingDays, tradingDaysCompleted, minDaysProgress, status, phase,
highWaterMark, startingBalance, currency, lastMarkTs
```

Any drawdown/profit-target field may be `null` when not applicable.

---

## Symbols & market data

| Method | Args | Returns |
|---|---|---|
| `getSymbols` | — | `Symbol[]` |
| `getCandles` | `(symbol, timeframe, limit?)` | `Candle[]` |
| `getCandlesWithMeta` | `(symbol, timeframe, limit?)` | `{ candles, metadata }` |
| `getTick` | `(symbol)` | `{ symbol, bid, ask, timestamp }` |
| `getMarketDataHealth` | — | `{ status }` |
| `getEconomicCalendar` | — | `Event[]` |

**`getCandles`** is the method that feeds the chart. It takes:

- `symbol` — ticker string, e.g. `"AAPL"`
- `timeframe` — interval string. Inspect call sites to confirm the exact
  values in use; the demo history loader in `src/services/demo/candles.ts`
  is the source of truth for what it accepts.
- `limit?` — optional max number of bars

Returns a `Candle[]`. See `CandleSchema` in `src/services/schemas.ts` for the
exact field names — do not assume `timestamp` vs `time`.

**`getCandlesWithMeta`** wraps the same data with coverage metadata:

```
{ isPartial: boolean, backfillQueued: boolean, historicalCoverageStart: string | null }
```

Most chart code uses `getCandles`. Use the meta variant only if the UI needs
to render a "loading older data" indicator.

---

## Trading

Order entry and position management, backed in demo by an in-browser paper
engine (`src/services/demo/engine.ts`).

| Method | Args | Returns |
|---|---|---|
| `placeOrder` | `PlaceOrderArgs` | `Order` |
| `cancelOrder` | `(orderId)` | result of engine call |
| `modifyOrder` | `(orderId)` | `Order \| undefined` |
| `cancelAllOrders` | — | `{ success: true }` |
| `getOrders` | — | `Order[]` |
| `getPositions` | — | `Position[]` |
| `getOpenPositionCount` | — | `number` |
| `closePosition` | `(positionId, quantity?)` | result of engine call |
| `closeAllPositions` | — | result of engine call |
| `modifyPosition` | `(positionId, { takeProfit?, stopLoss? })` | `Position` |
| `getFills` | — | `{ data, total, page, pageSize, totalPages }` |
| `getClosedPositions` | — | `{ data, total, page, pageSize, totalPages }` |
| `getClosedPositionsSummary` | — | `{ realizedPnl, trades, wins, losses }` |
| `getFillQuality` | — | `FillQuality[]` |

`PlaceOrderArgs` is defined in `src/services/demo/engine.ts` — read it there.
It describes side, type, quantity, price, stop/take-profit levels, etc.

Note the pagination split: `getFills` and `getClosedPositions` return
envelopes, while `getOrders` and `getPositions` return bare arrays.

---

## Trade journal

| Method | Args | Returns |
|---|---|---|
| `getJournalEntries` | — | `JournalEntry[]` |
| `createJournalEntry` | — | `JournalEntry \| null` |
| `updateJournalEntry` | — | `JournalEntry \| null` |
| `deleteJournalEntry` | — | `{ success: true }` |

Demo returns empty. Safe to stub as `[]` / `null` until you build it.

---

## Chart persistence

Chart drawings persist per-symbol to `localStorage` under
`oc_drawings_<symbol>`.

| Method | Args | Returns |
|---|---|---|
| `chartDrawings.list` | `(symbol)` | `DrawingLine[]` |
| `chartDrawings.save` | `(symbol, timeframe, drawing)` | `{ saved: true }` |
| `chartDrawings.remove` | `(drawingId)` | `{ deleted: true }` |
| `chartDrawings.clear` | `(symbol)` | `{ cleared: true }` |
| `savePreferences` | — | `{ success: true }` |

`DrawingLine` is defined in `src/pages/trading/constants.ts`. Note that
`remove` scans all demo symbols to find the drawing — a real backend would
key on `drawingId` alone.

`chartDrawings` is a **nested object**, not a method. Your `liveApi`
replacement must preserve that nesting.

---

## Feature gating & misc

| Method | Args | Returns |
|---|---|---|
| `getFeatureFlags` | — | `Record<string, boolean>` |
| `isAiTraderEnabled` | — | `boolean` |
| `getAnnouncements` | — | `Announcement[]` |
| `getAnnouncementsUnreadCount` | — | `number` |
| `replayGetSession` | — | `Session \| null` |

All are read on mount to decide which panels render. Safe to stub with empty
values.

---

## Migration checklist

If you're wiring a real backend, this is the minimum to get the app running
and rendering a chart:

1. **`demoLogin`** (or `login`) — return `{ accessToken, refreshToken, user }`.
   Required or the app crashes at boot.
2. **`getSymbols`** — return your instrument list, shaped like `Symbol`.
3. **`getCandles`** — the chart's data source. This is the one you actually
   came here for.

Everything else can stay delegated to `demoApi` via spread, or be stubbed as
`[]` / `null`, until you have real endpoints for it.

### Recommended migration pattern

```ts
import { demoApi } from "./demo/api.ts";

const liveApi = {
  ...demoApi, // keep working implementations for everything not yet migrated

  async getCandles(symbol: string, timeframe: string, limit?: number) {
    // your real implementation
  },
};

export const api = new Proxy(liveApi, { /* same fallback as before */ });
```

Override one method at a time. Confirm each works before moving on. Delete
the `demoApi` spread only when every method is implemented.

---

## Debugging the contract

**List every method the app expects:**

```bash
grep -rno "api\.[a-zA-Z]*" src --include="*.ts" --include="*.tsx" \
  | grep -v "services/api.ts" | sort -u
```

**Find call sites for one method:**

```bash
grep -rn "api.getCandles" src --include="*.ts" --include="*.tsx"
```

**At runtime:** `Object.keys(api)` in the console.

**When something silently returns `null`:** you called a method that isn't on
your `liveApi`. The Proxy swallowed it. Check the spelling against
`demoApi`.