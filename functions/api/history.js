const ALLOWED = {
  "BTCUSD": "BTCUSD 比特币",
  "NQ=F": "纳指期货 NQ",
  "ES=F": "标普500期货 ES",
  "YM=F": "道指期货 YM",
  "GC=F": "黄金期货 GC",
  "CL=F": "原油期货 CL",
  "NG=F": "天然气期货 NG",
  "^N225": "日经225指数"
};

const INTERVALS = new Set(["5m", "15m", "30m", "1h", "1d"]);
const RANGES = new Set(["5d", "1mo", "60d", "6mo", "1y", "2y"]);

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "ES=F";
  const interval = url.searchParams.get("interval") || "15m";
  const range = url.searchParams.get("range") || "60d";

  if (!ALLOWED[symbol]) return json({ error: "不支持的品种。" }, 400);
  if (!INTERVALS.has(interval)) return json({ error: "不支持的周期。" }, 400);
  if (!RANGES.has(range)) return json({ error: "不支持的数据范围。" }, 400);
  if (symbol === "BTCUSD") return fetchBtcHistory(interval, range);
  return fetchYahooHistory(symbol, interval, range);
}

async function fetchBtcHistory(interval, range) {
  const errors = [];
  for (const source of [fetchBinanceHistory, fetchCoinbaseHistory, fetchKrakenHistory]) {
    try {
      const result = await source(interval, range);
      if (result.candles.length >= 80) return json(result, 200, { "Cache-Control": interval === "1d" ? "public, max-age=300" : "public, max-age=15" });
      errors.push(`${result.source}: K线不足`);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  return json({ error: `BTCUSD行情源暂时不可用：${errors.join("；")}` }, 502);
}

async function fetchYahooHistory(symbol, interval, range) {
  const endpoint = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  endpoint.searchParams.set("range", range);
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("includePrePost", "true");
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" }, cf: { cacheTtl: interval === "1d" ? 3600 : 300, cacheEverything: true } });
  if (!response.ok) return json({ error: "行情数据源暂时不可用。" }, 502);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) return json({ error: "没有返回行情数据。" }, 502);
  const candles = timestamps.map((ts, i) => candle(new Date(ts * 1000), quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i])).filter(validCandle);
  return json({ symbol, label: ALLOWED[symbol], interval, range, source: "Yahoo Finance chart", candles }, 200, { "Cache-Control": interval === "1d" ? "public, max-age=3600" : "public, max-age=300" });
}

async function fetchBinanceHistory(interval, range) {
  const endpoint = new URL("https://api.binance.com/api/v3/klines");
  endpoint.searchParams.set("symbol", "BTCUSDT");
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("limit", "1000");
  endpoint.searchParams.set("startTime", String(Date.now() - rangeMs(range)));
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" }, cf: { cacheTtl: interval === "1d" ? 300 : 15, cacheEverything: true } });
  if (!response.ok) throw new Error(`Binance ${response.status}`);
  const rows = await response.json();
  const candles = rows.map((row) => candle(new Date(row[0]), row[1], row[2], row[3], row[4])).filter(validCandle);
  return { symbol: "BTCUSD", label: "BTCUSD 比特币", interval, range, source: "Binance BTCUSDT klines", candles };
}

async function fetchCoinbaseHistory(interval, range) {
  const endpoint = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
  endpoint.searchParams.set("granularity", String(granularity(interval)));
  endpoint.searchParams.set("start", new Date(Date.now() - Math.min(rangeMs(range), granularity(interval) * 300 * 1000)).toISOString());
  endpoint.searchParams.set("end", new Date().toISOString());
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" }, cf: { cacheTtl: interval === "1d" ? 300 : 15, cacheEverything: true } });
  if (!response.ok) throw new Error(`Coinbase ${response.status}`);
  const rows = await response.json();
  const candles = rows.sort((a, b) => a[0] - b[0]).map((row) => candle(new Date(row[0] * 1000), row[3], row[2], row[1], row[4])).filter(validCandle);
  return { symbol: "BTCUSD", label: "BTCUSD 比特币", interval, range, source: "Coinbase BTC-USD candles", candles };
}

async function fetchKrakenHistory(interval, range) {
  const endpoint = new URL("https://api.kraken.com/0/public/OHLC");
  endpoint.searchParams.set("pair", "XBTUSD");
  endpoint.searchParams.set("interval", String(Math.max(1, Math.round(granularity(interval) / 60))));
  endpoint.searchParams.set("since", String(Math.floor((Date.now() - rangeMs(range)) / 1000)));
  const response = await fetch(endpoint.toString(), { headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" }, cf: { cacheTtl: interval === "1d" ? 300 : 15, cacheEverything: true } });
  if (!response.ok) throw new Error(`Kraken ${response.status}`);
  const payload = await response.json();
  const key = Object.keys(payload.result || {}).find((name) => name !== "last");
  const rows = key ? payload.result[key] : [];
  const candles = rows.map((row) => candle(new Date(Number(row[0]) * 1000), row[1], row[2], row[3], row[4])).filter(validCandle);
  return { symbol: "BTCUSD", label: "BTCUSD 比特币", interval, range, source: "Kraken XBTUSD OHLC", candles };
}

function granularity(interval) {
  return { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400 }[interval] || 900;
}

function rangeMs(range) {
  const day = 24 * 60 * 60 * 1000;
  return { "5d": 5 * day, "1mo": 30 * day, "60d": 60 * day, "6mo": 180 * day, "1y": 365 * day, "2y": 730 * day }[range] || 60 * day;
}

function candle(time, open, high, low, close) {
  return { time: time.toISOString().replace("T", " ").slice(0, 16), open: round(Number(open)), high: round(Number(high)), low: round(Number(low)), close: round(Number(close)) };
}

function validCandle(c) {
  return [c.open, c.high, c.low, c.close].every(Number.isFinite);
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*", ...headers } });
}
