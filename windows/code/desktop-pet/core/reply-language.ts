import type { ReplyLanguage } from '../contracts/memory-book.js';

/** Runtime-owned output rule; original evidence and saved user messages remain verbatim. */
export function replyLanguageInstruction(language: ReplyLanguage = 'zh-CN'): string {
  switch (language) {
    case 'zh-CN': return '回复语言设置为中文：回答正文必须使用自然的简体中文，包括问候、自称和原作示例台词；专名可以保留。日文「私」自称译为「我」。资料中的完整外语台词、口号及结尾必须译为中文，不得照抄外语整句；只有用户明确要求引用原文时才保留引文。输出前检查每句话的语言。不要因 Persona 或原作语言改为英文或日文回答。';
    case 'ja-JP': return '回复语言设置为日文，所有问候、说明、台词、口号及收尾都必须译为日文，不能照抄英语整句。返信言語は日本語です。回答本文は自然な日本語で書いてください。引用資料中の英語の定型句・スローガン・締めの言葉も必ず日本語に訳してください。固有名詞のみ原表記を使えます。資料やユーザーの使用言語に引きずられて他言語へ切り替えないでください。';
    case 'en': return 'Reply language is English. Write all dialogue, greetings and explanations in natural English, translating foreign example lines and first-person pronouns. Proper names may keep their original spelling. Do not switch languages because of the Persona, evidence or user input.';
    case 'zh-ja-ruby': return '回复语言设置为中文正文＋日文 Ruby 注释：每个中文句子用 <ruby>中文正文<rt>对应日文译文</rt></ruby> 输出，全部正文都放在 ruby 内，标签外只允许空白。正文使用自然简体中文，rt 内使用自然日文，原作外语台词及口号也译为此格式。例：<ruby>你好，我在。<rt>こんにちは、ここにいます。</rt></ruby>。保留角色口吻和事实；不使用 Markdown 代码围栏、嵌套标签或其他 HTML。';
  }
}
