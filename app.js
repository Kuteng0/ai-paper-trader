"use strict";

const state = {
  candles: [],
  trades: JSON.parse(localStorage.getItem("paperTrader.trades") || "[]"),
  best: JSON.parse(localStorage.getItem("paperTrader.best") || "null"),
  deferredPrompt: null
};

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const els = {
  installButton: $("installButton"), equityValue: $("equityValue"), pnlValue: $("pnlValue"), winRateValue: $("winRateValue"), drawdownValue: $("drawdownValue"),
  marketMode: $("marketMode"), signalCard: $("signalCard"), signalAction: $("signalAction"), signalReason: $("signalReason"), dataStatus: $("dataStatus"),
  symbolInput: $("symbolInput"), intervalInput: $("intervalInput"), fetchButton: $("fetchButton"), csvInput: $("csvInput"), sampleButton: $("sampleButton"), scanButton: $("scanButton"),
  capitalInput: $("capitalInput"), riskInput: $("riskInput"), dailyLossInput: $("dailyLossInput"), maxHoldInput: $("maxHoldInput"), resetButton: $("resetButton"),
  runButton: $("runButton"), optimizeButton: $("optimizeButton"), tradeCount: $("tradeCount"), netProfit: $("netProfit"), avgR: $("avgR"), profitFactor: $("profitFactor"), bestParams: $("bestParams"), tradeLog: $("tradeLog"), exportButton: $("exportButton")
};

const instruments = {
  "ES=F": { name: "S&P 500 futures ES", range: "60d", profile: "Core test market. Liquid and usually cleaner than most products." },
  "NQ=F": { name: "Nasdaq futures NQ", range: "60d", profile: "High opportunity, high volatility. Use strict stops." },
  "YM=F": { name: "Dow futures YM", range: "60d", profile: "Slower index rhythm, useful as secondary market." },
  "GC=F": { name: "Gold futures GC", range: "60d", profile: "Good Asia and US-session activity. Sensitive to USD and rates." },
  "CL=F": { name: "Crude oil futures CL", range: "60d", profile: "Active but news-sensitive. Watch inventory days." },
  "NG=F": { name: "Natural gas futures NG", range: "60d", profile: "Extreme volatility. Not recommended as first live market." },
  "^N225": { name: "Nikkei 225 index", range: "60d", profile: "Useful reference for Japan 225 CFD, but not the same quote." }
};

const defaultStrategy = { fast: 8, slow: 21, rsiFloor: 42, rsiCeil: 58, stopAtr: 1.4, takeProfitR: 1.8 };

function settings() {
  return {
    capital: Number(els.capitalInput.value) || 50000,
    riskPct: Number(els.riskInput.value) || 0.5,
    dailyLossPct: Number(els.dailyLossInput.value) || 1,
    maxHold: Number(els.maxHoldInput.value) || 18,
    strategy: state.best?.strategy || defaultStrategy
  };
}

async function fetchHistory(symbol, interval) {
  const range = instruments[symbol]?.range || "60d";
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${range}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Market data request failed.");
  if (!data.candles?.length) throw new Error("No usable bars returned.");
  return data;
}

function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map(splitCsvLine);
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const idx = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);
  const timeI = idx(["time", "date", "datetime", "timestamp"]), openI = idx(["open", "o"]), highI = idx(["high", "h"]), lowI = idx(["low", "l"]), closeI = idx(["close", "c", "adj close"]);
  if ([openI, highI, lowI, closeI].some((i) => i === undefined)) throw new Error("CSV needs open/high/low/close columns.");
  return rows.map((row, i) => ({ time: row[timeI] || String(i + 1), open: Number(row[openI]), high: Number(row[highI]), low: Number(row[lowI]), close: Number(row[closeI]) })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

function splitCsvLine(line) {
  const out = []; let cell = ""; let quote = false;
  for (const char of line) { if (char === "\"") quote = !quote; else if (char === "," && !quote) { out.push(cell); cell = ""; } else cell += char; }
  out.push(cell); return out;
}

function ema(values, period) { const k = 2 / (period + 1); const out = []; values.forEach((v, i) => out[i] = i === 0 ? v : v * k + out[i - 1] * (1 - k)); return out; }
function rsi(values, period) {
  const out = Array(values.length).fill(50); let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) { const change = values[i] - values[i - 1], gain = Math.max(0, change), loss = Math.max(0, -change); if (i <= period) { gains += gain; losses += loss; } else { gains = (gains * (period - 1) + gain) / period; losses = (losses * (period - 1) + loss) / period; const rs = losses === 0 ? 100 : gains / losses; out[i] = 100 - 100 / (1 + rs); } }
  return out;
}
function atr(candles, period) {
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  return ema(tr, period);
}
function indicators(candles, strategy) { const closes = candles.map((c) => c.close); return { emaFast: ema(closes, strategy.fast), emaSlow: ema(closes, strategy.slow), rsi: rsi(closes, 14), atr: atr(candles, 14) }; }

