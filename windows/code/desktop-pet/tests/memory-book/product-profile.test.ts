import {previewPublication} from '../../memory/channel-publication.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptyEntry} from '../../contracts/memory-book.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import {BookRuntime} from '../../app/book-runtime.js';
import {BookCredentials} from '../../management/book-credentials.js';
import {startBookServer} from '../../management/book-server.js';
import {PROFILES, resolveProductProfile} from '../../app/product-profile.js';
import {AstrbotConnector, parseAstrbotChatBody, runTurnExecutor} from '../../app/astrbot-connector.js';
import {saveCapabilityBinding, revokeCapabilityBinding} from '../../management/allmind-capabilities.js';
import {handleGptText} from '../../providers/gpt-text-endpoint.js';

const root = resolve('.local/product-profile-tests');

test('desktop-lite closure omits voice, screen, direct QQ and tools while desktop-astrbot keeps the connector', async () => {
  const {moduleClosure} = await import(pathToFileURL(resolve('tools/profile-closure.mjs')).href) as {moduleClosure:(entry:string, omit?:readonly string[])=>string[]};
  const entry = resolve('dist/app/book-backend.js');
  const has = (files: string[], suffix: string) => files.some(file => file.replaceAll('\\', '/').endsWith(suffix));
  const lite = moduleClosure(entry, PROFILES['desktop-lite'].omitDynamic);
  for (const banned of ['/management/book-voice.js', '/core/book-screen.js', '/app/qq-channel-manager.js', '/management/book-tools.js', '/providers/onebot-qq.js', '/app/napcat-host.js', '/management/allmind-capabilities.js', '/app/astrbot-connector.js']) assert.equal(has(lite, banned), false, banned);
  assert.equal(has(lite, '/providers/gpt-text-endpoint.js'), true);
  assert.equal(has(lite, '/contracts/book-voice.js'), true);
  const astrbot = moduleClosure(entry, PROFILES['desktop-astrbot'].omitDynamic);
  assert.equal(has(astrbot, '/app/astrbot-connector.js'), true);
  assert.equal(has(astrbot, '/management/allmind-capabilities.js'), true);
  assert.equal(has(astrbot, '/management/book-voice.js'), false);
  const full = moduleClosure(entry, []);
  for (const required of ['/management/book-voice.js', '/core/book-screen.js', '/app/qq-channel-manager.js', '/management/book-tools.js']) assert.equal(has(full, required), true, required);
  for (const file of ['dist/app/book-backend.js', 'dist/app/book-runtime.js', 'dist/management/book-server.js']) {
    const source = readFileSync(resolve(file), 'utf8');
    assert.doesNotMatch(source, /from '\.\/(?:book-voice|book-tools|qq-channel-manager)\.js'|from '\.\.\/core\/book-screen\.js'/);
  }
});

