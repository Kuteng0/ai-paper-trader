"use strict";

const FREE_LIMITS = { cloudWritesPerDay: 50, cloudReadsPerDay: 200, linePushesPerDay: 10, trainingRunsPerDay: 20 };
const LIVE_REFS_KEY = "paperTrader.liveRefs";
const UNSYNCED_KEY = "paperTrader.unsynced";
const LAST_AUTO_SYNC_KEY = "paperTrader.lastAutoSyncDate";

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
  const data = await cloudJson("/api/learning", { method: "POST", body: JSON.stringify({ records, model: state.model || null }) }, "cloudWrites");
  addFeedback(`云端同步完成：云端现有 ${data.count} 条学习记录，AI模型第${data.model?.generation || 0}代。今日云端写入 ${getUsage("cloudWrites")}/${FREE_LIMITS.cloudWritesPerDay}。`, true);
  if (data.records?.length) {
    state.learning = data.records;
    localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
    renderLeaderboard();
  }
  if (data.model) saveModel(data.model);
  markSynced();
}

async function restoreCloudLearning() {
  addFeedback("正在从云端恢复学习记录...");
  const data = await cloudJson("/api/learning", {}, "cloudReads");
  state.learning = data.records || [];
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
  if (data.model) saveModel(data.model);
  renderLeaderboard();
  markSynced();
  addFeedback(`云端恢复完成：已恢复 ${state.learning.length} 条学习记录，AI模型第${state.model?.generation || 0}代。今日云端读取 ${getUsage("cloudReads")}/${FREE_LIMITS.cloudReadsPerDay}。`, true);
}

function confirmCloudAction(kind) {
  const count = state.learning?.length || 0;
  if (kind === "sync") {
    return window.confirm(`确认同步云端？\n\n将把本机 ${count} 条AI学习记录上传到 Cloudflare KV，并可能覆盖/合并云端策略库。\n\n确认继续？`);
  }
  return window.confirm(`确认恢复云端？\n\n将从 Cloudflare KV 读取云端策略库，并替换本机当前AI学习记录。\n建议先确认你已经同步过重要训练结果。\n\n确认继续？`);
}

async function lineFollowRecommendation() {
  assertFreeLimit("linePushes", FREE_LIMITS.linePushesPerDay, "LINE推送");
  addFeedback("正在生成实盘参考：使用本机当前AI模型、读取行情、计算止损/止盈/OCO；不会自动同步云端。");
  await checkLiveReferenceOutcomes().catch(() => {});
  const data = await cloudJson("/api/line-recommend", { method: "POST", body: JSON.stringify({ records: state.learning || [], model: state.model || null }) }, "linePushes");
  saveLiveReference(data);
  addFeedback(`${data.message || "实盘参考LINE已发送。"} 今日LINE推送 ${getUsage("linePushes")}/${FREE_LIMITS.linePushesPerDay}。`, true);
}

async function trainingMode() {
  addUsage("trainingRuns");
  const used = getUsage("trainingRuns");
  if (used > FREE_LIMITS.trainingRunsPerDay) {
    addFeedback(`训练模式今日已超过建议次数 ${FREE_LIMITS.trainingRunsPerDay} 次。本次仍会继续训练，但会消耗历史行情请求次数；训练结果只保存在本机，不会自动同步云端。`, true);
  } else {
    addFeedback(`训练模式启动：进行AI模型训练并保存在本机。今日训练 ${used}/${FREE_LIMITS.trainingRunsPerDay}。训练完成后不会自动同步云端。`, true);
  }
  await randomLearnAllMarkets();
}

function unsyncedState() {
  return JSON.parse(localStorage.getItem(UNSYNCED_KEY) || "{\"dirty\":false,\"reason\":\"\",\"updatedAt\":null}");
}

function markUnsynced(reason = "model") {
  localStorage.setItem(UNSYNCED_KEY, JSON.stringify({ dirty: true, reason, updatedAt: new Date().toISOString() }));
  updateUnsyncedStatus();
}

function markSynced() {
  localStorage.setItem(UNSYNCED_KEY, JSON.stringify({ dirty: false, reason: "", updatedAt: new Date().toISOString() }));
  updateUnsyncedStatus();
}

function updateUnsyncedStatus() {
  const status = document.getElementById("cloudStatus");
  if (!status) return;
  status.textContent = unsyncedState().dirty ? "本机有未同步AI模型" : "云端已同步";
}

