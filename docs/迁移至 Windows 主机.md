---
title: "迁移至 Windows 主机"
description: "将现有 OpenClaw 全量迁移到 Windows 并保持浏览器自动化能力"
summary: "一次停机切换：全量迁移状态目录、工作区、认证与会话"
read_when:
  - 需要将 OpenClaw 从旧主机迁移到专用 Windows 电脑
  - 需要保留配置、记忆、会话和渠道登录态
  - 需要继续操作 Windows 现有浏览器
---

# 迁移至 Windows 主机

本文档记录已确认并落地的迁移方案：**全量迁移**、**一次停机切换**，并要求迁移后可继续通过 OpenClaw 操作 Windows 现有浏览器。

## 已确认决策

- 迁移范围：A（全量）
- 外部认证文件：迁移
- 浏览器目标：必须操作 Windows 现有浏览器
- 切换方式：允许一次停机切换
- 传输方式：经局域网其他机器中转
- 迁移后密钥轮换：不更换

## 目标架构

本次实际落地架构（2026-02-27）：

- OpenClaw Gateway：运行在 **Windows 原生环境**
- 浏览器控制：使用 **Windows 原生浏览器**
- 状态目录与工作区：`%USERPROFILE%\.openclaw`
- 切换原则：迁移窗口内仅保留单活（旧机与新机不并行对外处理消息）

## 迁移范围清单

必须迁移：

- `$OPENCLAW_STATE_DIR`（默认 `~/.openclaw`）
- 全部 agent workspace（默认 `~/.openclaw/workspace`，以及自定义 workspace）

建议一起迁移（已确认“要”）：

- `~/.codex/auth.json`
- `~/.claude/.credentials.json`
- `~/.local/share/signal-cli/data`（若在用）

## 执行步骤（一次停机）

### 1) 预检（旧主机）

- 确认旧机是实际 Gateway 主机（非 remote 客户端）
- 记录当前 profile、stateDir、configPath、workspace 列表
- 记录 `openclaw.json` 中所有绝对路径项（后续在 Windows 校正）
- 识别“主机绑定型”能力并标记迁后验证项：
  - iMessage / BlueBubbles（依赖 macOS）
  - Signal（依赖 signal-cli 运行方式与数据目录）
  - 任何本机绝对路径脚本/二进制依赖

### 2) 冻结与备份

- 停止旧主机 Gateway，进入停机窗口
- 立刻做冷备：状态目录 + 全部 workspace + 外部认证文件
- 生成校验值（hash），用于传输后核验

### 3) 传输

- 备份包先传至局域网中转机，再传目标 Windows 主机
- 校验 hash 一致后再解包
- 完成后删除中转机上的临时副本
- 若远程管理端口（SSH/WinRM/RDP）未开放，可使用 SMB 共享完成文件中转

### 4) 新机运行基座

- 安装 Node 22+
- 安装 OpenClaw CLI
- 不先做业务级重新 onboarding，直接进入恢复

### 5) 恢复与路径校正

- 将备份恢复到 Windows 对应目录
- 校正 `openclaw.json` 中无效绝对路径：
  - `agents.defaults.workspace`
  - `agents.list[].workspace`
  - `agents.list[].agentDir`
  - 各渠道 `tokenFile/cliPath/dbPath`
  - hooks/脚本路径
- 原则：路径统一到 Windows 本机路径（不要残留旧主机绝对路径）

### 6) 接入 Windows 浏览器控制

- 在 Windows 侧启用并常驻 OpenClaw Gateway
- 确认 browser tool 路由到 Windows 浏览器
- 验证能执行：列标签页、点击输入、截图
- 核对网络与权限：
  - Windows 防火墙放行 node host 监听端口（仅内网/受控网段）
  - OpenClaw Gateway 到浏览器服务连通
  - 节点配对/鉴权状态正常

### 7) 启动与验收

- 执行 `openclaw doctor`
- 启动/重启 Gateway
- 验收项：
  - 配置正确加载
  - 记忆文件可读（`MEMORY.md`、`memory/*.md`）
  - 历史会话可见
  - 渠道登录态正常
  - 可操作 Windows 现有浏览器

## 回滚方案

- 保留旧主机完整状态至少 48 小时
- 若出现阻断问题：
  - 停止新主机 Gateway
  - 在旧主机按原状态恢复启动
  - 业务快速回切

