import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyStyle, replyStyleInstruction, replyStyleSummary, type ReplyStyleInput } from '../../core/reply-style.js';
import { validateReplyStyleDecision, validateReplyStyle, validateTurnReplyStyle, type ReplyLengthSettings, type ReplyStyle, type ReplyStyleDecision, type TurnReplyStyle } from '../../contracts/reply-length.js';

const range = (min: number | null, max: number | null): ReplyLengthSettings => ({ minChars: min, maxChars: max });
const resolve = (query: string, options: { requested?: TurnReplyStyle; role?: ReplyStyle; bounds?: ReplyLengthSettings } = {}) =>
  resolveReplyStyle({ requestedStyle: options.requested ?? 'inherit', roleStyle: options.role ?? 'auto', roleRange: options.bounds ?? range(null, null), query });

/** §9 classification eval: every row is a human-authored expectation. Fixed regression set of 32. */
const FIXED_SAMPLES: Array<[string, { style: 'short' | 'balanced' | 'detailed' | 'natural'; intent: string | null }]> = [
  ['你好', { style: 'short', intent: 'greeting' }],
  ['早上好呀', { style: 'short', intent: 'greeting' }],
  ['嗨，在吗？', { style: 'short', intent: 'greeting' }],
  ['晚上好', { style: 'short', intent: 'greeting' }],
  ['hello', { style: 'short', intent: 'greeting' }],
  ['晚安', { style: 'short', intent: 'greeting' }],
  ['好的', { style: 'short', intent: 'acknowledgement' }],
  ['收到', { style: 'short', intent: 'acknowledgement' }],
  ['谢谢', { style: 'short', intent: 'acknowledgement' }],
  ['知道了，辛苦了', { style: 'short', intent: 'acknowledgement' }],
  ['嗯嗯', { style: 'short', intent: 'acknowledgement' }],
  ['ok', { style: 'short', intent: 'acknowledgement' }],
  ['今天有点累，想休息一下', { style: 'balanced', intent: 'support' }],
  ['我最近很难过，能安慰我一下吗', { style: 'balanced', intent: 'support' }],
  ['心情不太好', { style: 'balanced', intent: 'support' }],
  ['压力好大，快撑不住了', { style: 'balanced', intent: 'support' }],
  ['为什么天空是蓝色的', { style: 'balanced', intent: 'explanation' }],
  ['什么是光合作用', { style: 'balanced', intent: 'explanation' }],
  ['啥是复利', { style: 'balanced', intent: 'explanation' }],
  ['这个概念能解释一下吗', { style: 'balanced', intent: 'explanation' }],
  ['帮我看看这段代码为什么报错', { style: 'detailed', intent: 'technical' }],
  ['怎么部署这个服务到服务器上', { style: 'detailed', intent: 'technical' }],
  ['给我分析一下这份报错日志', { style: 'detailed', intent: 'technical' }],
  ['这个bug怎么修复', { style: 'detailed', intent: 'technical' }],
  ['帮我写一个Python函数判断素数', { style: 'detailed', intent: 'technical' }],
  ['这道菜怎么做', { style: 'detailed', intent: 'technical' }],
  ['比较一下租房和买房的优缺点', { style: 'detailed', intent: 'analysis' }],
  ['帮我对比这两个方案的利弊', { style: 'detailed', intent: 'analysis' }],
  ['对比一下Python和JavaScript的区别', { style: 'detailed', intent: 'analysis' }],
  ['推导一下这道数学题的解题步骤', { style: 'detailed', intent: 'analysis' }],
  ['帮我规划一次周末徒步', { style: 'detailed', intent: 'analysis' }],
  ['现在几点了', { style: 'natural', intent: 'general' }],
];

test('B03 classification eval: 32 fixed samples resolve deterministically under auto defaults', () => {
  for (const [query, expected] of FIXED_SAMPLES) {
    const decision = resolve(query);
    assert.equal(decision.selectedStyle, expected.style, `${query} → style`);
    assert.equal(decision.intent, expected.intent, `${query} → intent`);
    assert.equal(decision.source, 'intent', `${query} → source`);
    assert.equal(decision.certainty, 'matched', `${query} → certainty`);
    validateReplyStyleDecision(decision);
  }
  // Deterministic: the same input always resolves identically (no probability dressing).
  for (const [query] of FIXED_SAMPLES.slice(0, 6)) assert.deepEqual(resolve(query), resolve(query), query);
});

