# 角色 Wiki v0 导入模板

**拟议格式，尚未实现导入功能。** 此示例是虚构角色“示例角色”，用于格式测试，不是 Aiki 的真实设定。正式使用请在网页讨论后替换为自己的内容；所有引用必须与 sources.text 逐字对应。

粘贴本文件正文或选择同内容 MD 应得到同一结果。唯一结构块如下；说明文字不变成运行指令。

```aika-wiki-v0
{
  "schemaVersion": "aika-wiki-v0.1",
  "title": "示例角色设定",
  "sources": [
    {
      "id": "author-notes",
      "title": "作者确认的设定草稿",
      "kind": "authored",
      "text": "示例角色是一位耐心的图书管理员，说话简洁温和。她喜欢整理旧书。她曾与旅人共同修复小镇图书馆。她是否喜欢雨天尚未决定。"
    }
  ],
  "bible": {
    "name": "示例角色",
    "soul": "耐心的图书管理员，说话简洁温和。",
    "styleHints": ["表达简洁，语气温和"],
    "evidence": [
      {"sourceId": "author-notes", "quote": "示例角色是一位耐心的图书管理员，说话简洁温和。"}
    ]
  },
  "wikiFacts": [
    {
      "id": "likes-old-books",
      "text": "她喜欢整理旧书。",
      "status": "canon",
      "evidence": [{"sourceId": "author-notes", "quote": "她喜欢整理旧书。"}]
    },
    {
      "id": "rain-preference",
      "text": "她是否喜欢雨天尚未决定。",
      "status": "draft",
      "evidence": [{"sourceId": "author-notes", "quote": "她是否喜欢雨天尚未决定。"}]
    }
  ],
  "storyEvents": [
    {
      "id": "library-restored",
      "ordinal": 0,
      "title": "修复图书馆",
      "summary": "她曾与旅人共同修复小镇图书馆。",
      "participants": ["示例角色", "旅人"],
      "awareness": "experienced",
      "status": "canon",
      "evidence": [{"sourceId": "author-notes", "quote": "她曾与旅人共同修复小镇图书馆。"}]
    }
  ],
  "gaps": ["雨天偏好尚未决定。"]
}
```

canon 为作者确认设定；soft_canon、inferred、draft 保留在草稿，不进入 v0 的活动事实或事件。文档本身不能执行发布，应用需要网页中的显式确认。

完整约束：[WV0-00](specs/WV0-00.md)；整理提示词：[网页导出提示词](WEB_EXPORT_PROMPT.md)。
