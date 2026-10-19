# Character-first 管理台 · 初期接线

来源：用户提供的独立 aika-character-ui 原型。旧工作树保持只读；这里是 Next Windows 的正式前端源码，保留角色优先导航、插画和柔紫视觉。没有 Mock 数据/Provider 成功回执。

## 构建和正式打开

在 Next 的 `windows/code/desktop-pet` 目录执行：

```powershell
npm --prefix management/character-ui ci --no-audit --no-fund
npm run build
npm run build:character-ui
# 后续 npm run build:desktop 也会构建本前端
```

输出位于 `management/character-app`（LUI-07 起不再放在已退役的 `management/ui/` 内），由管理 HTTP server 同源提供，**不要把 Vite 的 5217 预览当成正式运行实例**。正式打开仍使用桌宠自身的管理入口；会话 token 从 fragment 写入 sessionStorage 后移出地址。独立 Vite 未配正式 API，会明确显示未鉴权，不模拟成功。

已有生产进程需要按原 runtime pin/refresh 启动流程更新后端；不要编辑 activation/pin 或绕过存活锁。此次没有自动停止/重启用户进程，也没有执行真实模型/语音/采集。

## 现有接线

- 注册角色列表/基础创建、Prompt 与作者资料读写，浏览不切换运行角色。
- 显式选择下次运行角色，selection 和模型绑定标明重启后生效。
- 角色 v2 来源绑定读写：dialogue/asr/tts；保留原 ProviderSelection 高级参数，使用凭据引用，未新增密钥输入。模型发现调用服务器真实 discovery，列表结果不等于模型推理通过。
- 已登记形象资源选择/应用；资源导入与实际 Live2D / Sprite 预览在新 UI 弹窗内完成，使用正式系统选择器与资源票据。导入不自动应用；关闭弹窗后显式应用。凭据高级管理暂留兼容工具页。
- 长期记忆/角色设定/陪伴 Wiki 分离、角色配对隔离、近期 Timeline 与 Trace 分离。
- 正式文字 Playground 提交、状态读取、已知 running turn 的取消；无假回复。当前服务通常待轮次结束才返回编号，编号未知阶段不显示假取消成功。
- 概览真实状态及已有统计；陪伴天数/日产生记忆/感知统计未知时标为“未提供”。记录轮次采用持久化 Trace 条数，不是聊天消息总数。
- 管理快照的 Windows 凭据权限检查异步批量执行，每次仍实时校验；角色信息与静态图片不再被同步 PowerShell 子进程阻塞。加载回归证据见 [2026-10-08 修复报告](../../../../../docs/next/ui-rework/reports/CFW-LOADING-20261008.md)。
- 正式插件列表与停用；全局设置保留已有诊断、宿主、隐私和导入工具入口。

## 旧 UI 退役状态（LUI-07）

**旧 `management/ui/` 控制台已完整退役**：旧壳、全部 `*-view.mjs`、`roles-session.mjs`、`routes.mjs`、`api.mjs`、`dom.mjs`、`envelope.mjs`、`icons.mjs`、`views.mjs`、`style.css` 与 `aika.html` 均已删除，服务端也不再提供 `/legacy.html` 或旧脚本（未知静态路径一律 404）。`legacyUrl()` 与 `Advanced` 组件已移除，旧 `page`/`section` 深链按 `LUI_CONTRACTS §2.3` 映射进本 SPA，无法归属的目标回落到 `/characters`。

原本"暂未移植"的能力已全部迁入本前端：记忆纠正/遗忘、故事书编辑、来源详情、高级计费/密钥编辑、语音工具、感知与主动陪伴策略、插件生命周期、宿主设置、采集与留存、诊断、工作协议与集成。**不再存在任何跳回旧管理页的入口。**

仍未实现（保持明确未实现，不编造）：网络 Wiki 向导、3D 形象、无约束的任意图片上传、主题/语言/自动更新检查、备份/恢复。形象导入支持正式选择器的 Live2D 模型包及 PNG / WebP Sprite。原型插画仅装饰，角色头像使用中性占位，不冒充已注册运行资产。

2026-10-08 形象入口修复与真实实例只读验收见 [报告](../../../../../docs/next/ui-rework/reports/CFW-APPEARANCE-20261008.md)。完整退役过程、删除清单与逐 AC 证据见 [交接执行计划](../../../../../docs/next/ui-rework/LEGACY_UI_RETIREMENT_PLAN_20261008.md) 与 `docs/next/ui-rework/reports/LUI-0*.md`；共享预览产物已迁到 `management/preview-runtime/`（LUI-05）。

## 定向验证

```powershell
node --test tests/ui-rework/character-first-wiring.test.mjs dist/tests/ui-rework/playground-routes.test.js
node --test tests/ui-rework/character-first.browser.test.mjs
node --test tests/ui-rework/appearance-resources.browser.test.mjs
```

这些测试调用生产管理 server/Adapter/真实临时 SQLite，模型或宿主边界隔离；不证明真实 LLM/TTS 效果，不接触用户数据库。

## 资产说明

界面 PNG 从用户交付的原型按原样复制；未重新生成或从第三方下载。应用插画与运行 skin 登记分开；分发前沿用项目资产授权审查规则。中性头像是本轮新增本地 SVG。
