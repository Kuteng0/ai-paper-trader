"use strict";

const FREE_LIMITS = {
  functionRequestsPerDay: 100000,
  cloudWritesPerDay: 900,
  cloudReadsPerDay: 90000,
  linePushesPerDay: 10,
  trainingAdvisoryRunsPerDay: 20
};

const LIVE_REFS_KEY = "paperTrader.liveRefs";
const LIVE_MONITOR_KEY = "paperTrader.liveMonitor";
const LIVE_SYMBOL_KEY = "paperTrader.liveSymbol";
const LAST_SIGNAL_KEY = "paperTrader.lastSignalKey";
const PRE_CLOSE_KEY = "paperTrader.preClose";
const MARKET_ACTIVITY_KEY = "paperTrader.marketActivity";
const UNSYNCED_KEY = "paperTrader.unsynced";
const LAST_AUTO_SYNC_KEY = "paperTrader.lastAutoSyncDate";
const REALTIME_ULTRA_INTERVAL_MS = 2 * 1000;
const REALTIME_FAST_INTERVAL_MS = 5 * 1000;
const REALTIME_NORMAL_INTERVAL_MS = 15 * 1000;
const REALTIME_SLOW_INTERVAL_MS = 60 * 1000;
const REALTIME_IDLE_INTERVAL_MS = 5 * 60 * 1000;
const PRE_CLOSE_MINUTES = 15;
let realtimeMonitorRunning = false;
let realtimeTimerId = null;

function todayKey() { return new Date().toISOString().slice(0, 10); }
function jstNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })); }
function minutesOfDay(date) { return date.getHours() * 60 + date.getMinutes(); }
function usageKey(name) { return `paperTrader.usage.${todayKey()}.${name}`; }
function getUsage(name) { return Number(localStorage.getItem(usageKey(name)) || "0"); }
function addUsage(name) { const next = getUsage(name) + 1; localStorage.setItem(usageKey(name), String(next)); return next; }

function assertFreeLimit(name, limit, label) {
  const used = getUsage(name);
  if (used >= limit) throw new Error(`${label}今日已达到免费保护上限 ${limit} 次。明天再用，避免超出免费额度。`);
}

function addFunctionRequestUsage(label = "function", count = 1) {
  const used = addUsage("functionRequests") + count - 1;
  if (used >= FREE_LIMITS.functionRequestsPerDay) {
    addFeedback(`Cloudflare动态请求估算已达到 ${used}/${FREE_LIMITS.functionRequestsPerDay}。建议今天停止训练，避免超过免费额度。`, true);
  } else if (used >= FREE_LIMITS.functionRequestsPerDay * 0.95) {
    addFeedback(`Cloudflare动态请求估算已超过95%：${used}/${FREE_LIMITS.functionRequestsPerDay}。建议只做必要操作。`, true);
  } else if (used >= FREE_LIMITS.functionRequestsPerDay * 0.8) {
    addFeedback(`Cloudflare动态请求估算已超过80%：${used}/${FREE_LIMITS.functionRequestsPerDay}。继续训练前请注意免费额度。`, true);
  }
  return used;
}

function functionUsageText() {
  return `${getUsage("functionRequests")}/${FREE_LIMITS.functionRequestsPerDay}`;
}

function isUsSummerTimeForTrading(date = jstNow()) {
  const year = date.getFullYear();
  const secondSundayMarch = nthWeekdayOfMonth(year, 2, 0, 2);
  const firstSundayNovember = nthWeekdayOfMonth(year, 10, 0, 1);
  return date >= secondSundayMarch && date < firstSundayNovember;
}

function nthWeekdayOfMonth(year, monthIndex, weekday, nth) {
  const date = new Date(year, monthIndex, 1);
  const offset = (weekday - date.getDay() + 7) % 7;
  date.setDate(1 + offset + (nth - 1) * 7);
  return date;
}

