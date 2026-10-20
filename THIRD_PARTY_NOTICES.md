# 第三方与来源声明（THIRD_PARTY NOTICES）

本文件是 ALLMIND Beta 源码树的最小来源/修改/素材声明，不是产品 README。许可条款以随树保留的 [LICENSE](LICENSE) 为准；本文件不改变、不放宽其任何条款。

## 1. 项目许可与署名（必读）

- 本树源码来自 **AAAAGENT** 项目（源项目 <https://github.com/phoiex/AAAAGENT>）的 Windows 主线整理副本。根 [LICENSE](LICENSE) 为 AAAAGENT 非商业使用及署名许可，**原样保留**。
- 依据该许可与源项目声明：**本项目原创内容禁止商用；使用须署名 AAAAGENT、原作者及项目来源。**
- 本轮整理（ALLMIND Beta 最小源码整理）对源码做了以下类别的必要适配，之后继续按授权开发，主要修改如下：
  1. 将测试对源仓库 `docs/` 的 fixture 读取迁移到 `validation/fixtures/` 并更新引用路径；
  2. 将测试截图/日志输出重定向到被 ignore 的 `validation/output/` 隔离目录；
  3. `tests/memory-book/zip-import.test.mjs` 中对另一私有工程导出的真实交付 ZIP 的引用，替换为同文件内可重复生成的合成 ZIP 样例（生产导入路径与断言结构保持不变）；
  4. `windows/Start-Windows.cmd` 去除对本机 Codex cache、`.tooling` 的依赖，改为纯净的首次安装/构建/启动脚本并输出可定位日志；
  5. `.env.example` 中的个人机器路径示例值改为空值/通用占位；
  6. 新建 `.gitignore`（修复源仓库宽泛 `data/` 规则对 `management/character-ui/src/components/data/` 真实源码的误伤）、本文件与 `.github/workflows/verify.yml`，并新增 `validation/` 验证包。
- 仓库内保留的 `AGENTS.md` 记录本树整理期的工程约束。
- 后续 Beta 修改还包括：对话输入稳定性、右键聊天入口、去除自主浮动、关闭到托盘与真正退出分离、七项快捷菜单、五类设置重组、专注暂停自主活动，以及默认可见名称 ALLMIND；内部数据 ID 与兼容 namespace 保留。上述修改的验证与范围见 validation 中的追加记录。
- 本树经 Aika-Next Windows 工作线继续开发后整理为 ALLMIND；并非对 AAAAGENT 原版的纯字节复制。发布树还修复了 eraseTurns 的校验、journal 与附件/回执撤销顺序，同步更新生产组合根和安全/恢复测试。README、DEMO 与 Beta 版本信息在初始整理后补入。

## 2. 未随树分发的第三方组件（使用前需自行取得授权）

- **Live2D Cubism SDK**：不随本树分发。`desktop/vendor/`（Cubism Core/Framework 的 SDK 槽位）被 `.gitignore` 排除。没有该 SDK 时，构建显式进入静态立绘模式，Live2D 载入会被明确拒绝（见 `desktop/model-build-options.mjs`、`desktop/cubism-unavailable.mjs` 与 `tests/memory-book/w02-release.test.mjs`）。使用 Live2D 展示需自行准备有权使用的 Cubism SDK 与模型，放入 `desktop/vendor/` 后重新构建。
- **私有 Live2D 模型**：源工程的 `desktop/assets/local-model/`（内建模型槽位）与模型备份不随树分发，`.gitignore` 已排除该目录。未配置私有模型时应用以随包静态 ALLMIND 标志作为默认形象。
- **Live2D 官方样例模型**：源工程 `desktop/assets/presets-source/` 内的 Live2D 官方样例数据（natori、Hiyori 等）不随树分发（分发依据未核实，且无代码引用）。

## 3. 随树保留的素材及其来源状态

2026-10-19 按用户的空白包发布要求，原来源待核实的游戏图标与两张立绘已迁出发布树，不随包分发。应用首次启动不导入测试角色、预设或历史记录。

- `windows/code/desktop-pet/desktop/assets/allmind/`：项目原创几何图标（`icon-source.svg` 与派生 PNG/ICO、`derive-report.json`）。不属于第三方游戏素材。
- `validation/fixtures/wiki-handoff/inputs/w02-allmind/`：两张合成几何测试图片，仅供上传、预览与撤销路径验证，无原游戏立绘。文件名 `portrait-01-original.png` / `portrait-02-original.png` 是为兼容既有测试导入保留的历史命名，文件本身是 2026-10-19 生成的原创几何测试卡（说明见该目录 `README.md`）；首次启动不加载。
- `validation/fixtures/prompt-presets/nano-bear-roleplay.json`：Nano Bear 的 Roleplay Chat Completion 预设，来源 https://github.com/cavecomputing/nanobear/blob/5a625088f34df130f4b02b6f2b3e649bfa46b1ae/presets/sillytavern/roleplay-v2.0b-chat.json ，固定版本 `5a625088f34df130f4b02b6f2b3e649bfa46b1ae`，随树原件 SHA-256 `d7a7dfcbc8349d6813171b1a1edbab40cc229e37550be90426ddd7cbfdd78c7f`。依原项目 CC BY 4.0 分发，许可正文见同目录 `NANO-BEAR-LICENSE.txt`。随树 JSON 原件未改写；产品导入时可在本地编辑副本中增加 ALLMIND 记忆与材料插槽。该预设仅为可选验收样例，不默认启用。
- `validation/fixtures/aiki-character-book/allmind.aiki.md`：合成的角色书测试设定（源文件自述为简化测试设定），供导入/解析/召回等测试使用。
- `validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md`：Wiki 导入模板，供 Wiki 导入测试使用。
- `validation/fixtures/next081/perf-thresholds.template.json`：资源测量阈值模板。
- `tests/companion-knowledge/fixtures/ocr/probe.webp`：OCR/Sprite 检查用合成 fixture。

