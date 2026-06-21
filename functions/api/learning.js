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
  if (!validIncoming) return normalizeModel(validExisting);
  if (!validExisting) return normalizeModel(validIncoming);
  return mergeModels(validExisting, validIncoming);
}

function mergeModels(existing, incoming) {
  const population = mergePopulation(existing.population, incoming.population);
  const championPool = mergePopulation([
    ...population,
    existing.champion,
    incoming.champion,
    existing.generalChampion,
    incoming.generalChampion,
    existing.btcChampion,
    incoming.btcChampion
  ].filter(Boolean), []);
  const livePool = championPool.filter((item) => item.liveEligible !== false && item.grade !== "观察");
  const generalChampion = livePool.find((item) => item.symbol !== "BTCUSD") || incoming.generalChampion || existing.generalChampion || null;
  const btcChampion = championPool.find((item) => item.symbol === "BTCUSD") || incoming.btcChampion || existing.btcChampion || null;
  const champion = generalChampion || livePool[0] || null;
  return {
    ...existing,
    ...incoming,
    version: 2,
    generation: Math.max(Number(existing.generation || 0), Number(incoming.generation || 0)),
    population,
    generalChampion,
    btcChampion,
    champion,
    updatedAt: new Date().toISOString(),
    mergedAt: new Date().toISOString()
  };
}

function normalizeModel(model) {
  if (!model) return null;
  const population = mergePopulation(model.population || [], []);
  const pool = mergePopulation([...(population || []), model.champion, model.generalChampion, model.btcChampion].filter(Boolean), []);
  const livePool = pool.filter((item) => item.liveEligible !== false && item.grade !== "观察");
  return {
    ...model,
    version: 2,
    population,
    generalChampion: model.generalChampion || livePool.find((item) => item.symbol !== "BTCUSD") || null,
    btcChampion: model.btcChampion || pool.find((item) => item.symbol === "BTCUSD") || null,
    champion: model.generalChampion || (model.champion?.symbol !== "BTCUSD" ? model.champion : null) || livePool.find((item) => item.symbol !== "BTCUSD") || livePool[0] || null
  };
}

function mergePopulation(a = [], b = []) {
  const map = new Map();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item?.strategy || !item.symbol) continue;
    const key = `${item.symbol}|${item.interval || ""}|${item.regime || "unknown"}|${strategyKey(item.strategy)}`;
    const prev = map.get(key);
    if (!prev || Number(item.score || 0) > Number(prev.score || 0)) map.set(key, item);
  }
  return [...map.values()].sort((x, y) => Number(y.score || 0) - Number(x.score || 0)).slice(0, 50);
}

function strategyKey(strategy = {}) {
  return [strategy.mode || "cross", strategy.fast, strategy.slow, strategy.rsiFloor, strategy.rsiCeil, strategy.stopAtr, strategy.takeProfitR].join("-");
}

function isValidModel(model) {
  return model && typeof model === "object" && Number.isFinite(Number(model.generation || 0));
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