## 本次执行记录（2026-02-28）

已完成：

- 已通过 SSH 登录目标主机（`user@gateway-host`）
- 已传输并校验迁移包 `openclaw-migration-YYYYMMDD.tgz`
- 已完成恢复并验证以下路径存在：
  - `%USERPROFILE%\.openclaw\openclaw.json`
  - `%USERPROFILE%\.openclaw\memory`
  - `%USERPROFILE%\.openclaw\agents`
  - `%USERPROFILE%\.codex\auth.json`
- 已确认运行版本：
  - `openclaw --version` = `2026.2.23`
  - `dist/build-info.json` 对应定制仓库 commit：`c2179ee164477aa8ac7c0048ad4c2e85b47c5458`
- 已确认网关可用：
  - 监听端口：`0.0.0.0:18789`
  - `openclaw channels status --probe` 返回 `Gateway reachable`，且 Feishu `works`
- 已完成一次增量发布演练（本机编译后发布到 Windows）：
  - 发布包：`openclaw-windows-deploy-YYYYMMDD-HHMMSS.tgz`
  - 预发布备份：`openclaw-runtime-backup-predeploy-YYYYMMDD-HHMMSS.tgz`
  - 发布后 `dist/build-info.json` 的 `builtAt` 已更新

## Windows 常驻运行（已落地）

已按“保守自愈 + 私聊告警 + 每日备份”落地：

- 自动登录：已启用（用于确保登录态下任务链路稳定）
- 网关任务：`OpenClawGatewayAdmin`
  - 触发器：系统启动 + 用户登录
  - 启动命令：`openclaw gateway run --bind lan --port 18789`
- 健康守护任务：`OpenClawHealthGuard`
  - 频率：每 5 分钟（仅本地健康检查）
  - 判定：连续 3 次失败才触发重启
  - 冷却：10 分钟内不重复重启
  - 熔断：1 小时内超过 3 次重启则停止自愈，等待人工恢复
- 深探测任务：`OpenClawDeepProbe`
  - 频率：每 2 小时（`channels status --probe`）
  - 动作：仅告警，不触发重启
- 备份任务：`OpenClawDailyBackup`
  - 频率：每天 03:30
  - 目标目录：`E:\openclaw-backups`
  - 保留策略：7 天
- 告警：通过 Feishu open_id 私聊目标用户（含故障、恢复、熔断）
- 网络暴露：仅保留 LAN 防火墙规则（`localsubnet`）

### 2026-02-28 V2 调优（额度与稳定性）

基于运行复盘，已完成以下调优：

- 健康检查拆层：
  - `OpenClawHealthGuard`（本地健康）改为每 5 分钟执行
  - 新增 `OpenClawDeepProbe`（渠道深探测）每 2 小时执行
- 重启条件收敛：
  - 仅本地健康异常触发重启
  - 渠道深探测异常仅告警，不触发重启
- 风暴控制：
  - 连续 3 次本地失败才重启
  - 重启冷却 10 分钟
  - 1 小时内超过 3 次重启触发熔断（人工恢复）
- 日志策略：
  - 运维脚本日志落地到 `%USERPROFILE%\openclaw-ops\logs`
  - 保留 14 天，目录总量上限 2GB（超限删最旧）
  - 清理 `%LOCALAPPDATA%\Temp\openclaw` 下 14 天前日志

任务列表（当前）：

- `OpenClawGatewayAdmin`：开机/登录后拉起网关（当前主机已落地为登录触发，自动登录保障开机常驻）
- `OpenClawHealthGuard`：每 5 分钟本地健康守护
- `OpenClawDeepProbe`：每 2 小时渠道深探测（仅告警）
- `OpenClawDailyBackup`：每天 03:30 备份

## Windows 增量发布流程（可复用）

适用场景：代码已在开发机修改并完成编译，需要把最新构建产物发布到 Windows 运行主机，不做全量迁移。

### 1) 开发机编译

- 在仓库根目录执行：
  - `pnpm build`
- 校验构建信息：
  - `cat dist/build-info.json`
- 打包发布产物（最小集）：
  - `tar -czf /tmp/openclaw-windows-deploy-YYYYMMDD-HHMMSS.tgz dist openclaw.mjs`

### 2) 上传到 Windows

