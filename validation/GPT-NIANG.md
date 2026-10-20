# GPT 龙娘与本地 GPT-Niang 适配

## 随包初始角色（2026-10-20）

应用首次启动会注册 `gpt-niang`（GPT 龙娘）及 `starter-gpt-niang` 单帧静态形象。全新实例默认选中它；已有实例只补充这一角色，保留当前选择、现有人设、模型与资料。初始化标记保存在 Runtime 中；后续启动不重复创建，不覆盖用户改名、换装或删除。

初始角色不预填 Persona、Wiki、陪伴经历，也不从历史测试包拷贝虚构记忆。具体设定可以后续在“角色 → 人设与说话方式”编辑，或通过角色包预览导入；知识资料在记忆中管理。图片位于 `windows/code/desktop-pet/desktop/assets/gpt-niang/`，附原始 CHARACTER-NOTICE.txt 与生成说明；素材不适用代码 MIT 许可，仅按上游声明作为非商业项目副本的一部分随附。

角色不绑定任何供应商、Key 或预设，不自动启用感知或自主活动。WPF 宿主沿用 GPT-Niang 的静态形象与原有本地按压/拖动等交互；单张图片不被标记为 Live2D 或多帧动画。

## 角色草案 ZIP

先新增一个空白角色，在“角色 → 导入角色包”选择 ZIP（原“我们的回忆”高级导入入口仍可用），预览后应用到当前角色。支持 `aiki.character-pack.draft/1`：`wiki.required` 合并为总计不超过 4 KiB 的常驻 Persona；`wiki/worldbook.md` 中带“触发：”的二级章节按关键词召回；其余检索文件作为 Wiki 交互建议。交互建议是角色资料，不会启用感知、工具或脚本。缺失文件、无效路径、超限核心设定、非空初始记忆均拒绝导入。预览不写入，应用沿用既有版本/冲突检查；不会替换当前角色原有的人格，已有 Persona 的合计预算仍由上下文构建器校验。

`memory/examples`、记忆政策说明和其他未选择的文件不导入；导入包内故事不成为真实聊天经历。用户提供的 GPT 龙娘 v0.1 草案实测转换为 1 条 Persona、4 条关键词世界书、1 条交互 Wiki，0 条用户记忆。

## 本地形象与能力

### 随树 WPF 宿主

`desktop/wpf/shell/` 已包含宿主源码与素材，`build:allmind` 同时构建后台、管理界面和 WPF exe，`start:wpf` 无需外部 `--shell-root`。`pack:allmind -- --output <新目录>` 生成带 Node/Electron 的单目录包。默认使用 `%LOCALAPPDATA%/ALLMIND` 数据；`--data <目录>` 可隔离验收。关闭桌宠隐藏，托盘退出停止后台。原生按压、拖动、声音与窗口可见性策略由随树 WPF 代码处理；不启动 Codex 监控。静态形象不是 Live2D。

以下“本地读取”描述的是管理页向现有立绘库导入图片/额度快照的独立能力，其范围不等同于 WPF 宿主自身的互动能力。

2026-10-20 整合验证：`build:allmind`、TypeScript check 通过；单目录包 1668 文件哈希一致，`verify:portable` 38 项通过，包括初始角色/形象 ACK、包内 Electron 网页辅助宿主握手和关闭、真实本地 HTTP fixture 聊天、隐藏期间后台不退出、完整重启保留记录且不重发、VBS 重复启动恢复同一实例、退出释放锁。另有控制管道/状态用例 4/4、窗口策略 53 项、Win32 观察器 10 项、通知门控 5 项和音乐挂起 8 项通过。这些是组件与进程检查；原生鼠标交互、真实全屏/锁屏和模型登录聊天为 NOT_RUN，不表示完整用户验收通过。

同日用户复测发现网页登录仍失败：Windows GUI Electron 的 stdin 会提前结束，旧检查只验证握手和 EOF 退出，遗漏了实际请求。现已换成独立、带随机能力令牌的 Windows 命名管道；stdin 不再控制网页宿主生命周期。新增真实 Electron 连续请求回归，控制/宿主及页面逻辑共 7/7；更新后的便携包 1669 文件、40 项检查通过。实际用户实例 `/chatgpt-web/embedded/login` 已返回 200 并打开登录窗口，后续登录绑定须以用户完成认证后的检查为准，不将打开窗口当作绑定成功。

用户随后完成登录：独立页 ready/signedIn 均为 true，embedded/current 绑定保存并回读成功；High level 2 经过实际菜单读取、选择与回读。真实最小连接测试 HTTP 200、ok=true，7249 ms，返回“ALLMIND连接正常。”；测试后无未结束请求。此结果不替代真实 Wiki、长历史和原生输入验收。

“角色 → 形象与换装面板 → 静态立绘与换装 → 从本地 GPT-Niang 读取形象与额度”读取当前 Windows 用户的标准安装绑定，或手动指定本地 `gpt-niang-usage` 项目目录。也支持进程环境变量 `ALLMIND_GPT_NIANG_DIR`，不将个人目录写入导出角色包。已安装用户的绑定来自 `%LOCALAPPDATA%/GPTNiangUsage/update-agent/binding.json`；项目目录读取 `assets/characters.json` 及其 PNG/WebP，旧目录无清单时使用标准半身图文件名。

点击读取只生成预览票据，点击添加才复制到本实例的立绘库；之后仍需“使用此差分”。票据限当前角色、15 分钟有效，文件内容变化要求重新预览。原挂件文件只读，不执行原项目脚本。当前支持静态半身图，不宣称支持原项目的音乐律动、按压音效、自动语录或窗口跟随。

额度只读取 `%LOCALAPPDATA%/GPTNiangUsage/state/status.json` 中白名单字段，显示窗口、剩余比例和观察时间，不返回账户标识或凭据。3 分钟以上、已重置、未来时间或刷新失败的缓存显示过期。这里不发起额度接口刷新，不创建模型会话，也不读取 auth.json；无本地安装/快照时明确显示不可用。

格式参考：[GPT-Niang](https://github.com/T7moris/GPT-Niang)，本次核对提交 `f906d61bb3a19b6a7004507274fdd2165d3f14b6`。本地数据适配独立实现；本轮按用户要求随附初始龙娘图片及其独立声明。原图片声明见上游 `gpt-niang-usage/assets/CHARACTER-NOTICE.txt`，不将图片视为 MIT 代码资产。

本轮证据：worker `review-fixes/dragon-build.log`、`dragon-ui-build.log`、`dragon-l1.log`、`dragon-ui-acceptance.json`。真实 ZIP 和上游图片的生产 UI 导入已执行；实际桌面互动、真实账户额度和角色模型对话未测。
