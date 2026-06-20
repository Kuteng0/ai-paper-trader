const KEY = "learning:default";

export async function onRequestPost({ env }) {
  if (!env.LEARNING_KV) return json({ error: "Cloudflare KV 尚未配置。请绑定 LEARNING_KV。" }, 500);
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !env.LINE_TO) {
    return json({ error: "LINE 尚未配置。请设置 LINE_CHANNEL_ACCESS_TOKEN 和 LINE_TO。" }, 500);
  }

  const records = await env.LEARNING_KV.get(KEY, "json") || [];
  const top10 = records
    .filter((r) => r && r.trades >= 3 && Number.isFinite(r.winRate))
    .sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades) || (b.profitFactor - a.profitFactor) || (b.netProfit - a.netProfit))
    .slice(0, 10);

  if (!top10.length) return json({ error: "排行榜还没有可用策略。请先运行训练模式。" }, 400);

  const best = top10[0];
  const text = buildMessage(best, top10.length);
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      to: env.LINE_TO,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return json({ error: `LINE推送失败：${response.status} ${detail}` }, 502);
  }

  return json({ message: `LINE已发送：${best.label}，胜率 ${pct(best.winRate)}。`, selected: best });
}

function buildMessage(best, count) {
  return [
    "AI模拟交易提醒",
    `从胜率前${count}策略中选择：${best.label}`,
    `周期：${best.interval}`,
    `胜率：${pct(best.winRate)} / 交易：${best.trades}笔`,
    `净利润：${yen(best.netProfit)} / 最大回撤：${(best.maxDrawdown * 100).toFixed(1)}%`,
    `盈亏比：${Number(best.profitFactor || 0).toFixed(2)} / 平均R：${Number(best.avgR || 0).toFixed(2)}`,
    `参数：EMA ${best.strategy.fast}/${best.strategy.slow}, 止损 ${best.strategy.stopAtr}ATR, 止盈 ${best.strategy.takeProfitR}R`,
    "注意：这是模拟策略提醒，不是实盘下单指令。实盘必须自行确认并设置止损/OCO。"
  ].join("\n");
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function yen(value) {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value || 0);
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}
