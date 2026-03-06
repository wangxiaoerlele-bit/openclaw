# 爬梯虫 bot 配置

更新时间：2026-03-05
执行人：自动化代理（本机 Chrome + 本机 OpenClaw）

## 任务目标

完成「爬梯虫」飞书 bot 的后台配置，并使用已登录飞书账号完成端到端闭环测试（发送消息 -> 机器人回复）。

## 执行环境

- 项目目录：`/Users/lxg/ProjectsBackup/openclaw-custom`
- OpenClaw 配置：`/Users/lxg/.openclaw/openclaw.json`
- 网关日志：`/Users/lxg/.openclaw/logs/gateway.log`
- 浏览器：macOS 本机 Google Chrome（远程调试 CDP）
- 飞书应用：`爬梯虫`、`五年`
- 飞书应用 ID：
  - `爬梯虫`：`cli_a9224d8d0d78dcd1`
  - `五年`：`cli_a914227f74389bd8`
- 飞书应用 Secret：已在执行时读取并写入本机配置（文档中不明文落盘）

## 完整操作日志（逐步记录）

1. [19:56] 打开飞书「事件与回调」页面并做首轮状态探测。页面显示 `订阅方式=未配置`，`已添加事件=暂无数据`。
   证据：`/images/feishu_event_page_probe.png`、`/images/feishu_event_scroll_0.png`、`/images/feishu_event_scroll_500.png`、`/images/feishu_event_scroll_900.png`、`/images/feishu_event_scroll_1300.png`、`/images/feishu_event_scroll_1700.png`、`/images/feishu_event_scroll_2200.png`

2. [19:57-19:58] 点击“订阅方式”编辑按钮，打开订阅方式弹窗，看到可选项“使用长连接接收事件 / 发送至开发者服务器”。
   证据：`/images/feishu_event_mode_edit_open.png`、`/images/feishu_event_subscribe_mode_modal.png`

3. [19:58] 选择“长连接接收事件”后尝试保存，提示：`未检测到应用连接信息，请确保长连接建立成功后再保存配置`。判断为网关侧尚未建立对应 Feishu WS 连接。
   证据：`/images/feishu_event_mode_saved.png`

4. [19:58] 跳转“凭证与基础信息”页面读取应用凭证，确认 `App ID=cli_a9224d8d0d78dcd1`，并展开 Secret（用于本机配置）。
   证据：`/images/feishu_base_info.png`、`/images/feishu_secret_visible_attempt.png`

5. [19:59] 修改本机 OpenClaw 配置 `~/.openclaw/openclaw.json`，将 `channels.feishu.accounts.main` 切换到“爬梯虫”应用（`appId/appSecret/botName`）。
   说明：该动作只改本机配置，不改仓库代码。

6. [20:00] 重启网关使新配置生效：

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
```

日志确认 Feishu 长连接启动并 ready，关键日志包含：`starting feishu[main] (mode: websocket)`、`bot open_id resolved`、`WebSocket client started`。

7. [20:00] 排查浏览器自动化连接异常：原先可控 CDP 端口短暂失联（`connect ECONNREFUSED 127.0.0.1:18800`）。

8. [20:01] 重新拉起可控 Chrome CDP 实例并复连：

```bash
open -na 'Google Chrome' --args --remote-debugging-port=18800 --user-data-dir='/Users/lxg/.openclaw/browser/openclaw/user-data' --no-first-run --no-default-browser-check about:blank
```

确认监听：`127.0.0.1:18800 (LISTEN)`。

9. [20:02] 使用恢复后的 CDP 会话重新打开事件页：`https://open.feishu.cn/app/cli_a9224d8d0d78dcd1/event`。页面可正常访问。
   证据：`/images/feishu_event_check_after_cdp_restart.png`

10. [20:03] 再次执行“订阅方式=长连接接收事件”并保存。这次不再出现“未检测到应用连接信息”错误。
    证据：`/images/feishu_event_after_subscribe_save.png`

11. [20:04] 点击“添加事件”，打开事件选择弹窗。
    证据：`/images/feishu_event_add_dialog.png`

12. [20:04] 在“消息与群组”分类中定位并选中 `im.message.receive_v1`（接收消息），确认添加。
    证据：`/images/feishu_event_add_dialog_message_group.png`、`/images/feishu_event_after_add_im_message_receive.png`

13. [20:04] 打开飞书消息页验证登录状态：`https://www.feishu.cn/messages/`，确认已登录。
    证据：`/images/feishu_messages_home_check.png`、`/images/feishu_messages_frame_probe.png`

14. [20:05-20:09] 多轮搜索与会话定位：
    先通过搜索“爬梯虫”定位结果，再切“应用”标签进入“爬梯虫 机器人”私聊窗口。
    证据：`/images/feishu_messages_search_pati_chong.png`、`/images/feishu_search_candidates_bot.png`、`/images/feishu_search_probe_current.png`、`/images/feishu_search_tab_app.png`、`/images/feishu_after_enter_from_app_tab.png`、`/images/feishu_messages_after_enter_chat_keyboard.png`