async function autoSyncIfNeeded(source = "timer") {
  const stateInfo = unsyncedState();
  if (!stateInfo.dirty) return;
  if (getUsage("cloudWrites") >= FREE_LIMITS.cloudWritesPerDay) return;
  addFeedback(`${source === "midnight" ? "0:00" : "启动检查"}：发现本机AI模型未同步，开始自动同步云端。`, true);
  await syncCloudLearning();
}

function scheduleMidnightAutoSync() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());
  window.setTimeout(async () => {
    localStorage.setItem(LAST_AUTO_SYNC_KEY, todayKey());
    await autoSyncIfNeeded("midnight").catch((error) => addFeedback(`0:00自动同步失败：${error.message || error}`, true));
    scheduleMidnightAutoSync();
  }, delay);
}

function checkMissedAutoSync() {
  const today = todayKey();
  const last = localStorage.getItem(LAST_AUTO_SYNC_KEY);
  if (last !== today && unsyncedState().dirty) {
    localStorage.setItem(LAST_AUTO_SYNC_KEY, today);
    autoSyncIfNeeded("startup").catch((error) => addFeedback(`启动自动同步失败：${error.message || error}`, true));
  }
}

window.markUnsynced = markUnsynced;

function liveRefs() {
  return JSON.parse(localStorage.getItem(LIVE_REFS_KEY) || "[]");
}

function saveLiveRefs(records) {
  localStorage.setItem(LIVE_REFS_KEY, JSON.stringify(records.slice(-80)));
  renderLiveReferenceLog();
}

function ensureLiveReferencePanel() {
  if (document.getElementById("liveReferenceLog")) return;
  const learningPanel = document.querySelector(".learning-panel");
  if (!learningPanel) return;
  const panel = document.createElement("section");
  panel.className = "panel live-reference-panel";
  panel.innerHTML = `
    <div class="section-title">
      <div>
        <p class="section-kicker">实盘参考追踪</p>
        <h2>LINE建议结果</h2>
      </div>
      <span id="liveReferenceStats">0 条</span>
    </div>
    <div id="liveReferenceLog" class="live-reference-log"><p class="empty">还没有可追踪的实盘参考。</p></div>
  `;
  learningPanel.insertAdjacentElement("afterend", panel);
}

function renderLiveReferenceLog() {
  ensureLiveReferencePanel();
  const log = document.getElementById("liveReferenceLog");
  const stats = document.getElementById("liveReferenceStats");
  if (!log || !stats) return;
  const records = liveRefs().slice().reverse();
  const closed = records.filter((record) => record.status === "win" || record.status === "loss");
  const wins = closed.filter((record) => record.status === "win").length;
  stats.textContent = closed.length ? `正确率 ${Math.round(wins / closed.length * 100)}%` : `${records.length} 条`;
  log.innerHTML = records.length ? records.slice(0, 20).map((record) => `
    <div class="live-reference-item ${record.status}">
      <div>
        <strong>${record.label} / ${record.action === "long" ? "做多" : "做空"} / ${record.status === "pending" ? "追踪中" : record.status === "win" ? "止盈" : "止损"}</strong>
        <span>${new Date(record.createdAt).toLocaleString("ja-JP")} / 等级 ${record.grade || "B"} / 正确率 ${Math.round((record.winRate || 0) * 100)}%</span>
        <small>入场 ${fmtLive(record.entry)} / 止损 ${fmtLive(record.stop)} / 止盈 ${fmtLive(record.target)}</small>
      </div>
    </div>
  `).join("") : `<p class="empty">还没有可追踪的实盘参考。</p>`;
}

function fmtLive(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "-";
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
  if (sync) sync.addEventListener("click", () => { if (!confirmCloudAction("sync")) { addFeedback("已取消云端同步。", true); return; } syncCloudLearning().catch((error) => { showError(error); addFeedback(`云端同步失败：${error.message || error}`, true); }); });
  if (restore) restore.addEventListener("click", () => { if (!confirmCloudAction("restore")) { addFeedback("已取消云端恢复。", true); return; } restoreCloudLearning().catch((error) => { showError(error); addFeedback(`云端恢复失败：${error.message || error}`, true); }); });
}

bindCloudButtons();
checkLiveReferenceOutcomes().catch(() => {});
renderLiveReferenceLog();
updateUnsyncedStatus();
checkMissedAutoSync();
scheduleMidnightAutoSync();
addFeedback("免费保护模式已启用：打开App不自动读取云端；只有点击按钮才会消耗Cloudflare/LINE额度。", true);
