const KEY = "learning:default";
const MIN_TRADES = 10;

export async function onRequestPost({ request, env }) {
  if (!env.LEARNING_KV) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_TO) {
    return json({ error: "LINE 尚未配置。请设置 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_TO。" }, 500);
  }

  const body = await request.json().catch(() => ({}));
  if (body.eventText) {
    const response = await pushLine(env, String(body.eventText).slice(0, 4500));
    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `LINE推送失败：${response.status} ${detail}` }, 502);
    }
    return json({ message: "LINE事件通知已发送。", pushed: true });
  }

  const cloudState = normalizeCloudState(await env.LEARNING_KV.get(KEY, "json"));
  const requestState = normalizeCloudState(body);
  const activeState = requestState.records.length || requestState.model ? requestState : cloudState;
  const forceSymbol = body.forceSymbol ? String(body.forceSymbol) : "";
  const records = forceSymbol ? activeState.records.filter((r) => r?.symbol === forceSymbol) : activeState.records;
  const top10 = records
    .filter((r) => r && r.trades >= MIN_TRADES && Number.isFinite(r.winRate) && r.strategy && r.grade !== "C")
    .map((r) => ({ ...r, score: Number.isFinite(r.score) ? r.score : scoreRecord(r), grade: r.grade || gradeRecord(r) }))
    .sort((a, b) => (b.score - a.score) || (b.winRate - a.winRate) || (b.profitFactor - a.profitFactor) || (b.trades - a.trades))
    .slice(0, 10);

  const modelChampionRaw = activeState.model?.champion?.strategy ? normalizeChampion(activeState.model.champion) : null;
  const eligibleModelChampion = modelChampionRaw && modelChampionRaw.liveEligible !== false && modelChampionRaw.grade !== "观察" ? modelChampionRaw : null;
  const modelChampion = forceSymbol && eligibleModelChampion?.symbol !== forceSymbol ? null : eligibleModelChampion;
  if (!top10.length && !modelChampion) return json({ error: "AI模型还没有可用冠军策略。请先运行训练模式。" }, 400);

  const best = modelChampion && (!top10[0] || (modelChampion.score || 0) >= (top10[0].score || 0)) ? modelChampion : top10[0];
  const live = await buildLivePlan(best, env);
  const text = buildMessage(best, Math.max(1, top10.length), live);
  if (body.dryRun) {
    return json({ message: "实时盯盘检查完成。", pushed: false, selected: best, live, text });
  }
  if (body.notifyOnlyOnSignal && !["long", "short"].includes(live.action)) {
    return json({ message: "当前没有符合策略的入场信号，未发送LINE。", pushed: false, selected: best, live });
  }

  const response = await pushLine(env, text);

  if (!response.ok) {
    const detail = await response.text();
    return json({ error: `LINE推送失败：${response.status} ${detail}` }, 502);
  }

  return json({ message: `LINE已发送：${best.label}，等级${best.grade}，${live.actionText}。`, pushed: true, selected: best, live });
}

function pushLine(env, text) {
  return fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      to: env.LINE_TO,
      messages: [{ type: "text", text }]
    })
  });
}

function normalizeCloudState(value) {
  if (Array.isArray(value)) return { records: value, model: null };
  if (value && typeof value === "object") return { records: Array.isArray(value.records) ? value.records : [], model: value.model || null };
  return { records: [], model: null };
}

function normalizeChampion(champion) {
  return {
    symbol: champion.symbol,
    label: champion.label || champion.symbol,
    interval: champion.interval || "15m",
    regime: champion.regime || "unknown",
    strategy: champion.strategy,
    score: Number(champion.score || 0),
    grade: champion.grade || "B",
    winRate: Number(champion.winRate || 0),
    trades: Number(champion.trades || 0),
    netProfit: Number(champion.netProfit || 0),
    maxDrawdown: Number(champion.maxDrawdown || 0),
    profitFactor: Number(champion.profitFactor || 0),
    liveEligible: champion.liveEligible !== false
  };
}

