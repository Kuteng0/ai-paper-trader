const KEY = "learning:default";
const MAX_RECORDS = 500;

export async function onRequestGet({ env }) {
  const store = env.LEARNING_KV;
  if (!store) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  const state = await readState(store);
  return json({ records: state.records, model: state.model, count: state.records.length });
}

export async function onRequestPost({ request, env }) {
  const store = env.LEARNING_KV;
  if (!store) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.records) ? body.records : [];
  const existing = await readState(store);
  const merged = mergeRecords(existing.records, incoming).slice(-MAX_RECORDS);
  const model = chooseModel(existing.model, body.model);
  await store.put(KEY, JSON.stringify({ records: merged, model, updatedAt: new Date().toISOString() }));
  return json({ records: merged, model, count: merged.length });
}

async function readState(store) {
  const value = await store.get(KEY, "json");
  if (Array.isArray(value)) return { records: value, model: null };
  if (value && typeof value === "object") {
    return { records: Array.isArray(value.records) ? value.records : [], model: isValidModel(value.model) ? value.model : null };
  }
  return { records: [], model: null };
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

function chooseModel(existing, incoming) {
  const validExisting = isValidModel(existing) ? existing : null;
  const validIncoming = isValidModel(incoming) ? incoming : null;
  if (!validIncoming) return validExisting;
  if (!validExisting) return validIncoming;
  return Number(validIncoming.generation || 0) >= Number(validExisting.generation || 0) ? validIncoming : validExisting;
}

function isValidModel(model) {
  return model && typeof model === "object" && Number.isFinite(Number(model.generation || 0));
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
