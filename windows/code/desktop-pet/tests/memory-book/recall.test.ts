import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { LocalBookIndex, bookTokenCost, chunkEntry } from '../../memory/local-book-index.js';
import { BookRecallEngine, BookContextBuilder } from '../../memory/book-recall.js';
import { DEFAULT_RECALL_CONFIG, emptyEntry, type BookScope } from '../../contracts/memory-book.js';
const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'test-session' };
function fixture(t: test.TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'recall-')); const repository = new FileBookRepository(directory);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const persona = emptyEntry('persona-core', 'persona', '人格', '我温和、诚实，不编造共同经历。');
  const alice = { ...emptyEntry('alice', 'wiki', 'Alice', 'Alice 是我们的研究搭档，负责结构检测。'), aliases: ['学姐'], entities: ['Alice'], related: ['first-meet'] };
  const story = { ...emptyEntry('first-meet', 'story', '第一次见面', '我们第一次见面是在测试机库，Alice 向我介绍了用户。'), entities: ['Alice'], timeStart: '2026-10-01', tags: ['初次见面'] };
  const unrelated = { ...emptyEntry('unrelated', 'wiki', '海洋学', '鲸鱼是哺乳动物。'), trigger: { ...alice.trigger, priority: 100 } };
  repository.commit(scope, { upsert: [persona, alice, story, unrelated] }, 0, 'seed');
  const engine = new BookRecallEngine(repository, new LocalBookIndex());
  const builder = new BookContextBuilder(repository);
  const run = (query: string, session = scope) => engine.run({ scope: session, currentMessage: query, recentMessages: [], config: structuredClone(DEFAULT_RECALL_CONFIG), signal: new AbortController().signal });
  return { repository, engine, builder, run };
}
test('local queries read relevant Wiki/Episode bodies, keep Persona, and exclude unrelated high priority entries', async t => {
  const f = fixture(t), result = await f.run('还记得我们第一次见面吗？');
  assert.ok(result.selected.some(item => item.entry.id === 'first-meet' && item.text.includes('测试机库')));
  assert.ok(result.base.some(item => item.entry.type === 'persona'));
  assert.ok(!result.selected.some(item => item.entry.id === 'unrelated'));
  const alias = await f.run('学姐负责什么？');
  assert.ok(alias.selected.some(item => item.entry.id === 'alice'));
  assert.ok(alias.selected.some(item => item.entry.id === 'first-meet' && item.candidate.matchReasons.some(reason => reason.startsWith('related:'))));
  const context = f.builder.build('还记得我们第一次见面吗？', [], result, 4096);
  assert.ok(context.messages.some(message => message.content.includes('测试机库')));
  assert.ok(context.messages.some(message => message.content.includes('不编造共同经历')));
});
test('default dialogue includes conversational style with intact evidence and current input', async t => {
  const f = fixture(t), query = '今天有点累', result = await f.run(query);
  const context = f.builder.build(query, [], result, 4096);
  const system = context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.ok(system.includes('【默认聊天表达】'));
  assert.ok(system.includes('默认只输出角色说出的台词'));
  assert.ok(system.includes('用户明确要求的长度和格式优先'));
  assert.ok(system.includes('不能把导入的故事或模拟记录说成真实共同经历'));
  assert.equal(context.messages.filter(message => message.role === 'user' && message.content === query).length, 1);
  assert.ok(context.usedTokens <= 4096);
});