## 4. 第三方依赖

运行与开发依赖均通过 npm 声明于 `windows/code/desktop-pet/package.json`、`windows/code/desktop-pet/package-lock.json` 与 `windows/code/desktop-pet/management/character-ui/package.json`、`.../package-lock.json`（如 electron、esbuild、typescript、@playwright/test、yauzl、qrcode、pinyin-pro、better-sqlite3（optional）、sherpa-onnx-node（optional）、silk-wasm（optional）等），安装时由 npm 从 registry 获取，各依赖的许可证随其分发包提供；本树不 vendor 任何上述依赖的代码。构建链中的 WeChat bundle 使用上述 npm 依赖 `silk-wasm`。

## 5. 历史文档声明提取

源工程 `windows/` 顶层的 README-WINDOWS.md、README.md、README.en.md、CHANGELOG-WINDOWS.md、WINDOWS-VALIDATION.md、WINDOWS-STRESS-RESULTS.md 属历史工程文档，未整份带入本树；其中独有的来源/署名/使用声明已提取到本文件第 1、2 节。其余为历史验收记录，不构成本树的内容声明。

2026-10-17：管理界面布局、配色与交互参考用户提供的 ALLMIND-UX-Redesign-Prototype.html，在现有 React 应用中实现；不复制原型演示数据，不改变原知识与来源图谱。调整了文字模型绑定保存入口、独立登录窗口显示时序与宿主错误反馈。此修改记录不表示对现有素材分发授权作出新的确认。

2026-10-19：增加四分类 Wiki 图谱、真实依据连线与二维布局、轻量酒馆预设导入/编译/Prompt Inspector；酒馆字段语义参考官方文档与公开源码，未复制酒馆运行时，不执行导入扩展脚本。真实模型与发布候选的验收状态以 validation 的当前记录为准。

2026-10-19 发布清理：移除仅用于个人账号/本机浏览器档案的验收脚本（通过 `tools/` 内浏览器 CLI 驱动本机 Chrome 的 chatgpt-* 脚本、指向原工作区的 self-accept、依赖私有角色包角色数据的 character smoke 数据与用例）。构建与回归必需的 `build-*`、`run-tests.mjs`、`release-doctor.mjs`、`run-eval.mjs` 等入口未改动；`tools/quick.mjs` 的本机 MSVC 路径改为环境变量 `AIKI_VCVARS`，未设置时该入口显式 BLOCKED。删除不改变第三方署名与本节约定的许可义务。

## 6. 图谱与交互参考（2026-10-19）

- 本轮新增 npm 依赖：Graphology 0.26.0、graphology-layout-forceatlas2 0.10.1、graphology-communities-louvain 2.0.2、Sigma 3.0.3，均为 MIT；精确版本与传递依赖见两处 package-lock.json，许可随 npm 包分发。
- 技术路线参考 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 提交 `48fd970e206a02a6d2028d1dbfc41b7a0345bf0b` 的布局 Worker、Sigma 渲染与社区分析；ALLMIND 独立实现适配组件，未复制其完整运行时、文档或截图。
- 管理界面延续用户提供的 `allmind_companion_studio_ui.html` 视觉元素。交互核对参考 [Anthropic frontend-design skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design) 与 [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)，未将这些 skill 全文或第三方演示资产打入源码包。
- README 截图为隔离 ALLMIND 实例的实际界面，使用项目自编合成角色/图谱资料和本机 fixture 模型，不含原游戏图片、本地 GPT 娘图片或私人聊天。

2026-10-20 空白源码收口：移除旧 UI 示例图 avatar-aika.png、avatar-sakura.png、avatar-yoruko.png、hero-aika.png；旧页面引用改用既有 avatar-neutral.svg。上述旧图不再包含于发布 Init。

## 7. GPT-Niang 初始角色形象（2026-10-20）

WPF 整合版本另在 `windows/code/desktop-pet/desktop/wpf/shell/` 保留 GPT-Niang 的宿主源码、音效与素材，增量修改及基线见同目录 `UPSTREAM.md`；MIT 代码署名保留在 `LICENSE`，图片、语录分别适用 `assets/CHARACTER-NOTICE.txt` 与 `assets/quotes-LICENSE.txt`。便携包随附 Node 运行时，其完整许可见 `runtime/NODE-LICENSE.txt`；Electron 与 Chromium 许可随 `node_modules/electron/dist/` 分发。源码仓库不保存这些运行时二进制，打包时从本地安装复制。

按用户要求随附 GPT-Niang 的 `gpt-dragon-niang-bust.png`，来源 https://github.com/T7moris/GPT-Niang ，原路径 `gpt-niang-usage/assets/gpt-dragon-niang-bust.png`。固定素材提交 `f906d61bb3a19b6a7004507274fdd2165d3f14b6`，SHA-256 `7787b108d9c972d06228acf4c41721217ae88489b79dc116e2a78d4f81767204`。图片保持原字节，未改绘。随附于 `windows/code/desktop-pet/desktop/assets/gpt-niang/`，同目录保留上游 `CHARACTER-NOTICE.txt` 与 `生成说明.md`。

该图片及副本**不适用代码 MIT 许可**。上游声明在维护者有权许可的范围内，允许随非商业项目副本用于挂件和项目展示，要求保留素材声明与来源；不许可商业素材用途或独立素材包分发，第三方参考设计权利归各自权利人。以随附原声明为准。初始角色只注册名称与静态形象，不随附用户 Wiki、私人设定或聊天记录。