async function buildLivePlan(best, env) {
  const candles = await fetchCandles(best.symbol, best.interval || "15m");
  if (candles.length < 80) return { action: "wait", actionText: "行情不足，观望", reason: "最新K线数量不足，不能计算可靠信号。" };

  const tick = await latestMarketTick(env, best.symbol);
  if (tick?.last) {
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = { ...last, close: tick.last, high: Math.max(last.high, tick.last), low: Math.min(last.low, tick.last) };
  }

  const strategy = best.strategy;
  const ind = indicators(candles, strategy);
  const i = candles.length - 1;
  const side = signalAt(i, candles, ind, strategy);
  const latest = candles[i];
  const entry = latest.close;
  const stopDistance = Math.max(ind.atr[i] * strategy.stopAtr, entry * 0.001);
  const atrNow = ind.atr[i];
  const trend = ind.emaFast[i] > ind.emaSlow[i] ? "偏多" : "偏空";
  const currentRegime = marketRegime(candles);
  const expectedRegime = best.regime || "unknown";
  const regimeMismatch = expectedRegime !== "unknown" && currentRegime !== "unknown" && expectedRegime !== currentRegime;

  if (regimeMismatch) {
    return {
      action: "wait",
      actionText: "行情状态不匹配，观望",
      reason: `该策略训练环境为${expectedRegime}，当前行情为${currentRegime}。为避免硬套策略，本次不下单。`,
      entry, atr: atrNow, rsi: ind.rsi[i], trend, currentRegime
    };
  }

  if (!side) {
    return {
      action: "wait",
      actionText: "无明确信号，观望",
      reason: `当前${trend}，但没有出现策略入场信号。不为了交易而开仓。`,
      entry, atr: atrNow, rsi: ind.rsi[i], trend, currentRegime
    };
  }

  const stop = side === "long" ? entry - stopDistance : entry + stopDistance;
  const target = side === "long" ? entry + stopDistance * strategy.takeProfitR : entry - stopDistance * strategy.takeProfitR;
  const invalidation = side === "long" ? "跌破止损价立即退出" : "突破止损价立即退出";
  return {
    action: side,
    actionText: side === "long" ? "做多参考" : "做空参考",
    reason: `EMA交叉 + RSI过滤触发，当前${trend}。`,
    entry, stop, target, atr: atrNow, rsi: ind.rsi[i], trend, invalidation, currentRegime
  };
}

async function latestTick(env, symbol) {
  if (!env.LEARNING_KV) return null;
  const ticks = await env.LEARNING_KV.get("ticks:latest", "json").catch(() => null);
  const tick = ticks?.[symbol];
  if (!tick?.last || !tick.updatedAt) return null;
  const ageMs = Date.now() - new Date(tick.updatedAt).getTime();
  return ageMs <= 5 * 60 * 1000 ? tick : null;
}

async function latestMarketTick(env, symbol) {
  const bridged = await latestTick(env, symbol);
  if (bridged) return bridged;
  if (symbol !== "BTCUSD") return null;
  return latestBtcTicker();
}

