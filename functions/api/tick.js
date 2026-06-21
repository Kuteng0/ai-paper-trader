const KEY = "ticks:latest";

export async function onRequestGet({ env }) {
  if (!env.LEARNING_KV) return json({ error: "Cloudflare KV 尚未配置。" }, 500);
  const ticks = await env.LEARNING_KV.get(KEY, "json");
  return json({ ticks: ticks || {}, updatedAt: ticks?.updatedAt || null });
}

export async function onRequestPost({ request, env }) {
  if (!env.LEARNING_KV) return json({ error: "Cloudflare KV 尚未配置。" }, 500);
  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();
  const incoming = Array.isArray(body.ticks) ? body.ticks : [body];
  const current = await env.LEARNING_KV.get(KEY, "json") || {};
  for (const item of incoming) {
    const symbol = String(item.symbol || "").trim();
    if (!symbol) continue;
    const bid = num(item.bid);
    const ask = num(item.ask);
    const last = num(item.last) ?? (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask);
    if (last == null) continue;
    current[symbol] = {
      symbol,
      label: String(item.label || symbol),
      bid,
      ask,
      last,
      source: String(item.source || "gaikaex-bridge"),
      updatedAt: now
    };
  }
  current.updatedAt = now;
  await env.LEARNING_KV.put(KEY, JSON.stringify(current));
  return json({ ok: true, updatedAt: now, count: Object.keys(current).filter((key) => key !== "updatedAt").length });
}

function num(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
