# ALLMIND Beta 验证 RUNBOOK

本文件只包含安装、构建、测试的复跑命令与结果解释。固定用例选择见 [CASES.json](CASES.json)，历史首错与处置见 [baseline.json](baseline.json)，逐文件 SHA-256 清单见 [source-manifest.json](source-manifest.json)，当前发布准备状态见 [release-status.json](release-status.json)。

## 上一轮用户操作闭环记录（2026-10-22，beta.1）

本节是 beta.1 历史记录。当前事实入口为 `release-status.json` 的 `currentSummary`；下方带旧日期的记录保留历史含义，不能作为本轮新增测试。当前源码在独立复制目录执行两处 `npm ci`，未复制旧 node_modules、Git、登录态或用户数据，完成统一构建。具体最新结果与包清单哈希在 `currentSummary` 中逐项记录。

- 核心涵盖完整私人备份、v1/v2 恢复、270 会话、恢复中断日志、全文搜索、Unicode 历史分页、归档角色、普通资料、显式 Wiki 失败修正。
- 浏览器选择与 CI 保持一致：固定组及新增用户闭环、语音、OCR、QQ、NapCat、主动频率和分类审核组；模型／设备为受控 fixture，真实 API 验收另记。
- 真实 API 使用此前用户选择的 Minimax；失败原文与错误保留。显式修正后的四条合成材料完成审核、应用、图谱、真实召回与重启；不是任意规模质量证书。
- 真实鼠标、中文 IME、系统选择器、物理音频和全屏／锁屏／睡眠仍由用户手工验收，不用无输入组件测试替代。QQ 新接收人／群聊不在本轮授权范围内，未发送测试消息。

## beta.2 当前增量

屏幕图片增量：`book-screen.browser.test.mjs` 包括截图确认、OCR 旁路、手动发送、单轮附件与禁用能力拒绝；`character-client.test.ts` 验证 API 图片编码和失败不重发。均为合成画面／受控模型，不证明真实 VLM 识图。真实系统来源选择器仍 NOT_RUN；物理麦克风／扬声器及设备效果按用户要求 DEFERRED。

2026-10-22 可自主补测：新增 `qq-http-acceptance.test.ts`，从实际 OneBot WS 贯穿生产 HTTP 适配器，模型端为本机 fixture；核心全组 515/515。Win32 observer、通知边界和独立透明窗口桌面模式已加入 CI；没有模拟真实输入/锁屏/睡眠。Windows 中文语音及中英/空白图 OCR 的本机补测单独记录，不能据此声称 GitHub Runner 装有相同语言组件。

```powershell
node --test --test-concurrency=1 dist/tests/windows/local-book-speech.test.js dist/tests/windows/local-book-ocr.test.js dist/tests/windows/activity-atomic-replace.test.js
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File desktop/wpf/shell/tests/allmind-observer.test.ps1
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File desktop/wpf/shell/tests/allmind-notifications.test.ps1
powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File desktop/wpf/shell/tests/desktop-mode.test.ps1
```

语音用例在没有中文语音组件的电脑会明确 SKIP，不能当成已完成硬件/语言验收。实际 Chromium 无录音授权时，本机设备面板可成功读取空列表；这是权限下的可见性结果，不证明麦克风/扬声器可用。只读服务诊断成功读取已选模型列表，同样不能清除先前的推理 429。

真实 API 本轮一次提交返回 HTTP 429（服务建议等待约23小时），没有重试/切换模型；真实服务门槛 BLOCKED。当前状态见 [release-status.json](release-status.json) 的 currentSummary；以下原有日期记录保持历史含义。新增验收矩阵、升级与手工边界见 [PRODUCT-COMPLETION.md](PRODUCT-COMPLETION.md)。核心组自动收录新增 .test.ts；浏览器新增 `tests/memory-book/product-controls.browser.test.mjs`，WPF 新增 `allmind-perch.test.ps1`，CI 已接线。

发布门槛 CLI（仓库根目录）：

```powershell
node windows/code/desktop-pet/tools/release-gate.mjs snapshot --source . --output <新的源码清单.json>
node windows/code/desktop-pet/tools/release-gate.mjs verify --source . --evidence <六项证据索引.json> --package <便携目录> --output <新的门槛结果.json>
```