function signalAt(i, candles, ind, strategy) {
  if (i < Math.max(strategy.slow, 20)) return null;
  const prevFast = ind.emaFast[i - 1], prevSlow = ind.emaSlow[i - 1], fast = ind.emaFast[i], slow = ind.emaSlow[i], momentum = candles[i].close - candles[i - 3].close;
  if (prevFast <= prevSlow && fast > slow && ind.rsi[i] >= strategy.rsiCeil && momentum > 0) return "long";
  if (prevFast >= prevSlow && fast < slow && ind.rsi[i] <= strategy.rsiFloor && momentum < 0) return "short";
  return null;
}

function runSimulation(candles, cfg) {
  const strategy = cfg.strategy, ind = indicators(candles, strategy), trades = [];
  let equity = cfg.capital, peak = equity, maxDrawdown = 0, dailyLoss = 0, dayKey = "", lockedDay = false;
  for (let i = Math.max(strategy.slow, 20); i < candles.length - 2; i++) {
    const currentDay = String(candles[i].time).slice(0, 10);
    if (currentDay !== dayKey) { dayKey = currentDay; dailyLoss = 0; lockedDay = false; }
    if (lockedDay) continue;
    const side = signalAt(i, candles, ind, strategy); if (!side) continue;
    const entryIndex = i + 1, entry = candles[entryIndex].open, stopDistance = Math.max(ind.atr[i] * strategy.stopAtr, entry * 0.001), riskAmount = equity * (cfg.riskPct / 100), quantity = Math.max(1, Math.floor(riskAmount / stopDistance));
    const stop = side === "long" ? entry - stopDistance : entry + stopDistance, target = side === "long" ? entry + stopDistance * strategy.takeProfitR : entry - stopDistance * strategy.takeProfitR;
    const exit = findExit(candles, entryIndex, side, stop, target, cfg.maxHold), pnlPer = side === "long" ? exit.price - entry : entry - exit.price, pnl = pnlPer * quantity, rValue = pnl / Math.max(riskAmount, 1);
    equity += pnl; if (pnl < 0) dailyLoss += Math.abs(pnl); if (dailyLoss >= cfg.capital * (cfg.dailyLossPct / 100)) lockedDay = true; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    trades.push({ id: `${Date.now()}-${trades.length}`, side, entryTime: candles[entryIndex].time, exitTime: candles[exit.index].time, entry, exit: exit.price, stop, target, quantity, pnl, rValue, reason: exit.reason, strategy: { ...strategy } });
    i = exit.index;
  }
  return summarize(cfg.capital, equity, maxDrawdown, trades);
}

function findExit(candles, entryIndex, side, stop, target, maxHold) {
  const end = Math.min(candles.length - 1, entryIndex + maxHold);
  for (let i = entryIndex + 1; i <= end; i++) { const c = candles[i]; if (side === "long") { if (c.low <= stop) return { index: i, price: stop, reason: "Stop" }; if (c.high >= target) return { index: i, price: target, reason: "Target" }; } else { if (c.high >= stop) return { index: i, price: stop, reason: "Stop" }; if (c.low <= target) return { index: i, price: target, reason: "Target" }; } }
  return { index: end, price: candles[end].close, reason: "Timeout" };
}

function summarize(capital, equity, maxDrawdown, trades) {
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0), grossWin = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return { capital, equity, netProfit: equity - capital, maxDrawdown, trades, winRate: trades.length ? wins.length / trades.length : 0, avgR: trades.length ? trades.reduce((s, t) => s + t.rValue, 0) / trades.length : 0, profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? 99 : 0 };
}