15. [20:10] 首轮消息测试发送：`闭环测试 12600720，请只回复：闭环成功-12600720`。
    当时脚本以“页面包含目标文本”做判据，误把自己发送文本当作“已回复”。
    证据：`/images/feishu_bot_test_sent.png`、`/images/feishu_bot_test_reply_check.png`、`/images/feishu_bot_token_messages_probe.png`

16. [20:11] 第二轮严格测试改为“`message-self` 以外消息数增量”判据。发送：`闭环二次测试2682863，请回复“已收到2682863”`，结果 3 分钟无机器人回复（`other=0`）。
    证据：`/images/feishu_bot_test2_sent.png`、`/images/feishu_bot_test2_reply_check.png`

17. [20:15] 回查事件页，发现 `im.message.receive_v1` 行仍提示：`请开通以下任一权限`。定位为权限未开通导致不回包。
    证据：`/images/feishu_event_permission_after_confirm.png`

18. [20:16] 跳转权限管理页面：`https://open.feishu.cn/app/cli_a9224d8d0d78dcd1/auth`，点击“开通权限”。
    证据：`/images/feishu_permission_page.png`、`/images/feishu_permission_open_dialog.png`

19. [20:16-20:17] 在开通权限弹窗搜索并开通：`读取用户发给机器人的单聊消息`，确认开通。
    证据：`/images/feishu_permission_after_open.png`

20. [20:17] 返回事件页复核：`请开通以下任一权限` 提示消失；保留 `长连接接收事件` + `im.message.receive_v1`。
    证据：`/images/feishu_event_after_permission_opened.png`

21. [20:18] 发现一次测试脚本因右侧会话未激活导致编辑框不可见，先点击左侧“爬梯虫 机器人”会话卡片恢复输入框。
    证据：`/images/feishu_messenger_current_state.png`、`/images/feishu_after_click_bot_row.png`

22. [20:19] 第三轮测试发送：`闭环终测3148154，请回复ACK3148154`。机器人有回包，但内容为：
    `OpenClaw: access not configured ... Pairing code: FP35BMLM ... openclaw pairing approve feishu FP35BMLM`。
    说明：事件链路已通，但发送者需要 pairing 授权。
    证据：`/images/feishu_bot_final_sent2.png`、`/images/feishu_bot_final_reply2.png`

23. [20:20] 在本机执行 pairing 授权命令：

```bash
pnpm openclaw pairing approve feishu FP35BMLM
```

关键结果：`Approved feishu sender ou_83d04e3b9ad1424ba0d381b4fbfff107.`

24. [20:20] 最终验收测试发送：`最终验收203334：请回复“配置闭环成功203334”`。

25. [20:20] 机器人实际回复：`配置闭环成功203334`。
    判定通过：`beforeOther=1 -> finalOther=2`，新增了 1 条非 self 机器人消息。
    证据：`/images/feishu_bot_acceptance_sent.png`、`/images/feishu_bot_acceptance_reply.png`

26. [20:21] 运行健康探针复核：

```bash
pnpm openclaw channels status --probe
```

关键结果：`Feishu main: enabled, configured, running, works`。

27. [20:32] 用户反馈“给五年发消息没回复”，进入二次排障。
    先看运行态和配置，确认网关在线，但当时 `channels.feishu.accounts` 仅有 `main=爬梯虫`，未并行接入 `五年`。

28. [20:33] 在飞书后台复核应用归属，确认 `cli_a914227f74389bd8` 对应应用标题为“凭证与基础信息 - 五年 - 开发者后台”。

29. [20:34] 将 `五年` 账号并行加入本机 Feishu 账户配置（保留 `main=爬梯虫` 不变）：

```bash
jq '.channels.feishu.accounts.wunian = {"appId":"cli_a914227f74389bd8","appSecret":"***","botName":"五年","streaming":false,"renderMode":"raw"}' /Users/lxg/.openclaw/openclaw.json > /tmp/openclaw.json.new && mv /tmp/openclaw.json.new /Users/lxg/.openclaw/openclaw.json
```

30. [20:34] 发现配置热重载被关闭（`gateway.reload.mode=off`），触发手动重启：

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
```

31. [20:34] 重启后日志确认双账号同时启动：

- `starting feishu[main] (mode: websocket)`
- `starting feishu[wunian] (mode: websocket)`
- 两路均出现 `ws client ready`

32. [20:35] 对 `五年` 会话做连通验证，发送测试消息并收到回包（会话列表可见最新回复）。
    证据：`/images/feishu_wunian_after_fix_test.png`

33. [20:39-20:41] 进一步以网关日志验证 `wunian` 通道稳定收发：

- `feishu[wunian]: received message ...`
- `feishu[wunian]: dispatch complete (queuedFinal=true, replies=1)`
- `feishu[wunian]: dispatch complete (queuedFinal=true, replies=2)`

## 关键命令清单（原样记录）

```bash
# 重启网关
launchctl kickstart -k gui/$UID/ai.openclaw.gateway

