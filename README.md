# AI 模拟交易系统

这是一个适合 iPhone Safari 使用的期货/指数模拟交易 PWA。它不会连接真实账户，不会实盘下单，只用于模拟交易、记录结果、随机学习、云端备份和LINE提醒。

## 数据保存方式

系统现在采用双保存：

- iPhone本地保存：速度快，但清除Safari数据或换手机会丢失。
- Cloudflare KV云端备份：用于恢复学习记录和排行榜。

如果 Cloudflare KV 没配置，App仍可本地使用，但云端同步、恢复和LINE推荐不可用。

## Cloudflare KV配置

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 找到 `ai-paper-trader`。
4. 进入 `Settings`。
5. 找到 `Functions` 或 `Bindings`。
6. 新增 KV namespace。
7. 变量名必须填：`LEARNING_KV`。
8. 保存后重新部署 Pages。

## LINE推送配置

需要在 LINE Developers 创建 Messaging API Channel，并取得 Channel access token。然后在 Cloudflare Pages 里设置两个环境变量：

- `LINE_CHANNEL_ACCESS_TOKEN`：LINE Messaging API 的 Channel access token。
- `LINE_TO`：你的 LINE userId 或群组/聊天室 id。

配置路径：

1. Cloudflare Dashboard。
2. Workers & Pages。
3. `ai-paper-trader`。
4. Settings。
5. Environment variables。
6. 添加上面两个变量。
7. 重新部署。

## 推荐使用流程

1. 打开 App。
2. 先点“训练模式”。
3. 系统会执行全品种随机学习，并自动同步云端。
4. 看“胜率前10排行榜”。
5. 点“AI跟单提醒”。
6. 系统会从排行榜前10里选择胜率最高策略，通过LINE发送给你。

## 按钮说明

- 训练模式：随机学习全部品种，完成后同步到Cloudflare KV。
- AI跟单提醒：从云端排行榜前10中选择胜率最高策略，发到LINE。
- 同步云端：把当前iPhone本地学习记录上传到Cloudflare KV。
- 恢复云端：从Cloudflare KV恢复学习记录到当前iPhone。
- 随机模拟并升级AI：只在当前设备训练并更新排行榜。
- 扫描推荐：对所有品种做确定性参数优化并推荐一个品种。
- 自主学习：对当前品种做参数优化。
- 运行模拟：用当前参数对当前品种模拟交易。

## 排行榜怎么看

排行榜按胜率从高到低排序，同时显示：品种、周期、交易笔数、净利润、最大回撤、盈亏比和策略参数。

胜率高不一定最好。实盘前仍要看交易笔数、最大回撤和盈亏比。交易笔数太少的高胜率不可靠。

## 支持品种

- `ES=F` 标普500期货 ES
- `NQ=F` 纳指期货 NQ
- `YM=F` 道指期货 YM
- `GC=F` 黄金期货 GC
- `CL=F` 原油期货 CL
- `NG=F` 天然气期货 NG
- `^N225` 日经225指数参考数据

## 小资金实盘前门槛

在考虑 5万日币小资金跟单前，建议至少满足：

- 连续模拟 1 个月。
- 交易笔数不少于 30 笔。
- 最大回撤低于 5%。
- 盈亏比大于 1.2。
- 不只是靠一两笔大赚撑起来。
- 真实交易必须设置止损或 OCO。

## 重要限制

- 当前行情来自 Yahoo Finance chart 数据，适合研究和模拟，不适合作为实盘下单依据。
- 系统不连接外貨EX CFD 或任何真实交易账户。
- LINE提醒不是实盘下单指令，只是模拟策略提醒。
- 回测盈利不代表未来盈利。
- 不建议使用手机自动点击方式进行实盘自动下单。
