"use strict";

const SYMBOLS = ["ES=F", "NQ=F", "GC=F", "CL=F", "^N225", "YM=F", "NG=F"];

const state = {
  candles: [],
  trades: JSON.parse(localStorage.getItem("paperTrader.trades") || "[]"),
  best: JSON.parse(localStorage.getItem("paperTrader.best") || "null"),
  learning: JSON.parse(localStorage.getItem("paperTrader.learning") || "[]"),
  feedback: [],
  deferredPrompt: null
};

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const els = {
  installButton: $("installButton"), equityValue: $("equityValue"), pnlValue: $("pnlValue"), winRateValue: $("winRateValue"), drawdownValue: $("drawdownValue"),
  marketMode: $("marketMode"), signalCard: $("signalCard"), signalAction: $("signalAction"), signalReason: $("signalReason"), dataStatus: $("dataStatus"),
  symbolInput: $("symbolInput"), intervalInput: $("intervalInput"), fetchButton: $("fetchButton"), csvInput: $("csvInput"), sampleButton: $("sampleButton"), scanButton: $("scanButton"),
  capitalInput: $("capitalInput"), riskInput: $("riskInput"), dailyLossInput: $("dailyLossInput"), maxHoldInput: $("maxHoldInput"), resetButton: $("resetButton"),
  runButton: $("runButton"), optimizeButton: $("optimizeButton"), randomLearnButton: $("randomLearnButton"), learnCount: $("learnCount"), feedbackLog: $("feedbackLog"),
  tradeCount: $("tradeCount"), netProfit: $("netProfit"), avgR: $("avgR"), profitFactor: $("profitFactor"), bestParams: $("bestParams"), leaderboard: $("leaderboard"), clearBoardButton: $("clearBoardButton"),
  tradeLog: $("tradeLog"), exportButton: $("exportButton")
};

const instruments = {
  "ES=F": { name: "标普500期货 ES", range: "60d", profile: "流动性强、节奏相对稳定，建议作为核心模拟品种。" },
  "NQ=F": { name: "纳指期货 NQ", range: "60d", profile: "机会多但波动大，必须严格止损。" },
  "YM=F": { name: "道指期货 YM", range: "60d", profile: "波动节奏较慢，可作为辅助测试品种。" },
  "GC=F": { name: "黄金期货 GC", range: "60d", profile: "亚洲和美国时段都有机会，受美元和利率预期影响明显。" },
  "CL=F": { name: "原油期货 CL", range: "60d", profile: "波动活跃，但库存数据和地缘新闻会带来跳动。" },
  "NG=F": { name: "天然气期货 NG", range: "60d", profile: "波动极端，不建议作为小资金第一实盘品种。" },
  "^N225": { name: "日经225指数", range: "60d", profile: "适合参考日本225方向，但指数数据不等于CFD报价。" }
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
  if (!res.ok) throw new Error(data.error || "行情获取失败。");
  if (!data.candles?.length) throw new Error("没有取得可用K线。");
  return data;
}

function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map(splitCsvLine);
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const idx = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0);
  const timeI = idx(["time", "date", "datetime", "timestamp"]), openI = idx(["open", "o"]), highI = idx(["high", "h"]), lowI = idx(["low", "l"]), closeI = idx(["close", "c", "adj close"]);
  if ([openI, highI, lowI, closeI].some((i) => i === undefined)) throw new Error("CSV需要 open/high/low/close 列。");
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
  for (let i = entryIndex + 1; i <= end; i++) { const c = candles[i]; if (side === "long") { if (c.low <= stop) return { index: i, price: stop, reason: "止损" }; if (c.high >= target) return { index: i, price: target, reason: "止盈" }; } else { if (c.high >= stop) return { index: i, price: stop, reason: "止损" }; if (c.low <= target) return { index: i, price: target, reason: "止盈" }; } }
  return { index: end, price: candles[end].close, reason: "超时离场" };
}