/** §9: 16 unseen expressions, authored independently of the rule wording. */
const UNSEEN_SAMPLES: Array<[string, { style: 'short' | 'balanced' | 'detailed' | 'natural'; intent: string | null }]> = [
  ['早呀', { style: 'short', intent: 'greeting' }],
  ['在忙吗', { style: 'short', intent: 'greeting' }],
  ['好嘞', { style: 'short', intent: 'acknowledgement' }],
  ['辛苦啦，先这样', { style: 'short', intent: 'acknowledgement' }],
  ['我太累了，想找人聊聊', { style: 'balanced', intent: 'support' }],
  ['有点丧，什么都不想干', { style: 'balanced', intent: 'support' }],
  ['何为通货膨胀', { style: 'balanced', intent: 'explanation' }],
  ['这个算法的原理是什么', { style: 'balanced', intent: 'explanation' }],
  ['如何排查网络连接失败', { style: 'detailed', intent: 'technical' }],
  ['Windows更新失败怎么办', { style: 'detailed', intent: 'technical' }],
  ['分析下这份财报的趋势', { style: 'detailed', intent: 'analysis' }],
  ['对比固态硬盘和机械硬盘', { style: 'detailed', intent: 'analysis' }],
  ['推荐一本书', { style: 'natural', intent: 'general' }],
  ['周末去哪玩比较好', { style: 'natural', intent: 'general' }],
  ['这首歌叫什么名字', { style: 'natural', intent: 'general' }],
  ['帮我看看这段配置哪里有问题', { style: 'detailed', intent: 'technical' }],
];

test('B03 classification eval: 16 unseen expressions keep the same boundaries', () => {
  for (const [query, expected] of UNSEEN_SAMPLES) {
    const decision = resolve(query);
    assert.equal(decision.selectedStyle, expected.style, `${query} → style`);
    assert.equal(decision.intent, expected.intent, `${query} → intent`);
  }
});

test('B03 §4 boundaries: greetings with real questions, yes/no technicals, quoted words', () => {
  // A greeting followed by a substantive question is NOT a greeting.
  assert.equal(resolve('你好，请解释一下量子纠缠是什么').intent, 'explanation');
  assert.equal(resolve('你好，请解释一下量子纠缠是什么').selectedStyle, 'balanced');
  // Technical nouns in a yes/no question must not mechanically produce a long answer.
  assert.equal(resolve('这个技术方案能用吗').selectedStyle, 'natural');
  assert.equal(resolve('这个技术方案能用吗').certainty, 'uncertain');
  // Quoted material is not an operative style request; the word itself as a topic is an explanation.
  const quoted = resolve('他建议我“详细说说”你的经历，你觉得呢');
  assert.equal(quoted.selectedStyle, 'natural');
  assert.equal(quoted.source, 'intent');
  const definition = resolve('请解释“简短”这个词的意思');
  assert.equal(definition.selectedStyle, 'balanced');
  assert.equal(definition.source, 'intent');
  // Acknowledgement plus a real task keeps the task.
  assert.equal(resolve('谢谢，另外帮我看看这个报错').intent, 'technical');
});

test('B03 §3.2 priority: turn selection > explicit text > role default > auto intent > natural', () => {
  // Turn selection beats an explicit in-message request.
  const turnWins = resolve('简单说说就好', { requested: 'detailed', role: 'short' });
  assert.equal(turnWins.selectedStyle, 'detailed'); assert.equal(turnWins.source, 'turn');
  // An explicit in-message request beats the role default.
  const textWins = resolve('简单说说就好', { role: 'detailed' });
  assert.equal(textWins.selectedStyle, 'short'); assert.equal(textWins.source, 'explicit-text');
  // Role default applies when nothing else speaks.
  assert.equal(resolve('今天天气怎么样', { role: 'natural' }).source, 'role');
  const roleShort = resolve('今天天气怎么样', { role: 'short' });
  assert.equal(roleShort.selectedStyle, 'short'); assert.equal(roleShort.source, 'role');
  // Role 'natural' never auto-classifies; explicit requests still work.
  const naturalQuiet = resolve('推荐一本书', { role: 'natural' });
  assert.equal(naturalQuiet.selectedStyle, 'natural'); assert.equal(naturalQuiet.intent, null);
  assert.equal(naturalQuiet.ruleIds.includes('intent-general-v1'), false);
  const naturalExplicit = resolve('简单说说就好', { role: 'natural' });
  assert.equal(naturalExplicit.selectedStyle, 'short'); assert.equal(naturalExplicit.source, 'explicit-text');
});