test('zero match is honest; dry runs do not advance active memory; sessions and edits invalidate references', async t => {
  const f = fixture(t);
  const blank = await f.run('量子纠缠的贝尔不等式'); assert.equal(blank.selected.length, 0);
  const hit = await f.run('Alice');
  assert.equal((await f.run('他后来呢？')).selected.length, 0, 'dry-run must not change active entities');
  f.engine.advance(hit);
  assert.ok((await f.run('他后来呢？')).selected.some(item => item.entry.id === 'alice'));
  assert.equal((await f.run('他后来呢？', { ...scope, sessionId: 'other-session' })).selected.length, 0);
  const book = f.repository.snapshot(scope), alice = book.entries.find(entry => entry.id === 'alice')!;
  f.repository.commit(scope, { upsert: [{ ...alice, enabled: false }] }, book.revision, 'disable');
  assert.throws(() => f.builder.assertCurrent(hit), { code: 'conflict' });
  assert.ok(!(await f.run('他后来呢？')).selected.some(item => item.entry.id === 'alice'));
});
test('budget and cancellation are explicit; Persona is never silently discarded', async t => {
  const f = fixture(t), result = await f.run('Alice');
  assert.throws(() => f.builder.build('Alice', [], result, 2), { code: 'budget' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.engine.run({ scope, currentMessage: 'Alice', recentMessages: [], config: structuredClone(DEFAULT_RECALL_CONFIG), signal: controller.signal }), { name: 'AbortError' });
});

test('active-only consumption expires without extending sticky; NO_RETRIEVAL retains valid active references', async t => {
  const f = fixture(t), hit = await f.run('Alice'); f.engine.advance(hit);
  const one = await f.run('你好'); assert.ok(one.base.some(item => item.entry.id === 'alice' && item.candidate.routes.includes('active')));
  f.engine.advance(one);
  const two = await f.run('你好'); assert.ok(two.base.some(item => item.entry.id === 'alice' && item.candidate.routes.includes('active')));
  f.engine.advance(two);
  const expired = await f.run('你好');
  assert.ok(!expired.base.some(item => item.candidate.routes.includes('active')), 'active-only references must expire after two turns');
  assert.equal(expired.selected.length, 0);
  f.engine.advance(await f.run('Alice'));
  const planner = { async plan() { return { action: 'NO_RETRIEVAL' as const, intent: ['chat'], queries: [], entities: [], sources: [], timeRange: { from: null, to: null } }; }, async rerank() { return []; } };
  // Prime the planner-backed engine through its normal successful-turn path.
  const engine = new BookRecallEngine(f.repository, new LocalBookIndex(), planner);
  const run = (query: string, mode: 'off' | 'deep') => engine.run({ scope, currentMessage: query, recentMessages: [], config: { ...structuredClone(DEFAULT_RECALL_CONFIG), mode }, signal: new AbortController().signal });
  engine.advance(await run('Alice', 'off'));
  const no = await run('今天天气不错', 'deep');
  assert.equal(no.enhancement, 'no-retrieval'); assert.ok(no.base.some(item => item.entry.id === 'alice'));
  assert.equal(no.selected.length, 0);
});

test('explicit episode dates narrow retrieval and first encounter selects the earliest relevant episode', async t => {
  const f = fixture(t), snapshot = f.repository.snapshot(scope);
  f.repository.commit(scope, { upsert: [
    { ...emptyEntry('late-meet', 'story', '第一次见面补记', '第一次见面。后来我补充了这一份记录。'), timeStart: '2026-10-05' },
    { ...emptyEntry('early-unrelated', 'story', '旧故事', '一次完全无关的故事。'), timeStart: '2020-01-01' },
  ] }, snapshot.revision, 'date-seed');
  const dated = await f.run('2026-10-05 第一次见面');
  assert.ok(dated.selected.some(item => item.entry.id === 'late-meet'));
  assert.ok(!dated.selected.some(item => item.entry.id === 'first-meet'));
  const first = await f.run('还记得首次见面吗');
  assert.equal(first.selected.filter(item => item.entry.type === 'story')[0]?.entry.id, 'first-meet');
  assert.ok(!first.selected.some(item => item.entry.id === 'early-unrelated'));
});

test('Context removes overlapping/duplicate text and crops only at paragraph boundaries', async t => {
  const f = fixture(t), before = f.repository.snapshot(scope);
  const body = 'A'.repeat(550) + 'OVERLAP-MARKER' + 'B'.repeat(500);
  f.repository.commit(scope, { upsert: [emptyEntry('long', 'wiki', 'LongAlice', body)] }, before.revision, 'long');
  const result = await f.run('LongAlice'), context = f.builder.build('LongAlice', [], result, 4096);
  assert.equal(context.messages.map(message => message.content).join('\n').split('OVERLAP-MARKER').length - 1, 1);
  const snapshot = f.repository.snapshot(scope), paragraphBody = 'Alice 第一段资料。\n\n' + '第二段很长。'.repeat(20) + '\n\n最后一段。';
  f.repository.commit(scope, { upsert: [emptyEntry('paragraphs', 'wiki', 'ParagraphTarget', paragraphBody), emptyEntry('duplicate', 'wiki', 'ParagraphTarget copy', paragraphBody)] }, snapshot.revision, 'paragraphs');
  const all = await f.run('ParagraphTarget'), full = f.builder.build('ParagraphTarget', [], all, 8192);
  assert.ok(full.omissions.some(item => item.reason === 'duplicate_content'));
  const core = f.builder.build('ParagraphTarget', [], { ...all, selected: [] }, 8192);
  const small = f.builder.build('ParagraphTarget', [], all, core.usedTokens + 180);
  assert.ok(small.omissions.some(item => item.reason === 'paragraph_crop'));
  assert.ok(small.messages.some(message => message.content.includes('第一段资料。')));
  assert.ok(!small.messages.some(message => message.content.includes('第二段很长。')));
  assert.ok(small.usedTokens <= core.usedTokens + 180);
});

test('expired sticky references honor cooldown before permitting a fresh trigger', async t => {
  const f = fixture(t), book = f.repository.snapshot(scope), alice = book.entries.find(entry => entry.id === 'alice')!;
  f.repository.commit(scope, { upsert: [{ ...alice, related: [], trigger: { ...alice.trigger, stickyTurns: 1, cooldownTurns: 2 } }] }, book.revision, 'cooldown-config');
  f.engine.advance(await f.run('Alice'));
  const sticky = await f.run('你好'); assert.ok(sticky.base.some(item => item.entry.id === 'alice' && item.candidate.routes.includes('active'))); f.engine.advance(sticky);
  for (let i = 0; i < 2; i++) {
    const cooling = await f.run('Alice'); assert.ok(cooling.rejected.some(item => item.ref.entryId === 'alice' && item.reason === 'cooldown'));
    assert.ok(!cooling.selected.some(item => item.entry.id === 'alice')); f.engine.advance(cooling);
  }
  assert.ok((await f.run('Alice')).selected.some(item => item.entry.id === 'alice'));
});

test('local follow-up resolves a unique alias from bounded recent history and asks when ambiguous', async t => {
  const f = fixture(t), book = f.repository.snapshot(scope);
  f.repository.commit(scope, { upsert: [emptyEntry('bob', 'wiki', 'Bob', 'Bob 负责机器人控制。')] }, book.revision, 'bob');
  const run = (recentMessages: { role: 'user'; content: string }[]) => f.engine.run({ scope, currentMessage: '她后来呢？', recentMessages, config: structuredClone(DEFAULT_RECALL_CONFIG), signal: new AbortController().signal });
  const unique = await run([{ role: 'user', content: '学姐负责什么？' }]);
  assert.deepEqual(unique.entities, ['Alice']);
  assert.ok(unique.selected.some(item => item.entry.id === 'alice'));
  const ambiguous = await run([{ role: 'user', content: 'Alice 和 Bob 的分工是什么？' }]);
  assert.ok(ambiguous.plan.intent.includes('ambiguous-followup'));
  assert.deepEqual(ambiguous.entities, []);
  assert.ok(f.builder.build('她后来呢？', [], ambiguous, 4096).messages.some(message => message.role === 'system' && message.content.includes('先询问')));
  const outOfWindow = await run([{ role: 'user', content: 'Alice' }, ...Array.from({ length: 6 }, () => ({ role: 'user' as const, content: '你好' }))]);
  assert.equal(outOfWindow.selected.length, 0);
});

test('NO_RETRIEVAL does not expand new related bodies from an active parent', async t => {
  const f = fixture(t);
  const planner = { async plan() { return { action: 'NO_RETRIEVAL' as const, intent: ['chat'], queries: [], entities: [], sources: [], timeRange: { from: null, to: null } }; }, async rerank() { return []; } };
  const engine = new BookRecallEngine(f.repository, new LocalBookIndex(), planner);
  const run = (query: string, mode: 'off' | 'deep') => engine.run({ scope, currentMessage: query, recentMessages: [], config: { ...structuredClone(DEFAULT_RECALL_CONFIG), mode }, signal: new AbortController().signal });
  const initial = await run('Alice', 'off'), parent = initial.selected.find(item => item.entry.id === 'alice')!;
  engine.advance(initial, [parent.candidate.ref]);
  const no = await run('今天天气不错', 'deep');
  assert.ok(no.base.some(item => item.entry.id === 'alice' && item.candidate.routes.includes('active')));
  assert.ok(!no.base.some(item => item.entry.id === 'first-meet'));
  assert.equal(no.selected.length, 0); assert.equal(no.candidates.length, 0);
});

test('active context has its own base budget and is not displaced by new search candidates', async t => {
  const f = fixture(t), book = f.repository.snapshot(scope);
  f.repository.commit(scope, { upsert: Array.from({ length: 12 }, (_, i) => ({ ...emptyEntry('dense-' + i, 'wiki', 'Dense ' + i, 'Dense 资料。'), aliases: ['Dense'] })) }, book.revision, 'dense');
  const hit = await f.run('Alice'); f.engine.advance(hit);
  const result = await f.run('Dense');
  assert.equal(result.selected.length, DEFAULT_RECALL_CONFIG.limits.selected);
  assert.ok(result.base.some(item => item.entry.id === 'alice' && item.candidate.routes.includes('active')));
  assert.ok(f.builder.build('Dense', [], result, 8192).messages.some(message => message.content.includes('负责结构检测')));
});

test('budget estimates bound UTF-8 bytes and Unicode chunks retain exact positions with bounded overlap', () => {
  assert.ok(bookTokenCost('🙂罕见字') >= Buffer.byteLength('🙂罕见字', 'utf8') + 8);
  const entry = emptyEntry('unicode', 'wiki', 'Unicode', ('结构检测🙂'.repeat(130)));
  const chunks = chunkEntry(entry);
  assert.ok(chunks.length > 1);
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(Buffer.byteLength(chunk.text, 'utf8') <= 590);
    assert.equal(entry.body.slice(chunk.start, chunk.end), chunk.text);
    assert.ok(chunk.splitterVersion.length > 0);
    if (index) assert.ok(Buffer.byteLength(entry.body.slice(chunk.start, chunks[index - 1]!.end), 'utf8') <= 50);
  }
  assert.equal(chunks[0]!.start, 0); assert.equal(chunks.at(-1)!.end, entry.body.length);
});
