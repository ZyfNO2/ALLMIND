# Chat Completion 预设兼容

ALLMIND 提供轻量 Prompt Compiler。设置 → AI 与对话 → 对话预设，导入 JSON、选择当前角色预设并保存。导入原件与编辑副本分开保存在本机 Runtime 配置；不会执行预设扩展或把连接配置覆盖到当前模型。

支持 `prompts`、指定 `prompt_order` block、Enable、system/user/assistant、Relative/In-Chat、Depth、Order、普通回复 Trigger，以及角色/世界书/聊天历史/ALLMIND记忆与材料 Marker。常见文字宏：char、charIfNotGroup、user、description、personality、scenario、persona；纯注释与 trim 标记可解析。嵌套、变量赋值、随机、脚本等宏不执行；启用的未知宏或 Marker 会阻断使用并报告位置。资料值不会被当成宏模板再次求值。

Depth 基于保留后的历史消息与本轮用户输入：0 在当前输入后，1 在当前输入前。多条注入按边界构建；Order 数值升序，同Order的混合Role按锁定的官方源码最终序列 assistant/user/system 排列。更深位置在最早保留消息前钳制。复杂酒馆预设与不同版本未承诺完全兼容。

模型窗口由当前绑定和预设限额共同限制，输出预留优先使用预设值。运行时协议、核心角色、当前输入和固定预设不能静默截断；超预算时先移除最旧完整历史，再移除可选召回。选定材料无法容纳时拒绝发送。预算为保守UTF-8估算，非供应商精确token计数。未选择预设时使用内置聊天表达规则（见下文）。

槽位数据以当前运行实例实际接线为准：核心角色描述与人格、世界书、召回、记忆、材料与真实 history 已接入。`scenario`、`personaDescription`、`dialogueExamples`、`DesktopContext` 等槽位语法可以解析，但对应数据源尚未全部接线；没有数据时该片段为空，判断依据是 Inspector 的 items/omissions/warnings，本文件不承诺空槽一定有独立诊断文案（属待补项）。不得把角色人格写进用户画像，也不得为填补空槽编造数据。

HTTP采用现有OpenAI-compatible接口，映射 temperature、top_p、frequency_penalty、presence_penalty及输出预留；不支持的其他字段保留但不发送。若服务不接受已映射参数，会如实报错，不删参数或换模型重试；可在JSON副本中调整。未提供Claude原生、完整Text Completion、扩展执行或群聊兼容。

ChatGPT网页按最终消息顺序进行带Role标签的文本投递，不等同API的消息优先级，也不能控制API采样参数。使用预设的网页回复发送前要求High；Wiki编纂另用完整结构化协议与任务包，不继承RP预设。普通连接测试也不运行RP模板。

“预览最终Prompt”使用已保存配置与正式召回链，不提交主模型回复；Fast规划开启时可能调用Fast模型。Inspector分别标识装配与完成回执、片段位置、估算预算、生效参数和省略原因。聊天记录保存预设版本与摘要，不将整份含记忆的Prompt另行永久存储；重启后可继续聊天，但旧的易失上下文详情可能过期。无痕上下文不持久化。

示例：`fixtures/prompt-presets/nano-bear-roleplay.json` 是 Nano Bear 原始预设，固定提交 `5a625088f34df130f4b02b6f2b3e649bfa46b1ae`，SHA-256 `d7a7dfcbc8349d6813171b1a1edbab40cc229e37550be90426ddd7cbfdd78c7f`。导入时会在编辑副本中显式附加ALLMIND记忆/材料槽，原始正文与原件不改写。示例不自动绑定到空白角色，不代表人物资料或用户记忆。来源及CC BY 4.0许可见同目录 `NANO-BEAR-LICENSE.txt` 和根目录来源声明。

验证入口：`tests/memory-book/prompt-presets.test.ts` 与 `prompt-presets.browser.test.mjs`。fixture、当前候选live和历史验证分别报告；本文不以功能说明代替真实服务通过证明。

2026-10-19 真实网页记录（限定范围）：两轮 SavedTurn 均带 `presetId`、预设版本与 documentHash，说明预设确实参与真实投递；High 思考强度在每次发送前读取并回读核实。已知缺陷：首轮角色化介绍出现“你我这两个真人”的错误措辞，第二轮追问后模型自行说明自己不是人类，首次缺陷保留不删；后续真实问答与边界复测见 release-status 的历史记录；长历史仍未通过。当前修复改为调用前提交意图与有界拒绝策略，并补测硬退出/写盘失败/容量上限，未在本轮重复真实模型问答。真实 API（非网页）路径本轮返回 HTTP 403，记 DEFERRED。

# 默认聊天表达（2026-10-19）

未选择自定义预设时，默认融合用户提供的 Tavo「微信真实聊天风格预设 4.0」：直接说话、短句与自然分段、保留角色差异；普通聊天避免动作旁白、报告结构、粗体和反复解释证据规则。不强制 8–20 字、不制造错别字或统一萌系口癖。用户明确要求的详细说明、故事与格式仍优先，事实及记忆边界不变。选择自定义酒馆预设后由其正文控制文风，不叠加默认聊天风格。结构化 Wiki 编纂与记忆维护不使用这段聊天提示词。已有会话的旧回复不会改写；后端重新加载构建产物后，从下一轮起生效。
