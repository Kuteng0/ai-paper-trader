"use strict";

const SYMBOLS = ["BTCUSD", "ES=F", "NQ=F", "GC=F", "CL=F", "^N225", "YM=F", "NG=F"];

const state = {
  candles: [],
  trades: JSON.parse(localStorage.getItem("paperTrader.trades") || "[]"),
  best: JSON.parse(localStorage.getItem("paperTrader.best") || "null"),
  learning: JSON.parse(localStorage.getItem("paperTrader.learning") || "[]"),
  model: JSON.parse(localStorage.getItem("paperTrader.model") || "null"),
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
  "BTCUSD": { name: "BTCUSD 比特币", range: "60d", profile: "24小时交易，适合单独训练；实盘前必须确认XTrend Lite报价、点差和最小交易单位。" },
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

async function fetchHistory(symbol, interval, rangeOverride = null) {
  const range = rangeOverride || instruments[symbol]?.range || "60d";
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&range=${range}`);
  window.addFunctionRequestUsage?.("history");
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
  const mode = strategy.mode || "cross";
  const recent = candles.slice(Math.max(0, i - 20), i);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  const atrNow = ind.atr[i] || 0;
  if (mode === "momentum") {
    if (fast > slow && ind.rsi[i] >= strategy.rsiCeil && momentum > atrNow * 0.25) return "long";
    if (fast < slow && ind.rsi[i] <= strategy.rsiFloor && momentum < -atrNow * 0.25) return "short";
  }
  if (mode === "breakout") {
    if (fast > slow && candles[i].close > recentHigh && ind.rsi[i] >= 50) return "long";
    if (fast < slow && candles[i].close < recentLow && ind.rsi[i] <= 50) return "short";
  }
  if (mode === "pullback") {
    if (fast > slow && candles[i - 1].close <= ind.emaFast[i - 1] && candles[i].close > fast && ind.rsi[i] >= 45) return "long";
    if (fast < slow && candles[i - 1].close >= ind.emaFast[i - 1] && candles[i].close < fast && ind.rsi[i] <= 55) return "short";
  }
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

const MIN_LEARNING_TRADES = 10;
const BTC_OBSERVATION_MIN_TRADES = 4;

function evaluateStrategy(candles, cfg, strategy) {
  const fullResult = runSimulation(candles, { ...cfg, strategy });
  const validation = walkForwardValidation(candles, cfg, strategy);
  const result = validation.trades >= MIN_LEARNING_TRADES ? validation : fullResult;
  const quality = scoreResult(result, cfg.capital);
  return { strategy, fullResult, validation, result, ...quality };
}

function walkForwardValidation(candles, cfg, strategy) {
  if (candles.length < 160) return runSimulation(candles, { ...cfg, strategy });
  const folds = 4;
  const chunk = Math.floor(candles.length / folds);
  const trades = [];
  let maxDrawdown = 0;
  for (let fold = 1; fold < folds; fold++) {
    const start = Math.max(0, fold * chunk - Math.max(strategy.slow, 40));
    const end = fold === folds - 1 ? candles.length : Math.min(candles.length, (fold + 1) * chunk);
    const result = runSimulation(candles.slice(start, end), { ...cfg, strategy });
    trades.push(...result.trades.map((trade) => ({ ...trade, walkForwardFold: fold })));
    maxDrawdown = Math.max(maxDrawdown, result.maxDrawdown);
  }
  const equity = cfg.capital + trades.reduce((sum, trade) => sum + trade.pnl, 0);
  return summarize(cfg.capital, equity, maxDrawdown, trades);
}

function gradeStrategy(result) {
  if (result.trades.length >= 18 && result.winRate >= 0.56 && result.profitFactor >= 1.35 && result.avgR > 0.15 && result.maxDrawdown <= 0.05) return "A";
  if (result.trades.length >= MIN_LEARNING_TRADES && result.winRate >= 0.50 && result.profitFactor >= 1.15 && result.avgR > 0 && result.maxDrawdown <= 0.08) return "B";
  return "C";
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

function randomBtcStrategy() {
  const fast = randomInt(5, 24);
  const slow = randomInt(Math.max(20, fast + 5), 80);
  const modes = ["cross", "momentum", "breakout", "pullback"];
  return {
    mode: modes[randomInt(0, modes.length - 1)],
    fast,
    slow,
    rsiFloor: randomInt(38, 50),
    rsiCeil: randomInt(50, 62),
    stopAtr: randomFloat(0.8, 2.8),
    takeProfitR: randomFloat(0.9, 3.4)
  };
}
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomFloat(min, max) { return Math.round((min + Math.random() * (max - min)) * 10) / 10; }
function scoreResult(result, capital) {
  const trades = result.trades.length;
  const grade = gradeStrategy(result);
  const sampleScore = Math.min(trades, 60) * 4;
  const expectancy = result.trades.length ? result.trades.reduce((sum, trade) => sum + trade.rValue, 0) / result.trades.length : 0;
  let score = result.winRate * 220 + Math.min(result.profitFactor, 4) * 100 + result.avgR * 150 + expectancy * 120 + result.netProfit / Math.max(1, capital) * 420 - result.maxDrawdown * 1200 + sampleScore;
  if (trades < MIN_LEARNING_TRADES) score -= 300;
  if (trades < 18) score -= 90;
  if (result.profitFactor < 1.15) score -= 180;
  if (result.avgR <= 0) score -= 180;
  if (result.maxDrawdown > 0.08) score -= 220;
  if (result.maxDrawdown > 0.12) score -= 400;
  if (grade === "A") score += 120;
  if (grade === "C") score -= 120;
  return { score, grade };
}

function makeRecord(symbol, interval, result, strategy, source) {
  const quality = scoreResult(result, Number(els.capitalInput.value) || 50000);
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time: new Date().toLocaleString("ja-JP"), symbol, label: instruments[symbol]?.name || symbol, interval, source, trades: result.trades.length, winRate: result.winRate, netProfit: result.netProfit, maxDrawdown: result.maxDrawdown, profitFactor: result.profitFactor, avgR: result.avgR, score: quality.score, grade: quality.grade, strategy };
}
function saveLearningRecord(record) {
  if (record.trades < MIN_LEARNING_TRADES || record.grade === "C") return;
  state.learning.push(record);
  state.learning = state.learning.slice(-300);
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
}
function topRecords() {
  return state.learning.slice().filter((r) => r.trades >= MIN_LEARNING_TRADES && r.grade !== "C").sort((a, b) => ((b.score || 0) - (a.score || 0)) || (b.winRate - a.winRate) || (b.profitFactor - a.profitFactor) || (b.trades - a.trades)).slice(0, 10);
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
        const quality = scoreResult(result, cfg.capital);
        const scored = { symbol, data, result, strategy, record, score: quality.score, grade: quality.grade };
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

function optimize() {
  if (state.candles.length < 80) throw new Error("至少需要80根K线才能自主学习。");
  const grid = [];
  for (const fast of [5, 8, 12]) {
    for (const slow of [18, 21, 34]) {
      if (fast >= slow) continue;
      for (const stopAtr of [1.1, 1.4, 1.8]) {
        for (const takeProfitR of [1.3, 1.8, 2.2]) {
          grid.push({ fast, slow, rsiFloor: 42, rsiCeil: 58, stopAtr, takeProfitR });
        }
      }
    }
  }
  const cfg = settings();
  const scored = grid
    .map((strategy) => evaluateStrategy(state.candles, cfg, strategy))
    .filter((item) => item.result.trades.length >= MIN_LEARNING_TRADES && item.grade !== "C")
    .sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error("没有找到足够稳健的参数组合。请换更长周期或其他品种。");
  const best = scored[0];
  state.best = { strategy: best.strategy, trainResult: best.fullResult, testResult: best.result, validation: best.validation, score: best.score, grade: best.grade };
  localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
  return state.best;
}

async function randomLearnAllMarkets() {
  const plan = randomTrainingPlan();
  const interval = plan.interval;
  const cfg = settings();
  const allResults = [];
  setBusy(true);
  addFeedback(`随机历史训练参数：周期 ${plan.interval}，范围 ${plan.range}，每个品种抽取随机窗口并生成48组随机策略。`, true);
  addFeedback(`随机历史训练参数：周期 ${plan.interval}，范围 ${plan.range}，每个品种抽取随机窗口并生成48组随机策略。`, true);
  addFeedback("开始稳健训练：全品种随机参数 + Walk-Forward 多段验证。", true);
  try {
    for (const symbol of SYMBOLS) {
      addFeedback(`正在训练 ${instruments[symbol].name} ${interval}...`);
      const data = await fetchHistory(symbol, interval);
      let bestForSymbol = null;
      const strategies = [defaultStrategy, ...Array.from({ length: 28 }, randomStrategy)];
      for (const strategy of strategies) {
        const evaluation = evaluateStrategy(data.candles, cfg, strategy);
        const result = evaluation.result;
        if (result.trades.length < MIN_LEARNING_TRADES || evaluation.grade === "C") continue;
        const record = makeRecord(symbol, interval, result, strategy, "稳健训练");
        record.score = evaluation.score;
        record.grade = evaluation.grade;
        saveLearningRecord(record);
        const scored = { symbol, data, result, strategy, record, score: evaluation.score, grade: evaluation.grade };
        allResults.push(scored);
        if (!bestForSymbol || scored.score > bestForSymbol.score) bestForSymbol = scored;
      }
      if (bestForSymbol) {
        addFeedback(`${data.label} 完成：等级 ${bestForSymbol.grade}，正确率 ${pct(bestForSymbol.result.winRate)}，交易 ${bestForSymbol.result.trades.length} 笔。`);
      } else {
        addFeedback(`${data.label} 完成：未通过稳健过滤，不进入排行榜。`);
      }
      renderLeaderboard();
    }
    if (!allResults.length) throw new Error("本轮没有策略通过稳健过滤。可以换周期，或先积累更多行情。");
    const best = allResults.sort((a, b) => b.score - a.score)[0];
    state.candles = best.data.candles;
    state.best = { strategy: best.strategy, trainResult: best.result, testResult: best.result, score: best.score, grade: best.grade };
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(best.result.trades);
    els.symbolInput.value = best.symbol;
    render(best.result);
    addFeedback(`训练完成：当前采用 ${best.data.label} 等级 ${best.grade} 策略，正确率 ${pct(best.result.winRate)}，排行榜已更新。`, true);
  } catch (error) {
    showError(error);
    addFeedback(`训练失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
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

async function scanMarkets() {
  setBusy(true);
  addFeedback("开始稳健扫描：逐个品种优化参数并做多段验证。", true);
  const interval = els.intervalInput.value, cfg = settings(), results = [];
  try {
    for (const symbol of SYMBOLS) {
      addFeedback(`扫描 ${instruments[symbol].name}...`);
      try {
        const data = await fetchHistory(symbol, interval), prevCandles = state.candles, prevBest = state.best;
        state.candles = data.candles;
        const best = optimize();
        const result = best.testResult || runSimulation(data.candles, { ...cfg, strategy: best.strategy });
        const record = makeRecord(symbol, interval, result, best.strategy, "稳健扫描");
        record.score = best.score || record.score;
        record.grade = best.grade || record.grade;
        saveLearningRecord(record);
        results.push({ symbol, label: data.label, data, result, best, score: record.score, grade: record.grade });
        state.candles = prevCandles;
        state.best = prevBest;
        addFeedback(`${data.label} 完成：等级 ${record.grade}，正确率 ${pct(result.winRate)}，交易 ${result.trades.length} 笔。`);
      } catch (error) {
        addFeedback(`${instruments[symbol].name} 跳过：${error.message || error}`);
      }
    }
    const ranked = results.filter((x) => x.result.trades.length >= MIN_LEARNING_TRADES && x.grade !== "C").sort((a, b) => b.score - a.score);
    if (!ranked.length) throw new Error("本轮扫描没有找到通过稳健过滤的品种。");
    const top = ranked[0];
    els.symbolInput.value = top.symbol;
    state.candles = top.data.candles;
    state.best = top.best;
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(top.result.trades);
    addFeedback(`扫描完成：当前推荐 ${top.label}，等级 ${top.grade}，正确率 ${pct(top.result.winRate)}，净利 ${money.format(top.result.netProfit)}。`, true);
    render(top.result);
  } catch (error) {
    showError(error);
    addFeedback(`扫描失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

function renderLeaderboard() {
  els.learnCount.textContent = `${state.learning.length} 条记录`;
  const rows = topRecords();
  els.leaderboard.innerHTML = rows.length ? rows.map((r, i) => `<div class="rank-item"><div class="rank-no">${i + 1}</div><div class="rank-main"><strong>${r.label} / 等级 ${r.grade || "B"}</strong><span>${r.interval} / ${r.source} / ${r.time}</span><span>交易 ${r.trades} 笔，净利 ${money.format(r.netProfit)}，回撤 ${(r.maxDrawdown * 100).toFixed(1)}%，盈亏比 ${Number(r.profitFactor || 0).toFixed(2)}</span><span>综合分 ${Math.round(r.score || 0)}，参数 EMA ${r.strategy.fast}/${r.strategy.slow}，止损 ${r.strategy.stopAtr}ATR，止盈 ${r.strategy.takeProfitR}R</span></div><div class="rank-side"><span>正确率</span><strong>${pct(r.winRate)}</strong></div></div>`).join("") : `<p class="empty">还没有通过稳健过滤的学习记录。</p>`;
}

function marketRegime(candles) {
  if (candles.length < 40) return "unknown";
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 10);
  const slow = ema(closes, 30);
  const atrValues = atr(candles, 14);
  const i = candles.length - 1;
  const atrPct = atrValues[i] / Math.max(1, closes[i]);
  const slope = Math.abs(fast[i] - slow[i]) / Math.max(1, closes[i]);
  if (atrPct > 0.018) return "volatile";
  if (slope > 0.004) return fast[i] > slow[i] ? "trend-up" : "trend-down";
  return "range";
}

function mutateStrategy(strategy) {
  const fast = clampInt(strategy.fast + randomInt(-2, 2), 4, 18);
  const slow = clampInt(strategy.slow + randomInt(-5, 5), fast + 4, 60);
  return {
    fast,
    slow,
    rsiFloor: clampInt((strategy.rsiFloor || 42) + randomInt(-4, 4), 30, 50),
    rsiCeil: clampInt((strategy.rsiCeil || 58) + randomInt(-4, 4), 50, 70),
    stopAtr: clampFloat((strategy.stopAtr || 1.4) + randomFloat(-0.3, 0.3), 0.8, 2.6),
    takeProfitR: clampFloat((strategy.takeProfitR || 1.8) + randomFloat(-0.4, 0.4), 1.0, 3.2)
  };
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value, min, max) {
  return Math.round(Math.max(min, Math.min(max, value)) * 10) / 10;
}

function seededStrategies(symbol, interval) {
  const seeds = state.learning
    .filter((record) => record.symbol === symbol && record.interval === interval && record.strategy && record.grade !== "C")
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);
  const variants = [];
  for (const seed of seeds) {
    variants.push(seed.strategy);
    for (let i = 0; i < 4; i++) variants.push(mutateStrategy(seed.strategy));
  }
  return variants;
}

async function randomLearnAllMarkets() {
  const plan = randomTrainingPlan();
  const interval = plan.interval;
  const cfg = settings();
  const allResults = [];
  setBusy(true);
  addFeedback(`随机历史训练参数：周期 ${plan.interval}，范围 ${plan.range}，每个品种抽取随机窗口并生成48组随机策略。`, true);
  addFeedback("开始进化训练：优秀策略变体 + 随机参数 + Walk-Forward 验证。", true);
  try {
    for (const symbol of SYMBOLS) {
      addFeedback(`正在训练 ${instruments[symbol].name} ${interval}...`);
      const data = await fetchHistory(symbol, interval, plan.range);
      const sampled = randomTrainingWindow(data.candles);
      const trainCandles = sampled.candles;
      const regime = marketRegime(trainCandles);
      let bestForSymbol = null;
      const strategies = [
        defaultStrategy,
        ...seededStrategies(symbol, interval),
        ...Array.from({ length: 24 }, randomStrategy)
      ];
      const unique = new Map(strategies.map((strategy) => [`${strategy.fast}-${strategy.slow}-${strategy.rsiFloor}-${strategy.rsiCeil}-${strategy.stopAtr}-${strategy.takeProfitR}`, strategy]));
      for (const strategy of unique.values()) {
        const evaluation = evaluateStrategy(data.candles, cfg, strategy);
        const result = evaluation.result;
        if (result.trades.length < MIN_LEARNING_TRADES || evaluation.grade === "C") continue;
        const record = makeRecord(symbol, interval, result, strategy, "进化训练");
        record.score = evaluation.score;
        record.grade = evaluation.grade;
        record.regime = regime;
        saveLearningRecord(record);
        const scored = { symbol, data, result, strategy, record, score: evaluation.score, grade: evaluation.grade, regime };
        allResults.push(scored);
        if (!bestForSymbol || scored.score > bestForSymbol.score) bestForSymbol = scored;
      }
      if (bestForSymbol) {
        addFeedback(`${data.label} 完成：行情 ${regime}，等级 ${bestForSymbol.grade}，正确率 ${pct(bestForSymbol.result.winRate)}，交易 ${bestForSymbol.result.trades.length} 笔。`);
      } else {
        addFeedback(`${data.label} 完成：行情 ${regime}，未通过稳健过滤。`);
      }
      renderLeaderboard();
    }
    if (!allResults.length) throw new Error("本轮没有策略通过稳健过滤。可以换周期，或先积累更多行情。");
    const best = allResults.sort((a, b) => b.score - a.score)[0];
    state.candles = best.data.candles;
    state.best = { strategy: best.strategy, trainResult: best.result, testResult: best.result, score: best.score, grade: best.grade, regime: best.regime };
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(best.result.trades);
    els.symbolInput.value = best.symbol;
    render(best.result);
    addFeedback(`训练完成：采用 ${best.data.label} 等级 ${best.grade} 策略，行情 ${best.regime}，正确率 ${pct(best.result.winRate)}。`, true);
  } catch (error) {
    showError(error);
    addFeedback(`训练失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

function renderLeaderboard() {
  els.learnCount.textContent = `${state.learning.length} 条记录`;
  const rows = topRecords();
  els.leaderboard.innerHTML = rows.length ? rows.map((r, i) => `<div class="rank-item"><div class="rank-no">${i + 1}</div><div class="rank-main"><strong>${r.label} / 等级 ${r.grade || "B"}</strong><span>${r.interval} / ${r.source} / 行情 ${r.regime || "unknown"} / ${r.time}</span><span>交易 ${r.trades} 笔，净利 ${money.format(r.netProfit)}，回撤 ${(r.maxDrawdown * 100).toFixed(1)}%，盈亏比 ${Number(r.profitFactor || 0).toFixed(2)}</span><span>综合分 ${Math.round(r.score || 0)}，参数 EMA ${r.strategy.fast}/${r.strategy.slow}，止损 ${r.strategy.stopAtr}ATR，止盈 ${r.strategy.takeProfitR}R</span></div><div class="rank-side"><span>正确率</span><strong>${pct(r.winRate)}</strong></div></div>`).join("") : `<p class="empty">还没有通过稳健过滤的学习记录。</p>`;
}

function learningRecordKey(record) {
  const s = record.strategy || {};
  return [record.symbol, record.interval, record.range || "60d", record.windowKey || "full", record.regime || "unknown", s.mode || "cross", s.fast, s.slow, s.rsiFloor, s.rsiCeil, s.stopAtr, s.takeProfitR].join("|");
}

function saveLearningRecord(record) {
  if (record.trades < MIN_LEARNING_TRADES || record.grade === "C") return;
  const map = new Map();
  for (const existing of state.learning) {
    if (!existing?.strategy) continue;
    map.set(learningRecordKey(existing), existing);
  }
  const key = learningRecordKey(record);
  const previous = map.get(key);
  if (!previous || (record.score || 0) > (previous.score || 0)) map.set(key, record);
  state.learning = [...map.values()]
    .filter((item) => item.trades >= MIN_LEARNING_TRADES && item.grade !== "C")
    .sort((a, b) => ((b.score || 0) - (a.score || 0)) || String(b.time || "").localeCompare(String(a.time || "")))
    .slice(0, 300);
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
  window.markUnsynced?.("learning");
  renderBtcModelPanel();
}

function currentModel() {
  if (state.model && typeof state.model === "object") return state.model;
  state.model = {
    version: 1,
    generation: 0,
    champion: null,
    population: [],
    updatedAt: null,
    notes: "AI model initializes from robust strategy search."
  };
  return state.model;
}

function saveModel(model = state.model) {
  state.model = model;
  localStorage.setItem("paperTrader.model", JSON.stringify(model));
  window.markUnsynced?.("model");
  renderModelPanel();
}

function strategyKey(strategy) {
  return [strategy.mode || "cross", strategy.fast, strategy.slow, strategy.rsiFloor, strategy.rsiCeil, strategy.stopAtr, strategy.takeProfitR].join("-");
}

function updateModelFromCandidates(candidates) {
  if (!candidates.length) return currentModel();
  const model = currentModel();
  const previous = Array.isArray(model.population) ? model.population : [];
  const combined = [...previous, ...candidates.map((item) => ({
    symbol: item.symbol,
    label: item.data?.label || item.label,
    interval: item.record?.interval || els.intervalInput.value,
    regime: item.regime || item.record?.regime || "unknown",
    strategy: item.strategy,
    score: item.score,
    grade: item.grade,
    winRate: item.result?.winRate,
    trades: item.result?.trades?.length || item.record?.trades || 0,
    netProfit: item.result?.netProfit,
    profitFactor: item.result?.profitFactor,
    maxDrawdown: item.result?.maxDrawdown,
    expectancy: item.result?.trades?.length ? item.result.trades.reduce((sum, trade) => sum + trade.rValue, 0) / item.result.trades.length : 0,
    liveEligible: item.liveEligible !== false && item.grade !== "观察",
    updatedAt: new Date().toISOString()
  }))];
  const map = new Map();
  for (const item of combined) {
    if (!item.strategy || item.grade === "C") continue;
    const key = `${item.symbol}|${item.interval}|${item.regime}|${strategyKey(item.strategy)}`;
    const previousItem = map.get(key);
    if (!previousItem || (item.score || 0) > (previousItem.score || 0)) map.set(key, item);
  }
  const population = [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 30);
  model.population = population;
  model.champion = population.find((item) => item.liveEligible !== false && item.grade !== "观察") || model.champion;
  model.generation = (model.generation || 0) + 1;
  model.updatedAt = new Date().toISOString();
  model.notes = "Champion evolves from population, walk-forward validation, regime filter, and live-reference tracking.";
  saveModel(model);
  return model;
}

function modelSeedStrategies(symbol, interval) {
  const model = currentModel();
  const seeds = (model.population || [])
    .filter((item) => item.symbol === symbol && item.interval === interval && item.strategy)
    .slice(0, 8);
  const strategies = [];
  for (const item of seeds) {
    strategies.push(item.strategy);
    for (let i = 0; i < 5; i++) strategies.push(mutateStrategy(item.strategy));
  }
  if (model.champion?.strategy) {
    strategies.push(model.champion.strategy);
    for (let i = 0; i < 8; i++) strategies.push(mutateStrategy(model.champion.strategy));
  }
  return strategies;
}

function randomTrainingPlan() {
  const intervals = ["5m", "15m", "30m", "1h"];
  const ranges = ["5d", "1mo", "60d"];
  return {
    interval: intervals[randomInt(0, intervals.length - 1)],
    range: ranges[randomInt(0, ranges.length - 1)],
    runId: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  };
}

function btcTrainingPlan() {
  const intervals = ["5m", "15m", "30m", "1h"];
  const ranges = ["1mo", "60d", "6mo"];
  return {
    interval: intervals[randomInt(0, intervals.length - 1)],
    range: ranges[randomInt(0, ranges.length - 1)],
    runId: `btc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  };
}

function isObservationCandidate(result, score) {
  return result.trades.length >= BTC_OBSERVATION_MIN_TRADES
    && Number.isFinite(score)
    && result.winRate >= 0.40
    && result.profitFactor >= 0.75
    && result.maxDrawdown <= 0.16;
}

function randomTrainingWindow(candles) {
  if (candles.length < 180) return { candles, windowKey: "full" };
  const minLen = Math.min(candles.length, 160);
  const len = randomInt(minLen, candles.length);
  const start = randomInt(0, Math.max(0, candles.length - len));
  return { candles: candles.slice(start, start + len), windowKey: `${start}-${start + len}` };
}

function ensureModelPanel() {
  if (document.getElementById("modelPanel")) return;
  const learningPanel = document.querySelector(".learning-panel");
  if (!learningPanel) return;
  const panel = document.createElement("section");
  panel.className = "panel model-panel";
  panel.id = "modelPanel";
  panel.innerHTML = `
    <div class="section-title">
      <div>
        <p class="section-kicker">AI交易系统</p>
        <h2>当前模型</h2>
      </div>
      <span id="modelGeneration">第0代</span>
    </div>
    <div id="modelSummary" class="model-summary"><p class="empty">模型尚未完成训练。</p></div>
    <div id="btcModelSummary" class="model-summary btc-model-summary"><p class="empty">BTCUSD尚未完成单独训练。</p></div>
  `;
  learningPanel.insertAdjacentElement("afterend", panel);
}

function renderModelPanel() {
  ensureModelPanel();
  const generation = document.getElementById("modelGeneration");
  const summary = document.getElementById("modelSummary");
  if (!generation || !summary) return;
  const model = currentModel();
  const champion = model.champion;
  generation.textContent = `第${model.generation || 0}代`;
  if (!champion) {
    summary.innerHTML = `<p class="empty">模型尚未完成训练。</p>`;
    renderBtcModelPanel();
    return;
  }
  summary.innerHTML = `
    <div class="model-card">
      <strong>${champion.label || champion.symbol} / 等级 ${champion.grade || "B"} / 评分 ${Math.round(Number(champion.score || 0))}</strong>
      <span>行情 ${champion.regime || "unknown"} / 周期 ${champion.interval || "-"} / 候选池 ${(model.population || []).length} 组</span>
      <span>正确率 ${pct(champion.winRate || 0)} / 交易 ${champion.trades || 0} 笔 / 盈亏比 ${Number(champion.profitFactor || 0).toFixed(2)} / 回撤 ${((champion.maxDrawdown || 0) * 100).toFixed(1)}%</span>
      <span>参数 EMA ${champion.strategy.fast}/${champion.strategy.slow}，止损 ${champion.strategy.stopAtr}ATR，止盈 ${champion.strategy.takeProfitR}R</span>
    </div>
  `;
  renderBtcModelPanel();
}

function bestBtcModel() {
  const modelPopulation = Array.isArray(state.model?.population) ? state.model.population : [];
  const fromModel = modelPopulation.filter((item) => item.symbol === "BTCUSD" && item.strategy);
  const fromLearning = state.learning.filter((item) => item.symbol === "BTCUSD" && item.strategy && item.grade !== "C");
  return [...fromModel, ...fromLearning]
    .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || (Number(b.winRate || 0) - Number(a.winRate || 0)))
    [0] || null;
}

function renderBtcModelPanel() {
  const target = document.getElementById("btcModelSummary");
  if (!target) return;
  const btc = bestBtcModel();
  if (!btc) {
    target.innerHTML = `<div class="model-card"><strong>BTCUSD 单独模型</strong><span>尚未完成BTC单独训练。点击“BTC单独训练”生成策略。</span></div>`;
    return;
  }
  const s = btc.strategy || {};
  target.innerHTML = `
    <div class="model-card btc-model-card">
      <strong>BTCUSD 单独模型 / 等级 ${btc.grade || "B"} / 评分 ${Math.round(Number(btc.score || 0))}</strong>
      <span>来源 ${btc.source || "模型种群"} / 周期 ${btc.interval || "-"} / 范围 ${btc.range || "-"} / 窗口 ${btc.windowKey || "-"}</span>
      <span>正确率 ${pct(Number(btc.winRate || 0))} / 交易 ${btc.trades || 0} 笔 / 盈亏比 ${Number(btc.profitFactor || 0).toFixed(2)} / 回撤 ${((btc.maxDrawdown || 0) * 100).toFixed(1)}%</span>
      <span>参数 ${s.mode || "cross"} / EMA ${s.fast}/${s.slow}，RSI ${s.rsiFloor}/${s.rsiCeil}，止损 ${s.stopAtr}ATR，止盈 ${s.takeProfitR}R</span>
    </div>
  `;
}

async function randomLearnAllMarkets() {
  const plan = randomTrainingPlan();
  const interval = plan.interval;
  const cfg = settings();
  const allResults = [];
  setBusy(true);
  addFeedback("开始模型进化：读取当前AI模型，围绕冠军策略继续变异、筛选、替换。", true);
  try {
    currentModel();
    for (const symbol of SYMBOLS) {
      addFeedback(`模型训练 ${instruments[symbol].name} ${interval}...`);
      const data = await fetchHistory(symbol, interval, plan.range);
      const sampled = randomTrainingWindow(data.candles);
      const trainCandles = sampled.candles;
      const regime = marketRegime(trainCandles);
      let bestForSymbol = null;
      const strategies = [
        defaultStrategy,
        ...modelSeedStrategies(symbol, interval),
        ...seededStrategies(symbol, interval),
        ...Array.from({ length: 48 }, randomStrategy)
      ];
      const unique = new Map(strategies.map((strategy) => [`${strategy.fast}-${strategy.slow}-${strategy.rsiFloor}-${strategy.rsiCeil}-${strategy.stopAtr}-${strategy.takeProfitR}`, strategy]));
      for (const strategy of unique.values()) {
        const evaluation = evaluateStrategy(trainCandles, cfg, strategy);
        const result = evaluation.result;
        if (result.trades.length < MIN_LEARNING_TRADES || evaluation.grade === "C") continue;
        const record = makeRecord(symbol, interval, result, strategy, "模型进化");
        record.score = evaluation.score;
        record.grade = evaluation.grade;
        record.regime = regime;
        record.range = plan.range;
        record.windowKey = sampled.windowKey;
        record.runId = plan.runId;
        saveLearningRecord(record);
        const scored = { symbol, data: { ...data, candles: trainCandles }, result, strategy, record, score: evaluation.score, grade: evaluation.grade, regime };
        allResults.push(scored);
        if (!bestForSymbol || scored.score > bestForSymbol.score) bestForSymbol = scored;
      }
      if (bestForSymbol) addFeedback(`${data.label} 模型进化完成：行情 ${regime}，等级 ${bestForSymbol.grade}，正确率 ${pct(bestForSymbol.result.winRate)}。`);
      else addFeedback(`${data.label} 本轮没有产生可替换模型的策略。`);
      renderLeaderboard();
    }
    if (!allResults.length) throw new Error("本轮没有策略通过模型进化过滤。");
    const model = updateModelFromCandidates(allResults);
    const champion = model.champion;
    const best = allResults.sort((a, b) => b.score - a.score)[0];
    state.candles = best.data.candles;
    state.best = { strategy: champion.strategy, trainResult: best.result, testResult: best.result, score: champion.score, grade: champion.grade, regime: champion.regime };
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(best.result.trades);
    els.symbolInput.value = champion.symbol || best.symbol;
    render(best.result);
    addFeedback(`模型第${model.generation}代完成：冠军 ${champion.label || champion.symbol}，等级 ${champion.grade}，正确率 ${pct(champion.winRate || 0)}。`, true);
  } catch (error) {
    showError(error);
    addFeedback(`模型进化失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

async function randomLearnBtcOnly() {
  const original = SYMBOLS.slice();
  const plan = btcTrainingPlan();
  const interval = plan.interval;
  const cfg = settings();
  const allResults = [];
  setBusy(true);
  addFeedback(`BTCUSD单独训练：真实历史行情，周期 ${plan.interval}，范围 ${plan.range}，随机窗口 + 220组BTC专用随机/变异策略。`, true);
  try {
    currentModel();
    for (const symbol of ["BTCUSD"]) {
      const data = await fetchHistory(symbol, interval, plan.range);
      const sampled = randomTrainingWindow(data.candles);
      const trainCandles = sampled.candles;
      const regime = marketRegime(trainCandles);
      let bestForSymbol = null;
      const strategies = [
        defaultStrategy,
        ...modelSeedStrategies(symbol, interval),
        ...seededStrategies(symbol, interval),
        ...Array.from({ length: 220 }, randomBtcStrategy)
      ];
      const unique = new Map(strategies.map((strategy) => [strategyKey(strategy), strategy]));
      let bestObservation = null;
      for (const strategy of unique.values()) {
        const evaluation = evaluateStrategy(trainCandles, cfg, strategy);
        const result = evaluation.result;
        if (result.trades.length < BTC_OBSERVATION_MIN_TRADES) continue;
        const record = makeRecord(symbol, interval, result, strategy, "BTC单独训练");
        record.score = evaluation.score + 25;
        record.grade = evaluation.grade;
        record.regime = regime;
        record.range = plan.range;
        record.windowKey = sampled.windowKey;
        record.runId = plan.runId;
        if (evaluation.grade === "C") {
          if (isObservationCandidate(result, record.score)) {
            record.grade = "观察";
            record.source = "BTC观察候选";
            const observed = { symbol, data: { ...data, candles: trainCandles }, result, strategy, record, score: record.score, grade: record.grade, regime, liveEligible: false };
            if (!bestObservation || observed.score > bestObservation.score) bestObservation = observed;
          }
          continue;
        }
        saveLearningRecord(record);
        const scored = { symbol, data: { ...data, candles: trainCandles }, result, strategy, record, score: record.score, grade: evaluation.grade, regime, liveEligible: true };
        allResults.push(scored);
        if (!bestForSymbol || scored.score > bestForSymbol.score) bestForSymbol = scored;
      }
      if (bestForSymbol) addFeedback(`BTCUSD训练完成：窗口 ${sampled.windowKey}，等级 ${bestForSymbol.grade}，正确率 ${pct(bestForSymbol.result.winRate)}。`, true);
      else if (bestObservation) {
        allResults.push(bestObservation);
        addFeedback(`BTCUSD本轮未达到实盘参考标准，已保存观察候选继续进化：正确率 ${pct(bestObservation.result.winRate)}，盈亏比 ${Number(bestObservation.result.profitFactor || 0).toFixed(2)}。`, true);
      } else addFeedback("BTCUSD本轮随机窗口没有产生可替换模型的策略。", true);
    }
    if (!allResults.length) throw new Error("BTCUSD本轮没有足够交易次数的历史模拟候选。已换用真实历史行情随机训练，请再运行几次抽取不同窗口。");
    const model = updateModelFromCandidates(allResults);
    const champion = model.population.find((item) => item.symbol === "BTCUSD" && item.liveEligible !== false && item.grade !== "观察") || model.population.find((item) => item.symbol === "BTCUSD") || allResults.sort((a, b) => b.score - a.score)[0].record;
    const best = allResults.sort((a, b) => b.score - a.score)[0];
    state.candles = best.data.candles;
    state.best = { strategy: best.strategy, trainResult: best.result, testResult: best.result, score: best.score, grade: best.grade, regime: best.regime };
    localStorage.setItem("paperTrader.best", JSON.stringify(state.best));
    saveTrades(best.result.trades);
    els.symbolInput.value = "BTCUSD";
    render(best.result);
    addFeedback(`BTCUSD单独训练完成：当前BTC候选 ${champion.label || champion.symbol}，等级 ${champion.grade || best.grade}。观察候选只用于继续训练，不用于实盘LINE参考。`, true);
  } catch (error) {
    showError(error);
    addFeedback(`BTCUSD单独训练失败：${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

function saveTrades(trades) { state.trades = trades; localStorage.setItem("paperTrader.trades", JSON.stringify(trades)); }
function showError(error) { els.signalCard.className = "signal-card neutral"; els.signalAction.textContent = "操作失败"; els.signalReason.textContent = error.message || String(error); }

els.csvInput.addEventListener("change", async (event) => { try { const file = event.target.files[0]; if (!file) return; state.candles = parseCsv(await file.text()); addFeedback(`CSV已导入，共 ${state.candles.length} 根K线。`, true); render(); } catch (e) { showError(e); } });
els.fetchButton.addEventListener("click", loadSelectedHistory);
els.sampleButton.addEventListener("click", () => { state.candles = makeSampleCandles(); addFeedback("样本行情已加载。", true); render(); });
els.runButton.addEventListener("click", () => { try { if (!state.candles.length) state.candles = makeSampleCandles(); const result = runSimulation(state.candles, settings()); saveTrades(result.trades); addFeedback(`模拟完成：交易 ${result.trades.length} 笔，胜率 ${pct(result.winRate)}，净利 ${money.format(result.netProfit)}。`, true); render(result); } catch (e) { showError(e); } });
els.optimizeButton.addEventListener("click", randomLearnAllMarkets);
els.scanButton.addEventListener("click", scanMarkets);
els.randomLearnButton.addEventListener("click", randomLearnAllMarkets);
document.getElementById("btcTrainingButton")?.addEventListener("click", randomLearnBtcOnly);
els.resetButton.addEventListener("click", () => { localStorage.removeItem("paperTrader.trades"); localStorage.removeItem("paperTrader.best"); state.trades = []; state.best = null; addFeedback("模拟交易记录已重置，排行榜未清空。", true); render(); });
els.clearBoardButton.addEventListener("click", () => { localStorage.removeItem("paperTrader.learning"); state.learning = []; addFeedback("胜率排行榜已清空。", true); renderLeaderboard(); });
els.exportButton.addEventListener("click", () => { const header = "side,entryTime,exitTime,entry,exit,quantity,pnl,rValue,reason\n"; const body = state.trades.map((t) => [t.side, t.entryTime, t.exitTime, t.entry, t.exit, t.quantity, t.pnl.toFixed(2), t.rValue.toFixed(3), t.reason].join(",")).join("\n"); const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "paper-trades.csv"; a.click(); URL.revokeObjectURL(url); addFeedback("交易日志CSV已导出。", true); });
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredPrompt = event; els.installButton.hidden = false; });
els.installButton.addEventListener("click", async () => { if (!state.deferredPrompt) return; state.deferredPrompt.prompt(); await state.deferredPrompt.userChoice; state.deferredPrompt = null; els.installButton.hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
render();
renderLeaderboard();
renderModelPanel();
