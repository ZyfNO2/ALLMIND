import {validateReplyLength, validateReplyStyle, validateTurnReplyStyle, validateReplyStyleDecision, REPLY_STYLE_TARGETS, type ReplyLengthSettings, type ReplyStyle, type ReplyStyleDecision, type TurnReplyStyle} from '../contracts/reply-length.js';

export interface ReplyStyleInput {
  requestedStyle: TurnReplyStyle;
  roleStyle: ReplyStyle;
  roleRange: ReplyLengthSettings;
  query: string;
}

/**
 * B03 §3.2/§3.3: one pure, deterministic resolver. Inputs are the frozen per-turn options plus
 * the raw user query; it never sees retrieved material, other sessions or private Book content.
 * Quoted spans, code and links are stripped before any keyword work, so cited material that
 * says "详细说说" or "不超过300字" is never treated as this turn's instruction.
 */
function operativeText(query: string): string {
  return query
    .replace(/^ {0,3}>.*$/gmu, ' ')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/gu, ' ')
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/gu, ' ')
    .replace(/[「『“‘"']([^「」『』“”‘’"'\n]*)[」』”’"']/gu, ' ');
}

const NUMBER = '(\\d{1,5})\\s*个?\\s*字';
interface NumericDirectives { floor: number|null; cap: number|null; target: number|null; uncertain: boolean }
function parseNumericDirectives(text: string): NumericDirectives {
  const result: NumericDirectives = { floor: null, cap: null, target: null, uncertain: false };
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 20000;
  // Restrict parsing to a direct answer instruction, not an article/assignment being described.
  const prefix = /^(?:(?:而且|并且|并|且)\s*)?(?:(?:这次|本次|本轮|你的回答|你的回复|回答|回复|答复)\s*)?(?:请\s*)?(?:(?:回答|回复|答复|控制在|控制为)\s*)?/u;
  for (const clause of text.split(/[，,。；;！!？?\n]/u)) {
    const rest = clause.trim().replace(prefix, '');
    const patterns: Array<[RegExp, 'cap'|'floor'|'target'|'span']> = [
      [new RegExp(`^(?:不超过|最多|别超过|不要超过|不许多过)\\s*${NUMBER}`, 'u'), 'cap'],
      [new RegExp(`^${NUMBER}\\s*(?:以内|之内)`, 'u'), 'cap'],
      [new RegExp(`^(?:至少|不少于|别少于|不要少于|起码)\\s*${NUMBER}`, 'u'), 'floor'],
      [new RegExp(`^${NUMBER}\\s*(?:以上|起步)`, 'u'), 'floor'],
      [new RegExp(`^(?:大约|大概|约)\\s*${NUMBER}`, 'u'), 'target'],
      [new RegExp(`^${NUMBER}\\s*(?:左右|上下)`, 'u'), 'target'],
      [/^(\d{1,5})\s*个?\s*字?\s*(?:到|至|~|—|–|-)\s*(\d{1,5})\s*个?\s*字/u, 'span'],
    ];
    let matched = false;
    for (const [pattern, kind] of patterns) {
      const match = rest.match(pattern);
      if (!match) continue;
      // A following noun (e.g. “的作文”) makes this a subject limit, not this answer's limit.
      if (!/^(?:\s*(?:之间)?\s*(?:(?:回答|回复|答复|解释|说明|总结|介绍|写|说|讲|就行|即可|就好).*)?)$/u.test(rest.slice(match[0].length))) continue;
      matched = true;
      if (!valid(Number(match[1])) || kind==='span' && !valid(Number(match[2]))) { result.uncertain=true; break; }
      if (kind==='span') { result.floor=Number(match[1]);result.cap=Number(match[2]); }
      else result[kind] = Number(match[1]);
      break;
    }
    if (!matched && /^(?:这次|本次|本轮|你的回答|你的回复|回答|回复|请)/u.test(clause.trim()) && /(?:字|字数)/u.test(rest) && /(?:控制|不超过|最多|至少|不少于|大约|左右|以内)/u.test(clause)) result.uncertain=true;
  }
  // Do not manufacture a partial constraint for an expression we cannot parse reliably.
  if (result.uncertain) result.floor=result.cap=result.target=null;
  return result;
}

