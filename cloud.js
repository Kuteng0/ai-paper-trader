"use strict";

const FREE_LIMITS = {
  cloudWritesPerDay: 50,
  cloudReadsPerDay: 200,
  linePushesPerDay: 10,
  trainingRunsPerDay: 20
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(name) {
  return `paperTrader.usage.${todayKey()}.${name}`;
}

function getUsage(name) {
  return Number(localStorage.getItem(usageKey(name)) || "0");
}

function addUsage(name) {
  const next = getUsage(name) + 1;
  localStorage.setItem(usageKey(name), String(next));
  return next;
}

function assertFreeLimit(name, limit, label) {
  const used = getUsage(name);
  if (used >= limit) throw new Error(`${label}今日已达到免费保护上限 ${limit} 次。明天再用，避免超出免费额度。`);
}

async function cloudJson(path, options = {}, usageName = "cloudReads") {
  const isWrite = options.method && options.method !== "GET";
  assertFreeLimit(usageName, isWrite ? FREE_LIMITS.cloudWritesPerDay : FREE_LIMITS.cloudReadsPerDay, isWrite ? "云端写入" : "云端读取");
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  addUsage(usageName);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "云端请求失败。");
  return data;
}

async function syncCloudLearning() {
  const records = state.learning || [];
  addFeedback(`正在同步云端：准备上传 ${records.length} 条学习记录...`);
  const data = await cloudJson("/api/learning", {
    method: "POST",
    body: JSON.stringify({ records })
  }, "cloudWrites");
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
  addFeedback("正在从胜率前10排行榜选择最高胜率策略，并准备LINE推送...");
  await syncCloudLearning();
  const data = await cloudJson("/api/line-recommend", { method: "POST" }, "linePushes");
  addFeedback(`${data.message || "LINE推送请求已完成。"} 今日LINE推送 ${getUsage("linePushes")}/${FREE_LIMITS.linePushesPerDay}。`, true);
}

async function trainingMode() {
  assertFreeLimit("trainingRuns", FREE_LIMITS.trainingRunsPerDay, "训练模式");
  addUsage("trainingRuns");
  addFeedback(`训练模式启动：先进行全品种随机学习，完成后云端备份。今日训练 ${getUsage("trainingRuns")}/${FREE_LIMITS.trainingRunsPerDay}。`, true);
  await randomLearnAllMarkets();
  await syncCloudLearning();
}

function bindCloudButtons() {
  const training = document.getElementById("trainingModeButton");
  const follow = document.getElementById("followModeButton");
  const sync = document.getElementById("syncCloudButton");
  const restore = document.getElementById("restoreCloudButton");
  const cloudStatus = document.getElementById("cloudStatus");

  if (cloudStatus) cloudStatus.textContent = "免费保护模式";
  if (training) training.addEventListener("click", () => trainingMode().catch((error) => { showError(error); addFeedback(`训练模式失败：${error.message || error}`, true); }));
  if (follow) follow.addEventListener("click", () => lineFollowRecommendation().catch((error) => { showError(error); addFeedback(`AI跟单提醒失败：${error.message || error}`, true); }));
  if (sync) sync.addEventListener("click", () => syncCloudLearning().catch((error) => { showError(error); addFeedback(`云端同步失败：${error.message || error}`, true); }));
  if (restore) restore.addEventListener("click", () => restoreCloudLearning().catch((error) => { showError(error); addFeedback(`云端恢复失败：${error.message || error}`, true); }));
}

bindCloudButtons();
addFeedback("免费保护模式已启用：打开App不会自动读取云端；只有点击按钮才会消耗Cloudflare/LINE额度。", true);
