"use strict";

const FREE_LIMITS = { cloudWritesPerDay: 50, cloudReadsPerDay: 200, linePushesPerDay: 10, trainingRunsPerDay: 20 };
const LIVE_REFS_KEY = "paperTrader.liveRefs";

function todayKey() { return new Date().toISOString().slice(0, 10); }
function usageKey(name) { return `paperTrader.usage.${todayKey()}.${name}`; }
function getUsage(name) { return Number(localStorage.getItem(usageKey(name)) || "0"); }
function addUsage(name) { const next = getUsage(name) + 1; localStorage.setItem(usageKey(name), String(next)); return next; }
function assertFreeLimit(name, limit, label) {
  const used = getUsage(name);
  if (used >= limit) throw new Error(`${label}今日已达到免费保护上限 ${limit} 次。明天再用，避免超出免费额度。`);
}

async function cloudJson(path, options = {}, usageName = "cloudReads") {
  const isWrite = options.method && options.method !== "GET";
  assertFreeLimit(usageName, isWrite ? FREE_LIMITS.cloudWritesPerDay : FREE_LIMITS.cloudReadsPerDay, isWrite ? "云端写入" : "云端读取");
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  addUsage(usageName);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "云端请求失败。");
  return data;
}

async function syncCloudLearning() {
  const records = state.learning || [];
  addFeedback(`正在同步云端：准备上传 ${records.length} 条学习记录...`);
  const data = await cloudJson("/api/learning", { method: "POST", body: JSON.stringify({ records }) }, "cloudWrites");
  addFeedback(`云端同步完成：云端现有 ${data.count} 条学习记录。今日云端写入 ${getUsage("cloudWrites")}/${FREE_LIMITS.cloudWritesPerDay}。`, true);
  if (data.records?.length) {
    state.learning = data.records;
    localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
    renderLeaderboard();
  }
}

async function restoreCloudLearning() {
  addFeedback("正在从云端恢复学习记录...");
  const data = await cloudJson("/api/learning", {}, "cloudReads");
  state.learning = data.records || [];
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
  renderLeaderboard();
  addFeedback(`云端恢复完成：已恢复 ${state.learning.length} 条学习记录。今日云端读取 ${getUsage("cloudReads")}/${FREE_LIMITS.cloudReadsPerDay}。`, true);
}

async function lineFollowRecommendation() {
  assertFreeLimit("linePushes", FREE_LIMITS.linePushesPerDay, "LINE推送");
  addFeedback("正在生成实盘参考：同步策略库、读取排行榜、获取最新行情、计算止损/止盈/OCO...");
  await checkLiveReferenceOutcomes().catch(() => {});
  await syncCloudLearning();
  const data = await cloudJson("/api/line-recommend", { method: "POST" }, "linePushes");
  saveLiveReference(data);
  addFeedback(`${data.message || "实盘参考LINE已发送。"} 今日LINE推送 ${getUsage("linePushes")}/${FREE_LIMITS.linePushesPerDay}。`, true);
}

async function trainingMode() {
  assertFreeLimit("trainingRuns", FREE_LIMITS.trainingRunsPerDay, "训练模式");
  addUsage("trainingRuns");
  addFeedback(`训练模式启动：先进行全品种稳健训练，完成后云端备份。今日训练 ${getUsage("trainingRuns")}/${FREE_LIMITS.trainingRunsPerDay}。`, true);
  await randomLearnAllMarkets();
  await syncCloudLearning();
}

function liveRefs() {
  return JSON.parse(localStorage.getItem(LIVE_REFS_KEY) || "[]");
}

function saveLiveRefs(records) {
  localStorage.setItem(LIVE_REFS_KEY, JSON.stringify(records.slice(-80)));
}

function saveLiveReference(data) {
  const live = data?.live;
  const selected = data?.selected;
  if (!live || !selected || !["long", "short"].includes(live.action)) return;
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    symbol: selected.symbol,
    label: selected.label,
    interval: selected.interval || "15m",
    action: live.action,
    entry: live.entry,
    stop: live.stop,
    target: live.target,
    grade: selected.grade || "B",
    winRate: selected.winRate,
    status: "pending"
  };
  const records = liveRefs();
  records.push(record);
  saveLiveRefs(records);
  addFeedback(`已记录实盘参考追踪：${record.label} ${record.action === "long" ? "做多" : "做空"}，等待后续行情验证止盈/止损。`, true);
}

async function checkLiveReferenceOutcomes() {
  const records = liveRefs();
  const pending = records.filter((record) => record.status === "pending").slice(-20);
  if (!pending.length) return;
  let changed = 0;
  for (const record of pending) {
    const candles = await fetch(`/api/history?symbol=${encodeURIComponent(record.symbol)}&interval=${encodeURIComponent(record.interval)}&range=60d`).then((res) => res.json()).then((data) => data.candles || []).catch(() => []);
    const later = candles.filter((candle) => new Date(candle.time).getTime() > new Date(record.createdAt).getTime());
    for (const candle of later) {
      if (record.action === "long") {
        if (candle.low <= record.stop) { record.status = "loss"; record.closedAt = candle.time; changed++; break; }
        if (candle.high >= record.target) { record.status = "win"; record.closedAt = candle.time; changed++; break; }
      } else {
        if (candle.high >= record.stop) { record.status = "loss"; record.closedAt = candle.time; changed++; break; }
        if (candle.low <= record.target) { record.status = "win"; record.closedAt = candle.time; changed++; break; }
      }
    }
  }
  if (changed) {
    saveLiveRefs(records);
    const closed = records.filter((record) => record.status === "win" || record.status === "loss");
    const wins = closed.filter((record) => record.status === "win").length;
    const rate = closed.length ? Math.round(wins / closed.length * 100) : 0;
    addFeedback(`实盘参考追踪已更新：已结算 ${closed.length} 条，正确率 ${rate}%（止盈 ${wins} / 止损 ${closed.length - wins}）。`, true);
  }
}

function bindCloudButtons() {
  const training = document.getElementById("trainingModeButton"), follow = document.getElementById("followModeButton"), sync = document.getElementById("syncCloudButton"), restore = document.getElementById("restoreCloudButton"), cloudStatus = document.getElementById("cloudStatus");
  if (cloudStatus) cloudStatus.textContent = "免费保护模式";
  if (training) training.addEventListener("click", () => trainingMode().catch((error) => { showError(error); addFeedback(`训练模式失败：${error.message || error}`, true); }));
  if (follow) follow.addEventListener("click", () => lineFollowRecommendation().catch((error) => { showError(error); addFeedback(`实盘参考LINE失败：${error.message || error}`, true); }));
  if (sync) sync.addEventListener("click", () => syncCloudLearning().catch((error) => { showError(error); addFeedback(`云端同步失败：${error.message || error}`, true); }));
  if (restore) restore.addEventListener("click", () => restoreCloudLearning().catch((error) => { showError(error); addFeedback(`云端恢复失败：${error.message || error}`, true); }));
}

bindCloudButtons();
checkLiveReferenceOutcomes().catch(() => {});
addFeedback("免费保护模式已启用：打开App不自动读取云端；只有点击按钮才会消耗Cloudflare/LINE额度。", true);
