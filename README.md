# AI Paper Trader

An iPhone-friendly paper trading PWA for futures and index simulation. It runs in Safari, can be added to the iPhone home screen, and uses a Cloudflare Pages Function to fetch historical market data.

## Features

- Fetch historical bars through Cloudflare Pages Functions
- Simulate trades with EMA, RSI, ATR, stop-loss and take-profit rules
- Optimize strategy parameters with a train/test split
- Scan ES, NQ, YM, GC, CL, NG and Nikkei 225 reference data
- Save paper trade results in browser local storage
- Export trade logs as CSV

## Cloudflare Pages Settings

Use these settings when connecting this GitHub repository to Cloudflare Pages:

```text
Framework preset: None
Build command: leave empty
Build output directory: .
Root directory: /
```

Cloudflare should automatically detect the `functions/api/history.js` Pages Function.

## Important Limits

- This is simulation software, not financial advice.
- It does not connect to a real trading account.
- Yahoo Finance chart data is suitable for research and simulation, not live execution.
- A good backtest does not guarantee future profit.
- Do not use real money until the system has enough out-of-sample paper trading history.

## Suggested Paper Trading Gate

Before following with small real capital, require at least:

- 1 month of paper trading
- 30 or more trades
- Max drawdown below 5%
- Profit factor above 1.2
- No martingale or loss-averaging behavior
- Every real trade uses a stop or OCO order
