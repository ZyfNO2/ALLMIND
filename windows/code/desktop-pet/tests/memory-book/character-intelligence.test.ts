import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { FactWikiService } from '../../memory/fact-wiki.js';
import { emptyEntry, type BookScope, type ChatMessage } from '../../contracts/memory-book.js';
import { BookCredentials } from '../../management/book-credentials.js';
import { startBookServer } from '../../management/book-server.js';
import { resolve } from 'node:path';
const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'cir' };
function fixture(t: test.TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'cir-')), repo = new FileBookRepository(directory);
  t.after(() => repo.close()); return { repo, directory, wiki: new FactWikiService(repo) };
}
test('facts from any domain compile into linked subject pages; updates are idempotent and survive restart', t => {
  const { repo, wiki, directory } = fixture(t);
  const source = { sourceId: 'project', title: '工程资料', text: '# AIKI\n存储：本地文件\n# 用户\n偏好：乌龙茶', private: true };
  const preview = wiki.preview(scope, source); assert.equal(preview.facts.length, 2);
  const first = wiki.apply(scope, preview.id, 'ingest-1'); assert.deepEqual(wiki.apply(scope, preview.id, 'ingest-1'), first);
  const again = wiki.preview(scope, source); assert.equal(again.changes.filter(c => c.action !== 'noop').length, 0);
  wiki.apply(scope, again.id, 'ingest-2'); assert.equal(repo.snapshot(scope).revision, first.revision);
  const pages = wiki.pages(scope); assert.equal(pages.pages.length, 6);assert.equal(pages.compiledCount,4);assert.equal(pages.pages.filter(page=>page.id.startsWith('page.')).length,2);
  assert.match(pages.pages.find(p => p.subject === '用户')!.body, /乌龙茶/);
  assert.equal(wiki.pages({ ...scope, pairingId: 'other' }).pages.length, 0);
  repo.close(); const restarted = new FileBookRepository(directory); t.after(() => restarted.close());
  assert.deepEqual(new FactWikiService(restarted).pages(scope),pages);
});
test('source revisions update only supported facts, retain immutable snapshots, and never overwrite hand edits', t => {
  const { repo, wiki } = fixture(t);
  let p = wiki.preview(scope, { sourceId: 'a', title: '项目', text: '# AIKI\n存储：SQLite\n平台：Windows' }); wiki.apply(scope, p.id, 'seed');
  p = wiki.preview(scope, { sourceId: 'a', title: '项目', text: '# AIKI\n存储：本地文件\n平台：Windows' }); wiki.apply(scope, p.id, 'update');
  const book = repo.snapshot(scope); assert.equal(book.wikiSources![0]!.snapshots.length, 2);
  assert.equal(book.entries.filter(e => e.enabled).length, 2); assert.ok(book.entries.some(e => e.body.includes('本地文件')));
  const edited = book.entries.find(e => e.fact!.predicate === '存储')!;
  repo.commit(scope, { upsert: [{ ...edited, body: '手工整理：本地存储' }] }, book.revision, 'hand-edit');
  assert.ok(wiki.lint(scope).issues.some(issue => issue.code === 'manual_fact_review_required'));
  p = wiki.preview(scope, { sourceId: 'a', title: '项目', text: '# AIKI\n存储：新格式\n平台：Windows' });
  assert.ok(p.changes.some(c => c.action === 'conflict')); wiki.apply(scope, p.id, 'conflicted-update');
  assert.equal(repo.snapshot(scope).entries.find(e => e.id === edited.id)!.body, '手工整理：本地存储');
});
test('conflicts are visible and withheld; revoke/forget prevent retrieval and resurrection', async t => {
  const { repo, wiki } = fixture(t);
  for (const [id, value] of [['a', 'SQLite'], ['b', '文件']]) {
    const p = wiki.preview(scope, { sourceId: id!, title: '资料', text: `# AIKI\n存储：${value}` }); wiki.apply(scope, p.id, `source-${id}`);
  }
  assert.ok(wiki.lint(scope).issues.some(i => i.code === 'conflicting_fact'));
  const runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  let trace = await runtime.inspect(scope, 'AIKI 存储', new AbortController().signal);
  assert.equal(trace.consumed.length, 0); assert.ok(trace.recall.excluded.some(e => e.reason === 'conflicting_fact'));
  const source = repo.snapshot(scope).wikiSources!.find(s => s.id === 'b')!;
  wiki.revoke(scope, source.id, repo.snapshot(scope).revision, 'revoke'); runtime.invalidate('aika');
  trace = await runtime.inspect(scope, 'AIKI 存储', new AbortController().signal); assert.equal(trace.consumed.length, 1);
  const book = repo.snapshot(scope), fact = book.entries.find(e => e.fact!.sourceId === 'a')!;
  repo.commit(scope, { remove: [fact.id] }, book.revision, 'forget'); runtime.invalidate('aika');
  const p = wiki.preview(scope, { sourceId: 'a', title: '资料', text: '# AIKI\n存储：SQLite' });
  assert.ok(p.changes.some(c => c.action === 'forgotten')); wiki.apply(scope, p.id, 'reingest');
  assert.equal((await runtime.inspect(scope, 'AIKI 存储', new AbortController().signal)).consumed.length, 0);
});
test('view filtering precedes search, related expansion, always and active references', async t => {
  const { repo } = fixture(t), config = repo.loadConfig();
  repo.commitConfig({ ...config, characters: config.characters.map(c => ({ ...c, knowledgeView: { worldId: 'fate', branch: 'saber', cutoff: 2 } })) }, 0, 'view');
  const allowed = emptyEntry('allowed', 'wiki', '梅林', '梅林是导师'); allowed.related = ['future', 'alter', 'unknown'];
  allowed.knowledge = { worldId: 'fate', branch: 'saber', chapter: 1, awareness: 'heard' }; allowed.canon = { level: 'official', confidence: 'explicit' }; allowed.authorScope = 'character';
  const banned = ['future', 'alter', 'unknown'].map((id, i) => ({ ...emptyEntry(id, 'wiki', '梅林', `禁入资料 ${id}`), pinned: true,
    knowledge: { worldId: 'fate', branch: i === 1 ? 'alter' : 'saber', chapter: i === 0 ? 5 : 1, awareness: i === 2 ? 'unknown' as const : 'experienced' as const } }));
  repo.commit(scope, { upsert: [allowed, ...banned] }, 0, 'seed');
  const runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  const trace = await runtime.inspect(scope, '梅林', new AbortController().signal);
  assert.deepEqual(trace.consumed.map(r => r.entryId), ['allowed']); assert.equal(trace.recall.excluded.length, 3);
  assert.ok(!JSON.stringify(trace.messages).includes('禁入资料'));
  assert.match(JSON.stringify(trace.messages), /canon:official/); assert.match(JSON.stringify(trace.messages), /authorScope:character/);
  const updated = repo.loadConfig(); repo.commitConfig({ ...updated, characters: updated.characters.map(c => ({ ...c, knowledgeView: { worldId: 'fate', branch: 'saber', cutoff: 0 } })) }, updated.revision, 'cutoff-change');
  assert.throws(() => runtime.trace(scope, trace.recall.id), { code: 'conflict' });
  assert.equal((await runtime.inspect(scope, '梅林', new AbortController().signal)).consumed.length, 0);
});
test('private user facts survive sessions, author export omits them, and sources roundtrip without field loss', t => {
  const { repo, wiki } = fixture(t);
  let p = wiki.preview(scope, { sourceId: 'user', title: '用户', text: '饮品：乌龙茶', private: true }); wiki.apply(scope, p.id, 'private');
  p = wiki.preview(scope, { sourceId: 'world', title: '世界', text: '地点：测试机库' }); wiki.apply(scope, p.id, 'public');
  const pages=wiki.pages({ ...scope, sessionId: 'new-session' });assert.equal(pages.pages.length,4);assert.equal(pages.compiledCount,2);assert.equal(pages.pages.filter(page=>page.id.startsWith('page.')).length,2);
  const runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  const exported = runtime.imports.export(scope);
  assert.ok(!exported.text.includes('乌龙茶')); assert.ok(exported.text.includes('测试机库'));
  const other = { ...scope, characterId: 'other' }, preview = runtime.imports.preview(other, exported.text, exported.filename);
  assert.deepEqual(preview.diagnostics, []); runtime.imports.apply(other, preview.id, 'roundtrip');
  assert.equal(new FactWikiService(repo).pages(other).pages.length, 1);
  assert.deepEqual(repo.snapshot(other).wikiSources, repo.snapshot(scope).wikiSources!.filter(s => !s.pairingId));
});
test('formal production chat consumes compiled facts; changing knowledge revision invalidates traces', async t => {
  const { repo, wiki } = fixture(t), messages: ChatMessage[][] = [], config = repo.loadConfig();
  repo.commitConfig({ ...config, mainModel: { baseUrl: 'http://127.0.0.1:9', model: 'stub', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  const runtime = new BookRuntime(repo, { async complete(_binding, prompt) { messages.push(prompt); return '资料记载存储为本地文件。'; } });
  const p = wiki.preview(scope, { sourceId: 'a', title: 'AIKI', text: '存储：本地文件' }); wiki.apply(scope, p.id, 'compile');
  const result = await runtime.chat(scope, 'AIKI 使用什么存储？', new AbortController().signal);
  assert.equal(result.context!.consumed.length, 1); assert.match(JSON.stringify(messages[0]), /本地文件/);
  wiki.revoke(scope, 'a', repo.snapshot(scope).revision, 'revoke');
  assert.throws(() => runtime.trace(scope, result.turn.traceId), { code: 'conflict' });
});
test('evidence proposals must match source spans; oversized core fails explicitly, State is query based', async t => {
  const { repo, wiki } = fixture(t);
  assert.throws(() => wiki.preview(scope, { sourceId: 'a', title: 'A', text: '存储：文件', claims: [{ subject: 'A', predicate: '存储', value: 'Neo4j', quote: '存储：文件', start: 0 }] }), { code: 'invalid_input' });
  assert.equal(emptyEntry('state', 'state', '地点', '测试机库').trigger.strategy, 'search');
  repo.commit(scope, { upsert: [emptyEntry('core', 'persona', '核心', '人'.repeat(2000))] }, 0, 'large-core');
  const runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  await assert.rejects(runtime.inspect(scope, '你好', new AbortController().signal), { code: 'budget' });
});

test('Wiki pages reference evidenced memory, story and state owners; repeated evidence has one readable fact', async t => {
  const { repo, wiki } = fixture(t);
  const memory = { ...emptyEntry('memory', 'memory', '饮品偏好', '用户喜欢乌龙茶'), pairingId: scope.pairingId, origin: 'observed' as const, entities: ['用户'], sourceRefs: ['turn.real'] };
  const state = { ...emptyEntry('state', 'state', '当前地点', '地点：机库'), pairingId: scope.pairingId, origin: 'observed' as const, entities: ['用户'], sourceRefs: ['event.real'] };
  const story = { ...emptyEntry('story', 'story', '原作前史', '作者故事：进入机库'), entities: ['用户'], sourceRefs: ['author.chapter'] };
  const persona = { ...emptyEntry('persona', 'persona', '核心', '角色名为工程伙伴，尊重事实。'), entities: ['工程伙伴'], sourceRefs: ['author.core'] };
  repo.commit(scope, { upsert: [memory, state, story, persona] }, 0, 'owners');
  const page = wiki.pages(scope).pages.find(p => p.subject === '用户')!;
  assert.deepEqual(page.entryIds.sort(), ['memory', 'state', 'story']); assert.match(page.body, /authored/); assert.match(page.body, /observed/);
  assert.match(wiki.pages(scope).pages.find(p => p.subject === '工程伙伴')!.body, /persona\/authored/);
  assert.deepEqual(wiki.pages({ ...scope, pairingId: 'other' }).pages[0]!.entryIds, ['story']);
  for (const id of ['a', 'b']) { const p = wiki.preview(scope, { sourceId: id, title: 'AIKI', text: '存储：本地文件' }); wiki.apply(scope, p.id, id); }
  const factPage = wiki.pages(scope).pages.find(p => p.subject === 'AIKI')!;
  assert.equal(factPage.body.split('AIKI的存储：本地文件').length - 1, 1); assert.equal(factPage.sourceIds.length, 2);
  const trace = await new BookRuntime(repo, { async complete() { return 'unused'; } }).inspect(scope, 'AIKI 存储', new AbortController().signal);
  assert.equal(trace.consumed.filter(ref => ref.entryId.startsWith('wiki.')).length, 1);
});

test('model ingest validates input and scope before calling provider and rejects invented evidence', async t => {
  const { repo, wiki } = fixture(t), config = repo.loadConfig(); let calls = 0;
  repo.commitConfig({ ...config, fastModel: { baseUrl: 'http://127.0.0.1:9', model: 'fixture', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 } }, 0, 'model');
  const runtime = new BookRuntime(repo, { async complete() { calls++; return JSON.stringify({ claims: [{ subject: '用户', predicate: '饮品', value: '咖啡', quote: '喜欢咖啡' }] }); } });
  await assert.rejects(runtime.previewWiki(scope, { sourceId: 'empty', title: '', text: '' }, 'model', new AbortController().signal), { code: 'invalid_input' }); assert.equal(calls, 0);
  let p = wiki.preview(scope, { sourceId: 'private', title: '用户', text: '饮品：茶', private: true }); wiki.apply(scope, p.id, 'seed');
  await assert.rejects(runtime.previewWiki(scope, { sourceId: 'private', title: '用户', text: '饮品：茶', private: false }, 'model', new AbortController().signal), { code: 'conflict' }); assert.equal(calls, 0);
  await assert.rejects(runtime.previewWiki(scope, { sourceId: 'new', title: '用户', text: '喜欢乌龙茶' }, 'model', new AbortController().signal), { code: 'invalid_input' }); assert.equal(calls, 1);
  await assert.rejects(runtime.previewWiki(scope, { sourceId: 'large', title: '资料', text: '字'.repeat(3200) }, 'model', new AbortController().signal), { code: 'budget' }); assert.equal(calls, 1, 'over-budget source must not call provider');
  assert.equal(repo.snapshot(scope).wikiSources!.length, 1);
});

test('reviewed user event and state commit atomically once; failed/cancelled/stale proposals write nothing', t => {
  const { repo } = fixture(t), runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  repo.appendTurn(scope, { ...scope, id: 'turn-one', traceId: 'trace-one', timestamp: new Date().toISOString(), user: '我已到机库，任务为检修', assistant: '我猜你的信任增加10', });
  assert.throws(() => runtime.state.preview(scope, { turnId: 'turn-one', quote: '信任增加10', changes: [{ key: '信任', value: '10' }] }), { code: 'invalid_input' });
  const p = runtime.state.preview(scope, { turnId: 'turn-one', quote: '我已到机库，任务为检修', changes: [{ key: '地点', value: '机库' }, { key: '任务', value: '检修' }] });
  const cancel = new AbortController(); cancel.abort(); assert.throws(() => runtime.state.apply(scope, p.id, 'cancel', cancel.signal)); assert.equal(repo.snapshot(scope).revision, 0);
  const receipt = runtime.state.apply(scope, p.id, 'apply', new AbortController().signal);
  assert.deepEqual(runtime.state.apply(scope, p.id, 'apply', new AbortController().signal), receipt);
  assert.equal(runtime.state.view(scope).states.length, 2); assert.equal(runtime.state.view(scope).events.length, 1);
  assert.equal(runtime.wiki.pages(scope).pages[0]!.entryIds.length, 3);
  assert.throws(() => runtime.state.preview(scope, { turnId: 'turn-one', quote: '我已到机库，任务为检修', changes: [{ key: '地点', value: '机库' }] }), { code: 'conflict' });
  assert.equal(runtime.state.view({ ...scope, pairingId: 'other' }).events.length, 0);
  assert.ok(!runtime.imports.export(scope).text.includes('机库'));
  repo.appendTurn(scope, { ...scope, id: 'turn-two', traceId: 'trace-two', timestamp: new Date().toISOString(), user: '我到庭院了', assistant: '好', });
  const stale = runtime.state.preview(scope, { turnId: 'turn-two', quote: '我到庭院了', changes: [{ key: '地点', value: '庭院' }] });
  repo.commit(scope, { upsert: [emptyEntry('unrelated', 'wiki', 'x', 'x')] }, receipt.revision, 'concurrent');
  assert.throws(() => runtime.state.apply(scope, stale.id, 'stale', new AbortController().signal), { code: 'conflict' });
  assert.equal(runtime.state.view(scope).states.find(e => e.title === '地点')!.state!.value, '机库');
});

test('author State initialization is explicit, labelled and cannot overwrite evolved instance values', async t => {
  const { repo } = fixture(t), runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  repo.commit(scope, { upsert: [emptyEntry('template', 'state', '关系', '盟友')] }, 0, 'template');
  const p = runtime.state.initialize(scope, 'template'); runtime.state.apply(scope, p.id, 'initialize', new AbortController().signal);
  assert.equal(runtime.state.view(scope).events[0]!.event!.basis, 'author_initialization');
  assert.throws(() => runtime.state.initialize({ ...scope, sessionId: 'next' }, 'template'), { code: 'conflict' });
  repo.commit(scope, { upsert: [{ ...repo.snapshot(scope).entries.find(e => e.id === 'template')!, body: '挚友' }] }, repo.snapshot(scope).revision, 'reimport');
  assert.equal(runtime.state.view(scope).states[0]!.state!.value, '盟友');
  const event = runtime.state.view(scope).events[0]!;
  repo.commit(scope, { remove: [event.id] }, repo.snapshot(scope).revision, 'forget-event');
  const context = await runtime.inspect(scope, '关系', new AbortController().signal);
  assert.ok(!context.consumed.some(ref => ref.entryId === p.states[0]!.id), 'forgotten event invalidates derived state');
});

test('Memory records real committed user/character dialogue, replays once and stays private across sessions', t => {
  const { repo } = fixture(t), runtime = new BookRuntime(repo, { async complete() { return 'unused'; } });
  assert.throws(() => runtime.rememberTurn(scope, 'nonexistent', 0, 'missing'), { code: 'not_found' });
  repo.appendTurn(scope, { ...scope, id: 'real', traceId: 'trace', timestamp: '2026-10-12T01:00:00Z', user: '我喜欢茶', assistant: '我可以陪你喝茶' });
  const receipt = runtime.rememberTurn(scope, 'real', 0, 'remember'); assert.deepEqual(runtime.rememberTurn(scope, 'real', 0, 'remember'), receipt);
  assert.equal(repo.snapshot(scope).entries.length, 1); assert.match(repo.snapshot(scope).entries[0]!.body, /用户：我喜欢茶\n\n角色：我可以陪你喝茶/);
  assert.equal(repo.snapshot({ ...scope, sessionId: 'next' }).entries.length, 1); assert.equal(repo.snapshot({ ...scope, pairingId: 'other' }).entries.length, 0);
  assert.equal(runtime.wiki.pages(scope).pages.length, 2); assert.ok(!runtime.imports.export(scope).text.includes('喝茶'));
});

test('AI Wiki cancellation or invalid extraction never writes partial facts', async t => {
  const { repo } = fixture(t), config = repo.loadConfig();
  repo.commitConfig({ ...config, fastModel: { baseUrl: 'http://127.0.0.1:9', model: 'fixture', credentialId: 'none', inputTokens: 8192, outputTokens: 1024 } }, 0, 'fast');
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new BookRuntime(repo, { complete(_binding, _messages, signal) { entered(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const controller = new AbortController(), pending = runtime.previewWiki(scope, { sourceId: 'a', title: '用户', text: '喜欢茶' }, 'model', controller.signal);
  await started; controller.abort(); await assert.rejects(pending); assert.equal(repo.snapshot(scope).revision, 0);
});

test('authenticated Wiki/Memory HTTP routes preserve scope, verify real turn sources and require reviewed application', async t => {
  const { repo, directory } = fixture(t), runtime = new BookRuntime(repo, { async complete() { throw Error('HTTP declaration fixture must not call provider'); } });
  const server = await startBookServer({ runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management') }); t.after(() => server.close());
  const origin = new URL(server.url).origin, headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const call = async (route: string, data?: unknown) => { const response = await fetch(origin + '/api/memory-book/v1' + route, { method: data ? 'POST' : 'GET', headers, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await fetch(origin + '/api/memory-book/v1/wiki')).status, 401);
  assert.equal((await call('/wiki/preview', { ...scope, turnId: 'forged' })).status, 404);
  repo.appendTurn(scope, { ...scope, id: 'real', traceId: 'trace', timestamp: '2026-10-12T01:00:00Z', user: '饮品：乌龙茶', assistant: '饮品：咖啡' });
  const preview = await call('/wiki/preview', { ...scope, turnId: 'real', source: { text: 'forged' } }); assert.equal(preview.status, 200);
  assert.equal(preview.data.source.pairingId, scope.pairingId); assert.equal(preview.data.source.snapshots[0].text, '饮品：乌龙茶'); assert.equal(repo.snapshot(scope).revision, 0);
  assert.equal((await call('/wiki/apply', { ...scope, pairingId: 'other', previewId: preview.data.id, operationId: 'foreign' })).status, 404);
  assert.equal((await call('/wiki/apply', { ...scope, previewId: preview.data.id, operationId: 'apply' })).status, 200);
  assert.equal((await call('/wiki?characterId=aika&pairingId=other')).data.pages.length, 0);
  assert.equal((await call('/wiki/revoke', { ...scope, sourceId: preview.data.source.id, expectedRevision: 0, operationId: 'stale' })).status, 409);
  assert.equal((await call('/memory/remember', { ...scope, turnId: 'real', expectedRevision: repo.snapshot(scope).revision, operationId: 'remember' })).status, 200);
  assert.equal((await call('/wiki/lint?characterId=aika')).status, 200);
});
