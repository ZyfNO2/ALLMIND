# README 配图说明 · 2026-10-22

本轮使用当前 beta.2 生产界面重新截取 13 张浏览器图片，并离屏渲染 2 张 WPF 气泡状态图。原始截图均未修图，没有修改页面正文、节点数量、样式或生成结果来制作画面。

## 浏览器截图

使用新的隔离数据目录和默认 GPT 龙娘角色，视口 1440 × 1000。界面导航、草稿审核、确认应用与图谱选中均通过实际产品入口完成。

| 文件 | 展示范围 |
| --- | --- |
| `ui-chat.jpg` | 明确标注“界面演示回复”的对话、实际场景路线与本地 token 估算 |
| `ui-role.png` | 角色资料、作者简介与知识入口 |
| `ui-settings.png` | 场景路由、预算与模型连接入口 |
| `ui-memory.png` | 知识目录、派生正文与关联入口 |
| `ui-voice.png` | 本机设备与本地语音设置入口；独立管理服务未连接桌面偏好宿主 |
| `ui-diagnostics.png` | 本地诊断结果，外部模型检查仍显示 NOT_RUN |
| `ui-sync.png` | 手动选择同步内容；设备 UUID 是此隔离实例新生成的演示标识 |
| `ui-tools.png` | 可信程序与权限表配置，未配置或执行外部工具 |
| `wiki-world.jpg` | 岚栖城的作者设定与反向链接 |
| `wiki-characters.jpg` | 林澄及其地点、物件、事件关联 |
| `wiki-events.jpg` | 档案室事件，未提供的动机保留为未知 |
| `wiki-synthesis.jpg` | 应用前的分类、类型与逐字依据审核，核心人设未勾选 |
| `wiki-graph.jpg` | 全屏图谱及林澄的节点依据；5 节点、10 连线，其中 5 条为语义关系 |

聊天与 Wiki 的模型输出均来自受控 fixture，未调用真实模型服务；fixture 分别返回一条演示回复和一份带逐字依据的结构化草稿。草稿经过生产校验与界面确认应用，页面没有替换为静态样稿。这组图片展示产品流程，不用于证明真实模型的推理、抽取质量或 ChatGPT High 核实能力。

Wiki 材料为专门编写的虚构作者设定：林澄、岚栖城、银钥匙与档案室事件，以及一条表达方式。没有真实 Key、账号身份、登录态、私人聊天、真实设备标识或私人路径。模型名 `demo-local-fixture` 和本机回环地址仅为演示配置。这些资料、配置和会话不随空白包初始化导入。

## 桌宠气泡预览

`pet-reply.png`、`pet-input.png` 使用当前 `widget.xaml` 与 `allmind-quick-chat.cs`，经 WPF RenderTargetBitmap 以 2 倍分辨率渲染为 756 × 756 图片。未显示或激活原生窗口，输入态由程序设置；不是桌面实机截屏，不证明鼠标、键盘或中文输入法验收通过。文字为布局演示，没有模型调用。

形象为随树 GPT-Niang 原素材，适用 [CHARACTER-NOTICE](../../windows/code/desktop-pet/desktop/wpf/shell/assets/CHARACTER-NOTICE.txt)。来源及许可见根目录 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) 第 7 节。

## 历史记录

原 Wiki 和聊天配图已替换为本轮图片。历史真实模型验收仍以 `validation/` 中带日期、来源和限制的记录为准，不把新图片当作真实服务复测结果。

既有 `screenshot-*.png` 为早期隔离实例配图，本次 README 不再引用；保留文件不表示它们是当前 UI。