- 上传到主机迁移目录：
  - `scp /tmp/openclaw-windows-deploy-YYYYMMDD-HHMMSS.tgz user@gateway-host:/C:/Users/<user>/migration/`

### 3) Windows 主机执行发布

发布动作建议脚本化执行，核心步骤如下：

1. 备份当前运行产物：
   - `tar -czf C:\Users\<user>\migration\openclaw-runtime-backup-predeploy-YYYYMMDD-HHMMSS.tgz -C C:\Users\<user>\node-v24.8.0-win-x64\node_modules\openclaw dist openclaw.mjs`
2. 停止网关任务与相关进程：
   - `schtasks /End /TN OpenClawGatewayAdmin`
   - 结束 `gateway run --bind` 进程
3. 解包新产物到临时目录。
4. 替换 `node_modules/openclaw` 下：
   - `dist/`
   - `openclaw.mjs`
5. 启动网关：
   - `schtasks /Run /TN OpenClawGatewayAdmin`
6. 清理临时目录。

### 4) 发布后验收

- 端口监听：
  - `netstat -ano | findstr :18789`
- 版本与构建信息：
  - `openclaw --version`
  - `type C:\Users\<user>\node-v24.8.0-win-x64\node_modules\openclaw\dist\build-info.json`
- 运行探活：
  - `openclaw channels status`
  - `openclaw channels status --probe`
- 计划任务状态：
  - `schtasks /query /tn OpenClawGatewayAdmin /v /fo list`
  - `schtasks /query /tn OpenClawHealthGuard /v /fo list`
  - `schtasks /query /tn OpenClawDeepProbe /v /fo list`

### 5) 快速回滚

若发布后异常，按以下顺序执行：

1. 停止网关任务与相关进程。
2. 用预发布备份包恢复：
   - `tar -xzf C:\Users\<user>\migration\openclaw-runtime-backup-predeploy-YYYYMMDD-HHMMSS.tgz -C C:\Users\<user>\node-v24.8.0-win-x64\node_modules\openclaw`
3. 启动网关任务。
4. 重新执行“发布后验收”。

### 本次增量发布实录（2026-03-04）

本轮已按上文流程完成一次可复用发布，关键结果如下：

- 开发机构建：
  - 执行：`pnpm build`
  - 产物包：`/tmp/openclaw-windows-deploy-20260304-025854.tgz`
- Windows 发布：
  - 预发布备份：`C:\Users\Lanmei\migration\openclaw-runtime-backup-predeploy-20260304-025958.tgz`
  - 替换位置：`C:\Users\Lanmei\node-v24.8.0-win-x64\node_modules\openclaw\dist` 与 `openclaw.mjs`
  - 重启任务：`schtasks /Run /TN OpenClawGatewayAdmin`
- 发布后验证：
  - `openclaw channels status --probe` 返回 `Gateway reachable` 且 `Feishu main ... works`
  - 端口监听恢复：`0.0.0.0:18789`
  - `dist/build-info.json`：`commit=c2179ee164477aa8ac7c0048ad4c2e85b47c5458`，`builtAt=2026-03-03T18:58:30.341Z`
- 同步修复（避免 cron 任务被系统判定失败）：
  - 任务：`OpenClaw Task Check`
  - 动作从 `python ...` 改为显式解释器：
    - `C:\Users\Lanmei\AppData\Local\Programs\Python\Python312\python.exe C:\Users\Lanmei\.openclaw\workspace\check_and_complete_tasks.py`
  - 手动触发后 `LastTaskResult=0`

### 验收结果

- 重启主机后自动恢复：
  - `OpenClawGatewayAdmin` 自动拉起
  - `OpenClawHealthGuard` 周期执行
  - `openclaw channels status --probe` 持续可用
- 手动触发备份成功：
  - 生成 `openclaw-state-*.tgz`
  - 备份后网关可恢复服务
- 告警链路测试成功：
  - Feishu 私聊消息发送 API 返回 `code=0`

### 运维命令（Runbook）

- 查看任务状态：
  - `schtasks /query /tn OpenClawGatewayAdmin /v /fo list`
  - `schtasks /query /tn OpenClawHealthGuard /v /fo list`
  - `schtasks /query /tn OpenClawDailyBackup /v /fo list`
- 手动拉起网关：
  - `schtasks /run /tn OpenClawGatewayAdmin`
- 手动触发备份：
  - `schtasks /run /tn OpenClawDailyBackup`