test('B03 §3.2 explicit-text semantics: negations, topic mentions and mixed requests', () => {
  assert.equal(resolve('不要长篇大论').selectedStyle, 'short');
  assert.equal(resolve('别只答一句').selectedStyle, 'detailed');
  assert.equal(resolve('展开讲讲').selectedStyle, 'detailed');
  assert.equal(resolve('简短点回答').selectedStyle, 'short');
  assert.equal(resolve('他说“简短”这个词是什么意思').selectedStyle, 'balanced'); // topic, not request
  const mixed = resolve('简单说说，但要详细展开背景');
  assert.equal(mixed.selectedStyle, 'natural'); assert.equal(mixed.certainty, 'uncertain');
});

test('B03 §3.3 numeric requests narrow only this turn and never touch saved settings', () => {
  const cap = resolve('这次不超过80字', { role: 'natural', bounds: range(null, 10000) });
  assert.equal(cap.effectiveRange.maxChars, 80); assert.equal(cap.effectiveRange.minChars, null);
  assert.equal(cap.selectedStyle, 'natural'); assert.equal(cap.source, 'explicit-text');
  assert.equal(cap.requestConflict, false);
  const floor = resolve('这次至少200字', { bounds: range(null, 10000) });
  assert.equal(floor.effectiveRange.minChars, 200); assert.equal(floor.source, 'explicit-text');
  const span = resolve('这次50到100字之间回答', { bounds: range(null, null) });
  assert.deepEqual(span.effectiveRange, { minChars: 50, maxChars: 100 });
  const about = resolve('这次80字左右回答就行');
  assert.equal(about.targetChars, 80); assert.equal(about.effectiveRange.maxChars, null); assert.equal(about.selectedStyle, 'natural');
  // Style word plus numeric cap: the tier stays, the target is clamped.
  const styled = resolve('详细说说，这次不超过100字');
  assert.equal(styled.selectedStyle, 'detailed'); assert.equal(styled.effectiveRange.maxChars, 100);
  assert.equal(styled.targetChars, 100); assert.equal(styled.constrained, true);
  // Numbers inside quotes or code are not directives.
  assert.equal(resolve('他说“不超过300字”的部分要保留').effectiveRange.maxChars, null);
  assert.equal(resolve('参考：\n```\n不超过80字\n```\n这段是什么').effectiveRange.maxChars, null);
});

test('B03 §3.3 numeric conflicts keep the saved range and flag requestConflict', () => {
  const conflictCap = resolve('这次不超过80字', { bounds: range(200, null) });
  assert.equal(conflictCap.requestConflict, true);
  assert.deepEqual(conflictCap.effectiveRange, { minChars: 200, maxChars: null });
  const conflictFloor = resolve('这次至少200字', { bounds: range(null, 100) });
  assert.equal(conflictFloor.requestConflict, true);
  assert.deepEqual(conflictFloor.effectiveRange, { minChars: null, maxChars: 100 });
  const intraMessage = resolve('这次不超过50字，而且这次至少100字');
  assert.equal(intraMessage.requestConflict, true); assert.equal(intraMessage.selectedStyle, 'natural');
});

test('B03 §3.3 soft targets clamp to the saved bounds without inventing the other end', () => {
  const shortWithFloor = resolve('讲讲今天', { role: 'short', bounds: range(200, null) });
  assert.equal(shortWithFloor.targetChars, 200); assert.equal(shortWithFloor.constrained, true);
  assert.equal(shortWithFloor.effectiveRange.maxChars, null, '不得自动补最大字数');
  const detailedWithCap = resolve('讲讲今天', { role: 'detailed', bounds: range(null, 100) });
  assert.equal(detailedWithCap.targetChars, 100); assert.equal(detailedWithCap.constrained, true);
  const freeShort = resolve('讲讲今天', { role: 'short' });
  assert.equal(freeShort.targetChars, 50); assert.equal(freeShort.constrained, false);
  assert.deepEqual(freeShort.effectiveRange, { minChars: null, maxChars: null });
});