type ExplicitStyle = { style: 'short'|'balanced'|'detailed'|null; mixed: boolean };
function detectExplicitStyle(text: string): ExplicitStyle {
  text = text.replace(/(?:不要|不用|别|无需|不必)\s*(?:详细|简单|简短|简要|展开|深入)(?:地|一点|些)?(?:回答|回复|说说|说|讲讲|讲|解释|介绍|说明)?/gu, ' ');
  const short = [
    /(?:请|^)(?:简短|简要|简单|精简|简洁)(?:地)?(?:比较|对比|分析|解释|介绍)/u,
    /(?:回答|回复|说|讲|介绍|总结)(?:得)?(?:更)?(?:简短|简短些|简短点|简短一点|简要|简单|简单点|简单些|简洁|精简|扼要)/u,
    /^(?:简短|简要|简单|精简|简洁)(?:点|一点|些)(?:说|说说|回答|回复|讲|来讲|来说)?/u,
    /(?:简短|简要|简单|精简|简洁|扼要)(?:地|一点|一点地|些)?(?:说|说说|讲|讲讲|回答|回复|总结)/u,
    /(?:不要|别|不用)(?:长篇大论|写太长|说太长|太长篇|长篇)/u,
  ];
  const detailed = [
    /(?:请)?(?:详细|展开|深入)(?:地|一点|一点地|些|一些)?(?:说|说说|讲|讲讲|解释|介绍|回答|谈谈|说明|展开)/u,
    /^(?:详细|展开|深入)(?:一点|一点地|些)?/u,
    /(?:多)(?:说|讲|介绍)(?:一点|一些|些)/u,
    /(?:不要|别)(?:只|就)(?:回答|答|说|讲|回复)(?:一句|一两句)/u,
    /(?:长一点|长一些|写长一点|再说详细点)/u,
  ];
  const hasShort = short.some(pattern => pattern.test(text));
  const hasDetailed = detailed.some(pattern => pattern.test(text));
  if (hasShort && hasDetailed) return { style: null, mixed: true };
  if (hasShort) return { style: 'short', mixed: false };
  if (hasDetailed) return { style: 'detailed', mixed: false };
  return { style: null, mixed: false };
}

const GREETING_TOKENS = new Set(['你好','你好呀','您好','嗨','哈喽','hello','hi','hey','早','早呀','早安','早上好','早上好呀','下午好','晚上好','晚安','在吗','在忙吗','在么']);
const ACK_TOKENS = new Set(['好','好的','好嘞','好哒','嗯','嗯嗯','嗯嗯嗯','收到','知道了','知道啦','明白','明白啦','ok','okay','行','辛苦了','辛苦啦','谢谢','多谢','感谢','感恩','先这样','就这样']);
function wholeMessage(text: string, tokens: Set<string>): boolean {
  const segments = text.split(/[，,、;；。.!！?？~～\s]+/u).map(part => part.toLowerCase().replace(/[呢吧啊呀哦嘛哟]+$/u, '')).filter(Boolean);
  return segments.length > 0 && segments.every(segment => tokens.has(segment) || tokens.has(segment.replace(/[呢吧啊呀哦嘛哟]/gu, '')));
}
const SUPPORT = /有点累|太累了|好累|很累|累死了|疲惫|难过|伤心|不开心|不高兴|心情不好|心情不太好|心情差|心情很差|心情糟糕|有点丧|很丧|想哭|压力大|压力好大|撑不住|安慰我|陪我聊聊|想找人聊聊|抱抱我|抱抱我一下/u;
const TECHNICAL = /调试|报错|报了错|bug|修复|修一下|怎么解决|如何解决|怎么办|怎么处理|排查|部署|搭建|搭一个|配置|代码|函数|日志|编译|更新失败|连接失败|启动不了|启动失败|怎么做|如何做|怎么弄|实现|环境变量|依赖安装/u;
const ANALYSIS = /比较一下|比较下|帮我比较|对比一下|对比|区别|优缺点|利弊|权衡|推导|分析一下|分析下|帮我分析|规划一次|规划一下|给我一个(?:详细)?(?:计划|方案)|哪个更(?:适合|好|合适)|推荐哪个/u;
const EXPLANATION = /为什么|为何|何为|是什么|什么是|啥是|啥意思|是什么意思|怎么理解|解释一下|解释下|讲讲原理|原理是什么|的含义|的意思|指的是什么/u;
const YES_NO = /(?:吗|么)\s*[?？。!！]?\s*$/u;
function classifyIntent(text: string): { intent: ReplyStyleDecision['intent']; certainty: 'matched'|'uncertain' } {
  if (wholeMessage(text, GREETING_TOKENS)) return { intent: 'greeting', certainty: 'matched' };
  if (wholeMessage(text, ACK_TOKENS)) return { intent: 'acknowledgement', certainty: 'matched' };
  if (SUPPORT.test(text)) return { intent: 'support', certainty: 'matched' };
  // A yes/no question carrying task-ish nouns is not a mechanical long-answer request.
  if (YES_NO.test(text.trim()) && (TECHNICAL.test(text) || ANALYSIS.test(text) || /方案|计划/u.test(text))) return { intent: 'general', certainty: 'uncertain' };
  if (TECHNICAL.test(text)) return { intent: 'technical', certainty: 'matched' };
  if (ANALYSIS.test(text)) return { intent: 'analysis', certainty: 'matched' };
  if (EXPLANATION.test(text)) return { intent: 'explanation', certainty: 'matched' };
  return { intent: 'general', certainty: 'matched' };
}
const INTENT_STYLE: Record<string, 'short'|'balanced'|'detailed'|'natural'> = { greeting: 'short', acknowledgement: 'short', support: 'balanced', explanation: 'balanced', technical: 'detailed', analysis: 'detailed', general: 'natural', unknown: 'natural' };

