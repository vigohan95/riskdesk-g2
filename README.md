# RiskDesk for Even Realities G2

See your crypto risk on the glasses, act with one tap, and get 5 seconds to take it back.

Heads Up: Even Realities G2 hackathon, track 03 Exchanges & Stocks (Coinbase).

![PnL page, live Coinbase prices](docs/shots/day1_pnl_en.png)

## What works today (Day 1-2)

- **Live Coinbase prices** over the public Advanced Trade WebSocket (`ticker` + `heartbeats`, no API key).
  The backend sends the glasses at most one update per second, and only when a number on screen would change.
- **Never shows an old price as live.** No heartbeat for 3 s, a dropped message (sequence gap), or a lost backend
  connection all switch the 24h column to `old`, dim the prices and say so in the footer.
- **Paper portfolio with honest PnL**: FIFO lots, 0.8% fee on every fill, positions marked at the price you could
  actually exit at (long -> best bid, short -> best ask) minus the exit fee. Day PnL runs from 00:00 UTC.
- **Demo portfolio priced at real history**: the seed fills (0.02 BTC bought 70 h ago, 0.75 ETH in two buys) are
  priced at the real Coinbase 1-minute candle of that moment, fetched at startup. Nothing on screen is made up.
- English and Chinese (double-tap toggles).

| Live | Backend lost |
|---|---|
| ![zh](docs/shots/day1_pnl_zh.png) | ![offline](docs/shots/day1_offline_zh.png) |

Screenshots are the simulator's 576x288 glasses buffer, drawn green-on-black at 2x.

### One-tap actions with a 5-second undo (Day 2)

Open the glasses' context menu on the positions page: **Halve BTC / Close BTC / Halve ETH / Close ETH / language**.

1. **Confirm page** - what will be sold, at roughly which price (bid for a sell, ask for a buy), the fee, what you get,
   and the position before -> after. Every number comes from the backend; the glasses only lay it out.
   Tap = confirm, double-tap = back.
2. **Undo page** - nothing has been sent yet. Five dots count down once per second; tap anywhere to undo.
3. **Result page** - after the window one Coinbase Advanced Trade *Create Order* request goes out
   (public sandbox by default) with `client_order_id` = the action id, so a double tap or a retry can never create two orders.
   The fill is booked in the paper ledger at the bid/ask *at execution time*, and the page says it was a sandbox order.

Safety checks at confirm time: a preview older than 30 s, or whose price moved more than 1%, is refused
("look again") instead of executed. Only one action can be armed at a time. The context menu exists only on the
positions page, so it can never open on top of a confirm or undo page.

| Context menu | Confirm | Undo window |
|---|---|---|
| ![menu](docs/shots/day2_menu_en.png) | ![confirm](docs/shots/day2_confirm_en.png) | ![undo](docs/shots/day2_undo_en.png) |

| Close ETH (zh) | Filled (sandbox) | Back on positions: ETH flat, day PnL updated |
|---|---|---|
| ![close](docs/shots/day2_confirm_close_zh.png) | ![filled](docs/shots/day2_filled_zh.png) | ![after](docs/shots/day2_after_zh.png) |

A confirm on a stale preview: ![expired](docs/shots/day2_expired_en.png)

All of the above are simulator screenshots of real runs driven by the simulator's automation API
(context_menu / down / click) against the live Coinbase feed; the backend log of the same run:

```
action 6054f04e halve BTC-USD: proposed
action 6054f04e halve BTC-USD: armed
action 6054f04e halve BTC-USD: undone
action 7a7ec95f close ETH-USD: proposed
action 7a7ec95f close ETH-USD: armed
action 7a7ec95f close ETH-USD: sending
filled SELL 0.75 ETH-USD @ 1722.8
action 7a7ec95f close ETH-USD: filled
```

## Run it

Needs Node 22.18+ (TypeScript runs natively, the backend has zero dependencies).

```bash
cd server && npm start            # http://127.0.0.1:8787  (/api/state, /api/stream, POST /api/preview|confirm|undo|dismiss)
cd app && npm install && npm run dev
npx evenhub-simulator http://127.0.0.1:5173/
```

Tests: `cd server && npm test` (ledger, feed, actions: 25 tests) and `cd app && npm test` (layout, pages, menu: 12 tests).

The demo portfolio is stored in `server/data/fills.json`; delete that file to re-seed it.

## How PnL is computed

- Unrealized = qty x (exit price - average entry) - exit fee, with exit price = best bid for longs, best ask for shorts.
- Day PnL = equity now - equity at 00:00 UTC. Equity = cash + what open positions would fetch after fees.
  The 00:00 UTC mark is the open of that minute's public Coinbase candle.
- Percent base = exposure held at 00:00 UTC (at the open price) + cost of positions opened today.
- If any held product has no live quote, day PnL shows `—`, never a stale or zero number.

## Display rules (measured in the simulator)

- A tap arrives as `CLICK_EVENT` = 0, the protobuf default, so `eventType` is usually omitted: the simulator sends `{sysEvent: {eventSource: 1}}`. Treat a missing type as a click.

- Line height 28 px; a text container needs `lines x 28 + 2 x padding` (+2 with a border) or a scrollbar appears.
- `textContainerUpgrade` changes text and brightness but never size, so the page geometry is fixed and does not depend on data.
- The font is proportional and containers have no alignment: numbers are right-aligned by left-padding with normal and
  thin (U+2009) spaces, using the firmware glyph widths from `@evenrealities/pretext` (within 1 px).
- Brightness levels 1 and 3 render only ~180 vs ~230, too subtle to carry a warning alone, hence the explicit `old` marker.

## Built during the hackathon

Code in this repository was written from 2026-11-23 08:00 UTC onward. Before that I only had research notes
(SDK/simulator behaviour, the display measurements above, Coinbase API tests, and a speech-command test set);
none of that pre-hackathon spike code is used here. Written with AI assistance (Claude), reviewed and tested by me.

## Roadmap for the week

1. ~~Confirm page + 5-second undo + sandbox orders for halve / close~~ (done Day 2); next: cancel all, stop, take-profit, price alerts.
2. Hold-to-talk voice commands (local faster-whisper) that only ever produce a confirm page.
3. Risk page: distance to stop / expiry for Coinbase futures, 24h sparkline.
4. Demo video.

## License

MIT
