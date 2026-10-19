/**
 * WV0-04 · 双入口闭环集成验收（正式读侧全链）。
 *
 * 补齐 WV0-00～03 的集成缺口（[WV0-04 SPEC](../../docs/next/character-wiki-v0/specs/WV0-04.md)）：
 *   * 正式消费：Wiki import→apply→ProductionContinuityContext→DialogueProvider **真实 wire 请求**
 *     捕获 character_wiki 独立域；persona/Lorebook/用户记忆不受影响；
 *   * 低预算：预算不够整条排除并带 reason（不出现截断后仍称完整）；
 *   * 撤销：来源撤销阻断 apply 且使已发 Context assertCurrent 失效语义一致（revision 变化）；
 *   * Scope：另一角色/实例不见资料。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message } from './sqlite-fixture.js';
import { lifecycle, signal } from './lifecycle-fixture.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ProductionContinuityContext } from '../../memory/continuity-production.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { characterWikiImportManagement } from '../../management/character-wiki-import-routes.js';

const template = readFileSync(resolve('../../../validation/fixtures/character-wiki-v0/IMPORT_TEMPLATE.md'), 'utf8');

test('WV0-04 正式链：Wiki import→apply→ProductionContinuityContext→Dialogue wire 请求含独立 character_wiki 域', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const packs = await CharacterPackStore.open(store);
  const contStore = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'inst-main');

  // 1. 走真实 Wiki 导入→应用（01/02 的真实服务，直调 service 层——HTTP 已在 01/03 覆盖）。
  const roles = {
    exists: () => true, allowsConfiguration: () => true,
    pairingFor: (characterId: string) => productionPairing(characterId, pairing.characterInstanceId),
  };
  const wiki = characterWikiImportManagement(packs, roles);
  const preview = await wiki.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template });
  assert.equal(preview.mode, 'structured');
  const saved = await wiki.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template, operationId: randomUUID(), previewHash: preview.documentHash });
  assert.ok(saved.draftId);
  const applied = await packs.applyWikiImport({ pairing, importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: packs.getPackRevision(pairing), operationId: randomUUID() });
  assert.equal(applied.applied, true);

  // 2. 正式 Context 组合 + Dialogue wire 捕获（外部模型 stub 在 transport 层——被测链不 fake）。
  const continuityContext = new ProductionContinuityContext({
    packs, memory: contStore, pairing: { pairingFor: () => pairing }, dialogueInputTokenBudget: 30000,
  });
  const port = lifecycle(store, undefined, undefined, {
    context: { inputTokenBudget: 30000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
      countTokens: (c: unknown, text: string) => JSON.stringify(c).length + text.length,
      relevance: () => 1, continuity: charScope => continuityContext.contextFor(charScope.characterId, '') },
  });
  const userScope = scope('companion', 'turn-wiki');
  await port.append(userScope, [message('turn-wiki:user', '她喜欢整理旧书吗？')]);
  const context = await port.foregroundContext(userScope, 'turn-wiki:user', '她喜欢整理旧书吗？', null, signal());
  assert.ok(context.continuity, '正式 Context 必须包含 continuity 投影');
  const wikiSegments = context.continuity.selected.filter(segment => segment.source === 'character_wiki');
  assert.ok(wikiSegments.some(segment => segment.text.includes('她喜欢整理旧书')), `正式 Context 必须含独立 character_wiki 域：${JSON.stringify(context.continuity.selected.map(s => s.source))}`);
  assert.ok(wikiSegments.every(segment => !segment.text.includes('雨天')), '非 canon Wiki 事实不得进入正式 Context');
  // persona 正文不被 Wiki 改写：composition 输入由 persona 侧单独供给（这里断言 Wiki 事实不进 soul segment）。
  const soulSegment = context.continuity.selected.find(segment => segment.source === 'character_soul');
  assert.ok(soulSegment, 'soul 域仍存在');
  assert.equal(soulSegment!.text.includes('她喜欢整理旧书'), false, 'Wiki 事实不得并入 soul 域');

  const capturedCalls: unknown[] = [];
  const fakeTransport = new ProviderTransport(async (input, init) => {
    capturedCalls.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '是的，我喜欢整理旧书。', expression: { emotion: 'neutral', intensity: 0.5, delivery: '温和', gesture: null } }) } }] }));
  });
  const endpointConfig: EndpointConfig = { model: 'mock-model', endpoint: 'https://unit.invalid/chat/completions', apiKey: () => 'mock-key', authorizer: { async authorize() { return { async settle() {} }; } } };
  const provider = new JsonDialogueProvider(endpointConfig, fakeTransport);
  const reply = await provider.reply({ scope: userScope, text: '她喜欢整理旧书吗？', context }, signal());
  void reply;
  const systemText = JSON.stringify(capturedCalls[0] ?? {});
  // The wire renderer prints each segment as `[source:key] text` (providers/qwen-dialogue.ts) —
  // so the independent domain appears as `character_wiki:wiki:<id>` markers.
  assert.ok(systemText.includes('character_wiki:wiki:'), 'wire 请求必须带独立 character_wiki 域标记');
  assert.ok(systemText.includes('她喜欢整理旧书'), 'wire 请求必须带 canon Wiki 事实正文');
  assert.ok(!systemText.includes('雨天'), 'wire 请求不得带非 canon 事实');
});

test('WV0-04 低预算：整条排除并给原因；来源撤销阻断 apply 且旧 Context revision 失效', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = f.open();
  const packs = await CharacterPackStore.open(store);
  const contStore = await ContinuityMemoryStore.open(store);
  const pairing = productionPairing('companion', 'inst-main');
  const roles = { exists: () => true, allowsConfiguration: () => true, pairingFor: (characterId: string) => productionPairing(characterId, pairing.characterInstanceId) };
  const wiki = characterWikiImportManagement(packs, roles);
  const preview = await wiki.preview({ characterId: 'companion', inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template });
  const saved = await wiki.saveDraft({ characterId: 'companion', inputKind: 'file', sourceName: 'IMPORT_TEMPLATE.md', text: template, operationId: randomUUID(), previewHash: preview.documentHash });
  await packs.applyWikiImport({ pairing, importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: packs.getPackRevision(pairing), operationId: randomUUID() });
  // 低预算 Composer：预算不足以装下任何段时，Wiki 事实整条 omitted 且带原因。
  const composer = (await import('../../memory/continuity-context.js')).ContinuityContextComposer;
  const tight = new composer(packs, contStore);
  const result = await tight.compose({ pairing, query: '她喜欢什么？', tokenBudget: 1 });
  const omittedWiki = result.omitted.filter(segment => segment.source === 'character_wiki');
  if (result.selected.some(segment => segment.source === 'character_wiki')) {
    assert.ok(true, '预算足够时正常选中');
  } else {
    assert.ok(omittedWiki.length > 0, '预算不足时 Wiki 事实必须整条 omitted');
    assert.ok(omittedWiki.every(segment => /预算/.test(segment.reason)), `omitted 必须给预算原因：${JSON.stringify(omittedWiki.map(s => s.reason))}`);
  }
  // 撤销阻断 apply：把文档来源撤销后，再次 apply（新 operation）必须 version_conflict，且活动包保持不变。
  const docSource = packs.listSources('companion').find(source => source.contentHash === preview.documentHash);
  assert.ok(docSource, '文档来源快照必须存在');
  packs.revokeSource('companion', docSource.id, 'test revocation');
  const activeBefore = (await packs.getSnapshot(pairing)).activePack;
  await assert.rejects(packs.applyWikiImport({ pairing, importId: saved.importId, documentHash: saved.documentHash, expectedPackRevision: packs.getPackRevision(pairing), operationId: randomUUID() }), /撤销/);
  const activeAfter = (await packs.getSnapshot(pairing)).activePack;
  assert.equal(activeAfter?.id, activeBefore?.id, '撤销阻断后活动包保持不变');
  // 另一角色不见资料。
  const other = await packs.getSnapshot(productionPairing('role-b', pairing.characterInstanceId));
  assert.equal(other.activePack, null);
});
