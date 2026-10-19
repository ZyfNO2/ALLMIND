/**
 * P0 4.2-1: a failed/cancelled/timed-out explicit turnId is terminal. The request-count fixtures prove
 * that changing the preset, changing the config, or restarting the runtime cannot turn one failed
 * attempt into a second model submission, while the completed-turn replay protection keeps working.
 * The durable marker stores identity/hash only — never the user or assistant body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,writeFileSync,renameSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import { join } from 'node:path';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { BookRuntime } from '../../app/book-runtime.js';
import { DEFAULT_CHATGPT_WEB_SOURCE, type BookScope, type ModelBinding, type RuntimeConfig } from '../../contracts/memory-book.js';
import type { BookModelPort } from '../../providers/book-model.js';
import type { PresetDocument } from '../../contracts/prompt-preset.js';

const scope: BookScope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'freeze' };
const binding: ModelBinding = { baseUrl: 'http://127.0.0.1:9999/v1', model: 'freeze-stub', credentialId: 'local', inputTokens: 16384, outputTokens: 4096 };

function fixture(t: test.TestContext) {
  const root = join(process.cwd(), '.local/memory-book-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'turn-freeze-')), repository = new FileBookRepository(directory);
  t.after(() => { try { repository.close(); } catch { /* already closed by a restart case */ } try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows may still hold a reopened handle */ } });
  return { directory, repository };
}
function configure(repository: FileBookRepository, changes: Partial<RuntimeConfig> = {}): void {
  const config = repository.loadConfig();
  repository.commitConfig({ ...config, ...changes, mainModel: changes.mainModel ?? config.mainModel ?? binding }, config.revision, 'config-' + config.revision);
}
/** (a) preset switch: a valid imported preset becomes the role's current preset (config revision moves). */
function switchPreset(repository: FileBookRepository): void {
  const config = repository.loadConfig();
  const document: PresetDocument = {
    prompts: [
      { identifier: 'main', role: 'system', content: 'Act as {{char}}.' },
      { identifier: 'charDescription', marker: true },
      { identifier: 'chatHistory', marker: true },
    ],
    prompt_order: [{ character_id: 100001, order: ['main', 'charDescription', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }],
  };
  repository.commitConfig({
    ...config,
    promptPresets: [{ id: 'preset-freeze', name: '合成冻结预设', revision: 1, original: JSON.stringify(document), document, orderBlock: 100001 }],
    characters: config.characters.map(role => ({ ...role, promptPresetId: 'preset-freeze' })),
  }, config.revision, 'config-preset');
}
function freezeFile(directory: string): string {
  const name = readdirSync(directory).find(row => row.startsWith('turn-freezes-'));
  assert.ok(name, '失败轮次应留下冻结记录文件');
  return join(directory, name);
}

test('hard exit inside transport retains a pre-submit intent and prevents the same ID after restart',t=>{
  const {directory,repository}=fixture(t);configure(repository);repository.close();
  const repoUrl=new URL('../../memory/file-book-repository.js',import.meta.url).href,runtimeUrl=new URL('../../app/book-runtime.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {writeFileSync} from 'node:fs';import {FileBookRepository} from ${JSON.stringify(repoUrl)};import {BookRuntime} from ${JSON.stringify(runtimeUrl)};const repo=new FileBookRepository(${JSON.stringify(directory)});const runtime=new BookRuntime(repo,{async complete(){writeFileSync(${JSON.stringify(join(directory,'submitted.txt'))},'1');process.exit(0);}});await runtime.chat(${JSON.stringify(scope)},'private synthetic body',new AbortController().signal,{turnId:'crash-turn'});`],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);assert.equal(readFileSync(join(directory,'submitted.txt'),'utf8'),'1');
  renameSync(join(directory,'writer.lock'),join(directory,'writer.crash.lock'));
  const repo=new FileBookRepository(directory);let calls=0;
  assert.equal(repo.readTurnFreeze(scope,'crash-turn')?.state,'submitted');assert.ok(!readFileSync(freezeFile(directory),'utf8').includes('private synthetic body'));
  return assert.rejects(new BookRuntime(repo,{async complete(){calls++;return 'must not run';}}).chat(scope,'private synthetic body',new AbortController().signal,{turnId:'crash-turn'}),{code:'conflict'}).then(()=>assert.equal(calls,0)).finally(()=>repo.close());
});

test('intent write failure rejects before transport; terminal write failure preserves the intent after restart',async t=>{
  const {directory,repository}=fixture(t);configure(repository);const persist=repository.freezeTurn.bind(repository);let calls=0;
  repository.freezeTurn=()=>{throw Error('synthetic disk failure');};
  const runtime=new BookRuntime(repository,{async complete(){calls++;throw Error('synthetic provider failure');}});
  await assert.rejects(runtime.chat(scope,'synthetic',new AbortController().signal,{turnId:'not-sent'}),/提交意图无法持久化/);assert.equal(calls,0);
  let writes=0;repository.freezeTurn=(owner,record)=>{if(++writes===2)throw Error('synthetic disk failure');persist(owner,record);};
  await assert.rejects(runtime.chat(scope,'synthetic',new AbortController().signal,{turnId:'sent-once'}),/冻结状态写入失败.*原请求错误：synthetic provider failure/);assert.equal(calls,1);repository.close();
  const repo=new FileBookRepository(directory);assert.equal(repo.readTurnFreeze(scope,'sent-once')?.state,'submitted');
  await assert.rejects(new BookRuntime(repo,{async complete(){calls++;return 'must not run';}}).chat(scope,'synthetic',new AbortController().signal,{turnId:'sent-once'}),{code:'conflict'});assert.equal(calls,1);repo.close();
});

test('full freeze ledger rejects new submissions without evicting old identities',async t=>{
  const {directory,repository}=fixture(t);configure(repository);
  const record={...scope,turnId:'oldest',state:'failed' as const,requestHash:'a'.repeat(64),at:new Date().toISOString()};repository.freezeTurn(scope,record);
  const file=freezeFile(directory),ledger=JSON.parse(readFileSync(file,'utf8'));ledger.records=Array.from({length:1024},(_,i)=>({...record,turnId:i?'seed-'+i:'oldest'}));writeFileSync(file,JSON.stringify(ledger));
  let calls=0;const runtime=new BookRuntime(repository,{async complete(){calls++;return 'must not run';}});
  await assert.rejects(runtime.chat(scope,'synthetic',new AbortController().signal,{turnId:'new-id'}),{code:'budget'});assert.equal(calls,0);assert.equal(JSON.parse(readFileSync(file,'utf8')).records.length,1024);
  repository.close();const repo=new FileBookRepository(directory);assert.equal(repo.readTurnFreeze(scope,'oldest')?.state,'failed');
  await assert.rejects(new BookRuntime(repo,{async complete(){calls++;return 'must not run';}}).chat(scope,'synthetic',new AbortController().signal,{turnId:'oldest'}),{code:'conflict'});assert.equal(calls,0);repo.close();
});

test('a failed turnId stays frozen across preset/config/restart and never becomes a second model submission', { timeout: 60000 }, async t => {
  const { directory, repository } = fixture(t);
  configure(repository);
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete() { calls++; throw Error('合成上游失败'); } });
  const turnId = 'frozen-turn';
  await assert.rejects(runtime.chat(scope, '合成失败问题', new AbortController().signal, { turnId }), /合成上游失败/);
  assert.equal(calls, 1);
  assert.equal(repository.readSession(scope).length, 0, '失败轮次不得写入聊天正文');
  assert.equal(repository.readTurnFreeze(scope, turnId)?.state, 'failed');
  const stored = readFileSync(freezeFile(directory), 'utf8');
  assert.ok(!stored.includes('合成失败问题'), '冻结记录不得包含用户正文');
  const parsed = JSON.parse(stored) as { records: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(parsed.records[0]!).sort(), ['at', 'characterId', 'pairingId', 'requestHash', 'sessionId', 'state', 'turnId']);
  assert.match(String(parsed.records[0]!.requestHash), /^[a-f0-9]{64}$/);
  // (a) changing the preset must not recompile and resubmit the frozen turn
  switchPreset(repository);
  await assert.rejects(runtime.chat(scope, '合成失败问题', new AbortController().signal, { turnId }), { code: 'conflict' });
  // (b) changing the model config must not resubmit it either
  configure(repository, { mainModel: { ...binding, model: 'another-stub', outputTokens: 2048 } });
  await assert.rejects(runtime.chat(scope, '合成失败问题', new AbortController().signal, { turnId }), { code: 'conflict' });
  assert.equal(calls, 1, '换预设/改配置都不得再次调用模型');
  // (c) restart the runtime and reload the same data: still no second submission
  repository.close();
  const reopened = new FileBookRepository(directory);
  try {
    let restartedCalls = 0;
    const restarted = new BookRuntime(reopened, { async complete() { restartedCalls++; return '不应被调用'; } });
    await assert.rejects(restarted.chat(scope, '合成失败问题', new AbortController().signal, { turnId }), { code: 'conflict' });
    assert.equal(restartedCalls, 0, '重启后不得再次调用模型');
    assert.equal(reopened.readTurnFreeze(scope, turnId)?.state, 'failed');
    assert.equal(reopened.readSession(scope).length, 0);
  } finally { reopened.close(); }
});

