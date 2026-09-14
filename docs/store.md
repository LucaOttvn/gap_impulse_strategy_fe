# store.md

This file has one job: **hold all the shared memory the app needs**, so every component can read from it and write to it without passing props through ten layers of React.

Think of it like a big whiteboard in the middle of a room. Anyone can walk up and read it. Anyone can walk up and write on it. When someone writes on it, everyone watching that part of the board sees the new value instantly.

That whiteboard is called a **store**. This file creates two of them: the **Auth Store** and the **Trading Store**.

---

## Part 1: What's a "store" anyway?

Normal React components keep their data in `useState`:

```tsx
const [count, setCount] = useState(0);
```

That's fine when only *one* component cares about `count`. But what about the **logged-in user**, or **which stock is selected**? Lots of components care. The chart needs to know. The order ticket needs to know. The header needs to know. If you use `useState`, you'd have to pass `user` and `selectedSymbol` down through every single component — a nightmare.

Zustand fixes this by making a **global box**. Any component can do:

```tsx
const user = useAuthStore(s => s.user);
```

and it gets the current user. It'll also re-render automatically when the user changes. No prop drilling.

This file defines two boxes:

- **`useAuthStore`** — "who is logged in?"
- **`useTradingStore`** — "what's on screen, what data do we have?"

---

## Part 2: The Auth Store — "Who are you?"

### What it remembers

```ts
accessToken: string | null      
refreshToken: string | null     
user: User | null               
isDemo: boolean                 
mfaPending: ...                 
```

### Where it starts from

When the page loads, it reads from `localStorage`:

```ts
accessToken: localStorage.getItem("access_token"),
```

### The functions it exposes

| Function | What it does |
|---|---|
| `login(email, password)` | Talks to server, saves tokens, says "you're in" |
| `googleLogin(credential, slug)` | Same but via Google |
| `demoLogin()` | Fake login — no server, just fills in demo tokens |
| `completeMfa(code)` | Finish a 2FA challenge |
| `cancelMfa()` | Gave up on 2FA |
| `logout()` | Forgets everything, clears storage |
| `restoreSession()` | On page load — "do I still have a valid login?" |

### The login flow, step by step

When you call `login(...)`:

1. It asks the API: "Here's an email and password, give me tokens."
2. The API either says **"here are your tokens"** or **"you need 2FA first."**
3. If it says 2FA: it saves `mfaPending` and waits. The UI shows a code input.
4. If it says tokens: it saves them in both `localStorage` and the store's state.
5. It tells the WebSocket client to connect using the new token: `wsClient.connect(data.accessToken)`.

That last step is important — the WebSocket needs the token to prove who you are before it streams you live prices.

### The token refresh thing (this is the tricky part)

Tokens expire. Yours expires after a while. If the app didn't refresh them, you'd get logged out mid-session.

So there's a background timer that:

1. Looks at the token's **expiry time** (encoded inside the JWT itself).
2. Schedules a refresh **60 seconds before it expires**.
3. When it fires, it asks the server for a new token.
4. If it fails, it retries up to 3 times, waiting 5s, then 10s, then 15s between tries.
5. If all retries fail, it force-logs you out.

There's also `isTokenStale()` — when the page loads, it checks "is this token almost dead?" If yes, refresh immediately instead of waiting for the timer.

**You don't need to touch any of this.** It works with any backend that implements `login`, `refreshToken`, and `logout` correctly. If your server doesn't do tokens, just return the same fake token every time — the demo does exactly that.

---

## Part 3: The Trading Store — "What's on screen?"


### Part 1: Where you are

```ts
activeAccountId: string | null     // which trading account is selected
selectedSymbol: string             // which stock/coin is on the chart
```

```ts
selectedSymbol: "BTCUSD",   // initial value

setSelectedSymbol: (symbol) =>
  set((state) =>
    state.selectedSymbol === symbol
      ? { selectedSymbol: symbol }
      : { selectedSymbol: symbol, liveCandleUpdates: {} },
  ),
```

So:

- The store starts with `"BTCUSD"` selected.
- When the user clicks a different symbol in the picker, `setSelectedSymbol("AAPL")` is called.
- The store updates `selectedSymbol` to `"AAPL"`.
- It also **wipes `liveCandleUpdates`** (the last-second partial bars from the WebSocket) so stale bars from BTCUSD don't bleed into the AAPL chart.
- Any component reading `selectedSymbol` re-renders automatically.