# 并行追加五年账号（示意，secret 已脱敏）
jq '.channels.feishu.accounts.wunian = {"appId":"cli_a914227f74389bd8","appSecret":"***","botName":"五年","streaming":false,"renderMode":"raw"}' /Users/lxg/.openclaw/openclaw.json > /tmp/openclaw.json.new && mv /tmp/openclaw.json.new /Users/lxg/.openclaw/openclaw.json

# 拉起可控 Chrome CDP
open -na 'Google Chrome' --args --remote-debugging-port=18800 --user-data-dir='/Users/lxg/.openclaw/browser/openclaw/user-data' --no-first-run --no-default-browser-check about:blank

# 状态探针
pnpm openclaw channels status --probe

# pairing 授权
pnpm openclaw pairing approve feishu FP35BMLM
```

## 问题与修复对照

1. 问题：订阅方式保存失败，提示未检测到连接。
   修复：切换本机 Feishu appId/appSecret 并重启网关，确认 WS ready 后重试保存。

2. 问题：事件已添加但机器人不回消息。
   修复：补开权限 `读取用户发给机器人的单聊消息`。

3. 问题：机器人回 `access not configured`。
   修复：执行 pairing approve，授权当前飞书发送者。

4. 问题：测试脚本误判回复。
   修复：将判据改为“非 self 消息计数增长”，避免把自己发送文本当回复。

5. 问题：测试时输入框偶发不可见。
   修复：先显式点击左侧“爬梯虫 机器人”会话卡片，再进行发送。

6. 问题：用户给“五年”发消息无回复。
   修复：将 `五年` app（`cli_a914227f74389bd8`）并行加入 `channels.feishu.accounts.wunian`，重启网关后恢复。

## 最终验收结论

- 订阅方式：已为长连接。
- 事件：`im.message.receive_v1` 已添加。
- 权限：事件所需权限已开通。
- pairing：已授权当前发送者。
- 闭环：真实账号发送测试消息，机器人返回预期内容，链路通过。
- “五年”恢复：`feishu[wunian]` 通道已接入并验证可回复。

## 截图索引（按生成时间）

1. `/images/feishu_event_page_probe.png`
2. `/images/feishu_event_scroll_0.png`
3. `/images/feishu_event_scroll_500.png`
4. `/images/feishu_event_scroll_900.png`
5. `/images/feishu_event_scroll_1300.png`
6. `/images/feishu_event_scroll_1700.png`
7. `/images/feishu_event_scroll_2200.png`
8. `/images/feishu_event_subscribe_mode_modal.png`
9. `/images/feishu_event_mode_edit_open.png`
10. `/images/feishu_event_mode_saved.png`
11. `/images/feishu_base_info.png`
12. `/images/feishu_secret_visible_attempt.png`
13. `/images/feishu_event_check_after_cdp_restart.png`
14. `/images/feishu_event_after_subscribe_save.png`
15. `/images/feishu_event_add_dialog.png`
16. `/images/feishu_event_add_dialog_message_group.png`
17. `/images/feishu_event_after_add_im_message_receive.png`
18. `/images/feishu_messages_home_check.png`
19. `/images/feishu_messages_frame_probe.png`
20. `/images/feishu_messages_search_pati_chong.png`
21. `/images/feishu_search_candidates_bot.png`
22. `/images/feishu_search_probe_current.png`
23. `/images/feishu_search_tab_app.png`
24. `/images/feishu_after_enter_from_app_tab.png`
25. `/images/feishu_messages_after_enter_chat_keyboard.png`
26. `/images/feishu_bot_test_sent.png`
27. `/images/feishu_bot_test_reply_check.png`
28. `/images/feishu_bot_token_messages_probe.png`
29. `/images/feishu_bot_test2_sent.png`
30. `/images/feishu_bot_test2_reply_check.png`
31. `/images/feishu_event_permission_after_confirm.png`
32. `/images/feishu_permission_page.png`
33. `/images/feishu_permission_open_dialog.png`
34. `/images/feishu_permission_after_open.png`
35. `/images/feishu_event_after_permission_opened.png`
36. `/images/feishu_messenger_current_state.png`
37. `/images/feishu_after_click_bot_row.png`
38. `/images/feishu_bot_final_sent2.png`
39. `/images/feishu_bot_final_reply2.png`
40. `/images/feishu_bot_acceptance_sent.png`
41. `/images/feishu_bot_acceptance_reply.png`
42. `/images/feishu_wunian_after_fix_test.png`