const STYLE_LABEL: Record<'short'|'balanced'|'detailed', string> = { short: '简短', balanced: '适中', detailed: '详细' };
const STYLE_EXPRESSION: Record<'short'|'balanced'|'detailed', string> = {
  short: '直接回答，省去重复引言，不漏必要条件',
  balanced: '先给结论，再补必要理由或步骤',
  detailed: '结构化展开，按问题需要给例子，不机械扩写',
};

export function resolveReplyStyle(input: ReplyStyleInput): ReplyStyleDecision {
  validateTurnReplyStyle(input.requestedStyle); validateReplyStyle(input.roleStyle); validateReplyLength(input.roleRange);
  const operative = operativeText(input.query ?? '');
  const numeric = parseNumericDirectives(operative);
  const explicit = detectExplicitStyle(operative);

  // Hard bounds: the saved range always governs; a numeric request may narrow only this turn.
  let effectiveRange: ReplyLengthSettings = { ...input.roleRange };
  let requestConflict = false;
  const numericRuleIds: string[] = [];
  if (numeric.floor !== null || numeric.cap !== null) {
    const lo = Math.max(input.roleRange.minChars ?? -Infinity, numeric.floor ?? -Infinity);
    const hi = Math.min(input.roleRange.maxChars ?? Infinity, numeric.cap ?? Infinity);
    if (lo > hi) { requestConflict = true; numericRuleIds.push('explicit-numeric-conflict-v1'); }
    else { effectiveRange = { minChars: lo === -Infinity ? null : lo, maxChars: hi === Infinity ? null : hi }; numericRuleIds.push('explicit-numeric-v1'); }
  } else if (numeric.target !== null) numericRuleIds.push('explicit-numeric-v1');

  // Style tier: turn selection > explicit text > role default > auto intent.
  let selectedStyle: ReplyStyleDecision['selectedStyle'];
  let source: ReplyStyleDecision['source'];
  let intent: ReplyStyleDecision['intent'] = null;
  let certainty: 'matched'|'uncertain' = 'matched';
  const ruleIds: string[] = [];
  if (input.requestedStyle !== 'inherit') {
    selectedStyle = input.requestedStyle; source = 'turn'; ruleIds.push('turn-selection-v1');
  } else if (explicit.style) {
    selectedStyle = explicit.style; source = 'explicit-text'; certainty = 'matched';
    ruleIds.push(explicit.style === 'short' ? 'explicit-style-short-v1' : 'explicit-style-detailed-v1');
  } else if (explicit.mixed) {
    selectedStyle = 'natural'; source = 'explicit-text'; certainty = 'uncertain';
    ruleIds.push('explicit-style-short-v1', 'explicit-style-detailed-v1');
  } else if (numeric.uncertain) {
    selectedStyle='natural';source='natural';certainty='uncertain';ruleIds.push('natural-fallback-v1');
  } else if (input.roleStyle === 'auto') {
    const classified = classifyIntent(operative);
    intent = classified.intent; certainty = classified.certainty;
    selectedStyle = INTENT_STYLE[classified.intent ?? 'general'] ?? 'natural'; source = 'intent';
    ruleIds.push(`intent-${classified.intent ?? 'general'}-v1`);
  } else {
    selectedStyle = input.roleStyle; source = 'role'; ruleIds.push('role-default-v1');
  }
  if ((numeric.floor !== null || numeric.cap !== null || numeric.target !== null) && source !== 'turn') {
    // A numeric directive is an explicit-text contribution that shaped this turn's bounds; it
    // outranks role/intert channels when describing what decided the turn. The intent field
    // (when classified) is still recorded for explanation.
    source = 'explicit-text';
  }
  ruleIds.push(...numericRuleIds.filter(id => !ruleIds.includes(id)));

  // Soft target: the tier's goal or an explicit "约N字", clamped into the effective bounds.
  let targetChars: number|null = selectedStyle === 'short' || selectedStyle === 'balanced' || selectedStyle === 'detailed' ? REPLY_STYLE_TARGETS[selectedStyle] : null;
  if (numeric.target !== null && input.requestedStyle === 'inherit') targetChars = numeric.target;
  let constrained = false;
  if (targetChars !== null) {
    const clamped = Math.min(Math.max(targetChars, effectiveRange.minChars ?? 1), effectiveRange.maxChars ?? 20000);
    constrained = clamped !== targetChars;
    targetChars = clamped;
  }

  const decision: ReplyStyleDecision = { version: 1, requestedStyle: input.requestedStyle, selectedStyle, source, intent, certainty, ruleIds: ruleIds.slice(0, 8), targetChars, effectiveRange, constrained, requestConflict };
  validateReplyStyleDecision(decision);
  return decision;
}