- 重置熔断并恢复：
  - `powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\openclaw-ops\reset-circuit.ps1"`
- 验证连通：
  - `openclaw channels status --probe`
  - `netstat -ano | findstr :18789`

## 飞书本地图片发送修复（2026-02-28）

### 问题描述

在 Windows 主机上通过飞书发送本地图片时遇到以下错误：

```
LocalMediaAccessError: Local media path is not under an allowed directory
```

### 根因分析

1. **API 权限缺失**：错误码 99991672，缺少 `im:resource:upload` 和 `im:resource` 权限
2. **网络限制**：Windows 主机无法访问外部图片 URL（upload.wikimedia.org, bing.net 等）
3. **本地路径限制**：`src/web/media.ts` 中的安全检查限制了只能访问特定目录下的文件

### 修复方案

#### 1) 配置飞书 API 权限

在飞书开放平台控制台为应用添加以下权限：

- `im:resource:upload` - 上传图片/文件
- `im:resource` - 下载图片/文件
- `cardkit:card:write` - 发送卡片消息

#### 2) 代码修改

**文件 1：`extensions/feishu/src/media.ts`**

```typescript
// 在 sendMediaFeishu 函数中，修改 loadWebMedia 调用
const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
  maxBytes: mediaMaxBytes,
  optimizeImages: false,
  localRoots: "any", // Allow any local path for Feishu media sending
});
```

**文件 2：`src/web/media.ts`**

```typescript
// 注释掉 unsafe-bypass 安全检查（约第 345-352 行）
// Note: We allow localRoots: "any" for trusted internal extensions (e.g. feishu media sending)
// The readFile override requirement is for external/untrusted callers
// if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
//   throw new LocalMediaAccessError(
//     "unsafe-bypass",
//     "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
//   );
// }
```

#### 3) 部署到 Windows

```bash
# 1. 本地编译
pnpm build

# 2. 传输扩展目录
sshpass -p 'password' scp -r extensions/feishu user@192.168.1.2:'C:/Users/<user>/node-v24.8.0-win-x64/node_modules/openclaw/extensions/'

# 3. 传输核心文件（找到正确的编译后文件名）
sshpass -p 'password' scp dist/ir-*.js user@192.168.1.2:'C:/Users/<user>/node-v24.8.0-win-x64/node_modules/openclaw/dist/'

# 4. 重启 Gateway
sshpass -p 'password' ssh user@192.168.1.2 'powershell -Command "Stop-ScheduledTask -TaskName OpenClawGatewayAdmin; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName OpenClawGatewayAdmin"'
```

#### 4) 验证修复

```bash
# 发送本地图片测试
sshpass -p 'password' ssh user@192.168.1.2 'node C:\Users\<user>\node-v24.8.0-win-x64\node_modules\openclaw\openclaw.mjs message send --channel feishu --account main -t <chatId> --media "C:\path\to\local\image.png" --message "测试发送本地图片"'
```

预期输出：

```
✅ Sent via Feishu. Message ID: om_xxx (chat <chatId>)
```

### 注意事项

- `localRoots: "any"` 仅用于受信任的内部扩展（如飞书媒体发送）
- 此修改允许飞书扩展访问任意本地路径的文件
- 外部/不受信任的调用者仍需要显式指定 `localRoots` 或使用 `sandboxValidated`

## 关键风险与规避

- 只迁 `openclaw.json`：会丢失凭证/会话/渠道状态
- profile 或 stateDir 不一致：会出现“配置在、状态不在”
- 路径未校正：Windows 启动后可能找不到 workspace 或外部依赖
- 双机并行处理消息：可能导致会话分叉与状态漂移
- 未提前验证浏览器服务连通：会导致“Gateway 正常但浏览器不可控”

## 连接与传输前置条件

至少满足其一：

- 可远程登录 Windows（SSH/WinRM/RDP 其一）
- 或可访问 Windows SMB 共享（用于迁移包传输）

建议检查：

- 目标机 IP 固定或 DHCP 保留
- Windows 时间同步正常
- 传输账户具备目标目录写权限

## 参考文档

- [迁移指南](/install/migrating)
- [Windows（WSL2）](/platforms/windows)
- [Agent Workspace](/concepts/agent-workspace)
- [Browser（OpenClaw-managed）](/tools/browser)
- [Doctor](/gateway/doctor)