**This is why your `getCandles` doesn't need to know which symbol is selected.** The chart component reads `useTradingStore(s => s.selectedSymbol)` and passes it to `getCandles(selectedSymbol, timeframe)`. By the time it reaches your function, it's already in the argument.

### Group B: Data fetched from the server

```ts
accounts: Account[]      // all your trading accounts
positions: Position[]    // open trades
orders: Order[]          // pending orders
symbols: Symbol[]        // the list of tradable instruments
```

Each has a matching `load*` function:

- `loadAccounts()` → calls `api.getMyAccounts()`
- `loadPositions()` → calls `api.getPositions(activeAccountId)`
- `loadOrders()` → calls `api.getOrders(activeAccountId)`
- `loadSymbols()` → calls `api.getSymbols()`

These are called once when the app boots, and again when the relevant thing changes (e.g. when you place an order, `loadOrders()` is called to get the updated list).

**`loadAccounts` has a special trick:** after fetching accounts, if none is currently selected (or the selected one no longer exists), it auto-picks the first one:

```ts
if (!currentValid && accounts.length > 0) {
  const firstAccountId = accounts[0]?.id;
  if (firstAccountId) get().setActiveAccount(firstAccountId);
}
```

It also registers all account IDs with the WebSocket client so you get live equity updates for every account you own.

### Group C: Live ticking prices

These are the fields the WebSocket fills in:

```ts
ticks: Record<string, TickEntry>              // "delayed" prices (what you see)
liveTicks: Record<string, TickEntry>          // raw prices (for HFT accounts)
liveCandleUpdates: Record<string, CandleBar>  // the currently-forming candle
```

`TickEntry` looks like:

```ts
{
  bid: 189.45,
  ask: 189.47,
  timestamp: 1726000000000,
  bidFmt: "189.45",   // ← pre-formatted string
  askFmt: "189.47",
}
```

**Why both raw numbers and formatted strings?** Because formatting on every render is slow. If 200 ticks arrive per second and each component calls `bid.toFixed(2)` on every tick, you waste CPU. So the store formats **once** when the tick arrives, and components just display the string.

The decimals come from the symbol's `tickSize`. Look at `_pipDecimals`:

```ts
function _pipDecimals(tickSize?: number | null): number {
  if (!tickSize) return 5;
  const s = String(tickSize);
  const dot = s.indexOf(".");
  return dot >= 0 ? s.length - dot - 1 : 2;
}
```

If `tickSize` is `0.01`, `String(0.01)` is `"0.01"`, there's a dot at index 1, and `"0.01".length - 1 - 1 = 2`. So 2 decimal places. If tick size is `0.0001`, you get 4 decimals. **This is why getting the tick sizes right in your SYMBOLS array matters** — pick the wrong value and every price on screen will show the wrong number of decimals.

### Group D: The requestAnimationFrame (RAF) buffering

Here's the code that makes the app not freeze:

```ts
if (_tickRafId === null) {
  _tickRafId = requestAnimationFrame(() => {
    const updates = Object.fromEntries(_pendingTicks);
    _pendingTicks.clear();
    _tickRafId = null;
    set((s) => ({ ticks: { ...s.ticks, ...updates } }));
  });
}
```

**The problem:** WebSocket ticks can arrive 500+ times per second. If every tick called `set()`, every component subscribed to `ticks` would re-render 500 times per second. The app would melt.