function boundsText(range: ReplyLengthSettings): string {
  return [range.minChars === null ? '' : `最少 ${range.minChars} 字`, range.maxChars === null ? '' : `最多 ${range.maxChars} 字`].filter(Boolean).join('，');
}

/** One final length policy per turn: hard bounds plus the clamped soft target, never both contradictory. */
export function replyStyleInstruction(decision: ReplyStyleDecision): string {
  validateReplyLength(decision.effectiveRange);
  const hasBounds = decision.effectiveRange.minChars !== null || decision.effectiveRange.maxChars !== null;
  const conflict = decision.requestConflict ? ' 本轮数值要求存在冲突，保存的字数范围优先；不要尝试同时满足冲突要求。' : '';
  const reset = ' 本轮风格替代旧轮次风格，不沿用旧轮次的风格要求。';
  const base = (hasBounds
    ? `【当前回复字数】本轮普通回复正文${boundsText(decision.effectiveRange)}。按 Unicode 字素计数，中英文字母、数字与标点均计入，空白、Markdown 格式标记、隐藏引用与推理过程不计。请在完整表达且不编造事实的前提下遵守，不机械重复凑字，不输出字数统计或本条规则。此设置替代旧轮次的长度偏好。`
    : '【当前回复长度】本轮按问题自然决定回复长短，不沿用旧轮次的风格和最小或最大字数偏好。') + reset + conflict;
  if (decision.selectedStyle === 'natural') {
    return decision.targetChars === null ? base : `${base} 本轮目标约 ${decision.targetChars} 字（软性目标，按问题需要伸缩，不机械凑字）。`;
  }
  const expression = STYLE_EXPRESSION[decision.selectedStyle];
  const goal = decision.targetChars === null ? '不设固定字数目标' : `目标约 ${decision.targetChars} 字（软性目标，${hasBounds ? '在上述边界内' : ''}按问题需要伸缩，不机械凑字）`;
  return `${base} 本轮回复风格：${STYLE_LABEL[decision.selectedStyle]}，${expression}，${goal}。`;
}

/** Compact UI label: the chosen tier plus the operative bound when the soft goal was constrained. */
export function replyStyleSummary(decision: ReplyStyleDecision): string {
  const tier = decision.selectedStyle === 'natural' ? '自然' : STYLE_LABEL[decision.selectedStyle];
  if (decision.requestConflict) return `${tier} · 数值要求与字数边界冲突，已按保存范围执行`;
  if (decision.constrained) {
    if (decision.effectiveRange.minChars !== null && decision.targetChars === decision.effectiveRange.minChars) return `${tier} · 当前下限${decision.effectiveRange.minChars}字`;
    if (decision.effectiveRange.maxChars !== null && decision.targetChars === decision.effectiveRange.maxChars) return `${tier} · 当前上限${decision.effectiveRange.maxChars}字`;
  }
  return tier;
}