function summarize(capital, equity, maxDrawdown, trades) {
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0), grossWin = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return { capital, equity, netProfit: equity - capital, maxDrawdown, trades, winRate: trades.length ? wins.length / trades.length : 0, avgR: trades.length ? trades.reduce((s, t) => s + t.rValue, 0) / trades.length : 0, profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? 99 : 0 };
}

function optimize() {
  if (state.candles.length < 80) throw new Error("至少需要80根K线才能自主学习。");
  const split = Math.floor(state.candles.length * 0.7), train = state.candles.slice(0, split), test = state.candles.slice(split - 40), grid = [];
  for (const fast of [5, 8, 12]) for (const slow of [18, 21, 34]) if (fast < slow) for (const stopAtr of [1.1, 1.4, 1.8]) for (const takeProfitR of [1.3, 1.8, 2.2]) grid.push({ fast, slow, rsiFloor: 42, rsiCeil: 58, stopAtr, takeProfitR });
  const cfg = settings();
  const scored = grid.map((strategy) => { const trainResult = runSimulation(train, { ...cfg, strategy }), testResult = runSimulation(test, { ...cfg, strategy }); return { strategy, trainResult, testResult, score: scoreResult(testResult, cfg.capital) }; }).filter((x) => x.testResult.trades.length >= 3).sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error("没有找到交易次数足够的参数组合。请换更长周期或其他品种。");
  state.best = scored[0]; localStorage.setItem("paperTrader.best", JSON.stringify(state.best)); return state.best;
}

function randomStrategy() {
  const fast = randomInt(4, 16);
  const slow = randomInt(Math.max(18, fast + 4), 55);
  return { fast, slow, rsiFloor: randomInt(35, 48), rsiCeil: randomInt(52, 65), stopAtr: randomFloat(0.9, 2.4), takeProfitR: randomFloat(1.1, 3.0) };
}
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomFloat(min, max) { return Math.round((min + Math.random() * (max - min)) * 10) / 10; }
function scoreResult(result, capital) { return result.winRate * 1000 + result.profitFactor * 80 + result.avgR * 120 + result.netProfit / Math.max(1, capital) * 500 - result.maxDrawdown * 700; }

function makeRecord(symbol, interval, result, strategy, source) {
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time: new Date().toLocaleString("ja-JP"), symbol, label: instruments[symbol]?.name || symbol, interval, source, trades: result.trades.length, winRate: result.winRate, netProfit: result.netProfit, maxDrawdown: result.maxDrawdown, profitFactor: result.profitFactor, avgR: result.avgR, strategy };
}
function saveLearningRecord(record) {
  if (record.trades < 3) return;
  state.learning.push(record);
  state.learning = state.learning.slice(-300);
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
}
function topRecords() {
  return state.learning.slice().filter((r) => r.trades >= 3).sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades) || (b.profitFactor - a.profitFactor) || (b.netProfit - a.netProfit)).slice(0, 10);
}