**The fix:** ticks are collected in a temporary holding area (`_pendingTicks`). Then once per animation frame (typically 60 times per second — the browser's render rate), all pending ticks are flushed into the store in one `set()` call. Components re-render at most 60 times per second instead of 500.

Think of it like a mailbox: mail carriers don't interrupt you every time a letter arrives. They drop it in the box, and you check the box every so often. Same idea.

There's also a **deduplication check**: if the new tick has the same bid/ask as the last one and an older timestamp, it's skipped. No point re-rendering for a price that hasn't changed.

### Group E: Replay mode

```ts
replayVersion: number
isReplaying: boolean
replayPaused: boolean
replaySpeed: number
replayCursorTimestamp: number | null
replaySessionDate: string | null
```

When you use the "replay" feature (replay a historical trading session), these fields track it. `replayVersion` is a number that gets bumped every time a replay action happens — the chart uses it as a cache key so React Query knows to throw away old data and refetch.

You can ignore all of this unless you're implementing replay yourself.

---

## Part 4: The WebSocket reconnect hook (bottom of the file)

```ts
let wasWsConnected = wsClient.state === "connected";
wsClient.onStateChange((state) => {
  if (state === "connected" && !wasWsConnected) {
    const accountIds = useTradingStore.getState().accounts.map((a) => a.id);
    if (accountIds.length > 0) wsClient.subscribeAccounts(accountIds);
  }
  wasWsConnected = state === "connected";
});
```

This is a **watchdog**. When the WebSocket reconnects (after a network blip, for example), the store re-subscribes to all account channels. Without this, you'd lose live position updates after every reconnect because the subscription would be silently gone.

**You don't need to touch this.** If your `ws.ts` stub does nothing, this code just never fires — which is fine.

---

## Part 5: The mental model, all together

Think of the store as a **library checkout desk**:

- **`localStorage`** is the drawer where the important stuff (tokens, user) is kept even when the lights go out.
- **The store** is the whiteboard in the middle of the room. It holds what's currently being used.
- **Components** are people who look at the whiteboard. When something on it changes, everyone watching that line looks again.
- **The API** is the phone. The store picks it up when it needs new data (load accounts, place order, etc.).
- **The WebSocket** is the loudspeaker. It shouts new prices at the store continuously.

The store is the pivot point. Everything passes through it. The API fills it in bulk. The WebSocket trickles in updates. Components only ever read from it.

---

## Part 6: What this means for YOU, wiring a backend

You're replacing `api`. That means you're changing **where the store fetches from**. Here's what happens step by step when a real user opens the app:

1. **Boot** — `restoreSession()` is called. If a token exists, the app is "logged in." If not, the login screen shows.
2. **Login** — user clicks "demoLogin" (or logs in properly). `api.demoLogin()` returns tokens. The store saves them, and tells `wsClient.connect()`.
3. **Load basics** — `loadAccounts()`, `loadSymbols()`, `loadPositions()`, `loadOrders()` are called. These hit your `api` methods.
4. **Load a chart** — the chart component reads `selectedSymbol` from the store, calls `api.getCandles(symbol, timeframe)`. **This is your method.** It fetches from your `/api/stocks`, translates, returns candles. The chart draws them.
5. **Live ticking** — WebSocket events arrive and update `ticks` and `liveCandleUpdates`. If you leave the WS stubbed, this step does nothing and your chart just shows the static candles from step 4.

**The minimum to make the app work with a real backend:**

- `demoLogin` → return `{ accessToken, refreshToken, user }`
- `getMyAccounts` → return `[{ id, ... }]`
- `getSymbols` → return your `SYMBOLS` array
- `getCandles` → your real implementation
- Everything else can stay on the demo

The store itself works fine with any backend, as long as these return the right shapes. **You don't modify the store at all.** You modify `api.ts` (which the store calls) and your server (which `api.ts` calls).

---

## Part 7: The three commands you need

**"Which methods does the store call on `api`?"**

```bash
grep -o "api\.[a-zA-Z]*" src/store.tsx | sort -u
```

**"Where is `selectedSymbol` read?"**

```bash
grep -rn "selectedSymbol" src --include="*.tsx" | grep -v "store.tsx"
```

**"Where is it written?"**

```bash
grep -rn "setSelectedSymbol" src --include="*.tsx"
```

Those three cover 90% of what you'll ever need to know about this file.

---

## TL;DR

- **Two stores.** One holds who you are (auth). One holds what's on screen (trading).
- **The store is the middleman.** Components read from it. `api` fills it. WebSocket updates it.
- **`selectedSymbol` lives in the store, not in `api`.** The chart reads it and passes it to `getCandles`. You never manage it yourself.
- **`getCandles` is the only thing you have to build.** The rest of the store will work the moment you give it the demo's stubs, and get better as you replace them.
- **Tick sizes matter** because the store uses them to format every price on screen. Wrong tick size → wrong decimals everywhere.
- **Never touch the RAF buffering, the token refresh, or the reconnect watchdog.** They're optimizations that work correctly without your involvement.