function cfdSessionState(date = jstNow()) {
  if (localStorage.getItem(LIVE_SYMBOL_KEY) === "BTCUSD") {
    return { open: true, beforeClose: false, reason: "BTCUSD 24小时交易", summer: isUsSummerTimeForTrading(date), closeMinute: null, reopenMinute: null, nextDelayMs: REALTIME_NORMAL_INTERVAL_MS };
  }
  const day = date.getDay();
  const minute = minutesOfDay(date);
  const summer = isUsSummerTimeForTrading(date);
  const closeMinute = summer ? 5 * 60 + 50 : 6 * 60 + 50;
  const reopenMinute = summer ? 6 * 60 + 10 : 7 * 60 + 10;
  const mondayOpenMinute = 7 * 60;
  const saturdayCloseMinute = closeMinute;

  let open = true;
  let reason = "主要CFD交易时间";
  if (day === 0) {
    open = false; reason = "周日休市";
  } else if (day === 1 && minute < mondayOpenMinute) {
    open = false; reason = "周一开盘前";
  } else if (day === 6 && minute >= saturdayCloseMinute) {
    open = false; reason = "周末休市";
  } else if (day >= 2 && day <= 5 && minute >= closeMinute && minute < reopenMinute) {
    open = false; reason = "每日维护/关盘时间";
  }

  const beforeClose = open && day >= 1 && day <= 5 && minute >= closeMinute - PRE_CLOSE_MINUTES && minute < closeMinute;
  return { open, beforeClose, reason, summer, closeMinute, reopenMinute, nextDelayMs: open ? REALTIME_NORMAL_INTERVAL_MS : REALTIME_IDLE_INTERVAL_MS };
}

