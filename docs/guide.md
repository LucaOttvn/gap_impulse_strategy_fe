# 🔌 OpenCharts — Connecting Your Own Server (Backend Guide)

**OpenCharts** ships with a fully self-contained in-browser demo (bundled real
OHLC + paper-trading engine, no server). This guide explains how to point the
frontend at **your own backend** instead — every endpoint the UI calls, every
WebSocket event it consumes, how symbols are advertised, how orders flow, and the
exact shapes it expects.

Everything here is derived from the code (v1.0 / `main`): the reference HTTP
clients in `src/services/api/*.ts`, the facade in `src/services/api.ts`, the
query hooks in `src/services/queries.ts`, the demo backend in
`src/services/demo/`, and the WS subscriber in `src/components/MarketDataBridge.tsx`.

> 🔊 Looking for the user guide or the API contract reference? See
> [docs.md](../docs.md) (how to operate the terminal) and [API.md](API.md)
> (facade method reference).

---

## Table of contents

- [1. Architecture — how the frontend talks to a server](#1-architecture--how-the-frontend-talks-to-a-server)
- [2. Option A — point the app at your server (no frontend changes)](#2-option-a--point-the-app-at-your-server-no-frontend-changes)
- [3. REST call conventions](#3-rest-call-conventions)
- [4. Endpoints your server must implement](#4-endpoints-your-server-must-implement)
  - [4.1 Auth & session](#41-auth--session)
  - [4.2 Symbols — how to set the available instruments](#42-symbols--how-to-set-the-available-instruments)
  - [4.3 Market data — candles & ticks](#43-market-data--candles--ticks)
  - [4.4 Trading — orders & positions](#44-trading--orders--positions)
  - [4.5 Accounts, metrics & history](#45-accounts-metrics--history)
  - [4.6 Trade journal](#46-trade-journal)
  - [4.7 Feature flags & misc](#47-feature-flags--misc)
- [5. Real-time WebSocket contract](#5-real-time-websocket-contract)
  - [5.1 Channels](#51-channels)
  - [5.2 Reference — every event the UI consumes](#52-reference--every-event-the-ui-consumes)
  - [5.3 What the bridge does per event](#53-what-the-bridge-does-per-event)
  - [5.4 Reconnecting](#54-reconnecting)
- [6. The order lifecycle end to end](#6-the-order-lifecycle-end-to-end)
- [7. Option B — override methods in code](#7-option-b--override-methods-in-code)
- [8. Boot sequence — what is called when](#8-boot-sequence--what-is-called-when)
- [9. Shapes reference — symbols, candles, orders, positions](#9-shapes-reference--symbols-candles-orders-positions)
  - [9.1 Timeframes](#91-timeframes)
- [10. Illustrative server sketch (Node/Express + WebSocket)](#10-illustrative-server-sketch-nodeexpress--websocket)
- [11. Debugging & testing checklist](#11-debugging--testing-checklist)
- [12. FAQ & gotchas](#12-faq--gotchas)

---

## 1. Architecture — how the frontend talks to a server

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Terminal UI (React)                          │
│  App.tsx · TradingPage · ChartPanel · OrderPanel · Watchlist · DOM  │
└──────┬───────────────────────────────┬──────────────────────────────┘
       │  REST-shaped facade            │  Streaming client
       │  src/services/api.ts           │  src/services/ws.ts
       │  (Proxy over your api object)  │  (wsClient)
       ▼                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  HTTP requests (fetch)               │  WebSocket (framed JSON)     │
└──────┬───────────────────────────────┬──────────────────────────────┘
       ▼                                ▼
   YOUR SERVER (REST API)          YOUR SERVER (WS endpoint)
```

Two facts dominate every integration decision:

1. **All HTTP goes through the `api` facade** (`src/services/api.ts`). It is a
   `Proxy` — any method you *don't* implement resolves to
   `Promise.resolve(null)` instead of throwing. A typo or a missing method
   therefore **fails silently** and panels break far from the cause.
2. **All real-time data goes through `wsClient`** (`src/services/ws.ts`) with
   four channels: `market-data`, `account`, `positions`, `orders`. The shipped
   demo implements `wsClient` with an in-process event bus; your server replaces
   it with a real WebSocket. Because the public surface
   (`connect` / `subscribe(channel, handler)` / `subscribeAccounts` /
   `onStateChange` / `state`) is identical, **no UI code needs to change**.

The components that consume these seams:

- `src/App.tsx` — boots: `demoLogin()` → `loadSymbols()` → `loadAccounts()`.
- `src/services/store.tsx` — Zustand stores; holds auth tokens, account list,
  symbols, ticks, live candle updates; exposes `loadSymbols/loadAccounts/…`.
- `src/services/queries.ts` — TanStack Query hooks (`useCandles`, `usePositions`,
  `useOrders`, `usePlaceOrder`, …). This file shows exactly which `api.*`
  methods are called and with what args.
- `src/components/MarketDataBridge.tsx` — the single global WS subscriber. It
  converts WS events into zustand store updates and React-Query cache surgery.

---

## 2. Option A — point the app at your server (no frontend changes)

You do **not** need to modify the frontend at all if your server speaks the
contract described in this guide. Three knobs control where HTTP goes:

### 2.1 `VITE_API_URL` (direct gateway access)

Create `.env.local` in the repo root:

```bash
# All REST calls go to <VITE_API_URL>/api/…
VITE_API_URL=https://api.yourdomain.com
```

`src/services/api/request.ts` then builds every request as
`${VITE_API_URL.replace(/\/$/,'')}/api` + path. Unset, it uses `/api`.

### 2.2 Dev-server proxy (Vite)

`vite.config.ts` already forwards local development traffic to a server on
`localhost:3000`:

```ts
server: {
  proxy: {
    "/api": { target: "http://localhost:3000", changeOrigin: true },
    "/ws":  { target: "ws://localhost:3000",  ws: true },
  },
}
```

So with a backend on `localhost:3000` you can run `npm run dev` and every
request hits it. No CORS needed because the browser only talks to the Vite
origin (same-origin). For `npm run preview`/production static hosting, use
`VITE_API_URL` + a server that sets **CORS** headers (the browser *will* be on a
different origin then).

### 2.3 CORS

When serving the UI and the API from different origins:

```
Access-Control-Allow-Origin:  https://your-frontend.example   (never *)
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
```

WebSockets are not subject to CORS the way fetch is, but the origin header is
still worth validating server-side.

**Minimum to boot** (see §8 for the full startup call order):

| # | Call | Purpose |
| --- | --- | --- |
| 1 | `POST /api/auth/demo` → `{ accessToken, refreshToken, user }` | Session |
| 2 | `GET /api/market-data/symbols` → `Symbol[]` | Watchlist/dropdown |
| 3 | `GET /api/accounts/me/list` → `Account[]` | Account bar, trading |
| 4 | `POST /api/market-data/candles/:symbol` | Chart data |
| 5 | WS `/ws` + `MarketTick` events | Live prices |

---

## 3. REST call conventions

Every request is made by the shared helper `request<T>(path, opts)` in
`src/services/api/request.ts`. **Conform to these rules or the app will misbehave:**

### 3.1 Base URL & auth header

- Base is `/api` (proxy) or `<VITE_API_URL>/api` (direct).
- Every request includes `Content-Type: application/json`.
- If `access_token` is in `localStorage`, the header
  `Authorization: Bearer <access_token>` is added automatically. Your server
  must accept that header.

### 3.2 Response envelope

The helper unwraps both styles — return either:

```json
{ "data": { ... } }     // preferred, matches the reference clients
```

or the bare object. List endpoints in this codebase return either a bare array
or a paginated envelope:

```json
{ "data": [ ... ], "total": 3, "page": 1, "pageSize": 50, "totalPages": 1 }
```

### 3.3 Error envelope

Non-2xx responses must carry an error object; the helper reads:

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "Human readable message",
    "details": {
      "validation": { "fieldErrors": { "email": ["Invalid email address"] } }
    }
  }
}
```

- `error.code === "DEMO_READ_ONLY"` triggers a yellow "read-only demo" toast.
- If `details.validation.fieldErrors` has a first value, the UI shows that field
  message instead of the generic one.
- Anything else falls back to `error.message` → HTTP status text.

### 3.4 Timeouts & automatic token refresh

- Requests abort after **20 s** by default (`timeoutMs: 0` disables); a timeout
  yields `ApiError(408, "REQUEST_TIMEOUT", …)`.
- On **401 with a token present**, the helper calls
  `POST /api/auth/refresh` with `{ "refreshToken": "<refresh_token>" }` (taken
  from `localStorage`), retries the original request once with the new token,
  and only then dispatches a `session:expired` event and throws
  `ApiError(401, "UNAUTHORIZED", "Session expired")`.
- On **401 without a token** (e.g. bad login credentials), the server's own
  error message is surfaced — do **not** make the client treat that as a session
  expiry.

### 3.5 Tokens the frontend stores

After a successful login/demo-login write these `localStorage` keys:

- `access_token`, `refresh_token`, `user` (JSON), `is_demo`,
  `active_account`. The silent-refresh scheduler decodes the JWT's `exp`
  (base64 payload, `atob`) and refreshes ~60 s before expiry — so issue a
  standard JWT access token with an `exp` claim, or expect refreshes to fire on
  a floor of 60 s.

---

## 4. Endpoints your server must implement

> Paths marked with **➞ (reference)** are the exact URLs the shipped HTTP clients
> in `src/services/api/*.ts` call. Trading paths (orders/positions) are
> **suggested**: the demo backend implements those methods in memory and the UI
> only knows the *method* contract — you can mount them anywhere, but keep the
> method names identical. `GET /api/market-data/symbols` etc. must be exact.

### 4.1 Auth & session

| Method | Path ➞ | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/auth/demo` | — | `{ accessToken, refreshToken, user, isDemo }` |
| `POST` | `/api/auth/login` | `{ email, password }` | `{ accessToken, refreshToken, user }` |
| `POST` | `/api/auth/register` | `{ email, password, firstName, lastName, firmSlug? }` | `{ accessToken, refreshToken, user }` |
| `POST` | `/api/auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| `POST` | `/api/auth/logout` | `{ refreshToken? }` | `204 / {}` |
| `POST` | `/api/auth/forgot-password` | `{ email }` | `{ message, expiresIn }` |
| `POST` | `/api/auth/reset-password` | `{ resetToken, newPassword }` | `{ message }` |
| `POST` | `/api/auth/mfa/complete` | `{ mfaToken, code }` | `{ accessToken, refreshToken, user }` |
| `PATCH` | `/api/auth/preferences` | prefs object | prefs |
| `GET` | `/api/auth/preferences` | — | prefs |
| `GET` | `/api/auth/me` | — | `User` (used as `getMe`/`getMyProfile`) |
| `POST` | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `{ success/message }` |

`user` shape (`UserSchema`):

```json
{
  "id": "string",
  "email": "string",
  "firstName": "string|null",
  "lastName": "string|null",
  "roles": ["trader"],
  "status": "ACTIVE",
  "createdAt": "ISO-8601"
}
```

**The app calls `demoLogin` at boot and reads `.accessToken` straight off the
result — return this shape or the app crashes before rendering.** The simplest
integration is implementing `POST /api/auth/demo` and always issuing a session.

`user` must JSON-serialize to the shape above; the store does
`JSON.stringify(data.user)` into `localStorage`.

### 4.2 Symbols — how to set the available instruments

The **server owns the symbol list** — the app has none of its own at runtime.
On boot the store calls `api.getSymbols()`, which maps to the reference client:

```
GET /api/market-data/symbols     ➞ Symbol[]
```

`Symbol` (`SymbolSchema` in `src/services/schemas.ts`):

```json
{
  "id": "BTCUSD",
  "name": "BTCUSD",
  "displayName": "Bitcoin | null",
  "category": "CRYPTO",
  "contractSize": 1,
  "tickSize": 0.01,
  "tickValue": 0.01,
  "marginPercent": 1,
  "maxLeverage": 100,
  "commission": 0,
  "swapLong": 0,
  "swapShort": 0,
  "tradingHoursStart": null,
  "tradingHoursEnd": null,
  "isActive": true
}
```

How the list drives the UI:

- Every entry becomes a row in the **Watchlist** and an option in the
  **symbol dropdown**.
- `name` is the **primary key** — the UI keys ticks, candles, positions and
  orders by `symbolName === symbol.name`. Use uppercase, match it exactly in WS
  events, or live data won't connect to the row.
- `category` feeds the watchlist filter chips and the dropdown label.
- `isActive === false` hides the symbol from the watchlist (the dropdown still
  lists it if another panel selected it).
- `tickSize` drives price decimal precision (e.g. `0.01` → 2 digits). The store
  caches the digits from the first tick; wrong precision makes quotes look
  rounded wrongly.
- `contractSize`, `marginPercent`, `commission`, `maxLeverage` feed the order
  panel's margin/P&L calculations and the confirmation dialog.
- **There is no server-driven "default symbol".** The store hardcodes
  `selectedSymbol: "BTCUSD"`. Either ship a symbol literally named `BTCUSD`
  first (simplest), or be aware the chart starts empty until the user clicks a
  row. Recommend starting your symbols list with `BTCUSD`.

### 4.3 Market data — candles & ticks

**Candles** — the chart calls `api.getCandlesWithMeta(symbol, timeframe, limit)`
which maps to the reference client (`src/services/api/market-data.ts`):

```
POST /api/market-data/candles/:symbol
Content-Type: application/json

{ "timeframe": "15m", "limit": 500, "from": 1700000000000, "to": 1700086400000 }
```

Where `:symbol` is the symbol **name** (e.g. `BTCUSD`), `limit` is a positive
integer hint, and `from`/`to` are epoch-**milliseconds** (optional).

Response — either a bare `Candle[]` or the envelope:

```json
{
  "candles": [
    { "time": 1700000000, "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.2, "volume": 1234.0 }
  ],
  "metadata": {
    "historicalCoverageStart": 1699000000,
    "isPartial": false,
    "backfillQueued": false
  }
}
```

Candle contract:

- `time` is in **seconds** (epoch). An optional `timestamp` field (number or
  string) is tolerated.
- Return bars **ascending by `time`**.
- If you can't serve the full range yet, set `metadata.isPartial = true` — the
  UI then refetches every **3 s** until it flips to `false`, then drops to a
  safety-net 5-minute refresh. This is the built-in backfill mechanism: use it
  liberally for gap-filling.

Supported `timeframe` values the UI will ask for:

```
1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w
```

Rough lookback the UI requests per timeframe (see `LOOKBACK_MS` in
`src/services/api.ts`): 1m≈2 d, 5m≈7 d, 15m≈30 d, 30m≈60 d, 1h≈6 mo, 4h≈1 y,
1d≈5 y, 1w≈10 y.

> ⚠️ The app primarily calls `getCandlesWithMeta`. If you only implement one,
> implement that one (both are otherwise the same endpoint — see the facade).

**Ticks (on demand)** — the reference client also exposes:

```
GET /api/market-data/ticks/:symbol    ➞ { symbol, bid, ask, timestamp? }
GET /api/market-data/ticks            ➞ { "BTCUSD": { symbol, bid, ask, timestamp? }, ... }
```

Real-time quotes normally arrive over the WebSocket (`MarketTick`), so these
REST ticks are a fallback; the demo uses them for gap detection.

**Health & calendar:**

```
GET /api/market-data/health              ➞ { status: "ok", ... }   (polled every 5 s)
GET /api/market-data/staleness           ➞ { ... }                 (optional)
GET /api/market-data/economic-calendar?currencies=USD,EUR&from=&to= ➞ EconomicEvent[]
```

### 4.4 Trading — orders & positions

The UI knows these **methods** (called via `queries.ts`); the demo implements
them in memory. Below is the canonical mapping — endpoints are **suggested** but
stay consistent with the `/api/trading/*` style used by the journal client:

| Facade method | Suggested endpoint | Shape |
| --- | --- | --- |
| `placeOrder(input)` | `POST /api/trading/orders` | body `PlaceOrderInput` → `Order` |
| `getOrders(accountId, status?)` | `GET /api/trading/orders?accountId=&status=` | `Order[]` |
| `cancelOrder(orderId)` | `DELETE /api/trading/orders/:id` | `{ success: true }` |
| `cancelAllOrders()` | `DELETE /api/trading/orders?accountId=` | `{ success: true }` |
| `modifyOrder(orderId, mods?)` | `PATCH /api/trading/orders/:id` | `Order` |
| `getPositions(accountId)` | `GET /api/trading/positions?accountId=` | `Position[]` |
| `getOpenPositionCount()` | `GET /api/trading/positions/count` | `number` |
| `closePosition(positionId, quantity?)` | `DELETE /api/trading/positions/:id?quantity=` | `{ success }` |
| `closeAllPositions()` | `DELETE /api/trading/positions?accountId=` | `{ success }` |
| `modifyPosition(positionId, { takeProfit, stopLoss })` | `PATCH /api/trading/positions/:id` | `Position` |
| `getFills(accountId, page)` | `GET /api/trading/fills?accountId=&page=` | `{ data, total, page, pageSize, totalPages }` |
| `getClosedPositions(accountId, page)` | `GET /api/trading/closed-positions?accountId=&page=` | envelope of `ClosedPosition` |
| `getClosedPositionsSummary(accountId, from, to)` | `GET /api/trading/closed-positions/summary` | `{ pnl, commission, swap, tradeCount }` |
| `getFillQuality(accountId)` | `GET /api/trading/fill-quality` | see `queries.ts` |

**`PlaceOrderInput`** (validated by `PlaceOrderInputSchema`):

```json
{
  "accountId": "uuid",
  "symbol": "BTCUSD",
  "side": "BUY | SELL",
  "type": "MARKET | LIMIT | STOP | STOP_LIMIT",
  "quantity": 0.1,
  "price": 100.05,
  "stopPrice": 99.5,
  "takeProfit": 105.0,
  "stopLoss": 95.0
}
```

- `quantity` must be a positive number **≤ 1000** (the order panel enforces
  this client-side too).
- For `LIMIT`, `price` is required; for `STOP`, `stopPrice` is required.
- The demo fills **market orders instantly at the latest price**; the UI behaves
  best when your `placeOrder` also returns fast and a WS event follows quickly
  (see §6).

`Order` (server → UI) — required fields:

```json
{
  "id": "string", "accountId": "uuid", "symbolName": "BTCUSD",
  "side": "BUY|SELL", "type": "MARKET|LIMIT|STOP",
  "quantity": 0.1, "price": 100.05, "stopPrice": null,
  "takeProfit": null, "stopLoss": null,
  "status": "NEW|FILLED|CANCELLED|...", "filledQuantity": 0.1,
  "avgFillPrice": 100.05, "comment": null,
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

`Position` — required fields (margins/contract sizes are used by dialogs):

```json
{
  "id": "string", "accountId": "uuid", "symbolName": "BTCUSD",
  "side": "LONG|SHORT", "quantity": 0.1,
  "entryPrice": 100.05, "currentPrice": 100.1,
  "unrealizedPnl": 0.12, "margin": 0.01, "contractSize": 1,
  "openedAt": "ISO", "takeProfit": null, "stopLoss": 95.0
}
```

### 4.5 Accounts, metrics & history

| Method | Path ➞ | Returns |
| --- | --- | --- |
| `getMyAccounts` | `GET /api/accounts/me/list` | `Account[]` |
| `getAccount(id)` | `GET /api/accounts/:id` | `Account` |
| `createAccount(templateId, userId, label?)` | `POST /api/accounts` | `Account` |
| `setAccountLabel(id, label)` | `PATCH /api/accounts/:id/label` | `Account` |
| `getLedger(id, page, pageSize)` | `GET /api/accounts/:id/ledger?page=&pageSize=` | `{ data, total, page, pageSize, totalPages }` |
| `getEquityHistory(id, limit)` | `GET /api/accounts/:id/equity?limit=` | `EquityPoint[]` |
| `getAccountStats(id)` | `GET /api/accounts/:id/stats` | `AccountStats` |
| `getAccountMetrics(id)` | `GET /api/v1/accounts/:id/metrics` | metrics object (below) |
| `getDailyPnl(accountIds, from, to)` | `GET /api/accounts/daily-pnl?accountIds=&from=&to=` | pnl calendar |
| payouts | `POST /api/accounts/:id/payout/calculate` · `/request` · `GET …/history` · `GET /api/accounts/payouts/all` | payout records |
| replay | `GET /api/accounts/:id/replay/session?date=` · `POST …/start` `/pause` `/resume` `/stop` `/speed` `/seek` · `PATCH …/session` | replay session |

`Account` (minimum fields the UI reads):

```json
{
  "id": "uuid", "userId": "string", "templateId": "string",
  "label": "Demo Account", "status": "ACTIVE",
  "balance": 100000, "equity": 100000, "margin": 0, "freeMargin": 100000,
  "phase": "LIVE", "startDate": "ISO", "createdAt": "ISO", "updatedAt": "ISO",
  "isHftMode": false,
  "template": { "name": "Demo Account", "startingBalance": 100000, "instrumentType": "CRYPTO" }
}
```

`getAccountMetrics` powers the risk/metrics panel. It is a flat object:
`accountId`, `equity`, `balance`, `freeMargin`, `marginUsed`, `floatingPnl`,
`dailyPnl`, drawdown fields (`dd*`, `trailingDrawdown*`), profit target fields
(`profitTargetPercent`, `profitTargetProgress`), `minTradingDays`,
`tradingDaysCompleted`, `minDaysProgress`, `status`, `phase`,
`highWaterMark`, `startingBalance`, `currency`, `lastMarkTs`.

> ⚠️ **Live equity/balance are updated from the `account` WS channel**
> (`EquityUpdated`), **not** from REST polling. Serve it over the socket and the
> account bar stays smooth without hammering `getAccountMetrics`.

### 4.6 Trade journal

REST client: `src/services/api/journal.ts` (paths exact).

| Method | Path ➞ | Returns |
| --- | --- | --- |
| `getJournalEntries(accountId, { limit, offset, symbol })` | `GET /api/trading/journal?accountId=&limit=&offset=&symbol=` | `{ entries, total }` |
| `createJournalEntry(data)` | `POST /api/trading/journal` | `JournalEntry` |
| `updateJournalEntry(id, data)` | `PATCH /api/trading/journal/:id` | `JournalEntry` |
| `deleteJournalEntry(id)` | `DELETE /api/trading/journal/:id` | `204` |

`JournalEntry`: `{ id, accountId, positionId?, symbolName?, side?, entryPrice?,
exitPrice?, pnl?, emotion?, setupType?, rating?, tags: [], notes, createdAt }`.
Safe to return `{ entries: [], total: 0 }` until you build it.

### 4.7 Feature flags & misc

Read once at mount to decide which panels render:

| Method | Suggested return when "off" |
| --- | --- |
| `getFeatureFlags()` | `{}` |
| `isAiTraderEnabled()` | `false` (hides the AI Trader panel) |
| `getAnnouncements()` | `[]` |
| `getAnnouncementsUnreadCount()` | `0` |
| `replayGetSession(accountId, date)` | `null` (hides replay UI) |
| `getMarketDataHealth()` | `{ status: "ok" }` |

Chart templates persist to `localStorage` in demo mode — a backend only needs
`chartDrawings.list/save/remove/clear` if you want server-side drawings; the demo
uses keys `oc_drawings_<symbol>` locally. `savePreferences` maps to
`PATCH /api/auth/preferences`.

---

## 5. Real-time WebSocket contract

The frontend's `wsClient` (`src/services/ws.ts`) exposes
`connect(token)` / `subscribe(channel, handler)` / `subscribeAccounts(ids)` /
`onStateChange(cb)` / `state`. Your server needs:

- A WebSocket endpoint reachable at `/ws` (dev proxy) or
  `wss://<your-host>/ws` (production).
- **JSON-framed messages**: `{ "channel": "...", "event": { ... } }`.
  (`MarketDataBridge` calls `wsClient.subscribe(channel, handler)` — each
  handler receives the event object for that channel.)
- A way to authenticate the `token` handed to `connect()` (attach it as a query
  param `?token=`, `Sec-WebSocket-Protocol`, or an auth frame — your choice;
  the client doesn't dictate the handshake).
- **Per-account fan-out**: `subscribeAccounts(accountIds)` is called after
  `getMyAccounts`, so events for `positions`/`orders`/`account` channels must
  be scoped per `accountId` (the bridge filters on it).

### 5.1 Channels

| Channel | Payloads |
| --- | --- |
| `market-data` | `MarketTick`, `HftLiveTick`, `CandleUpdate`, `CandleClosed`, `ReplayStateChanged` |
| `account` | `EquityUpdated`, `AccountFailed`, `AccountPassed`, `AccountFrozen` |
| `positions` | `PositionOpened`, `PositionUpdated`, `PositionClosed` |
| `orders` | `OrderPlaced`, `OrderFilled`, `OrderCanceled` (any string accepted) |

### 5.2 Reference — every event the UI consumes

**`market-data` channel**

```jsonc
// Live quote — drives the chart bid/ask lines, watchlist, DOM, order panel, P&L.
{ "channel": "market-data", "event": {
    "eventType": "MarketTick",
    "symbol": "BTCUSD",
    "bid": 100.0,
    "ask": 100.02,
    "occurredAt": 1700000000000 }}

// Optional fast-path tick for HFT accounts (updates store.liveTicks).
{ "channel": "market-data", "event": {
    "eventType": "HftLiveTick",
    "symbol": "BTCUSD", "bid": 100.0, "ask": 100.02, "occurredAt": 1700000000000 }}

// Patch the currently forming candle without refetching history.
{ "channel": "market-data", "event": {
    "eventType": "CandleUpdate",
    "symbol": "BTCUSD", "timeframe": "1m",
    "open": 100.0, "high": 100.3, "low": 99.9, "close": 100.2,
    "volume": 120.0, "timestamp": 1700000040 }}

// Bar finalized → the app invalidates the candle query and refetches it.
{ "channel": "market-data", "event": { "eventType": "CandleClosed", "symbol": "BTCUSD", "timeframe": "1m" } }

// Session replay state changes (optional; hidden unless you enable replay).
{ "channel": "market-data", "event": {
    "eventType": "ReplayStateChanged",
    "action": "started", "speed": 1, "userId": "demo-user", "cursorTimestamp": 1700000000000 }}
```

**`account` channel**

```jsonc
// Live equity — updates the account bar, margin, P&L.
{ "channel": "account", "event": {
    "eventType": "EquityUpdated",
    "accountId": "uuid",
    "equity": 100012.5, "balance": 100000.0,
    "freeMargin": 99990.0, "marginUsed": 22.5 }}

// Account lifecycle → the app reloads the account list.
{ "channel": "account", "event": { "eventType": "AccountFailed" | "AccountPassed" | "AccountFrozen", "accountId": "uuid" } }
```

**`positions` channel**

```jsonc
// New fill. Attach the FULL position entity as _entity to skip a REST refetch;
// without it the UI falls back to a coalesced 150 ms refetch of getPositions.
{ "channel": "positions", "event": {
    "eventType": "PositionOpened",
    "accountId": "uuid", "positionId": "uuid",
    "_entity": { /* full Position object (see §4.4) */ } }}

// Price move on an open position → UI patches unrealizedPnl in place.
{ "channel": "positions", "event": {
    "eventType": "PositionUpdated",
    "accountId": "uuid", "positionId": "uuid",
    "unrealizedPnl": 1.5, "quantity": 0.1, "averagePrice": 100.1 }}

// Position closed → removed from the panel; closed-history refetched.
{ "channel": "positions", "event": { "eventType": "PositionClosed", "accountId": "uuid", "positionId": "uuid" } }
```

**`orders` channel**

```jsonc
// Emit with the full Order entity as _entity to update the orders tab directly;
// otherwise the UI refetches getOrders.
{ "channel": "orders", "event": {
    "eventType": "OrderPlaced" | "OrderFilled" | "OrderCanceled",
    "accountId": "uuid", "orderId": "uuid",
    "_entity": { /* full Order object (see §4.4) */ } }}
```

### 5.3 What the bridge does per event

`src/components/MarketDataBridge.tsx` translates events into state:

| Event | Effect |
| --- | --- |
| `MarketTick` | store `ticks[symbol] = { bid, ask, timestamp, formatted }` → chart/watchlist/DOM update |
| `CandleUpdate` | store `liveCandleUpdates["symbol:timeframe"]` → the forming bar updates live |
| `CandleClosed` | `invalidateQueries(["candles", symbol, timeframe])` → REST refetch |
| `EquityUpdated` | store account fields patched in place (no REST call) |
| `AccountFailed/Passed/Frozen` | `loadAccounts()` refetch |
| `PositionOpened` (with `_entity`) | buffered 50 ms upsert into the positions cache |
| `PositionUpdated` | patch `unrealizedPnl/quantity/entryPrice` in the cached position |
| `PositionClosed` | drop position from cache; invalidate closed-positions |
| `OrderPlaced/Filled/Canceled` (with `_entity`) | upsert into the orders cache |
| unknown / un-enriched events | 150 ms coalesced `invalidateQueries` — belt & braces refetch |

### 5.4 Reconnecting

The bridge subscribes to `wsClient.onStateChange`. When state transitions to
`connected` from anything else, it invalidates **all** caches
(`candles`, `positions`, `orders`, `accounts`) so anything missed while offline
is refetched immediately. Safe to keep this behavior in mind when tuning your
reconnect backoff: send a burst of current snapshots (or expect the client to
re-request them) on every (re)connect.

---

## 6. The order lifecycle end to end

This is the sequence a real backend should be built to satisfy (demo behavior in
`src/services/demo/engine.ts` is the reference):

**1. User clicks Buy/Sell** → `usePlaceOrder` mutation → `api.placeOrder(input)`
→ `POST /api/trading/orders`.

**2. Server fills** (market = instantly at best price; limit/stop = when the
market trades through) and:

- returns the `Order`.
- publishes `orders/OrderPlaced` with `_entity` = the order.
- if a position opened, publishes `positions/PositionOpened` with
  `_entity` = the full `Position`.
- publishes `account/EquityUpdated` with the new balance/equity/margins.

**3. Client-side fallbacks** — even if you skip `_entity`, the UI:

- invalidates `orders` + `positions` + `account` caches after a successful
  `placeOrder` (optimistic refetch),
- coalesces bursts into a single refetch (150 ms debounce),
- refetches `positions`/`orders` every 30 s and on WS reconnect as safety nets.

**4. Price moves** → push `market-data/MarketTick` (per symbol) and
`positions/PositionUpdated` (`unrealizedPnl` etc.) → mark-to-market; the UI
updates positions/P&L without REST.

**5. Stop-loss / take-profit hit** → server closes the position → push
`positions/PositionClosed` + `positions/PositionOpened` if a new position opens
(compound) + `account/EquityUpdated`.

**6. User closes / modifies** → `DELETE/PATCH /api/trading/positions/:id`,
`PATCH /api/trading/positions/:id` (TP/SL), `DELETE /api/trading/orders/:id` →
publish the matching WS events.

> The demo engine treats **stop-loss and take-profit as server-side
> responsibilities** (they're evaluated on every tick and fire automatically).
> Don't push this to the client — the UI has no local SL/TP evaluation loop.

---

## 7. Option B — override methods in code

If your server doesn't match the endpoint layout above, override the facade
methods one at a time in `src/services/api.ts`. The file already spreads
`demoApi`, so anything you don't override keeps working (session, positions,
orders, drawings…):

```ts
// src/services/api.ts
import { demoApi } from "./demo/api.ts";

const liveApi = {
  ...demoApi, // fall back to the in-browser engine for everything else

  async getCandlesWithMeta(symbol: string, timeframe: string, limit?: number) {
    const res = await fetch(`/api/market-data/candles/${symbol}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeframe, limit }),
    });
    return res.json();
  },

  async placeOrder(input: PlaceOrderInput) {
    // your real implementation
  },
};

export const api = new Proxy(liveApi as Record<string, unknown>, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return () => Promise.resolve(null); // benign fallback — see gotchas
  },
}) as typeof liveApi & Record<string, (...args: never[]) => Promise<unknown>>;
```

Rules of thumb:

- Override **one method at a time** and confirm the panel it feeds works before
  moving on.
- `getCandlesWithMeta` gets `(symbol, timeframe, limit)`. `getCandles` gets the
  same — implement either; the chart uses the `WithMeta` variant.
- The `api` Proxy method **must** be defined or you get a silent `null` (the
  method `Promise.resolve(null)` fallback) — see §12.
- You can also swap the WS client (`src/services/ws.ts`) with one that opens a
  real socket; it must keep the same public surface
  (`connect/subscribe/subscribeAccounts/onStateChange/state/disconnect`).

---

## 8. Boot sequence — what is called when

Reference: `src/App.tsx`, `src/services/store.tsx`.

```
App mounts
  └─ demoLogin()                      → POST /api/auth/demo
       └─ persists tokens to localStorage
       └─ wsClient.connect(accessToken)          → WS /ws
  └─ loadSymbols()                    → GET /api/market-data/symbols   (store.symbols)
  └─ loadAccounts()                   → GET /api/accounts/me/list      (store.accounts)
       └─ auto-selects the first account          (store.activeAccountId)
       └─ wsClient.subscribeAccounts(ids)
  └─ render TradingPage
       └─ useCandles(symbol, timeframe, limit)   → POST /api/market-data/candles/BTCUSD
       └─ usePositions(accountId)                → GET /api/trading/positions
       └─ useOrders(accountId)                   → GET /api/trading/orders
       └─ useMyAccounts()                        → GET /api/accounts/me/list
       └─ getFeatureFlags() / isAiTraderEnabled / announcements / market-data health
```

On symbol change → `useCandles(newSymbol, timeframe)` (plus
`updateTick` for the newly selected symbol's last quote). On timeframe change →
`useCandles(symbol, newTimeframe)`. On tab open (History, Journal, Calendar,
News) → the corresponding lazy queries fire.

LocalStorage keys written by the app: `access_token`, `refresh_token`, `user`,
`is_demo`, `active_account`, `theme`, `tf_<symbol>`, `oc_drawings_<symbol>`,
`oc_chart_templates`, `watchlist_favorites`.

---

## 9. Shapes reference — symbols, candles, orders, positions

Authoritative definitions: `src/services/schemas.ts` (zod) and
`src/services/api/market-data.ts`. Quick cheat sheet:

| Object | Key fields |
| --- | --- |
| `Symbol` | `id`, `name` (unique key!), `displayName`, `category`, `contractSize`, `tickSize`, `tickValue`, `marginPercent`, `maxLeverage`, `commission`, `swapLong`, `swapShort`, `tradingHoursStart/End`, `isActive` |
| `Candle` | `time` (seconds), `open`, `high`, `low`, `close`, `volume`, `timestamp?` |
| `Order` | `id`, `accountId`, `symbolName`, `side`, `type`, `quantity`, `price`, `stopPrice`, `takeProfit`, `stopLoss`, `status`, `filledQuantity`, `avgFillPrice`, `comment`, `createdAt`, `updatedAt` |
| `Position` | `id`, `accountId`, `symbolName`, `side` (LONG/SHORT), `quantity`, `entryPrice`, `currentPrice`, `unrealizedPnl`, `margin`, `contractSize?`, `openedAt`, `takeProfit`, `stopLoss` |
| `Fill` | `id`, `orderId`, `accountId`, `symbolName`, `side`, `quantity`, `price`, `commission`, `realizedPnl?`, `createdAt` |
| `ClosedPosition` | `id`, `accountId?`, `symbolName`, `side`, `quantity`, `entryPrice`, `exitPrice`, `realizedPnl`, `commission`, `swap`, `openedAt`, `closedAt`, `isPartialClose?` |
| `Account` | `id`, `userId`, `templateId`, `label`, `status`, `balance`, `equity`, `margin`, `freeMargin`, `phase`, `startDate`, `createdAt`, `updatedAt`, `isHftMode`, `template` |
| `User` | `id`, `email`, `firstName`, `lastName`, `roles`, `status`, `createdAt` |

### 9.1 Timeframes

| Key | Interval | Typical lookback |
| --- | --- | --- |
| `1m` | 1 minute | 2 days |
| `5m` | 5 minutes | 7 days |
| `15m` | 15 minutes | 30 days |
| `30m` | 30 minutes | 60 days |
| `1h` | 1 hour | 6 months |
| `4h` | 4 hours | 1 year |
| `1d` | 1 day | 5 years |
| `1w` | 1 week | 10 years |

The UI never asks for anything else. `TF_INTERVAL_MS` in
`src/pages/trading/constants.ts` maps each to milliseconds for chart layering;
keep `timeframe` strings identical to the ones above.

---

## 10. Illustrative server sketch (Node/Express + WebSocket)

A minimal Express + `ws` reference server that satisfies the contract. It
focuses on the **shapes** — replace storage/price-source/auth with your own.

```js
// server.mjs — illustrative, NOT production-ready
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";

const app = express();
app.use(express.json());

// ── Auth ──
app.post("/api/auth/demo", (req, res) => {
  res.json({ data: {
    accessToken: "jwt.with.exp.here",
    refreshToken: "refresh-token",
    user: { id: "u1", email: "demo@x.io", firstName: "Demo", lastName: "Trader",
            roles: ["trader"], status: "ACTIVE", createdAt: new Date().toISOString() },
    isDemo: true, } });
});
app.post("/api/auth/refresh", (req, res) => res.json({ data: {
  accessToken: "jwt.with.exp.here", refreshToken: "refresh-token" } }));
app.post("/api/auth/logout", (req, res) => res.status(204).end());

// ── Symbols — the list that becomes the watchlist ──
const SYMBOLS = [
  { id: "BTCUSD", name: "BTCUSD", displayName: "Bitcoin", category: "CRYPTO",
    contractSize: 1, tickSize: 0.01, tickValue: 0.01, marginPercent: 1,
    maxLeverage: 100, commission: 0, swapLong: 0, swapShort: 0,
    tradingHoursStart: null, tradingHoursEnd: null, isActive: true },
];
app.get("/api/market-data/symbols", (req, res) => res.json({ data: SYMBOLS }));

// ── Candles ──
app.post("/api/market-data/candles/:symbol", (req, res) => {
  const { timeframe, limit, from, to } = req.body;      // exactly what the UI sends
  const candles = loadCandles(req.params.symbol, timeframe, limit, from, to);
  res.json({ data: { candles,          // ascending by time (SECONDS)
    metadata: { historicalCoverageStart: null, isPartial: false, backfillQueued: false } } });
});
app.get("/api/market-data/health", (req, res) => res.json({ data: { status: "ok" } }));

// ── Accounts ──
app.get("/api/accounts/me/list", (req, res) => res.json({ data: [{
  id: "acct-1", userId: "u1", templateId: "demo", label: "Demo Account",
  status: "ACTIVE", balance: 100000, equity: 100000, margin: 0, freeMargin: 100000,
  phase: "LIVE", startDate: new Date().toISOString(), createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), isHftMode: false,
  template: { name: "Demo Account", startingBalance: 100000, instrumentType: "CRYPTO" },
}]}));

// ── Trading (suggested paths) ──
const orders = [], positions = [];
app.post("/api/trading/orders", (req, res) => {
  const order = { id: crypto.randomUUID(), ...req.body, symbolName: req.body.symbol,
    status: "FILLED", filledQuantity: req.body.quantity, avgFillPrice: lastPrice(req.body.symbol),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  orders.push(order);
  const pos = { id: crypto.randomUUID(), accountId: order.accountId, symbolName: order.symbolName,
    side: order.side === "BUY" ? "LONG" : "SHORT", quantity: order.quantity,
    entryPrice: order.avgFillPrice, currentPrice: order.avgFillPrice, unrealizedPnl: 0,
    margin: 0.01 * order.quantity * order.avgFillPrice, contractSize: 1,
    openedAt: new Date().toISOString(), takeProfit: req.body.takeProfit ?? null,
    stopLoss: req.body.stopLoss ?? null };
  positions.push(pos);
  wss.broadcast({ channel: "orders", event: { eventType: "OrderPlaced",
    accountId: order.accountId, orderId: order.id, _entity: order } });
  wss.broadcast({ channel: "positions", event: { eventType: "PositionOpened",
    accountId: pos.accountId, positionId: pos.id, _entity: pos } });
  wss.broadcast({ channel: "account", event: { eventType: "EquityUpdated",
    accountId: order.accountId, equity: 100000, balance: 100000,
    freeMargin: 99990, marginUsed: 10 } });
  res.json({ data: order });
});

// ── WebSocket: JSON frames { channel, event } at /ws ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function tickLoop() {
  for (const s of SYMBOLS) {
    const price = nextPrice(s);
    wss.broadcast({ channel: "market-data", event: {
      eventType: "MarketTick", symbol: s.name, bid: price, ask: price,
      occurredAt: Date.now() } });
  }
}
setInterval(tickLoop, 600);            // ≈1 tick/600 ms, like the demo feed
server.listen(3000, () => console.log("listening on :3000"));
```

Storage, JWT/margin validation, real price feeds, CORS, and multi-node WS
fan-out (e.g. Redis pub/sub) are left out on purpose — the contract above is
what matters.

---

## 11. Debugging & testing checklist

**Before you write a server, prove the contract with curl:**

```bash
# 1. Session    → expect { data: { accessToken, refreshToken, user } }
curl -s -X POST http://localhost:3000/api/auth/demo | jq .data.accessToken

# 2. Symbols    → expect an array (or { data: [...] })
curl -s http://localhost:3000/api/market-data/symbols | jq .

# 3. Candles    → POST body { timeframe: "15m", limit: 100 }
curl -s -X POST http://localhost:3000/api/market-data/candles/BTCUSD \
  -H 'Content-Type: application/json' -d '{"timeframe":"15m","limit":100}' | jq '.data.candles[0]'

# 4. Accounts
curl -s http://localhost:3000/api/accounts/me/list | jq .
```

**Frontend-side verification:**

| Symptom | Check |
| --- | --- |
| App stuck at "Loading OpenCharts…" | `POST /api/auth/demo` failed, or `/api/market-data/symbols` / `/api/accounts/me/list` errored. Look at the browser Network tab. |
| Chart empty, watchlist shows `--` everywhere | Symbols load but no `MarketTick` is arriving on the WS, or `symbol.name` in WS events doesn't match the symbols list. |
| Prices move but chart history is blank | `POST /api/market-data/candles/:symbol` — wrong shape (`data`/bare), `time` in ms instead of s, or bars not ascending. |
| Positions/orders don't appear after a fill | You returned an `Order` from `placeOrder` but didn't publish `orders/OrderPlaced`; the UI refetches on 150 ms debounce / 30 s safety net — check `GET /api/trading/positions` returns the position. |
| P&L never updates | No `market-data/MarketTick` for that symbol, or no `positions/PositionUpdated` on price moves. |
| 401 loops → "Session expired" | `/api/auth/refresh` is wrong/missing, or your access token has no parseable `exp` claim. |
| Everything works in dev (`npm run dev`) but not in `preview`/prod | CORS headers missing, or `VITE_API_URL` not set at build time. |

**Enumerate every method the app expects (handy after upgrades):**

```bash
grep -rno "api\.[a-zA-Z]*" src --include="*.ts" --include="*.tsx" \
  | grep -v "services/api.ts" | sort -u

# Find call sites of one method:
grep -rn "api.placeOrder" src --include="*.ts" --include="*.tsx"
```

At runtime: open the browser console and run `Object.keys(api)` (the Proxy
forwards `keys` to the target) to list the methods the facade knows.

**Watch the traffic:**

- All REST calls should appear in the Network tab under `/api/*`.
- WS frames appear under the Network tab → WebSocket → Messages.
- If you see `401` on the *first* call after a fresh demo-login, check that
  `demoLogin` actually stored `access_token` before `loadSymbols` ran (it does —
  same `Promise.all` boot in `App.tsx`).

**Suggested migration order (smallest → largest scope):**

1. Auth demo + symbols + accounts + candles → UI renders with live history.
2. WS ticks (`MarketTick`, `CandleUpdate`/`CandleClosed`) → chart live.
3. `placeOrder` + `orders`/`positions`/`account` WS events → paper trading.
4. Positions modify/close, history, journal, feature flags, equity metrics.

---

## 12. FAQ & gotchas

**Q: My server is up, but a panel silently reads `null` and breaks.**
The facade Proxy resolves any method you didn't define to
`Promise.resolve(null)`. Grep `api.` usages and cross-check against the method
tables in this guide. Always define `getCandlesWithMeta`, `getSymbols`,
`getMyAccounts`, `demoLogin`, `getPositions`, `getOrders`, `placeOrder`.

**Q: Do I need `getCandles` AND `getCandlesWithMeta`?**
The chart uses `getCandlesWithMeta`. If you only implement one, implement
`WithMeta` (or make both call the same endpoint with the payload documented in
§4.3).

**Q: The UI asks for candles with a `limit` I can't honor.**
Fine — `limit` is a hint. Return as many bars as you have (ascending by `time`).
If you have to return early, set `metadata.isPartial = true` and the UI refetches
every 3 s until you service the full range.

**Q: Should my server send `EquityUpdated` on every tick?**
The demo does (on every mark-to-market). If you push it too often you'll churn
renders; the UI stores it directly (no REST), but rate-limit sensibly (e.g. 1 Hz
or on actual equity changes). Do **not** rely on REST polling for live equity —
the bridge only invalidates `accounts` on reconnect/account-lifecycle events.

**Q: What exactly should I send for the "forming candle"?**
`CandleUpdate` with `open/high/low/close/volume` and `timeframe` — the UI stores
it keyed `symbol:timeframe` and overlays it without touching history. Send
`CandleClosed` once the bucket closes so the UI refetches the authoritative bar.

**Q: My REST calls work but the WebSocket gets no ticks.**
Three usual causes: (1) the UI connects to `/ws` (dev proxy) — make sure the
server exposes a WS endpoint at exactly that path; (2) `wsClient.connect(token)`
is only called after a successful demo/login — your auth must return OK; (3)
your `MarketTick.symbol` doesn't match a symbol name from `getSymbols` (the
store drops unknown symbols).

**Q: Can I skip the WebSocket and just poll REST?**
Ticks, candle updates, positions, and equity are all *designed* to be WS-driven.
The UI has REST safety nets (3 s partial-candle polling, 30 s position/order
refetch, 5 s health poll, reconnect invalidation), so a purely REST server will
still *function* — but the terminal will feel sluggish and race-free operation
is not guaranteed. Publish at least `MarketTick` (and ideally `PositionUpdated`)
over the socket.

**Q: Which header does the UI send for auth again?**
`Authorization: Bearer <access_token>` (`localStorage` key `access_token`),
added automatically by the request helper to every call. The WS token comes from
`wsClient.connect(accessToken)`.

**Q: My candles come from a different API with `timestamp` only.**
Provide `time` in seconds — that's the field the chart sorts and buckets by.
`timestamp` is tolerated but never assumed.

**Q: Timezone/clocks — what time base?**
Epoch. `time` in **seconds** for candles, `from`/`to` in **milliseconds** for the
candles REST body, `occurredAt`/`timestamp` in WS events can be epoch ms or an
ISO string (`toTimestamp` in the bridge handles both).

**Q: How do I disable the parts I don't implement?**
- Hide AI Trader: `isAiTraderEnabled() → false`.
- Hide history/journal content: return `[]` / `{ data: [], total: 0 }`.
- Hide replay: `replayGetSession() → null`.
- Read-only trading: return `{ error: { code: "DEMO_READ_ONLY", message: "…" } }`
  from `placeOrder` — the UI shows a toast (that's the one sanctioned "disabled"
  signal).
- All REST lists outside `api.ts` already default to harmless empties if you
  spread `demoApi` (Option B).

**Q: Related docs?**
- [docs.md](../docs.md) — full user + developer guide for the terminal.
- [API.md](API.md) — facade method contract & migration checklist.
- `src/components/MarketDataBridge.tsx` — the WS event → state map.
- `src/services/queries.ts` — every `api.*` call site with its arguments.