证据索引使用 allmind-release-evidence/v1，各门槛记录必须绑定相同 sourceHash、状态、检查数量及子证据哈希；真实服务还需 realService=true、fixture=false 与实际提交数量。源码清单以 git 的 NUL 文件清单读取，排除生成的 release-status/source-manifest 两文件，包内保存同一 sourceHash。缺少证据不会成为 PASS。签名、SmartScreen 与物理/原生验收独立记录，不因六项本地通过自动宣称公开发布就绪。过程日志和诊断记录只放独立 worker，不入包。

## 前置条件

- Windows；Node.js **>= 22.12.0**（本候选实测 v24.18.0）与 npm（实测 11.16.0）；Electron 44.4.1、Playwright 1.63.0。
- 首次依赖安装需要网络（npm registry）；构建与自动测试不联网调用模型——自动用例的模型响应均为本机 fixture（用例内本地 HTTP 服务或合成数据），不构成真实模型能力声明。
- Memory Book HTTP 聊天有 75 秒请求预算。超时返回 HTTP 503、code `timeout`，并明确提示“不会自动重试”；客户端断开是单独的 `cancelled` 结果。
- 本仓库不含私有 Live2D 模型与 Cubism SDK；默认以随包静态 ALLMIND 形象运行（详见 [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 第 2、3 节）。
- ChatGPT 网页接入属于真实服务路径；内置独立页面只需登录，不需外部 CLI。仅备选浏览器工具需要另装 `chatgpt-use` / `chrome-use`。不属于自动门槛。
- 所有命令的工作目录（cwd）均为 `windows/code/desktop-pet`（PowerShell）。

## L0 干净安装与构建

```powershell
npm.cmd ci
# 仅当你的 npm 带 allowScripts 机制且跳过了 electron postinstall 时（现象：node_modules\electron\dist\electron.exe 缺失）：
node node_modules/electron/install.js
npm.cmd --prefix management/character-ui ci
npm.cmd run check
npm.cmd run build
npm.cmd run build:desktop
npx.cmd playwright --version   # 记录版本（本基线 1.63.0）
npx.cmd playwright install chromium
```

预期：以上每条 exit code 0；产物存在：`dist/app/book-launcher.js`、`dist/app/book-backend.js`、`dist/wechat/{qr.js,voice.js,silk.wasm}`、`desktop/chatgpt-extension/page.js`、`desktop/build/renderer.js`、`management/preview-runtime/presentation-preview.js`、`management/character-app/index.html`。

说明：

- 本基线机器的 npm 11.16.0 自带 allowScripts 审批机制，`npm ci` 后 electron 二进制未落地，需按上面注释补跑官方安装脚本（exit 0）；标准 npm（含 GitHub Actions 的 setup-node）会自动执行 postinstall，无需该步骤。CI（`.github/workflows/verify.yml`）不包含该手动步骤。
- 双击 `windows/Start-Windows.cmd` 等价于：两处首次安装 → `npm run dev`（build + build:desktop + start），失败即停，日志在 `windows/code/desktop-pet/.local/start-windows-*.log`。

## L1 Book 核心（生产模块 + 合成数据）

```powershell
node --test dist/tests/memory-book/*.test.js
```

预期：exit 0。最近一次完整记录（2026-10-22 当前独立源码候选）：**489 用例全部通过**，0 failed / 0 skipped。计数随用例增删变化，最终冻结候选的复跑结果应替换本段记录；不得为凑旧数删改断言或跳过失败项。

## L2 固定浏览器组（模型为 fixture）

以 `.github/workflows/verify.yml` 的 L2 和 User operation closure 两个浏览器命令为当前选择；本轮使用 serial file execution，与 CI 一致：

```powershell
node --test --test-concurrency=1 tests/memory-book/w02-release.test.mjs tests/memory-book/character-client.browser.test.mjs tests/memory-book/w02-ui.browser.test.mjs tests/memory-book/w03-ui.browser.test.mjs tests/memory-book/zip-import.test.mjs tests/memory-book/local-pet-menu.browser.test.mjs tests/memory-book/incognito-renderer.browser.test.mjs tests/memory-book/companion-lifecycle.browser.test.mjs tests/memory-book/ux-binding.browser.test.mjs tests/memory-book/chatgpt-page-host.test.mjs tests/memory-book/connection-setup.browser.test.mjs tests/memory-book/chatgpt-model-menu.browser.test.mjs tests/memory-book/chatgpt-thinking.browser.test.mjs tests/memory-book/prompt-presets.browser.test.mjs tests/memory-book/wiki-compilation.browser.test.mjs tests/memory-book/wiki-maintenance.browser.test.mjs tests/memory-book/ui-v4-acceptance.browser.test.mjs tests/memory-book/role-onboarding.browser.test.mjs tests/memory-book/ui-v2.browser.test.mjs tests/memory-book/starter-characters.browser.test.mjs tests/memory-book/portable-preview.test.mjs tests/memory-book/chat-usability.browser.test.mjs tests/memory-book/endfield-ui.browser.test.mjs
node --test --test-concurrency=1 tests/memory-book/user-closure.browser.test.mjs tests/memory-book/reply-style-ui.browser.test.mjs tests/memory-book/synthesis-review.browser.test.mjs tests/memory-book/local-voice.browser.test.mjs tests/memory-book/book-screen.browser.test.mjs tests/memory-book/proactive-frequency.browser.test.mjs tests/memory-book/qq-channel.browser.test.mjs tests/memory-book/napcat-settings.browser.test.mjs
```

预期：exit 0。2026-10-22 的当前浏览器结果以顶部 currentSummary 为准；2026-10-19 的历史隔离复跑为 **28/28**（当时18个文件），更早冻结候选为27/27（同一轮中曾因并发 L1 与真实编纂造成 2 条超时失败，单独复跑 27/27 通过，保留该次记录）。截图/证据输出写入被忽略的 `.local/` 或仓库根 `validation/output/`（已被 .gitignore 排除，不入库）。

## L3 原生首次启动链

自动化（真实 Electron + 本机 HTTP fixture 模型）：

```powershell
node --test tests/memory-book/desktop.integration.test.mjs
```

预期：exit 0；2 用例（launcher 冒烟两轮 + 禁原生依赖解析）。

手动链（真实首启/退出/同目录重启）：

```powershell
$data = Join-Path $env:TEMP ("allmind-firstlaunch-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory $data | Out-Null
$env:AIKI_BOOK_DATA = $data
npm.cmd start        # 窗口标题应为 ALLMIND；stderr 应出现：
                     #   ALLMIND: 未配置私人默认模型，使用随包静态标志…
                     #   ALLMIND: 私人 Live2D 默认模型未安装…
                     #   Memory Book backend ready: local-file storage…
# 关闭窗口应隐藏到系统托盘，后台继续运行；双击托盘图标恢复
# 在托盘图标右键菜单选择"退出 ALLMIND"，才真正退出
# 验证：electron/node 进程全部退出；$data\writer.lock 已删除
# 同一 $data 再次 npm.cmd start（在前次完全退出后）→ 再次正常退出
```

预期：关闭窗口后进程与 `writer.lock` 保留，托盘恢复复用同一窗口；选择托盘“退出 ALLMIND”后进程排空并释放锁。两轮均能启动，数据目录生成 `book-*.json`、`management-session.json` 等。已知观察：前实例完全退出后约 1.5 秒内立即重启可能遇到瞬态页面加载失败；等待完整退出后再重启。本链 2026-10-18 有完整通过记录；**本轮不重复桌宠旅程，也不以旧原生记录宣称本轮已验证（OUT_OF_SCOPE）**。

## L4 真实服务

分层记录，不得互相替代：

- **ChatGPT 网页（限定范围 PASS）**：现有隔离实例的独立页 current 模型连接测试通过（秒级耗时、页面显示成功）；在界面读取并选择 High 后回读核实；两轮真实预设聊天均产生 SavedTurn（带 `presetId`、预设版本、documentHash）。已知缺陷：首轮出现“你我这两个真人”的错误措辞，第二轮追问后模型自行纠正，缺陷保留。
- **真实 API（DEFERRED）**：DeepSeek 最小连接测试与分批请求均返回 HTTP 403，用户已决定本轮不继续 API 排障；不得用网页或 fixture 结果替代，也不得宣称 API 路径可用。
- **Wiki 历史真实编纂（限定范围 PASS，重试后）**：189 条材料分12批，首次在第7批逐字证据校验失败且未应用；显式新任务完成36页/12关系/189覆盖，经审核、UI应用、召回与重启验证。详见 release-status.json 的 finalAcceptance20261019；本轮交互改动没有重跑真实编纂。中断不保存可续算正文、不自动重发。
- **桌宠本体（OUT_OF_SCOPE）**：本轮不测托盘/形象/提醒等桌宠旅程；保留既有自动构建与浏览器回归。

无凭据场景应用如实显示“未配置”；不得以 fixture 冒充真实服务通过。

## 结果解释

- 状态只用 PASS / FAIL / BLOCKED / NOT_RUN；用户明确后置的项才可写 DEFERRED。详细运行日志在被 ignore 的输出目录（`.local/`、`validation/output/`）。
- 历史各修订的计数（含早期 345/347/348、L2 的 11/14/16/17/22/27 等）保留在 [baseline.json](baseline.json) 与 [release-status.json](release-status.json) 的历史条目中，不作为当前候选的测试证据。
- 改动候选后：重跑受影响层级；候选变化使基线失效时，重新验证受影响部分并更新 baseline.json（注明新运行者与时间）。
- 本版关键行为边界（详见 [WIKI-SYNTHESIS.md](WIKI-SYNTHESIS.md)、[PROMPT-PRESETS.md](PROMPT-PRESETS.md)）：
  - Wiki 编纂按输出预留分批（每批 = 输出 token ÷ 1024，上限 16 条/批）；189 条材料在 16384 输出预留下 12 批（真实网页全量实测约 24 分钟），默认 4096 下约 48 批；生成时限上限现为 45 分钟（本地有界配置）；全局限额 48 页 / 每页 12 段 / 160 关系不放宽。
  - 图谱最多显示 128 节点 / 2048 边，超出显式标注省略，不隐藏截断。
  - 预设发送前必须核实唯一 High；不可核验即拒绝发送，不静默降级。
  - 聊天超时（75s）返回 503 且不自动重试；客户端断开是单独结果。
  - 调用模型前先持久化不含正文的 submitted 意图，失败/取消/超时再标记终态；完成回复持久化后才释放意图。意图无法写入则未发送。未完成记录达到角色1024条或当前会话512条时拒绝新增、不淘汰旧记录；同一 turnId 在切换预设/配置/历史或重启后仍拒绝重新编译与提交，只有新轮次编号才会再次发送。无痕会话只在进程内冻结。

## 清理后需要重新生成的清单

本次发布清理删除了若干个人工具与私有数据用例（清单与哈希见 worker 归档目录，不在本树内）。当前 `validation/source-manifest.json` 在本轮交互和文档修改后重新生成，对应未提交工作树，排除清单自身。此后任何改动都需再次生成；历史发布记录中的文件计数保持当时含义。

## 冷复现记录（2026-10-19 冻结候选）

- 另盘全新目录复制 git 可收录文件 1468 个，逐文件 SHA-256 0 差异；未复制 node_modules / dist / .local / .git / electron-user-data / 登录态。
- 两处 npm ci 均 exit 0；check / build / build:desktop 均 exit 0。
- L1：`node --test dist/tests/memory-book/*.test.js` → 382/382 PASS（首次并行运行有 1 条子进程 stdout 解析抖动，单文件复跑 8/8、全量复跑 382/382，均记录在 worker cold 日志）。
- L2：固定 17 文件 → 27/27 PASS，exit 0。
- 原 L3 的 PowerShell 日志进入返回流，非空数组被误判为 true；该 PASS 判定已作废。Code Review 修复复验改用保持 stdin 打开的真实后台，断言当前进程 PID、HTTP runtime、SPA、主动关闭、锁释放和端口关闭；首启/重启两轮均通过。另在该隔离实例通过正常管理 API 导入12条合成资料、绑定合成预设、召回、聊天，再重启回放同一turnId，模型总调用数为1。此复验复用既有另盘 npm ci 依赖并重建修改后的源码；没有重新执行 npm ci，不属于真实模型或桌宠验收。
