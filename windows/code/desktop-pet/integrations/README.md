# AstrBot 与可选模块

支持的集成基线为 AstrBot **v4.29.1**。AstrBot 独立安装，ALLMIND 不包含 Python、AstrBot 或 NapCat。主仓库不需要 Fork。

## 构建与启动

在 `windows/code/desktop-pet` 运行：

```powershell
npm.cmd ci
npm.cmd --prefix management/character-ui ci
npm.cmd run build:allmind
npm.cmd run pack:allmind -- --profile desktop-lite --output E:/ALLMIND-lite
npm.cmd run pack:allmind -- --profile desktop-astrbot --output E:/ALLMIND-astrbot
npm.cmd run pack:allmind -- --profile server-core --output E:/ALLMIND-server
```

输出目录必须不存在。默认 `full` 保留原完整产品组合；三个新包会保存自己的 `product-profile.json`，启动无需设置环境变量。源码开发可设置 `ALLMIND_PROFILE`。Lite/AstrBot 包保留内嵌网页 Bridge 所需 Electron，因此不承诺很小的安装体积。公共设置页和能力占位 UI 随壳保留；不包含 Voice/Screen/Tools 的后端实现、专用脚本与模型。

server-core 不含 WPF/Electron。使用管理 Web UI、Wiki 与 API 模型；网页 ChatGPT 需要另行运行桌面 Bridge。服务端运行：

```powershell
$env:AIKI_BOOK_DATA='E:/ALLMIND-server-data/book'
$env:AIKI_BOOK_PORT='3927'
node dist/app/server-core.js
```

目录包使用其 `runtime/node.exe`。源码可运行 `npm.cmd run start:server`。首次运行使用新的数据目录。服务只监听 `127.0.0.1`；跨主机接入通过受控隧道到本机端口，不直接公开管理服务。管理入口保存在数据目录 `management-session.json`，其中包含临时管理凭据，不分享或入库。

## 配置 AstrBot

1. 运行 `desktop-astrbot`，在设置的数据页打开“模块与 AstrBot”，填写本机根地址、稳定实例编号、可选配置 ID 和 OpenAPI Key。保存后退出并重新启动，新建会话。
2. AstrBot 的 OpenAPI Key 至少授予 `chat`；主动消息另需 `im`。不要授予管理员或配置修改权限来代替普通聊天权限。
3. 将本目录 `astrbot_plugin_allmind` 安装到 AstrBot 的 `data/plugins/`，重载插件。在插件设置填写 ALLMIND 实际本机地址与独立能力令牌。令牌从 ALLMIND 设置页显式显示；它不是管理页面令牌。
场景映射可填写 `{"quick":"quick-config-id","smart":"smart-config-id","rp":"rp-config-id"}`；未填写的场景沿用配置 ID。模型连接、MCP 和工具选择以对应 AstrBot 配置为准，不会复制 ALLMIND 的 API Key。ALLMIND 负责相应 Wiki 域与 Preset，AstrBot 负责实际 Provider。

4. 先用普通 API 模型完成往返，再接 GPT 网页。桌面会话会自动建立严格身份绑定。QQ 等外部平台需要在 ALLMIND 管理页手动审核绑定。

绑定示例（具体 ID 从 AstrBot 读取，不能用昵称代替）：

```json
{
  "platform": "aiocqhttp",
  "conversationKey": "qq-main:GroupMessage:123456",
  "senderKey": "234567",
  "characterId": "your-character",
  "pairingId": "public-qq",
  "sessionId": "qq-group-user",
  "audience": "public",
  "publicationEntryIds": [],
  "mode": "smart"
}
```

公开绑定须先通过“公开资料选择 JSON”预览全文，再按“确认身份与资料并保存绑定”。例如选择字段为 `id/revision/scope/entryIds/sourceIds/name/intro/presetId`，其中 scope 指向资料原位置。角色、来源与派生依据必须完整；沿用现有公开发布校验。原资料改动或删除后，旧授权失效，需重新审核。私聊与群聊分别绑定，私聊不会自动获得私人 Wiki。

`mode: "rp"` 的回合候选记录由绑定标记为 fiction；不会通过回复包含某个词来判断虚构域。回合记录进入待审核来源账本，**不自动提交事实 Wiki**。确认来源后可使用现有 Wiki 编纂与审核流程。

同一回合只有 AstrBot 执行。ALLMIND 保存展示镜像；失败不会改走本地生成，重复 turnId 不会再发。旧 QQ 直连与 AstrBot 接入互斥。完整聊天与桌宠气泡使用同一运行入口；气泡在 AstrBot 模式采用独立稳定会话。已有本地会话不可直接改引擎。

