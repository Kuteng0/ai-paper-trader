const KEY = "learning:default";
const MAX_RECORDS = 500;

export async function onRequestGet({ env }) {
  const store = env.LEARNING_KV;
  if (!store) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  const records = await readRecords(store);
  return json({ records, count: records.length });
}

export async function onRequestPost({ request, env }) {
  const store = env.LEARNING_KV;
  if (!store) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.records) ? body.records : [];
  const existing = await readRecords(store);
  const merged = mergeRecords(existing, incoming).slice(-MAX_RECORDS);
  await store.put(KEY, JSON.stringify(merged));
  return json({ records: merged, count: merged.length });
}

async function readRecords(store) {
  const records = await store.get(KEY, "json");
  return Array.isArray(records) ? records : [];
}

function mergeRecords(existing, incoming) {
  const map = new Map();
  for (const record of [...existing, ...incoming]) {
    if (!isValidRecord(record)) continue;
    map.set(record.id || `${record.symbol}-${record.interval}-${record.time}-${record.winRate}`, record);
  }
  return [...map.values()].sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
}

function isValidRecord(record) {
  return record && typeof record === "object" && record.symbol && Number.isFinite(record.winRate) && Number.isFinite(record.trades) && record.strategy;
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
