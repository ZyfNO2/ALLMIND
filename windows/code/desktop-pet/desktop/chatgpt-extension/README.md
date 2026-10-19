# AIKI Chat Bridge（MVP）

架构参考 DrA1ex/chatgpt-bridge 的扩展与本地服务模式（MIT，参考修订 0ffdae90239988f253058c05253226152acd55d2），这里只实现 AIKI 的固定页面动作端口；未复制它的 SQLite、zipflow、CLI/TUI 或 Agent 工作流。

1. 构建 AIKI：`npm run build` 会从生产页面动作生成静态 `page.js`，不是动态 eval。
2. 在要使用的 Chrome 配置中登录目标 ChatGPT 账号。
3. 在 `chrome://extensions` 开启开发者模式，加载本目录。代码更新后点扩展刷新按钮。
4. 从桌宠打开设置，连接方式选择 Chat Bridge 并保存。点“显示本地配对码”。
5. 在同一个 Chrome 配置里打开本扩展选项页，输入该码并配对。只创建一个专用后台标签，不切换焦点、不创建窗口。
6. 回 AIKI 检查来源状态，即可对话或 AI 整理。

浏览器关闭、专用标签被关闭或账号登录失效时，会明确失败。已有请求的提交结果未知时不能换配置、重发或重置配对，应先接续读取或核对停止。

AIKI 重启后原配对保留；扩展后台重连周期最多约 30 秒，可稍后再检查来源状态。无需重新配对。新实例的管理页面请从桌宠重新打开，旧页面的管理令牌可能已失效。

Google 账号、Chrome 配置、ChatGPT 登录账号是三件不同的事。本扩展只读取所在 Chrome 配置的 ChatGPT 登录态。AIKI 锁定一个扩展实例；即使它断开也不接受另一实例接管。服务重启保留该绑定。同配置切换 ChatGPT 登录账号，会在发送前检测并停止；需要在 AIKI 点“更换浏览器配置（重新配对）”，再在目标配置配对。当前一次使用一个账号，不做自动账号轮换。

服务只监听 `127.0.0.1:17643`，校验扩展 Origin、Host 与本地配对码；码仅授权本地 IPC，不是 OpenAI API Key 或 GPT 登录凭证。GPT 登录凭证留在浏览器，只有不可逆的账号指纹用于比对。扩展无需 `debugger` / `nativeMessaging` 权限；产品调用不运行 chrome-use、CMD 或 PowerShell。

`temporaryChatTests` 控制模型连接测试是否使用临时聊天；正式对话和整理仍按正式流程创建 ChatGPT 会话。临时模式必须在页面与原生请求中确认，否则提交被拒绝。CLI 是设置中显式选择的备选来源；bridge 失败不会自动切换。
