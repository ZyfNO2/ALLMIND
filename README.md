# ALLMIND

让角色住在桌面上，也让相处留下可以查证的记忆。

ALLMIND 是一个 Windows 桌面角色陪伴与本地知识管理项目。你可以创建角色、补充人设与世界观，通过 API 或 ChatGPT 网页聊天，再把资料整理成带来源的 Wiki，并查看知识之间的关系。

**0.1.0-beta.1 · 开发预览版** · Windows x64 · WPF 桌宠 + 本地后台 + Web 管理界面

[快速开始](#快速开始) · [Wiki 与图谱](#wiki-与图谱) · [模型连接](#模型连接) · [已知限制](#已知限制与验证范围) · [后续更新](#后续更新)

## 桌面上的陪伴

基于 GPT-Niang 的 WPF 桌宠底座，接入 ALLMIND 的角色、聊天、预设与记忆能力。

| 点击桌宠，显示回复 | 点击气泡，直接输入 |
| :---: | :---: |
| <img src="assets/readme/pet-reply.png" width="340" alt="GPT 龙娘头顶气泡回复预览"> | <img src="assets/readme/pet-input.png" width="340" alt="原有气泡内的淡紫色聊天输入框"> |

上图由当前生产 WPF 控件渲染，示例文字用于展示布局，**不是桌面实机截图或真实模型回复**。形象来自 [GPT-Niang](https://github.com/T7moris/GPT-Niang)，适用独立的[非商业素材声明](windows/code/desktop-pet/desktop/wpf/shell/assets/CHARACTER-NOTICE.txt)。

- 单击桌宠先看最近回复；没有回复时显示简短招呼。再点气泡进入输入态，发送后在同一气泡显示回复。
- `Enter` 发送，`Shift+Enter` 换行，`Esc` 返回回复，`×` 收起，`↗` 打开完整聊天。
- 空闲约 15 秒收起；聚焦且有草稿或正在等待回复时保持打开，回复完成后约 30 秒收起。失败保留草稿，不自动重发。
- 支持拖动、缩放、按压反馈与托盘驻留。右键桌宠进入聊天、角色、记忆或设置；托盘右键“退出 ALLMIND”才结束后台。

全新安装带有 **GPT 龙娘初始角色与静态形象**，人设、Wiki 和陪伴记录为空，等待你补充。已有实例不会被初始角色覆盖。截图中的演示资料不随首次启动导入。

## 可以做什么

| 能力 | 当前实现 |
| --- | --- |
| 自定义角色 | 新增、修改角色，分别管理人设、外观和资料；切换角色不复制其他角色的会话 |
| 两种模型来源 | OpenAI 兼容 API；独立 ChatGPT 登录页面，默认跟随网页当前模型 |
| 角色知识库 | 世界设定、人设、客观知识、陪伴记录四类目录，支持查看、编辑与来源追踪 |
| Wiki 编纂 | 产品准备材料、规范、Schema 与自检脚本；模型生成后独立校验，审核确认才应用 |
| 知识图谱 | 二维布局、连接社区、分类着色、连接度大小、方向关系与来源引用 |
| RP 预设 | 导入酒馆 Chat Completion JSON，编译顺序、Role、Depth、常用宏与动态插槽 |
| 对话与隐私 | 会话续接、归档、本地无痕；查看召回依据及最终 Prompt |

## 快速开始

### 从源码运行

需要 **Windows x64、Node.js ≥ 22.12.0、npm、Windows PowerShell 5.1 与 .NET Framework WPF**。首次安装需要网络。

```powershell
git clone https://github.com/ZyfNO2/ALLMIND.git
cd ALLMIND/windows/code/desktop-pet
npm.cmd ci
npm.cmd --prefix management/character-ui ci
npm.cmd run build:allmind
npm.cmd run start:wpf
```

构建后也可双击仓库根目录的 `Start-ALLMIND.vbs` 隐藏启动，无需另外安装 GPT-Niang。如果 Electron 安装脚本被跳过且缺少 `node_modules/electron/dist/electron.exe`，在上述项目目录运行 `node node_modules/electron/install.js` 后重试。

### 完成第一句对话

1. **准备角色**：右键桌宠打开管理，在“角色”编辑 GPT 龙娘，或新增你的角色。
2. **写入人设**：进入“人设与说话方式”，保存身份、性格与说话习惯；已有结构化角色包可先预览再导入。
3. **连接模型**：在“设置 → AI 与对话”选择 API 或 ChatGPT 网页接入，完成测试并保存。
4. **开始聊天**：进入首页聊天，或点击桌宠、再点击头顶气泡输入。管理页与气泡均使用当前角色；气泡消息保存到该角色的“桌宠对话”。

模型连接由应用共用，角色资料与对话按角色隔离。网页正式聊天默认**非临时**；“临时聊天”控制远端网页记录，“本地无痕”控制本机记录，二者独立。

### 使用免安装目录包

在 `windows/code/desktop-pet` 中构建，输出目录必须尚不存在：

```powershell
npm.cmd run pack:allmind -- --output E:/ALLMIND-portable
```

将**整个目录**复制到 Windows x64 电脑，双击其中的 `Start-ALLMIND.vbs`。包内包含 Node、Electron、WPF 宿主和管理页面，目标机器无需 Node/npm，仍依赖系统 PowerShell 5.1 与 .NET Framework WPF。当前不提供安装器、签名或自动更新。

默认数据在 `%LOCALAPPDATA%/ALLMIND/`：`book/` 保存角色、连接与记忆，`host/` 保存窗口状态。独立试用可指定新目录：

```powershell
npm.cmd run start:wpf -- --data E:/ALLMIND-demo-data
```

旧 Electron 开发入口 `npm start` / `windows/Start-Windows.cmd` 使用另一数据目录，不会自动迁移到 WPF 数据目录。

## 模型连接

**API Key 接入**：在“设置 → AI 与对话 → API Key 接入”填写 OpenAI 兼容地址、Key、模型 ID；可获取模型列表或手动输入。先测试、再保存，测试成功不会自动覆盖已保存连接。

**ChatGPT 网页接入**：选择“ALLMIND 独立常驻页面”，打开独立登录窗完成登录，再检查、绑定并保存。默认使用网页当前模型 `current`。内置来源无需额外 CLI；备选浏览器工具才需要另装 `chatgpt-use` / `chrome-use`。可用模型与服务状态取决于你的账号。

网页预设和 Wiki 请求发送前核实 **High**，不能核验时拒绝发送。失败、取消、超时或结果未知时不自动重发；已提交请求需先核对原回执。

## Wiki 与图谱

### 从资料到可核对的知识页

“记忆 → 日常整理”的流程是：**准备材料 → 发送模型 → 独立校验 → 查看草稿与原文依据 → 确认应用**。它不会把模型返回的文字直接覆盖到角色书中。

以下是 **2026-10-20 当前管理界面的真实截图**，内容来自本地 GPT 龙娘测试材料，经 ALLMIND 调用 ChatGPT High 编纂。虚构设定不代表官方设定或真实共同经历；这些测试记录不随空白包导入。

![Wiki：云栖城、金库与关键物件，以及关联与来源](assets/readme/wiki-world.jpg)

<details>
<summary>查看另外两个知识页：角色资料与事件叙事</summary>

**角色资料**：保留社区描述、作者虚构与未证实传言的边界。

![Wiki：GPT 龙娘与 DeepSeek 鲸娘](assets/readme/wiki-characters.jpg)

**事件叙事**：保留事件日期、未知凶手与虚构经历标记。

![Wiki：雾历 214 年事件与叙事](assets/readme/wiki-events.jpg)

</details>

<details>
<summary>查看真实编纂任务与 High 回执</summary>

本次生成 3 个综合页、3 条页间语义关系。结构、逐字依据、资料域与覆盖检查通过后，经界面确认应用。

![Wiki 编纂：已应用任务、High 核实与任务包哈希](assets/readme/wiki-synthesis.jpg)

</details>

角色包支持 ZIP、`memory-book/v1` JSON 与**结构化** `.aiki.md`，单文件上限 1 MiB。普通 Markdown 可以作为聊天资料上传，**仅修改扩展名不会成为可导入角色包**；当前编纂从角色书取材料，普通 Markdown 尚不能一键上传后直接编纂。核心人设合计上限 4 KiB。

较大材料集会分批处理，全部校验通过后再统一审核应用。历史 189 条材料曾分 12 批完成；跨批同名主题尚未自动合并，中断后不会自动续算或重发。详见 [Wiki 编纂说明](validation/WIKI-SYNTHESIS.md)。

### 看见知识之间的关系

![实际知识图谱与节点依据面板](assets/readme/wiki-graph.jpg)

图谱采用 ForceAtlas2 布局、Louvain 连接社区和 WebGL 渲染。支持搜索、缩放、拖动、全屏、键盘选中与右侧依据详情。颜色按四类知识或连接社区区分，节点大小反映连接度；箭头表示语义方向，浅色线表示来源引用。位置接近本身不表示事实关系。

上图共 **5 个节点、10 条连线**，其中 **3 条是模型生成的页间语义关系**，其余为来源、依据和页面关联。当前编纂偏向 1–3 个主题页，还不是完整的细粒度实体关系抽取。图谱显示上限为 128 节点 / 2048 边，超过时提示省略数量。

### 检查“为什么想起这些”

聊天中的引用入口与 Prompt Inspector 可检查实际召回条目、预设、预算和省略原因。酒馆预设兼容正文、顺序、Role、Depth、常用宏与 Marker；未知宏或 Marker 会明确阻断，不执行第三方脚本。预设在“设置 → AI 与对话 → 对话预设”管理。

## 已知限制与验证范围

- 自动编纂可能继承原始资料分类。本次三个派生页都落在“客观知识”，尚未自动分入人设与世界设定，也没有自动启用核心人设。
- 模拟派生页在 `story-rp` 模式可召回，在默认 `smart` 模式会被隔离；原始模拟材料与派生页的资格判断仍有不一致。这部分尚未完成统一。
- ChatGPT 网页长期历史仍有省略或空回复的已知问题；空回复会显式报错。真实 API 此前遇到服务 HTTP 403，不能用 fixture 成功代替真实服务通过。
- 当前默认静态形象；Live2D SDK、私人模型和语音模型不随包分发。气泡的真实鼠标、中文输入法手感，以及全屏/锁屏场景仍需单独验收。

| 验证范围 | 最近记录，不代表本次重新跑全量 |
| --- | --- |
| 本地核心 / 固定浏览器回归 | 历史 L1 395/395；固定浏览器 29/29，详细范围见验证记录 |
| 本次真实 Wiki 编纂 | ChatGPT High、3 页 / 3 关系、独立校验、界面应用、刷新与后台重启留存通过；RP 召回 3/3 |
| 气泡交互组件 | WPF 34 项断言，包含原 HWND 复用、焦点切换、草稿与回执隔离；不等于实际鼠标/IME验收 |
| WPF 与便携包 | Node WPF 套件 7/7；悬浮策略 53 项；当前测试目录包 1674 文件哈希核对、46 项隔离检查，模型使用 fixture |
| 全量冷复现 / 安装器 / 签名 | 本轮未做新的全量冷复现；安装器、签名、自动更新尚未提供 |

复跑入口：[RUNBOOK](validation/RUNBOOK.md) · [固定用例](validation/CASES.json) · [交互与图谱范围](validation/UX-GRAPH.md) · [历次验证记录](validation/release-status.json)。[源码清单](validation/source-manifest.json) 是此前冻结记录，不包含后续所有 WPF 与聊天修改。

便携包隔离检查（在项目目录运行，测试数据目录须尚不存在）：

```powershell
npm.cmd run verify:portable -- --package E:/ALLMIND-portable --data E:/ALLMIND-unused-test-data --report E:/portable-result.json
```

不要与其他占用 Chat Bridge 端口 17643 的 ALLMIND 实例并行运行该检查。它使用本地合成模型服务，不消耗真实模型额度。

## 后续更新

以下是计划方向，**尚不作为当前可用功能承诺**：

- **QQ 桥接**：把角色对话接到 QQ，明确会话路由、权限和记忆写入边界。
- **ACP 桥接**：对接兼容 ACP 的 Agent，区分角色陪伴与外部任务执行。
- **Wiki 与导入**：普通 Markdown 直接编纂、自动分类、实体级关系、跨批主题合并，统一模拟资料召回规则。
- **桌宠与交互**：继续完善气泡聊天、外观与动作、场景避让和原生验收。
- **发布体验**：干净安装复现、安装包、签名及更新流程。

## 来源与许可

ALLMIND 沿用 [phoiex/AAAAGENT](https://github.com/phoiex/AAAAGENT) 底座，经 Aika-Next Windows 工作线继续开发，适用原样保留的 [AAAAGENT 非商业使用及署名许可](LICENSE)。WPF 桌宠基于 [T7moris/GPT-Niang](https://github.com/T7moris/GPT-Niang) 增量改造；其代码与角色图片分别适用对应许可，不将角色图片解释为代码许可资产。

完整来源、依赖与素材声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本页配图来源与拍摄范围：[配图说明](assets/readme/README.md)。