test('an isolated desktop-lite process does not load the removed modules', () => {
  const probe = spawnSync(process.execPath, [resolve('tests/memory-book/profile-probe.mjs')], {cwd: resolve('.'), encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
});

test('lite routes report missing modules, capability tokens stay separate, and public bindings require reviewed snapshots', async t => {
  mkdirSync(root, {recursive: true});
  const directory = mkdtempSync(join(root, 'lite-'));
  const repo = new FileBookRepository(directory);
  let modelCalls = 0;
  const runtime = new BookRuntime(repo, {async complete() { modelCalls++; return 'no'; }}, {screenEnabled: false});
  const characterId = repo.loadConfig().currentCharacterId;
  const scope = {characterId, pairingId: 'local-user', sessionId: 'desktop'};
  repo.commit(scope, {upsert: [emptyEntry('public-fact', 'wiki', '公开事实', 'PUBLIC_FACT_TOKEN'), emptyEntry('private-fact', 'wiki', '私人事实', 'DESKTOP_SECRET_TOKEN')]}, 0, 'seed-profile');
  const binding={platform:'qq',conversationKey:'group-1',senderKey:'user-a',characterId,pairingId:'local-user',sessionId:'qq-a',audience:'public' as const,publicationEntryIds:['public-fact'],publication:previewPublication(repo,{id:'public-role',revision:1,scope,entryIds:['public-fact'],sourceIds:[],name:'Public role',intro:'Reviewed intro',presetId:null})};
  saveCapabilityBinding(directory,binding);
  const capability = 'c'.repeat(32);
  const gpt = 'd'.repeat(32);
  let gptCalls = 0;
  const server = await startBookServer({
    runtime, credentials: new BookCredentials(join(directory, 'credentials')), uiRoot: resolve('management'),
    profile: PROFILES['desktop-astrbot'], astrbotToken: capability,
    gptText: {token: gpt, port: {async complete(messages) { gptCalls++; assert.equal(messages.at(-1)?.content, 'hello'); return {text: 'bridge-once', requestId: 'req-1'}; }}},
  });
  t.after(async () => { await server.close(); repo.close(); rmSync(directory, {recursive: true, force: true}); });
  const origin = new URL(server.url).origin;
  const voice = await fetch(origin + '/api/memory-book/v1/voice/capabilities', {headers: {Authorization: 'Bearer ' + server.token}});
  assert.equal(voice.status, 200);
  assert.equal((await voice.json()).installed, false);
  const screen = await fetch(origin + '/api/memory-book/v1/screen/recognize', {method: 'POST', headers: {Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(screen.status, 503);
  const tools = await fetch(origin + '/api/memory-book/v1/tools', {headers: {Authorization: 'Bearer ' + server.token}});
  assert.equal(tools.status, 503);
  assert.equal((await fetch(origin + '/api/memory-book/v1/astrbot/capabilities', {headers: {Authorization: 'Bearer ' + server.token}})).status, 401);
  assert.equal((await fetch(origin + '/api/memory-book/v1/runtime', {headers: {Authorization: 'Bearer ' + capability}})).status, 401);
  const prepared = await fetch(origin + '/api/memory-book/v1/astrbot/prepare', {method: 'POST', headers: {Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json'}, body: JSON.stringify({eventKey:'a'.repeat(64),platform: 'qq', conversationKey: 'group-1', senderKey: 'user-a', message: '公开事实', audience: 'public'})});
  assert.equal(prepared.status, 200);
  const body = await prepared.json();
  assert.equal(body.preset.status, 'unused');
  assert.equal(body.systemNote.includes('DESKTOP_SECRET_TOKEN'),false);
  assert.equal(body.historyIncluded, false);
  assert.equal(JSON.stringify(body).includes('DESKTOP_SECRET_TOKEN'), false);
  assert.equal(modelCalls, 0);
  const other = await fetch(origin + '/api/memory-book/v1/astrbot/prepare', {method: 'POST', headers: {Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json'}, body: JSON.stringify({platform: 'qq', conversationKey: 'group-1', senderKey: 'user-b', message: '公开事实'})});
  assert.equal(other.status, 403);
  revokeCapabilityBinding(directory, {platform: 'qq', conversationKey: 'group-1', senderKey: 'user-a'});
  const revoked = await fetch(origin + '/api/memory-book/v1/astrbot/prepare', {method: 'POST', headers: {Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json'}, body: JSON.stringify({platform: 'qq', conversationKey: 'group-1', senderKey: 'user-a', message: '公开事实'})});
  assert.equal(revoked.status, 403);
  const deniedRecord=await fetch(origin+'/api/memory-book/v1/astrbot/record',{method:'POST',headers:{Authorization:'Bearer '+capability,'Content-Type':'application/json'},body:JSON.stringify({eventKey:'a'.repeat(64),recordToken:body.recordToken,answer:'x',generation:'completed',delivery:'unknown'})});
  assert.equal(deniedRecord.status,403);
  saveCapabilityBinding(directory,binding);
  const revision = repo.loadConfig().revision;
  const recorded = await fetch(origin + '/api/memory-book/v1/astrbot/record', {method: 'POST', headers: {Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json'}, body: JSON.stringify({eventKey:'a'.repeat(64),recordToken:body.recordToken, domain: 'fiction', answer: '故事', generation: 'completed', delivery: 'accepted'})});
  assert.equal((await recorded.json()).recorded, true);
  const again = await fetch(origin + '/api/memory-book/v1/astrbot/record', {method: 'POST', headers: {Authorization: 'Bearer ' + capability, 'Content-Type': 'application/json'}, body: JSON.stringify({eventKey:'a'.repeat(64),recordToken:body.recordToken, domain: 'reality', answer: '另一份', generation: 'completed', delivery: 'accepted'})});
  const duplicate = await again.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.domain, 'reality');
  assert.equal(repo.loadConfig().revision, revision);
  const rejected = await handleGptText('/gpt-text/v1/chat/completions', 'POST', {messages: [{role: 'user', content: 'hello'}], tools: [{}]}, {token: gpt, port: {async complete() { gptCalls++; return {text: 'x', requestId: 'no'}; }}}, new AbortController().signal);
  assert.equal(rejected?.status, 400);
  assert.equal(gptCalls, 0);
  const accepted = await fetch(origin + '/api/memory-book/v1/gpt-text/v1/chat/completions', {method: 'POST', headers: {Authorization: 'Bearer ' + gpt, 'Content-Type': 'application/json'}, body: JSON.stringify({messages: [{role: 'user', content: 'hello'}]})});
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).choices[0].message.content, 'bridge-once');
  assert.equal(gptCalls, 1);
  assert.equal(modelCalls, 0);
});

test('AstrBot chat posts once, keeps unknown streams unknown, and does not fall back locally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'astrbot-connector-'));
  let calls = 0;
  const settings = {execution: 'astrbot' as const, baseUrl: 'http://127.0.0.1:9', credentialId: 'k', configId: 'cfg', instanceId: 'inst'};
  const sse = 'data: {"type":"plain","text":"你好"}\n\ndata: {"type":"complete"}\n\n';
  const fetchImpl: typeof fetch = async () => { calls++; return new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}}); };
  const connector = new AstrbotConnector(directory, settings, 'secret', fetchImpl);
  const first = await connector.chat({requestId: 'req-1', text: 'hi', characterId: 'role', sessionId: 'desktop', signal: new AbortController().signal});
  const second = await connector.chat({requestId: 'req-1', text: 'hi', characterId: 'role', sessionId: 'desktop', signal: new AbortController().signal});
  assert.equal(first.state, 'completed');
  assert.equal(second.text, '你好');
  assert.equal(calls, 1);
  const dropped = new AstrbotConnector(directory, settings, 'secret', async () => new Response('data: {"type":"plain","text":"半截"}\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}}));
  const unknown = await dropped.chat({requestId: 'req-drop', text: 'hi', characterId: 'role', sessionId: 'desktop', signal: new AbortController().signal});
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.text, null);
  const again = await dropped.chat({requestId: 'req-drop', text: 'hi', characterId: 'role', sessionId: 'desktop', signal: new AbortController().signal});
  assert.equal(again.state, 'unknown');
  const official = parseAstrbotChatBody('data: {"type":"plain","data":"thinking","chain_type":"reasoning"}\n\ndata: {"type":"plain","data":"SE"}\n\ndata: {"type":"complete","data":"SECOND"}\n\n', 'text/event-stream');
  assert.equal(official.terminal, true);
  assert.equal(official.text, 'SECOND');
  const failed = parseAstrbotChatBody(JSON.stringify({status: 'error', message: 'username required'}), 'application/json');
  assert.equal(failed.failed, true);
  let local = 0;
  await assert.rejects(runTurnExecutor({execution: 'astrbot', local: async () => { local++; return 'local'; }, remote: async () => unknown}), /未改走本地生成|未知/);
  assert.equal(local, 0);
  rmSync(directory, {recursive: true, force: true});
  assert.throws(() => resolveProductProfile({ALLMIND_PROFILE: 'nope'} as NodeJS.ProcessEnv), /ALLMIND_PROFILE/);
});