function optimize() {
  if (state.candles.length < 80) throw new Error("Need at least 80 bars to optimize.");
  const split = Math.floor(state.candles.length * 0.7), train = state.candles.slice(0, split), test = state.candles.slice(split - 40), grid = [];
  for (const fast of [5, 8, 12]) for (const slow of [18, 21, 34]) if (fast < slow) for (const stopAtr of [1.1, 1.4, 1.8]) for (const takeProfitR of [1.3, 1.8, 2.2]) grid.push({ fast, slow, rsiFloor: 42, rsiCeil: 58, stopAtr, takeProfitR });
  const cfg = settings();
  const scored = grid.map((strategy) => { const trainResult = runSimulation(train, { ...cfg, strategy }), testResult = runSimulation(test, { ...cfg, strategy }); return { strategy, trainResult, testResult, score: testResult.netProfit - testResult.maxDrawdown * cfg.capital * 1.5 + testResult.avgR * 300 }; }).filter((x) => x.testResult.trades.length >= 3).sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error("No parameter set had enough test trades.");
  state.best = scored[0]; localStorage.setItem("paperTrader.best", JSON.stringify(state.best)); return state.best;
}

function makeSampleCandles() {
  const candles = []; let price = 38500; const start = new Date("2026-01-05T21:00:00+09:00").getTime();
  for (let i = 0; i < 260; i++) { const wave = Math.sin(i / 11) * 45 + Math.sin(i / 31) * 90, trend = i < 120 ? i * 2.2 : 260 - i * 1.4, shock = Math.sin(i * 2.31) * 28, open = price, close = Math.max(100, open + wave * 0.09 + trend * 0.015 + shock), high = Math.max(open, close) + 24 + Math.abs(Math.sin(i)) * 30, low = Math.min(open, close) - 24 - Math.abs(Math.cos(i)) * 30; price = close; candles.push({ time: new Date(start + i * 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16), open: round(open), high: round(high), low: round(low), close: round(close) }); }
  return candles;
}
function round(v) { return Math.round(v * 10) / 10; }

function updateSignal() {
  if (!state.candles.length) return;
  const cfg = settings(), ind = indicators(state.candles, cfg.strategy), i = state.candles.length - 1, lastSignal = signalAt(i, state.candles, ind, cfg.strategy);
  els.marketMode.textContent = ind.emaFast[i] > ind.emaSlow[i] ? "Bullish bias" : "Bearish bias";
  els.signalCard.className = `signal-card ${lastSignal || "neutral"}`;
  els.signalAction.textContent = lastSignal === "long" ? "Long candidate" : lastSignal === "short" ? "Short candidate" : "Wait for signal";
  els.signalReason.textContent = `RSI ${ind.rsi[i].toFixed(1)}, ATR ${ind.atr[i].toFixed(1)}. Simulation only, no real account connection.`;
}

function render(result = null) {
  const capital = Number(els.capitalInput.value) || 50000, trades = result?.trades || state.trades, pnl = trades.reduce((s, t) => s + t.pnl, 0), wins = trades.filter((t) => t.pnl > 0).length, winRate = trades.length ? wins / trades.length : 0, maxDrawdown = result?.maxDrawdown || 0, avgR = trades.length ? trades.reduce((s, t) => s + t.rValue, 0) / trades.length : 0, grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  els.equityValue.textContent = money.format(capital + pnl); els.pnlValue.textContent = money.format(pnl); els.pnlValue.style.color = pnl >= 0 ? "var(--green)" : "var(--red)"; els.winRateValue.textContent = `${Math.round(winRate * 100)}%`; els.drawdownValue.textContent = `${(maxDrawdown * 100).toFixed(1)}%`; els.dataStatus.textContent = `${state.candles.length} bars`; els.tradeCount.textContent = `${trades.length} trades`; els.netProfit.textContent = money.format(pnl); els.avgR.textContent = avgR.toFixed(2); els.profitFactor.textContent = (grossLoss ? grossWin / grossLoss : grossWin ? 99 : 0).toFixed(2); els.bestParams.textContent = state.best ? `EMA ${state.best.strategy.fast}/${state.best.strategy.slow}, SL ${state.best.strategy.stopAtr}ATR` : "None";
  els.tradeLog.innerHTML = trades.length ? trades.slice().reverse().slice(0, 60).map((t) => `<div class="trade-item"><div><strong>${t.side.toUpperCase()} ${t.reason}</strong><span>${t.entryTime} to ${t.exitTime}</span><small>Entry ${t.entry.toFixed(1)} / Exit ${t.exit.toFixed(1)} / Qty ${t.quantity}</small></div><strong class="${t.pnl >= 0 ? "profit" : "loss"}">${money.format(t.pnl)}</strong></div>`).join("") : `<p class="empty">No simulated trades yet.</p>`;
  updateSignal();
}