test('a cancelled turnId is frozen across restart and cannot be resubmitted', { timeout: 60000 }, async t => {
  const { directory, repository } = fixture(t);
  configure(repository);
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const runtime = new BookRuntime(repository, {
    complete(_binding, _messages, signal) {
      calls++; started();
      return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    },
  });
  const controller = new AbortController();
  const pending = runtime.chat(scope, '取消问题', controller.signal, { turnId: 'cancelled-turn' });
  await entered; controller.abort();
  await assert.rejects(pending);
  assert.equal(repository.readTurnFreeze(scope, 'cancelled-turn')?.state, 'cancelled');
  repository.close();
  const reopened = new FileBookRepository(directory);
  try {
    let restartedCalls = 0;
    const restarted = new BookRuntime(reopened, { async complete() { restartedCalls++; return '不应被调用'; } });
    await assert.rejects(restarted.chat(scope, '取消问题', new AbortController().signal, { turnId: 'cancelled-turn' }), { code: 'conflict' });
    assert.equal(restartedCalls, 0);
    assert.equal(reopened.readSession(scope).length, 0);
  } finally { reopened.close(); }
});

test('a timed-out web turnId is frozen and never resubmitted', { timeout: 30000 }, async t => {
  const { repository } = fixture(t);
  const webBinding: ModelBinding = { kind: 'chatgpt-web', baseUrl: 'chatgpt-web', model: 'current', credentialId: 'none', inputTokens: 16384, outputTokens: 4096 };
  const config = repository.loadConfig();
  repository.commitConfig({
    ...config, mainModel: webBinding,
    chatgptWeb: { ...DEFAULT_CHATGPT_WEB_SOURCE, transport: 'embedded', submitMechanism: 'page', authorizedPurposes: ['reply'], replyBudgetMs: 5000 },
  }, config.revision, 'config-web');
  let calls = 0;
  const runtime = new BookRuntime(repository, {
    complete(_binding, _messages, signal) {
      calls++;
      return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    },
  });
  await assert.rejects(runtime.chat(scope, '超时问题', new AbortController().signal, { turnId: 'timed-turn' }), (error: unknown) => (error as { name?: string }).name === 'TimeoutError');
  assert.equal(calls, 1);
  assert.equal(repository.readTurnFreeze(scope, 'timed-turn')?.state, 'timeout');
  let restartedCalls = 0;
  const restarted = new BookRuntime(repository, { async complete() { restartedCalls++; return '不应被调用'; } });
  await assert.rejects(restarted.chat(scope, '超时问题', new AbortController().signal, { turnId: 'timed-turn' }), { code: 'conflict' });
  assert.equal(restartedCalls, 0);
});