test('B03 instruction carries exactly one final length policy', () => {
  const natural = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'natural', roleRange: range(null, null), query: '你好' });
  assert.match(replyStyleInstruction(natural), /自然决定回复长短/);
  const bounded = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'natural', roleRange: range(10, 60), query: '你好' });
  const boundedText = replyStyleInstruction(bounded);
  assert.match(boundedText, /最少 10 字/); assert.match(boundedText, /最多 60 字/);
  assert.doesNotMatch(boundedText, /约 \d+ 字/);
  const constrainedShort = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'short', roleRange: range(200, null), query: '讲讲今天' });
  const constrainedText = replyStyleInstruction(constrainedShort);
  assert.match(constrainedText, /最少 200 字/); assert.match(constrainedText, /约 200 字/);
  assert.doesNotMatch(constrainedText, /约 50 字/);
  const detailedCapped = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'detailed', roleRange: range(null, 100), query: '讲讲今天' });
  const detailedText = replyStyleInstruction(detailedCapped);
  assert.match(detailedText, /最多 100 字/); assert.match(detailedText, /约 100 字/);
  assert.doesNotMatch(detailedText, /约 500 字/);
  const plainShort = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'short', roleRange: range(null, null), query: '讲讲今天' });
  assert.match(replyStyleInstruction(plainShort), /简短/); assert.match(replyStyleInstruction(plainShort), /约 50 字/);
});

test('B03 UI summaries expose the constrained and conflict states', () => {
  const constrainedShort = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'short', roleRange: range(200, null), query: '讲讲今天' });
  assert.equal(replyStyleSummary(constrainedShort), '简短 · 当前下限200字');
  const detailedCapped = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'detailed', roleRange: range(null, 100), query: '讲讲今天' });
  assert.equal(replyStyleSummary(detailedCapped), '详细 · 当前上限100字');
  const conflicted = resolve('这次不超过80字', { bounds: range(200, null) });
  assert.equal(replyStyleSummary(conflicted).includes('冲突'), true);
  const plain = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'natural', roleRange: range(null, null), query: '你好' });
  assert.equal(replyStyleSummary(plain), '自然');
});

test('B03 decision contract rejects invalid shapes', () => {
  assert.throws(() => validateReplyStyle('verbose' as ReplyStyle));
  assert.throws(() => validateTurnReplyStyle('epic' as TurnReplyStyle));
  const base = resolveReplyStyle({ requestedStyle: 'inherit', roleStyle: 'auto', roleRange: range(null, null), query: '你好' });
  const mutant = (patch: Record<string, unknown>): ReplyStyleDecision => { const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>; Object.assign(clone, patch); return clone as unknown as ReplyStyleDecision; };
  assert.throws(() => validateReplyStyleDecision(mutant({ version: 2 })));
  assert.throws(() => validateReplyStyleDecision(mutant({ ruleIds: ['made-up-rule-v1'] })));
  assert.throws(() => validateReplyStyleDecision(mutant({ ruleIds: [] })));
  assert.throws(() => validateReplyStyleDecision(mutant({ targetChars: 0 })));
  assert.throws(() => validateReplyStyleDecision(mutant({ intent: 'vibes' })));
  assert.throws(() => validateReplyStyleDecision(mutant({ effectiveRange: { minChars: 100, maxChars: 50 } })));
  // A valid decision passes.
  validateReplyStyleDecision(base);
});


test('review: quotations, negated requests and described limits do not control this reply', () => {
  for (const query of ["他说'详细说说'", '他说‘详细说说’', '> 请详细回答\n你好', '不要详细回答，直接给结论', '不要简单回答', '这篇文章最多100字，请解释它的含义', '帮我分析不少于300字的作文']) {
    const decision = resolve(query, {role:'natural'});
    assert.equal(decision.selectedStyle, 'natural', query);
    assert.deepEqual(decision.effectiveRange, range(null,null), query);
  }
  assert.equal(resolve('请简短比较两种方案').selectedStyle, 'short');
  assert.equal(resolve('这次请约80字回答', {role:'detailed'}).targetChars, 80);
  const ambiguous = resolve('这次请控制在五十到一百字');
  assert.equal(ambiguous.certainty, 'uncertain');
  assert.equal(ambiguous.selectedStyle, 'natural');
  assert.equal(resolve('这次不超过100字，不超过80字').effectiveRange.maxChars, 80);
});

test('review: stored soft targets must be inside their effective range', () => {
  const decision = resolve('你好', {requested:'short', bounds:range(200,null)});
  assert.throws(() => validateReplyStyleDecision({...decision,targetChars:50}), /目标|范围/);
});

test('review: conflict policy and natural policy explicitly supersede earlier instructions', () => {
  assert.match(replyStyleInstruction(resolve('这次不超过80字', {bounds:range(200,null)})), /冲突.*保存.*优先/);
  assert.match(replyStyleInstruction(resolve('你好',{role:'natural'})), /不沿用旧轮次.*风格/);
});