async function randomLearnAllMarkets() {
  const interval = els.intervalInput.value;
  const cfg = settings();
  const allResults = [];
  setBusy(true);
  addFeedback("开始全品种随机学习：系统会逐个品种获取行情并测试随机参数。", true);
  try {
    for (const symbol of SYMBOLS) {
      addFeedback(`正在获取 ${instruments[symbol].name} 的${interval}行情...`);
      const data = await fetchHistory(symbol, interval);
      let bestForSymbol = null;
      const strategies = [defaultStrategy, ...Array.from({ length: 14 }, randomStrategy)];
      addFeedback(`${data.label} 已取得 ${data.candles.length} 根K线，开始随机模拟 ${strategies.length} 组参数。`);
      for (const strategy of strategies) {
        const result = runSimulation(data.candles, { ...cfg, strategy });
        if (result.trades.length < 3) continue;
        const record = makeRecord(symbol, interval, result, strategy, "随机学习");
        saveLearningRecord(record);
        const scored = { symbol, data, result, strategy, record, score: scoreResult(result, cfg.capital) };
        allResults.push(scored);
        if (!bestForSymbol || scored.score > bestForSymbol.score) bestForSymbol = scored;
      }
      if (bestForSymbol) {
        addFeedback(`${data.label} 完成：最佳胜率 ${pct(bestForSymbol.result.winRate)}，交易 ${bestForSymbol.result.trades.length} 笔，净利 ${money.format(bestForSymbol.result.netProfit)}。`);
      } else {
        addFeedback(`${data.label} 完成：本轮交易次数不足，未计入排行榜。`);
      }
      renderLeaderboard();
    }
    if (!allResults.length) throw new Error("本轮没有产生足够交易次数的模拟结果。");
    const best = allResults.sort((a, b) => b.score - a.score)[0];
    state.candles = best.data.candles;
    state.best = { strategy: best.strategy, trainResult: best.result, testResult: best.result, score: best.score };
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(best.result.trades);
    els.symbolInput.value = best.symbol;
    render(best.result);
    addFeedback(`学习完成：当前采用 ${best.data.label} 的最佳参数，胜率 ${pct(best.result.winRate)}，排行榜已更新。`, true);
  } catch (error) {
    showError(error);
    addFeedback(`学习失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

function makeSampleCandles() {
  const candles = []; let price = 38500; const start = new Date("2026-01-05T21:00:00+09:00").getTime();
  for (let i = 0; i < 260; i++) { const wave = Math.sin(i / 11) * 45 + Math.sin(i / 31) * 90, trend = i < 120 ? i * 2.2 : 260 - i * 1.4, shock = Math.sin(i * 2.31) * 28, open = price, close = Math.max(100, open + wave * 0.09 + trend * 0.015 + shock), high = Math.max(open, close) + 24 + Math.abs(Math.sin(i)) * 30, low = Math.min(open, close) - 24 - Math.abs(Math.cos(i)) * 30; price = close; candles.push({ time: new Date(start + i * 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16), open: round(open), high: round(high), low: round(low), close: round(close) }); }
  return candles;
}
function round(v) { return Math.round(v * 10) / 10; }
function pct(value) { return `${Math.round(value * 100)}%`; }

function updateSignal() {
  if (!state.candles.length) return;
  const cfg = settings(), ind = indicators(state.candles, cfg.strategy), i = state.candles.length - 1, lastSignal = signalAt(i, state.candles, ind, cfg.strategy);
  els.marketMode.textContent = ind.emaFast[i] > ind.emaSlow[i] ? "偏多趋势" : "偏空趋势";
  els.signalCard.className = `signal-card ${lastSignal || "neutral"}`;
  els.signalAction.textContent = lastSignal === "long" ? "模拟做多候选" : lastSignal === "short" ? "模拟做空候选" : "等待更清晰信号";
  els.signalReason.textContent = `最新RSI ${ind.rsi[i].toFixed(1)}，ATR ${ind.atr[i].toFixed(1)}。这里只做模拟，不连接真实账户。`;
}

function render(result = null) {
  const capital = Number(els.capitalInput.value) || 50000, trades = result?.trades || state.trades, pnl = trades.reduce((s, t) => s + t.pnl, 0), wins = trades.filter((t) => t.pnl > 0).length, winRate = trades.length ? wins / trades.length : 0, maxDrawdown = result?.maxDrawdown || 0, avgR = trades.length ? trades.reduce((s, t) => s + t.rValue, 0) / trades.length : 0, grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  els.equityValue.textContent = money.format(capital + pnl); els.pnlValue.textContent = money.format(pnl); els.pnlValue.style.color = pnl >= 0 ? "var(--green)" : "var(--red)"; els.winRateValue.textContent = pct(winRate); els.drawdownValue.textContent = `${(maxDrawdown * 100).toFixed(1)}%`; els.dataStatus.textContent = `${state.candles.length} 根K线`; els.tradeCount.textContent = `${trades.length} 笔`; els.netProfit.textContent = money.format(pnl); els.avgR.textContent = avgR.toFixed(2); els.profitFactor.textContent = (grossLoss ? grossWin / grossLoss : grossWin ? 99 : 0).toFixed(2); els.bestParams.textContent = state.best ? `EMA ${state.best.strategy.fast}/${state.best.strategy.slow}, 止损 ${state.best.strategy.stopAtr}ATR` : "暂无";
  els.tradeLog.innerHTML = trades.length ? trades.slice().reverse().slice(0, 60).map((t) => `<div class="trade-item"><div><strong>${t.side === "long" ? "做多" : "做空"} ${t.reason}</strong><span>${t.entryTime} 至 ${t.exitTime}</span><small>入场 ${t.entry.toFixed(1)} / 出场 ${t.exit.toFixed(1)} / 数量 ${t.quantity}</small></div><strong class="${t.pnl >= 0 ? "profit" : "loss"}">${money.format(t.pnl)}</strong></div>`).join("") : `<p class="empty">还没有模拟交易。</p>`;
  renderLeaderboard();
  updateSignal();
}

function renderLeaderboard() {
  els.learnCount.textContent = `${state.learning.length} 条记录`;
  const rows = topRecords();
  els.leaderboard.innerHTML = rows.length ? rows.map((r, i) => `<div class="rank-item"><div class="rank-no">${i + 1}</div><div class="rank-main"><strong>${r.label}</strong><span>${r.interval} / ${r.source} / ${r.time}</span><span>交易 ${r.trades} 笔，净利 ${money.format(r.netProfit)}，回撤 ${(r.maxDrawdown * 100).toFixed(1)}%，盈亏比 ${r.profitFactor.toFixed(2)}</span><span>参数 EMA ${r.strategy.fast}/${r.strategy.slow}，止损 ${r.strategy.stopAtr}ATR，止盈 ${r.strategy.takeProfitR}R</span></div><div class="rank-side"><span>胜率</span><strong>${pct(r.winRate)}</strong></div></div>`).join("") : `<p class="empty">还没有学习记录。</p>`;
}

function addFeedback(message, important = false) {
  state.feedback.unshift({ time: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), message, important });
  state.feedback = state.feedback.slice(0, 20);
  els.feedbackLog.innerHTML = state.feedback.map((item) => `<div class="feedback-item">${item.time} ${item.important ? "【完成】" : ""}${item.message}</div>`).join("");
  els.signalAction.textContent = message;
  els.signalReason.textContent = "详细过程已记录在操作反馈中。";
}
function setBusy(isBusy) {
  [els.fetchButton, els.sampleButton, els.scanButton, els.runButton, els.optimizeButton, els.randomLearnButton].forEach((btn) => { if (btn) btn.disabled = isBusy; });
}

async function loadSelectedHistory() {
  const symbol = els.symbolInput.value, interval = els.intervalInput.value;
  setBusy(true); addFeedback(`正在获取 ${instruments[symbol].name} 的${interval}行情...`);
  try { const data = await fetchHistory(symbol, interval); state.candles = data.candles; addFeedback(`${data.label} 已加载，共 ${data.candles.length} 根K线。${instruments[symbol]?.profile || ""}`, true); render(); }
  catch (error) { showError(error); addFeedback(`获取失败：${error.message || error}`, true); }
  finally { setBusy(false); }
}

async function scanMarkets() {
  setBusy(true); addFeedback("开始扫描推荐：逐个品种获取行情并进行参数优化。", true);
  const interval = els.intervalInput.value, cfg = settings(), results = [];
  try {
    for (const symbol of SYMBOLS) {
      addFeedback(`扫描 ${instruments[symbol].name}...`);
      try { const data = await fetchHistory(symbol, interval), prevCandles = state.candles, prevBest = state.best; state.candles = data.candles; const best = optimize(), result = runSimulation(data.candles, { ...cfg, strategy: best.strategy }); const record = makeRecord(symbol, interval, result, best.strategy, "扫描推荐"); saveLearningRecord(record); results.push({ symbol, label: data.label, data, result, best, score: scoreResult(result, cfg.capital) }); state.candles = prevCandles; state.best = prevBest; addFeedback(`${data.label} 完成：胜率 ${pct(result.winRate)}，交易 ${result.trades.length} 笔。`); }
      catch (error) { addFeedback(`${instruments[symbol].name} 跳过：${error.message || error}`); }
    }
    const ranked = results.filter((x) => x.result.trades.length >= 5).sort((a, b) => b.score - a.score);
    if (!ranked.length) throw new Error("本轮扫描没有找到交易次数足够的品种。");
    const top = ranked[0]; els.symbolInput.value = top.symbol; state.candles = top.data.candles; state.best = top.best; localStorage.setItem("paperTrader.best", JSON.stringify(state.best)); saveTrades(top.result.trades); addFeedback(`扫描完成：当前推荐 ${top.label}，胜率 ${pct(top.result.winRate)}，净利 ${money.format(top.result.netProfit)}。`, true); render(top.result);
  } catch (error) { showError(error); addFeedback(`扫描失败：${error.message || error}`, true); }
  finally { setBusy(false); }
}

function saveTrades(trades) { state.trades = trades; localStorage.setItem("paperTrader.trades", JSON.stringify(trades)); }
function showError(error) { els.signalCard.className = "signal-card neutral"; els.signalAction.textContent = "操作失败"; els.signalReason.textContent = error.message || String(error); }

els.csvInput.addEventListener("change", async (event) => { try { const file = event.target.files[0]; if (!file) return; state.candles = parseCsv(await file.text()); addFeedback(`CSV已导入，共 ${state.candles.length} 根K线。`, true); render(); } catch (e) { showError(e); } });
els.fetchButton.addEventListener("click", loadSelectedHistory);
els.sampleButton.addEventListener("click", () => { state.candles = makeSampleCandles(); addFeedback("样本行情已加载。", true); render(); });
els.runButton.addEventListener("click", () => { try { if (!state.candles.length) state.candles = makeSampleCandles(); const result = runSimulation(state.candles, settings()); saveTrades(result.trades); addFeedback(`模拟完成：交易 ${result.trades.length} 笔，胜率 ${pct(result.winRate)}，净利 ${money.format(result.netProfit)}。`, true); render(result); } catch (e) { showError(e); } });
els.optimizeButton.addEventListener("click", () => { try { if (!state.candles.length) state.candles = makeSampleCandles(); const best = optimize(); const result = runSimulation(state.candles, settings()); saveTrades(result.trades); addFeedback(`自主学习完成：测试段净利润 ${money.format(best.testResult.netProfit)}，交易 ${best.testResult.trades.length} 笔。`, true); render(result); } catch (e) { showError(e); addFeedback(`自主学习失败：${e.message || e}`, true); } });
els.scanButton.addEventListener("click", scanMarkets);
els.randomLearnButton.addEventListener("click", randomLearnAllMarkets);
els.resetButton.addEventListener("click", () => { localStorage.removeItem("paperTrader.trades"); localStorage.removeItem("paperTrader.best"); state.trades = []; state.best = null; addFeedback("模拟交易记录已重置，排行榜未清空。", true); render(); });
els.clearBoardButton.addEventListener("click", () => { localStorage.removeItem("paperTrader.learning"); state.learning = []; addFeedback("胜率排行榜已清空。", true); renderLeaderboard(); });
els.exportButton.addEventListener("click", () => { const header = "side,entryTime,exitTime,entry,exit,quantity,pnl,rValue,reason\n"; const body = state.trades.map((t) => [t.side, t.entryTime, t.exitTime, t.entry, t.exit, t.quantity, t.pnl.toFixed(2), t.rValue.toFixed(3), t.reason].join(",")).join("\n"); const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "paper-trades.csv"; a.click(); URL.revokeObjectURL(url); addFeedback("交易日志CSV已导出。", true); });
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredPrompt = event; els.installButton.hidden = false; });
els.installButton.addEventListener("click", async () => { if (!state.deferredPrompt) return; state.deferredPrompt.prompt(); await state.deferredPrompt.userChoice; state.deferredPrompt = null; els.installButton.hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
render();
renderLeaderboard();
