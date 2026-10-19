# GPT 龙娘与本地 GPT-Niang 适配

角色文本与外观分别导入，不绑定供应商，不自动更改模型或预设。空白源码包不附带龙娘图片、私人角色、登录态或额度快照。

## 角色草案 ZIP

先新增一个空白角色，在“角色 → 导入角色包”选择 ZIP（原“我们的回忆”高级导入入口仍可用），预览后应用到当前角色。支持 `aiki.character-pack.draft/1`：`wiki.required` 合并为总计不超过 4 KiB 的常驻 Persona；`wiki/worldbook.md` 中带“触发：”的二级章节按关键词召回；其余检索文件作为 Wiki 交互建议。交互建议是角色资料，不会启用感知、工具或脚本。缺失文件、无效路径、超限核心设定、非空初始记忆均拒绝导入。预览不写入，应用沿用既有版本/冲突检查；不会替换当前角色原有的人格，已有 Persona 的合计预算仍由上下文构建器校验。

`memory/examples`、记忆政策说明和其他未选择的文件不导入；导入包内故事不成为真实聊天经历。用户提供的 GPT 龙娘 v0.1 草案实测转换为 1 条 Persona、4 条关键词世界书、1 条交互 Wiki，0 条用户记忆。

## 本地形象与能力

“角色 → 形象与换装面板 → 静态立绘与换装 → 从本地 GPT-Niang 读取形象与额度”读取当前 Windows 用户的标准安装绑定，或手动指定本地 `gpt-niang-usage` 项目目录。也支持进程环境变量 `ALLMIND_GPT_NIANG_DIR`，不将个人目录写入导出角色包。已安装用户的绑定来自 `%LOCALAPPDATA%/GPTNiangUsage/update-agent/binding.json`；项目目录读取 `assets/characters.json` 及其 PNG/WebP，旧目录无清单时使用标准半身图文件名。

点击读取只生成预览票据，点击添加才复制到本实例的立绘库；之后仍需“使用此差分”。票据限当前角色、15 分钟有效，文件内容变化要求重新预览。原挂件文件只读，不执行原项目脚本。当前支持静态半身图，不宣称支持原项目的音乐律动、按压音效、自动语录或窗口跟随。

额度只读取 `%LOCALAPPDATA%/GPTNiangUsage/state/status.json` 中白名单字段，显示窗口、剩余比例和观察时间，不返回账户标识或凭据。3 分钟以上、已重置、未来时间或刷新失败的缓存显示过期。这里不发起额度接口刷新，不创建模型会话，也不读取 auth.json；无本地安装/快照时明确显示不可用。

格式参考：[GPT-Niang](https://github.com/T7moris/GPT-Niang)，本次核对提交 `f906d61bb3a19b6a7004507274fdd2165d3f14b6`。代码独立实现数据适配；外部形象仅在隔离测试目录验证，不随源码发布。原图片声明见上游 `gpt-niang-usage/assets/CHARACTER-NOTICE.txt`，不将图片视为 MIT 代码资产。

本轮证据：worker `review-fixes/dragon-build.log`、`dragon-ui-build.log`、`dragon-l1.log`、`dragon-ui-acceptance.json`。真实 ZIP 和上游图片的生产 UI 导入已执行；实际桌面互动、真实账户额度和角色模型对话未测。
