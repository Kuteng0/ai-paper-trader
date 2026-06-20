const ALLOWED = {
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

  const endpoint = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  endpoint.searchParams.set("range", range);
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("includePrePost", "true");

  const response = await fetch(endpoint.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 AI Paper Trader" },
    cf: { cacheTtl: interval === "1d" ? 3600 : 300, cacheEverything: true }
  });

  if (!response.ok) return json({ error: "行情数据源暂时不可用。" }, 502);

  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!quote || !timestamps.length) return json({ error: "没有返回行情数据。" }, 502);

  const candles = timestamps.map((ts, i) => ({
    time: new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16),
    open: round(quote.open?.[i]),
    high: round(quote.high?.[i]),
    low: round(quote.low?.[i]),
    close: round(quote.close?.[i])
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));

  return json({ symbol, label: ALLOWED[symbol], interval, range, source: "Yahoo Finance chart", candles }, 200, {
    "Cache-Control": interval === "1d" ? "public, max-age=3600" : "public, max-age=300"
  });
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*", ...headers } });
}