async function latestBtcTicker() {
  const errors = [];
  for (const source of [latestBybitTicker, latestOkxTicker, latestBinanceTicker, latestCoinbaseTicker, latestKrakenTicker]) {
    try {
      const tick = await source();
      if (tick?.last) return tick;
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  return null;
}

async function latestBybitTicker() {
  const response = await fetch("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT", { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Bybit ticker ${response.status}`);
  const data = await response.json();
  if (data.retCode !== 0) throw new Error(`Bybit ticker ${data.retCode}`);
  const item = data.result?.list?.[0];
  return { symbol: "BTCUSD", label: "BTCUSD", last: Number(item?.lastPrice), source: "Bybit ticker", updatedAt: new Date().toISOString() };
}

async function latestOkxTicker() {
  const response = await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`OKX ticker ${response.status}`);
  const data = await response.json();
  if (data.code !== "0") throw new Error(`OKX ticker ${data.code}`);
  const item = data.data?.[0];
  return { symbol: "BTCUSD", label: "BTCUSD", bid: Number(item?.bidPx), ask: Number(item?.askPx), last: Number(item?.last), source: "OKX ticker", updatedAt: new Date().toISOString() };
}

async function latestBinanceTicker() {
  const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Binance ticker ${response.status}`);
  const data = await response.json();
  return { symbol: "BTCUSD", label: "BTCUSD", last: Number(data.price), source: "Binance ticker", updatedAt: new Date().toISOString() };
}

async function latestCoinbaseTicker() {
  const response = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker", { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Coinbase ticker ${response.status}`);
  const data = await response.json();
  return { symbol: "BTCUSD", label: "BTCUSD", bid: Number(data.bid), ask: Number(data.ask), last: Number(data.price), source: "Coinbase ticker", updatedAt: new Date().toISOString() };
}

async function latestKrakenTicker() {
  const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Kraken ticker ${response.status}`);
  const data = await response.json();
  const key = Object.keys(data.result || {})[0];
  const last = key ? Number(data.result[key]?.c?.[0]) : NaN;
  return { symbol: "BTCUSD", label: "BTCUSD", last, source: "Kraken ticker", updatedAt: new Date().toISOString() };
}

async function fetchCandles(symbol, interval) {
  if (symbol === "BTCUSD") return fetchBtcCandles(interval);
  const endpoint = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  endpoint.searchParams.set("range", "60d");
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("includePrePost", "true");
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error("最新行情获取失败，无法生成实盘参考。");
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) throw new Error("最新行情为空，无法生成实盘参考。");
  return timestamps.map((ts, i) => ({
    time: new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16),
    open: round(quote.open?.[i]), high: round(quote.high?.[i]), low: round(quote.low?.[i]), close: round(quote.close?.[i])
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

async function fetchBinanceCandles(interval) {
  const endpoint = new URL("https://api.binance.com/api/v3/klines");
  endpoint.searchParams.set("symbol", "BTCUSDT");
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("limit", "1000");
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error("BTCUSD最新行情获取失败，无法生成实盘参考。");
  const rows = await response.json();
  return rows.map((row) => ({
    time: new Date(row[0]).toISOString().replace("T", " ").slice(0, 16),
    open: round(Number(row[1])),
    high: round(Number(row[2])),
    low: round(Number(row[3])),
    close: round(Number(row[4]))
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

async function fetchBtcCandles(interval) {
  const errors = [];
  for (const source of [fetchBybitCandles, fetchOkxCandles, fetchBinanceCandles, fetchCoinbaseCandles, fetchKrakenCandles]) {
    try {
      const candles = await source(interval);
      if (candles.length >= 80) return candles;
      errors.push(`${source.name}: K线不足`);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  throw new Error(`BTCUSD最新行情获取失败：${errors.join("；")}`);
}

async function fetchBybitCandles(interval) {
  const endpoint = new URL("https://api.bybit.com/v5/market/kline");
  endpoint.searchParams.set("category", "spot");
  endpoint.searchParams.set("symbol", "BTCUSDT");
  endpoint.searchParams.set("interval", bybitInterval(interval));
  endpoint.searchParams.set("limit", "1000");
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Bybit ${response.status}`);
  const payload = await response.json();
  if (payload.retCode !== 0) throw new Error(`Bybit ${payload.retCode}`);
  const rows = payload.result?.list || [];
  return rows.sort((a, b) => Number(a[0]) - Number(b[0])).map((row) => ({
    time: new Date(Number(row[0])).toISOString().replace("T", " ").slice(0, 16),
    open: round(Number(row[1])),
    high: round(Number(row[2])),
    low: round(Number(row[3])),
    close: round(Number(row[4]))
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

async function fetchOkxCandles(interval) {
  const endpoint = new URL("https://www.okx.com/api/v5/market/candles");
  endpoint.searchParams.set("instId", "BTC-USDT");
  endpoint.searchParams.set("bar", okxBar(interval));
  endpoint.searchParams.set("limit", "300");
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`OKX ${response.status}`);
  const payload = await response.json();
  if (payload.code !== "0") throw new Error(`OKX ${payload.code}`);
  const rows = payload.data || [];
  return rows.sort((a, b) => Number(a[0]) - Number(b[0])).map((row) => ({
    time: new Date(Number(row[0])).toISOString().replace("T", " ").slice(0, 16),
    open: round(Number(row[1])),
    high: round(Number(row[2])),
    low: round(Number(row[3])),
    close: round(Number(row[4]))
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

async function fetchCoinbaseCandles(interval) {
  const endpoint = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
  const seconds = granularity(interval);
  endpoint.searchParams.set("granularity", String(seconds));
  endpoint.searchParams.set("start", new Date(Date.now() - seconds * 300 * 1000).toISOString());
  endpoint.searchParams.set("end", new Date().toISOString());
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Coinbase ${response.status}`);
  const rows = await response.json();
  return rows.sort((a, b) => a[0] - b[0]).map((row) => ({
    time: new Date(row[0] * 1000).toISOString().replace("T", " ").slice(0, 16),
    open: round(Number(row[3])),
    high: round(Number(row[2])),
    low: round(Number(row[1])),
    close: round(Number(row[4]))
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

async function fetchKrakenCandles(interval) {
  const endpoint = new URL("https://api.kraken.com/0/public/OHLC");
  endpoint.searchParams.set("pair", "XBTUSD");
  endpoint.searchParams.set("interval", String(Math.max(1, Math.round(granularity(interval) / 60))));
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" } });
  if (!response.ok) throw new Error(`Kraken ${response.status}`);
  const payload = await response.json();
  const key = Object.keys(payload.result || {}).find((name) => name !== "last");
  const rows = key ? payload.result[key] : [];
  return rows.map((row) => ({
    time: new Date(Number(row[0]) * 1000).toISOString().replace("T", " ").slice(0, 16),
    open: round(Number(row[1])),
    high: round(Number(row[2])),
    low: round(Number(row[3])),
    close: round(Number(row[4]))
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

function granularity(interval) {
  return { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400 }[interval] || 900;
}

function bybitInterval(interval) {
  return { "5m": "5", "15m": "15", "30m": "30", "1h": "60", "1d": "D" }[interval] || "15";
}

function okxBar(interval) {
  return { "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "1d": "1D" }[interval] || "15m";
}

function indicators(candles, strategy) {
  const closes = candles.map((c) => c.close);
  return { emaFast: ema(closes, strategy.fast), emaSlow: ema(closes, strategy.slow), rsi: rsi(closes, 14), atr: atr(candles, 14) };
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

function buildMessage(best, count, live) {
  const lines = [
    "AI实盘操作参考",
    `策略来源：稳健排行榜前${count}第1名 ${best.label}`,
    `等级：${best.grade} / 综合分：${Math.round(best.score || 0)}`,
    `周期：${best.interval} / 历史正确率：${pct(best.winRate)} / 交易：${best.trades}笔`,
    `历史净利：${yen(best.netProfit)} / 回撤：${(best.maxDrawdown * 100).toFixed(1)}% / 盈亏比：${Number(best.profitFactor || 0).toFixed(2)}`,
    `参数：EMA ${best.strategy.fast}/${best.strategy.slow}, 止损 ${best.strategy.stopAtr}ATR, 止盈 ${best.strategy.takeProfitR}R`,
    "",
    `当前建议：${live.actionText}`,
    `理由：${live.reason || "-"}`,
    `当前行情状态：${live.currentRegime || "unknown"} / 策略状态：${best.regime || "unknown"}`,
    `参考价：${fmt(live.entry)} / ATR：${fmt(live.atr)} / RSI：${fmt(live.rsi)}`
  ];

  if (live.action === "long" || live.action === "short") {
    lines.push(
      `参考入场：${fmt(live.entry)}`,
      `止损价：${fmt(live.stop)}`,
      `止盈价：${fmt(live.target)}`,
      `OCO设置：入场后立刻设置 止损 ${fmt(live.stop)} + 止盈 ${fmt(live.target)}`,
      `失效条件：${live.invalidation}`,
      "仓位：按单笔风险0.3%-0.5%计算；不允许亏损加仓。"
    );
  } else {
    lines.push("操作：不下单，等待下一次提醒。不要追单。");
  }

  lines.push("注意：这是实盘操作参考，不是保证盈利。下单前必须确认外貨EX CFD报价、点差、滑点，并设置止损/OCO。");
  return lines.join("\n");
}

function gradeRecord(r) {
  if (r.trades >= 18 && r.winRate >= 0.56 && r.profitFactor >= 1.35 && r.avgR > 0.15 && r.maxDrawdown <= 0.05) return "A";
  if (r.trades >= MIN_TRADES && r.winRate >= 0.50 && r.profitFactor >= 1.15 && r.avgR > 0 && r.maxDrawdown <= 0.08) return "B";
  return "C";
}
function scoreRecord(r) {
  const grade = gradeRecord(r);
  let score = r.winRate * 250 + Math.min(Number(r.profitFactor || 0), 4) * 90 + Number(r.avgR || 0) * 140 + Number(r.netProfit || 0) / 50000 * 450 - Number(r.maxDrawdown || 0) * 950 + Math.min(Number(r.trades || 0), 40) * 3;
  if (r.trades < MIN_TRADES) score -= 300;
  if (r.profitFactor < 1.15) score -= 180;
  if (r.avgR <= 0) score -= 180;
  if (r.maxDrawdown > 0.08) score -= 220;
  if (grade === "A") score += 120;
  if (grade === "C") score -= 120;
  return score;
}
function pct(value) { return `${Math.round(value * 100)}%`; }
function yen(value) { return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value || 0); }
function fmt(value) { return Number.isFinite(value) ? Number(value).toFixed(2) : "-"; }
function round(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }
function json(body, status = 200) { return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } }); }
