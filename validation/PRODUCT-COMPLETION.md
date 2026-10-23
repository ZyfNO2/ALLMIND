# 用户操作验收矩阵（beta.2）

本表是本轮增量的产品入口与证明映射。最终数字、源码和包身份以 release-status.json 的 currentSummary 为准；历史模型/QQ 样例不替代本次测试。

| 用户操作/风险 | 当前行为与入口 | 自动证据入口 |
| --- | --- | --- |
| 同群多人和多端聊天 | 平台/账号/群/成员/角色分别定域；不继承旧群级历史；QQ 只读审核后的公开快照 | product-security、channel-publication、qq-channel、OneBot 核心组 |
| 本机 API/IPC 被网页或其他进程滥用 | Host/Origin/跨站 bootstrap/bearer、命名管道令牌与范围检查；未授权时不读写/调用模型 | product-security、management-security、tests/wpf |
| 轮换/失效/撤销凭据 | 数据与备份→诊断；明确撤销停止活动本机任务及共用 QQ 连接；重新保存后显式恢复 | product-security、product-controls.browser |
| 资料/图片/OCR/模型内容试图授权 | 强制资料信任边界进入预算；资料只能作为证据；无材料→工具的自动端口 | product-security、screen、resources、prompt-presets 核心组 |
| 升级/异常中断/旧程序读取 | 精确字节迁移备份、准备日志、逐文件原子替换、reader barrier、离线条件回滚 | product-security、book-schema CLI；不得把安装器切换程序当数据回退 |
| 更正/忘记/撤销来源 | 保留可追溯修订，派生/索引/召回按有效依据重算；擦除原文同时使对应迁移副本不可恢复 | fact / privacy / synthesis / erase / recall 核心组 |
| 选场景/配模型/查花费 | 输入区场景选择、设置独立预设/模型/域/预算；实际回执显示本地估算，金额未知；失败不换模型 | dialogue-routing、product-controls.browser |
| RP/主动打扰 | RP 不自动写真实记忆；显式记住为故事；presence/default RP 抑制主动打扰；频率/暂停/冷却/免打扰配置 | companion-proactive、proactive-frequency、interaction-presence |
| 授权感知/不知道就不知道 | 来源许可、单帧预览、图片直发或本地 OCR、每轮发送确认；无权限/锁屏/未知不推测内容 | book-screen、screen 核心与浏览器；真实系统选择器由用户手测 |
| 检查坏在哪/导出诊断 | 诊断本地与可选模型列表；不推理不发外部信；下载只含固定诊断字段 | dialogue-routing、product-controls.browser |
| 文件/图像/转写 | 统一来源/权限/读取状态；转写回执绑定文字区间和会话，过期不能冒充新识别；不保存音频 | local-voice、resources、media、product-controls.browser |
| 语音设备/打断/分段 | 此浏览器保存设备；精确输入约束/输出 sink；无损句段与下一段预取；停止取消待播 | speech-chunks、local-voice、product-controls.browser；设备为合成接口 |
| 桌宠动作/窗口上沿/不抢焦点 | opt-in 几何停靠；拖动取消；未知/全屏/上沿不足不启用；减少动画/输入/隐藏时暂停 | allmind-perch、visibility、quick-chat、sound-sequence 和实际包生命周期 |
| 执行工具/插件 | 本机显式信任程序，固定可执行文件/脚本入口哈希，本机工具权限表，逐任务参数确认；ACP 仅 allow_once | book-tools、protocol-stdio.integration、product-controls.browser |
| 工具未知结果/取消/重启 | 先持久 intent；结果未知/已完成编号不能再次执行；取消不代表远端撤回 | book-tools；权限表不是 OS 沙箱，依赖链未全面哈希 |
| 双端资料同步 | 手动文件交换；可选私有条目、角色名称/简介；双方完整预览/冲突选择；缺来源整包拒绝；旧包不能复活明确删除 | book-sync、product-controls.browser 的两个独立实例 |
| 实体合并/关系依据/来源更新 | 同域实体身份、来源快照与关系依据；审核后写入，撤销后不可继续当证据 | wiki-synthesis、batches、synthesis-review、wiki-maintenance 核心与浏览器 |

## QQ 两条路线

当前交付的是 **NapCat / OneBot v11** 个人 QQ 账号路线：账号状态核实、白名单好友/群 @、隔离上下文、文本回复分段回执、断线/重启去重、未知投递人工核对。图片/语音/文件不会默默当作已经读取；纯媒体请求明确告知未读取且不调用模型。群中不同成员独立记忆，但新话题会取消该群旧任务。

**QQ 开放平台官方机器人**是另一条账号、授权和协议路线，不能复用 OneBot token；本版未提供官方机器人适配。本轮把此差异展示在产品入口。官方路线需要单独适配与接收范围授权，不能靠改一个 token 冒充可用。

本轮受控 OneBot 的收发/重连/去重/隔离/限流/回执测试属于协议证明。此前单个授权好友的真实网页模型 QQ 回路保留历史记录；本轮没有擅自向其他真实好友或群发信，真实群与 QQ→API 标为 NOT_RUN。

2026-10-22 补测进一步贯穿 OneBot WebSocket → Manager → Runtime → 生产 HTTP 模型适配器 → 受控 HTTP 服务 → 平台回执：验证同群两成员、同一发送者群/私聊和桌面私库隔离，未授权目标拒绝、重连/重启不重发，以及新话题/紧急停止取消真实挂起 HTTP 请求、另一成员可独立完成。测试在 `qq-http-acceptance.test.ts`，模型明确为 fixture，不将此记录升级为真实 QQ 联系人或真实模型服务验收。

本机 Windows 中文多句合成→识别、中英/空白像素 OCR 已补测；Win32 观察器的热键冲突/重绑/释放、通知边界、独立透明窗口最小化/关闭和层级/工作区缩放也有真实组件证据。未触发真实用户输入、锁屏或睡眠。无 fake-media 参数的 Chromium 通过产品设备面板读取设备列表，未申请录音、未播放、未导出设备 ID/名称；这不等于物理设备效果通过。

## 六项 Release Gate 与人工边界

空白安装、升级、真实服务、恢复、安全、文件完整性分别记录并绑定源码；fixture 不可通过真实服务门槛，程序回退不可代替数据回滚。发布包不含个人角色知识、密钥、会话或登录态；开源静态角色图片按独立素材声明分发。

真实鼠标/触摸、中文 IME、系统选择器、全屏/锁屏/睡眠仍由用户手工验收（NOT_RUN），自动组件不能替代。物理麦克风/扬声器、噪声、设备切换及听感验收按用户本轮要求后置（DEFERRED），未视为通过。签名与 SmartScreen 信誉按已确认范围 DEFERRED，未发布公开 Release。无签名、自动云同步、原生手机客户端、官方 QQ bot、模型 token 连续语音流均不在当前实现能力里。PR 不合并。


2026-10-22 屏幕图片小补：预览后可分别确认本地 OCR 或保存原图为本轮图片附件，均需手动发送。GPT 网页仅支持传图的内嵌来源；API 显式开启 imageInput 后才允许发送 OpenAI-compatible 图片内容，未开启或请求失败时不移除图片重试。原图在本地会话资料中保留；移除选择不删除副本，无痕会话不提供此保存入口。真实服务识图与系统选择器仍为 NOT_RUN。最新自动验证见 currentSummary.screenImageSupplement。