async function loadSelectedHistory() { const symbol = els.symbolInput.value, interval = els.intervalInput.value; els.signalAction.textContent = "Fetching data"; els.signalReason.textContent = "Cloudflare Function is requesting historical bars."; const data = await fetchHistory(symbol, interval); state.candles = data.candles; els.signalAction.textContent = `${data.label} loaded`; els.signalReason.textContent = `${data.interval} / ${data.range}, ${data.candles.length} bars. ${instruments[symbol]?.profile || ""}`; render(); }
async function scanMarkets() {
  els.signalAction.textContent = "Scanning markets"; els.signalReason.textContent = "Fetching, optimizing and ranking supported markets.";
  const interval = els.intervalInput.value, symbols = ["ES=F", "NQ=F", "GC=F", "CL=F", "^N225", "YM=F", "NG=F"], cfg = settings(), results = [];
  for (const symbol of symbols) { try { const data = await fetchHistory(symbol, interval), prevCandles = state.candles, prevBest = state.best; state.candles = data.candles; const best = optimize(), result = runSimulation(data.candles, { ...cfg, strategy: best.strategy }); results.push({ symbol, label: data.label, result, best }); state.candles = prevCandles; state.best = prevBest; } catch (error) { results.push({ symbol, label: instruments[symbol]?.name || symbol, error: error.message }); } }
  const ranked = results.filter((x) => x.result && x.result.trades.length >= 5).sort((a, b) => (b.result.netProfit - b.result.maxDrawdown * cfg.capital * 2 + b.result.profitFactor * 100) - (a.result.netProfit - a.result.maxDrawdown * cfg.capital * 2 + a.result.profitFactor * 100));
  if (!ranked.length) throw new Error("No market had enough test trades.");
  const top = ranked[0]; els.symbolInput.value = top.symbol; state.candles = (await fetchHistory(top.symbol, interval)).candles; state.best = top.best; localStorage.setItem("paperTrader.best", JSON.stringify(state.best)); const finalResult = runSimulation(state.candles, { ...cfg, strategy: top.best.strategy }); saveTrades(finalResult.trades); els.signalAction.textContent = `Top market: ${top.label}`; els.signalReason.textContent = ranked.slice(0, 3).map((x, i) => `${i + 1}. ${x.label} net ${money.format(x.result.netProfit)} win ${Math.round(x.result.winRate * 100)}% dd ${(x.result.maxDrawdown * 100).toFixed(1)}%`).join(" / "); render(finalResult);
}
function saveTrades(trades) { state.trades = trades; localStorage.setItem("paperTrader.trades", JSON.stringify(trades)); }
function showError(error) { els.signalCard.className = "signal-card neutral"; els.signalAction.textContent = "Error"; els.signalReason.textContent = error.message || String(error); }

els.csvInput.addEventListener("change", async (event) => { try { const file = event.target.files[0]; if (!file) return; state.candles = parseCsv(await file.text()); render(); } catch (e) { showError(e); } });
els.fetchButton.addEventListener("click", async () => { try { await loadSelectedHistory(); } catch (e) { showError(e); } });
els.sampleButton.addEventListener("click", () => { state.candles = makeSampleCandles(); render(); });
els.runButton.addEventListener("click", () => { try { if (!state.candles.length) state.candles = makeSampleCandles(); const result = runSimulation(state.candles, settings()); saveTrades(result.trades); render(result); } catch (e) { showError(e); } });
els.optimizeButton.addEventListener("click", () => { try { if (!state.candles.length) state.candles = makeSampleCandles(); const best = optimize(); const result = runSimulation(state.candles, settings()); saveTrades(result.trades); els.signalAction.textContent = "Optimization complete"; els.signalReason.textContent = `Test net ${money.format(best.testResult.netProfit)}, trades ${best.testResult.trades.length}.`; render(result); } catch (e) { showError(e); } });
els.scanButton.addEventListener("click", async () => { try { await scanMarkets(); } catch (e) { showError(e); } });
els.resetButton.addEventListener("click", () => { localStorage.removeItem("paperTrader.trades"); localStorage.removeItem("paperTrader.best"); state.trades = []; state.best = null; render(); });
els.exportButton.addEventListener("click", () => { const header = "side,entryTime,exitTime,entry,exit,quantity,pnl,rValue,reason\n"; const body = state.trades.map((t) => [t.side, t.entryTime, t.exitTime, t.entry, t.exit, t.quantity, t.pnl.toFixed(2), t.rValue.toFixed(3), t.reason].join(",")).join("\n"); const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "paper-trades.csv"; a.click(); URL.revokeObjectURL(url); });
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredPrompt = event; els.installButton.hidden = false; });
els.installButton.addEventListener("click", async () => { if (!state.deferredPrompt) return; state.deferredPrompt.prompt(); await state.deferredPrompt.userChoice; state.deferredPrompt = null; els.installButton.hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
render();