集成无痕目前明确拒绝。删除本地镜像不等于删除 AstrBot 或 GPT 网页记录，所以涉及集成历史的完整删除入口会阻止不完整清除；先在远端核对并删除历史。切回本地引擎需重启并新开会话。

## GPT 网页作为文本 Provider

在数据目录放置 `gpt-text.json`（模板见同目录），凭据通过现有凭据库保存；当前主模型必须是网页来源。端点根地址是：

```text
http://127.0.0.1:<ALLMIND端口>/api/memory-book/v1/gpt-text/v1
```

在 AstrBot 添加 OpenAI-compatible 模型 `allmind-gpt-text`。使用独立文本端点 Key，并设置 **streaming=false、request_max_retries=1、关闭该模型的工具调用**。该 Key 不能访问 Wiki 或管理接口。模型列表会声明 text=true，其余能力为 false。

工具、图片、非文本消息、结构化输出、逐 token 流均明确拒绝。网页请求执行失败使用不可重试的业务错误，保留 submit_unknown；连接断开仍不能推断远端没执行，所以 Provider 必须配置只尝试一次。网页登录态始终留在桌面。端点采用完整上下文配隔离网页会话，不复用私人桌面的远端项目。

Preset 通过插件编译完整 contexts，保留原 Role/Depth/顺序和末尾指令；原工具调用 ID 与工具回复不改写。包含工具历史且需要截断时明确报预算错误，先在 AstrBot 压缩或新开会话。当前预设适配只接受文本/工具历史，含图片音频会拒绝，以免丢弃材料。普通多模态 Bot 功能可直接用 AstrBot 原生 Provider；桌面连接器当前仅提交文本。

## 独立模块包

现有 Voice 是 Windows 系统语音服务，不需要 PyTorch 或语音权重。Screen 复用现有 Windows OCR。Tools 复用已有 MCP/ACP 连接、程序哈希与逐任务审核，不增加 Agent Loop。

从完整源码构建后，分别制作模块包：

```powershell
node tools/allmind-modules.mjs pack --id voice --output E:/allmind-voice
node tools/allmind-modules.mjs pack --id screen --output E:/allmind-screen
node tools/allmind-modules.mjs pack --id tools --output E:/allmind-tools
```

打包输出 manifest SHA-256。将模块根目录设为程序外的专用目录，并先退出 ALLMIND：

```powershell
node tools/allmind-modules.mjs install --id voice --source E:/allmind-voice --module-root E:/ALLMIND-modules --expected-manifest <可信发布渠道的SHA-256>
$env:ALLMIND_MODULE_ROOT='E:/ALLMIND-modules'
```

可用 `enable/disable/uninstall --id voice --module-root ...`，均在重启后生效。未指定时，WPF 默认使用用户数据根的 `modules`，与 `book`、`host` 并列。服务端根据 `AIKI_BOOK_DATA` 的父目录定位；也可明确配置 `ALLMIND_MODULE_ROOT`。

加载时检查应用版本、入口、文件清单与哈希；未知或修改后的文件会阻止卸载。升级保留 previous 目录以便人工回退，不自动清理。程序模块删除不删除 Wiki、角色、会话与设置。模块运行于当前用户权限下，文件完整性校验不等于操作系统沙箱。

## ACP / MCP 任务接入

补装 Tools 后，在现有“本机工具”页配置并授权 MCP/ACP 程序。AstrBot 中可注册 `tools/astrbot-task-mcp.mjs` 为 stdio MCP server，唯一参数为绝对路径的私有配置文件：

```json
{
  "origin": "http://127.0.0.1:3927",
  "tokenFile": "<本机能力令牌文件绝对路径>",
  "identity": {
    "platform": "webchat",
    "conversationKey": "<已绑定的 UMO>",
    "senderKey": "<已绑定的发言人 ID>"
  }
}
```

适配器只提供 `prepare_task` 与 `task_status`。它使用操作员固定身份，LLM 不能选择任意身份；公开绑定拒绝本机工具请求。准备的任务在 ALLMIND 工具页核对、确认执行，MCP 侧没有 execute/commit 接口。不同用户分别使用独立配置与实例；不要把主人身份的 MCP 配置共享到公共群机器人。超时/断线与已完成分开记录，不自动重发有副作用任务。

主动发送复用 `/api/v1/im/message`。受管理端点 `POST /integrations/astrbot/send` 只向已绑定 UMO 发送，要求已核对的正文、稳定 requestId 与 confirmed=true；发送与回执未知分开记账，接口成功只代表平台接受。平台支持、QQ 真机与网页会话需要实际账号联调，受控模型测试不证明这些能力。