test('incognito failures stay in memory and persist neither bodies nor freeze markers', { timeout: 60000 }, async t => {
  const { directory, repository } = fixture(t);
  configure(repository);
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete() { calls++; throw Error('无痕合成失败'); } });
  await assert.rejects(runtime.chat(scope, '无痕合成问题', new AbortController().signal, { turnId: 'private-turn', incognito: true }), /无痕请求未完成/);
  assert.equal(calls, 1);
  assert.equal(repository.readSession(scope).length, 0);
  assert.ok(!readdirSync(directory).some(name => name.startsWith('turn-freezes-')), '无痕失败不得写冻结文件');
  await assert.rejects(runtime.chat(scope, '无痕合成问题', new AbortController().signal, { turnId: 'private-turn', incognito: true }), { code: 'conflict' });
  assert.equal(calls, 1, '同进程内无痕失败 turnId 也不得重发');
});

test('completed turn replay stays idempotent after a config change and restart, with no freeze marker', { timeout: 60000 }, async t => {
  const { directory, repository } = fixture(t);
  configure(repository);
  let calls = 0;
  const runtime = new BookRuntime(repository, { async complete() { calls++; return '合成完成回复'; } });
  const first = await runtime.chat(scope, '已完成问题', new AbortController().signal, { turnId: 'done-turn' });
  assert.equal(first.replayed, false);
  const replay = await runtime.chat(scope, '已完成问题', new AbortController().signal, { turnId: 'done-turn' });
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1, '已完成 turnId 回放不得再次调用模型');
  configure(repository, { mainModel: { ...binding, outputTokens: 2048 } });
  const afterConfig = await runtime.chat(scope, '已完成问题', new AbortController().signal, { turnId: 'done-turn' });
  assert.equal(afterConfig.replayed, true);
  assert.equal(calls, 1);
  assert.equal(repository.readTurnFreeze(scope, 'done-turn'), null, '已完成轮次不应有冻结标记');
  repository.close();
  const reopened = new FileBookRepository(directory);
  try {
    let restartedCalls = 0;
    const restarted = new BookRuntime(reopened, { async complete() { restartedCalls++; return '不应被调用'; } });
    const replayed = await restarted.chat(scope, '已完成问题', new AbortController().signal, { turnId: 'done-turn' });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.turn.assistant, '合成完成回复');
    assert.equal(restartedCalls, 0);
    assert.equal(reopened.readSession(scope).length, 1);
  } finally { reopened.close(); }
});