function preCloseKey(date = jstNow()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function usageRatio() {
  return getUsage("functionRequests") / FREE_LIMITS.functionRequestsPerDay;
}

function marketActivityState() {
  return JSON.parse(localStorage.getItem(MARKET_ACTIVITY_KEY) || "{\"lastKey\":\"\",\"lastEntry\":0,\"quiet\":0,\"active\":0,\"lastSignalAt\":null}");
}

function saveMarketActivityState(info) {
  localStorage.setItem(MARKET_ACTIVITY_KEY, JSON.stringify(info));
}

function updateMarketActivityFromProbe(probe) {
  const info = marketActivityState();
  const live = probe?.live || {};
  const selected = probe?.selected || {};
  const entry = Number(live.entry || 0);
  const key = `${selected.symbol || "-"}|${selected.interval || "-"}|${live.currentRegime || "unknown"}|${live.action || "wait"}`;
  const lastEntry = Number(info.lastEntry || 0);
  const move = lastEntry ? Math.abs(entry - lastEntry) / Math.max(1, Math.abs(lastEntry)) : 0;
  const changed = key !== info.lastKey || move >= 0.00035 || ["long", "short"].includes(live.action);
  if (changed) {
    info.active = Math.min(6, Number(info.active || 0) + 1);
    info.quiet = 0;
    info.lastSignalAt = new Date().toISOString();
  } else {
    info.quiet = Math.min(12, Number(info.quiet || 0) + 1);
    info.active = Math.max(0, Number(info.active || 0) - 1);
  }
  info.lastKey = key;
  info.lastEntry = entry;
  info.lastMove = move;
  info.updatedAt = new Date().toISOString();
  saveMarketActivityState(info);
  return info;
}

function hasPendingLiveRefs() {
  return liveRefs().some((record) => record.status === "pending");
}

function adaptiveDelayMs(session = cfdSessionState()) {
  if (!session.open) return REALTIME_IDLE_INTERVAL_MS;
  const ratio = usageRatio();
  const activity = marketActivityState();
  const pending = hasPendingLiveRefs();
  if (ratio >= 0.98) return REALTIME_IDLE_INTERVAL_MS;
  if (ratio >= 0.90) return pending ? REALTIME_SLOW_INTERVAL_MS : REALTIME_IDLE_INTERVAL_MS;
  if (ratio >= 0.80) return pending || Number(activity.active || 0) >= 3 ? REALTIME_NORMAL_INTERVAL_MS : REALTIME_SLOW_INTERVAL_MS;
  if (Number(activity.quiet || 0) >= 8 && !pending) return REALTIME_SLOW_INTERVAL_MS;
  if (pending || Number(activity.active || 0) >= 4) return REALTIME_ULTRA_INTERVAL_MS;
  if (Number(activity.active || 0) >= 2) return REALTIME_FAST_INTERVAL_MS;
  return REALTIME_NORMAL_INTERVAL_MS;
}

function adaptiveDelayText(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`;
  return `${Math.round(ms / 60000)}分钟`;
}

async function cloudJson(path, options = {}, usageName = "cloudReads") {
  const isWrite = options.method && options.method !== "GET";
  assertFreeLimit(usageName, isWrite ? FREE_LIMITS.cloudWritesPerDay : FREE_LIMITS.cloudReadsPerDay, isWrite ? "云端写入" : "云端读取");
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  addFunctionRequestUsage(path);
  addUsage(usageName);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "云端请求失败。");
  return data;
}

async function lineJson(body) {
  const response = await fetch("/api/line-recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  addFunctionRequestUsage("/api/line-recommend");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "LINE请求失败。");
  if (data.pushed) addUsage("linePushes");
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
  return window.confirm("确认恢复云端？\n\n将从 Cloudflare KV 读取云端策略库，并替换本机当前AI学习记录。\n建议先确认你已经同步过重要训练结果。\n\n确认继续？");
}

async function lineFollowRecommendation() {
  localStorage.setItem(LIVE_MONITOR_KEY, "on");
  localStorage.removeItem(LIVE_SYMBOL_KEY);
  addFeedback("自适应实时盯盘已开启：行情活跃时最快10秒检查，安静或额度超过90%时自动降频。");
  await runRealtimeMonitorCycle("manual");
  scheduleRealtimeMonitor();
}

async function btcLineRecommendation() {
  localStorage.setItem(LIVE_MONITOR_KEY, "on");
  localStorage.setItem(LIVE_SYMBOL_KEY, "BTCUSD");
  addFeedback("BTCUSD实时LINE已开启：只检查BTCUSD策略，行情活跃时最快2秒检查。", true);
  await runRealtimeMonitorCycle("manual");
  scheduleRealtimeMonitor();
}

async function sendLineEvent(text) {
  assertFreeLimit("linePushes", FREE_LIMITS.linePushesPerDay, "LINE推送");
  return lineJson({ eventText: text });
}

async function trainingMode() {
  addUsage("trainingRuns");
  const used = getUsage("trainingRuns");
  const estimatedNext = getUsage("functionRequests") + SYMBOLS.length;
  if (estimatedNext >= FREE_LIMITS.functionRequestsPerDay) {
    addFeedback(`训练前提醒：Cloudflare动态请求估算将接近或超过免费额度 ${FREE_LIMITS.functionRequestsPerDay}/天。本次仍会继续，但建议今天停止追加训练。`, true);
  } else if (used > FREE_LIMITS.trainingAdvisoryRunsPerDay) {
    addFeedback(`训练模式今日已超过建议次数 ${FREE_LIMITS.trainingAdvisoryRunsPerDay} 次。本次仍会继续训练。当前Cloudflare动态请求估算 ${functionUsageText()}。`, true);
  } else {
    addFeedback(`训练模式启动：进行AI模型训练并保存在本机。今日训练 ${used}/${FREE_LIMITS.trainingAdvisoryRunsPerDay}，Cloudflare动态请求估算 ${functionUsageText()}。训练完成后不会自动同步云端。`, true);
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
window.addFunctionRequestUsage = addFunctionRequestUsage;

function liveRefs() {
  return JSON.parse(localStorage.getItem(LIVE_REFS_KEY) || "[]");
}

function saveLiveRefs(records) {
  localStorage.setItem(LIVE_REFS_KEY, JSON.stringify(records.slice(-80)));
  renderLiveReferenceLog();
}

function renderLiveReferenceLog() {
  const log = document.getElementById("liveReferenceLog");
  const stats = document.getElementById("liveReferenceStats");
  if (!log || !stats) return;
  const records = liveRefs().slice().reverse();
  const closed = records.filter((record) => ["win", "loss", "exit"].includes(record.status));
  const wins = closed.filter((record) => record.status === "win").length;
  stats.textContent = closed.length ? `完成 ${closed.length} / 止盈率 ${Math.round(wins / closed.length * 100)}%` : `${records.length} 条`;
  log.innerHTML = records.length ? records.slice(0, 20).map((record) => `
    <div class="live-reference-item ${record.status}">
      <strong>${record.label} / ${record.action === "long" ? "做多" : "做空"} / ${liveStatusText(record.status)}</strong>
      <span>${new Date(record.createdAt).toLocaleString("ja-JP")} / 等级 ${record.grade || "B"} / 正确率 ${Math.round((record.winRate || 0) * 100)}%</span>
      <small>入场 ${fmtLive(record.entry)} / 止损 ${fmtLive(record.stop)} / 止盈 ${fmtLive(record.target)}</small>
      ${record.exitReason ? `<small>变动：${record.exitReason}</small>` : ""}
    </div>
  `).join("") : `<p class="empty">还没有可追踪的实盘参考。</p>`;
}

function liveStatusText(status) {
  if (status === "win") return "止盈";
  if (status === "loss") return "止损";
  if (status === "exit") return "提前出场";
  return "追踪中";
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
    strategy: selected.strategy,
    regime: selected.regime || live.currentRegime || "unknown",
    score: selected.score,
    grade: selected.grade || "B",
    winRate: selected.winRate,
    profitFactor: selected.profitFactor,
    maxDrawdown: selected.maxDrawdown,
    status: "pending",
    lastNotified: "entry"
  };
  const records = liveRefs();
  records.push(record);
  saveLiveRefs(records);
  addFeedback(`已记录实盘LINE追踪：${record.label} ${record.action === "long" ? "做多" : "做空"}，等待后续行情验证止盈、止损或提前出场。`, true);
}

function liveSignalKey(selected, live) {
  if (!selected || !live) return "";
  return [
    selected.symbol,
    selected.interval || "15m",
    live.action,
    Math.round(Number(live.entry || 0) * 100),
    Math.round(Number(live.stop || 0) * 100),
    Math.round(Number(live.target || 0) * 100)
  ].join("|");
}

function isDuplicateLiveSignal(selected, live) {
  const key = liveSignalKey(selected, live);
  if (!key) return true;
  if (localStorage.getItem(LAST_SIGNAL_KEY) === key) return true;
  return liveRefs().some((record) => {
    if (record.status !== "pending") return false;
    if (record.symbol !== selected.symbol || record.interval !== (selected.interval || "15m") || record.action !== live.action) return false;
    const base = Math.max(1, Math.abs(Number(live.entry || 0)));
    return Math.abs(Number(record.entry || 0) - Number(live.entry || 0)) / base < 0.001;
  });
}

function rememberLiveSignal(selected, live) {
  const key = liveSignalKey(selected, live);
  if (key) localStorage.setItem(LAST_SIGNAL_KEY, key);
}

async function checkNewEntrySignal() {
  if (getUsage("linePushes") >= FREE_LIMITS.linePushesPerDay) {
    addFeedback(`LINE今日推送已达到保护上限 ${FREE_LIMITS.linePushesPerDay}，实时盯盘仍会检查行情，但不会继续推送。`, true);
    return;
  }
  const forceSymbol = localStorage.getItem(LIVE_SYMBOL_KEY) || "";
  const probe = await lineJson({ records: state.learning || [], model: state.model || null, dryRun: true, forceSymbol });
  const activity = updateMarketActivityFromProbe(probe);
  const live = probe.live;
  const selected = probe.selected;
  if (!live || !selected || !["long", "short"].includes(live.action)) {
    addFeedback(`实时盯盘：暂无新入场信号。活跃 ${activity.active || 0} / 安静 ${activity.quiet || 0}，Cloudflare动态请求 ${functionUsageText()}。`);
    return;
  }
  if (isDuplicateLiveSignal(selected, live)) {
    addFeedback(`实时盯盘：${selected.label} 仍是同一入场信号，避免重复LINE。`);
    return;
  }
  const pushed = await lineJson({ records: state.learning || [], model: state.model || null, notifyOnlyOnSignal: true, forceSymbol });
  if (pushed.pushed) {
    rememberLiveSignal(pushed.selected, pushed.live);
    saveLiveReference(pushed);
    addFeedback(`${pushed.message || "实时入场信号已发送LINE。"} 今日LINE推送 ${getUsage("linePushes")}/${FREE_LIMITS.linePushesPerDay}。`, true);
  }
}

async function runPreClosePreparation(session) {
  const key = preCloseKey();
  if (localStorage.getItem(PRE_CLOSE_KEY) === key) return;
  localStorage.setItem(PRE_CLOSE_KEY, key);
  addFeedback("关盘前预处理：获取最后一轮行情，让AI保存次日参考快照。", true);
  const probe = await lineJson({ records: state.learning || [], model: state.model || null, dryRun: true });
  updateMarketActivityFromProbe(probe);
  const snapshot = {
    date: key,
    savedAt: new Date().toISOString(),
    session,
    selected: probe.selected || null,
    live: probe.live || null,
    modelGeneration: state.model?.generation || 0
  };
  localStorage.setItem("paperTrader.preCloseSnapshot", JSON.stringify(snapshot));
  addFeedback(`关盘前预处理完成：${probe.selected?.label || "无策略"} / ${probe.live?.actionText || "观望"}。`, true);
}

async function runRealtimeMonitorCycle(source = "timer") {
  if (realtimeMonitorRunning) return;
  realtimeMonitorRunning = true;
  try {
    const session = cfdSessionState();
    if (!session.open) {
      addFeedback(`实时盯盘暂停高频检查：${session.reason}。下一轮低频检查。`);
      return;
    }
    await checkLiveReferenceOutcomes().catch((error) => addFeedback(`实时追踪检查失败：${error.message || error}`, true));
    await checkNewEntrySignal().catch((error) => addFeedback(`实时入场检查失败：${error.message || error}`, true));
    if (session.beforeClose) await runPreClosePreparation(session).catch((error) => addFeedback(`关盘前预处理失败：${error.message || error}`, true));
    if (source === "manual") addFeedback("实时盯盘首轮检查完成。PC端保持页面打开即可持续监控。", true);
  } finally {
    realtimeMonitorRunning = false;
  }
}

function scheduleRealtimeMonitor() {
  if (realtimeTimerId) window.clearTimeout(realtimeTimerId);
  const session = cfdSessionState();
  const delay = adaptiveDelayMs(session);
  realtimeTimerId = window.setTimeout(async () => {
    if (localStorage.getItem(LIVE_MONITOR_KEY) === "on") await runRealtimeMonitorCycle().catch(() => {});
    scheduleRealtimeMonitor();
  }, delay);
  if (localStorage.getItem(LIVE_MONITOR_KEY) === "on") {
    const ratio = Math.round(usageRatio() * 100);
    addFeedback(`自适应调度：下一轮 ${adaptiveDelayText(delay)} 后。额度 ${ratio}% / ${session.reason}。`);
  }
}

function buildLiveEventMessage(record, eventType, price, time, reason = "") {
  const title = eventType === "win" ? "AI实盘参考：止盈触发" : eventType === "loss" ? "AI实盘参考：止损触发" : "AI实盘参考：策略变动/提前出场";
  const side = record.action === "long" ? "做多" : "做空";
  return [
    title,
    `品种：${record.label}`,
    `方向：${side} / 周期：${record.interval}`,
    `参考入场：${fmtLive(record.entry)}`,
    `止损：${fmtLive(record.stop)}`,
    `止盈：${fmtLive(record.target)}`,
    `OCO：止损 ${fmtLive(record.stop)} + 止盈 ${fmtLive(record.target)}`,
    `当前/触发价：${fmtLive(price)} / 时间：${time || "-"}`,
    `策略等级：${record.grade || "B"} / 历史正确率：${Math.round((record.winRate || 0) * 100)}%`,
    reason ? `原因：${reason}` : "",
    "注意：这是实盘参考事件。真实仓位请以外貨EX CFD实际成交价和已设置OCO为准。"
  ].filter(Boolean).join("\n");
}

function earlyExitSignal(record, candles) {
  if (!record.strategy || candles.length < 80) return null;
  const latest = candles[candles.length - 1];
  const regime = typeof marketRegime === "function" ? marketRegime(candles) : "unknown";
  const expected = record.regime || "unknown";
  if (expected !== "unknown" && regime !== "unknown" && expected !== regime) {
    return { price: latest.close, time: latest.time, reason: `行情状态从 ${expected} 变为 ${regime}，策略环境不匹配。` };
  }
  if (typeof indicators !== "function" || typeof signalAt !== "function") return null;
  const ind = indicators(candles, record.strategy);
  const side = signalAt(candles.length - 1, candles, ind, record.strategy);
  if ((record.action === "long" && side === "short") || (record.action === "short" && side === "long")) {
    return { price: latest.close, time: latest.time, reason: "出现反向策略信号，建议确认是否提前出场。" };
  }
  return null;
}

async function checkLiveReferenceOutcomes() {
  const records = liveRefs();
  const pending = records.filter((record) => record.status === "pending").slice(-20);
  if (!pending.length) return;
  let changed = 0;
  for (const record of pending) {
    const candles = await fetch(`/api/history?symbol=${encodeURIComponent(record.symbol)}&interval=${encodeURIComponent(record.interval)}&range=60d`).then((res) => {
      addFunctionRequestUsage("history");
      return res.json();
    }).then((data) => data.candles || []).catch(() => []);
    const later = candles.filter((candle) => new Date(candle.time).getTime() > new Date(record.createdAt).getTime());
    for (const candle of later) {
      if (record.action === "long") {
        if (candle.low <= record.stop) {
          record.status = "loss"; record.closedAt = candle.time; record.exitPrice = record.stop; record.exitReason = "价格触发止损。"; changed++;
          await sendLineEvent(buildLiveEventMessage(record, "loss", record.stop, candle.time, record.exitReason)).catch((error) => addFeedback(`LINE止损通知失败：${error.message || error}`, true));
          break;
        }
        if (candle.high >= record.target) {
          record.status = "win"; record.closedAt = candle.time; record.exitPrice = record.target; record.exitReason = "价格触发止盈。"; changed++;
          await sendLineEvent(buildLiveEventMessage(record, "win", record.target, candle.time, record.exitReason)).catch((error) => addFeedback(`LINE止盈通知失败：${error.message || error}`, true));
          break;
        }
      } else {
        if (candle.high >= record.stop) {
          record.status = "loss"; record.closedAt = candle.time; record.exitPrice = record.stop; record.exitReason = "价格触发止损。"; changed++;
          await sendLineEvent(buildLiveEventMessage(record, "loss", record.stop, candle.time, record.exitReason)).catch((error) => addFeedback(`LINE止损通知失败：${error.message || error}`, true));
          break;
        }
        if (candle.low <= record.target) {
          record.status = "win"; record.closedAt = candle.time; record.exitPrice = record.target; record.exitReason = "价格触发止盈。"; changed++;
          await sendLineEvent(buildLiveEventMessage(record, "win", record.target, candle.time, record.exitReason)).catch((error) => addFeedback(`LINE止盈通知失败：${error.message || error}`, true));
          break;
        }
      }
    }
    if (record.status === "pending") {
      const exit = earlyExitSignal(record, candles);
      if (exit) {
        record.status = "exit";
        record.closedAt = exit.time;
        record.exitPrice = exit.price;
        record.exitReason = exit.reason;
        changed++;
        await sendLineEvent(buildLiveEventMessage(record, "exit", exit.price, exit.time, exit.reason)).catch((error) => addFeedback(`LINE提前出场通知失败：${error.message || error}`, true));
      }
    }
  }
  if (changed) {
    saveLiveRefs(records);
    const closed = records.filter((record) => ["win", "loss", "exit"].includes(record.status));
    const wins = closed.filter((record) => record.status === "win").length;
    const rate = closed.length ? Math.round(wins / closed.length * 100) : 0;
    addFeedback(`实盘LINE追踪已更新：已完成 ${closed.length} 条，止盈率 ${rate}%（止盈 ${wins} / 其他 ${closed.length - wins}）。`, true);
  }
}

function bindCloudButtons() {
  const training = document.getElementById("trainingModeButton");
  const follow = document.getElementById("followModeButton");
  const btcLine = document.getElementById("btcLineButton");
  const sync = document.getElementById("syncCloudButton");
  const restore = document.getElementById("restoreCloudButton");
  const cloudStatus = document.getElementById("cloudStatus");
  if (cloudStatus) cloudStatus.textContent = "免费保护模式";
  if (training) training.addEventListener("click", () => trainingMode().catch((error) => { showError(error); addFeedback(`训练模式失败：${error.message || error}`, true); }));
  if (follow) follow.addEventListener("click", () => lineFollowRecommendation().catch((error) => { showError(error); addFeedback(`实盘LINE失败：${error.message || error}`, true); }));
  if (btcLine) btcLine.addEventListener("click", () => btcLineRecommendation().catch((error) => { showError(error); addFeedback(`BTC实时LINE失败：${error.message || error}`, true); }));
  if (sync) sync.addEventListener("click", () => { if (!confirmCloudAction("sync")) { addFeedback("已取消云端同步。", true); return; } syncCloudLearning().catch((error) => { showError(error); addFeedback(`云端同步失败：${error.message || error}`, true); }); });
  if (restore) restore.addEventListener("click", () => { if (!confirmCloudAction("restore")) { addFeedback("已取消云端恢复。", true); return; } restoreCloudLearning().catch((error) => { showError(error); addFeedback(`云端恢复失败：${error.message || error}`, true); }); });
}

bindCloudButtons();
checkLiveReferenceOutcomes().catch(() => {});
renderLiveReferenceLog();
updateUnsyncedStatus();
checkMissedAutoSync();
scheduleMidnightAutoSync();
if (localStorage.getItem(LIVE_MONITOR_KEY) === "on") scheduleRealtimeMonitor();
addFeedback("免费保护模式已启用：点击“开启实时LINE”后，按行情活跃度和Cloudflare额度自适应调度。", true);
