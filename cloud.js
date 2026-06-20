"use strict";

async function cloudJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
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
  });
  addFeedback(`云端同步完成：云端现有 ${data.count} 条学习记录。`, true);
  if (data.records?.length) {
    state.learning = data.records;
    localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
    renderLeaderboard();
  }
}

async function restoreCloudLearning() {
  addFeedback("正在从云端恢复学习记录...");
  const data = await cloudJson("/api/learning");
  state.learning = data.records || [];
  localStorage.setItem("paperTrader.learning", JSON.stringify(state.learning));
  renderLeaderboard();
  addFeedback(`云端恢复完成：已恢复 ${state.learning.length} 条学习记录。`, true);
}

async function lineFollowRecommendation() {
  addFeedback("正在从胜率前10排行榜选择最高胜率策略，并准备LINE推送...");
  await syncCloudLearning();
  const data = await cloudJson("/api/line-recommend", { method: "POST" });
  addFeedback(data.message || "LINE推送请求已完成。", true);
}

async function trainingMode() {
  addFeedback("训练模式启动：先进行全品种随机学习，完成后自动云端备份。", true);
  await randomLearnAllMarkets();
  await syncCloudLearning();
}

function bindCloudButtons() {
  const training = document.getElementById("trainingModeButton");
  const follow = document.getElementById("followModeButton");
  const sync = document.getElementById("syncCloudButton");
  const restore = document.getElementById("restoreCloudButton");
  const cloudStatus = document.getElementById("cloudStatus");

  if (cloudStatus) cloudStatus.textContent = "本地保存 + Cloudflare备份";
  if (training) training.addEventListener("click", () => trainingMode().catch((error) => { showError(error); addFeedback(`训练模式失败：${error.message || error}`, true); }));
  if (follow) follow.addEventListener("click", () => lineFollowRecommendation().catch((error) => { showError(error); addFeedback(`AI跟单提醒失败：${error.message || error}`, true); }));
  if (sync) sync.addEventListener("click", () => syncCloudLearning().catch((error) => { showError(error); addFeedback(`云端同步失败：${error.message || error}`, true); }));
  if (restore) restore.addEventListener("click", () => restoreCloudLearning().catch((error) => { showError(error); addFeedback(`云端恢复失败：${error.message || error}`, true); }));
}

bindCloudButtons();
restoreCloudLearning().catch(() => {
  addFeedback("云端记录暂未恢复：请确认Cloudflare KV绑定是否已配置。", true);
});
