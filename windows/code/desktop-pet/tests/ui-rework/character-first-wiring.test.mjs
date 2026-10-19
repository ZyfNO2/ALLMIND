import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { characterUiAsset } from '../../dist/management/character-ui-static.js';
import { ProductionPlaygroundPort } from '../../dist/management/playground-port.js';
import { continuityManagement } from '../../dist/management/continuity-routes.js';
const dir = mkdtempSync(join(tmpdir(), 'aika-cfw-test-'));
const bundle = join(dir, 'runtime.mjs');
buildSync({ entryPoints: ['management/character-ui/src/services/runtime.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
const { createRuntime, consumeSession } = await import(pathToFileURL(bundle).href);
test.after(() => { assert.ok(dir.startsWith(join(tmpdir(), 'aika-cfw-test-'))); rmSync(dir, { recursive: true, force: true }); });

test('session token is removed from address and same-tab legacy access keeps storage', () => {
  const values = new Map(); let address;
  const token = consumeSession({ pathname: '/', search: '', hash: '#token=secret&page=memory&characterId=role-b' }, { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v) }, url => address = url);
  assert.equal(token, 'secret'); assert.equal(address, '/characters/role-b/memory'); assert.ok(!address.includes('secret'));
  assert.equal(consumeSession({pathname:'/settings',search:'',hash:''},{getItem:k=>values.get(k),setItem(){}},()=>{}),'secret');
});
test('legacy panel mapping keeps scope, strips credentials, and never forwards to the retired console', () => {
  let address;const storage={getItem:()=>'',setItem(){}};
  consumeSession({pathname:'/',search:'',hash:'#token=private&page=models'},storage,url=>address=url);
  assert.equal(address,'/current/config?tab=model');
  // LUI-06 §2.3: a scoped legacy target maps to the in-app route, preserving the character scope.
  consumeSession({pathname:'/',search:'',hash:'#token=private&page=memory&section=import&character=role-b&instance=custom'},storage,url=>address=url);
  assert.equal(address,'/characters/role-b/memory?tab=import');assert.ok(!address.includes('private'));
  // A target the SPA has no home for falls back to the roster — it is never forwarded to /legacy.html.
  consumeSession({pathname:'/',search:'',hash:'#token=private&page=roles&section=appearance&character=role-b'},storage,url=>address=url);
  assert.equal(address,'/characters');assert.ok(!address.includes('legacy'));
  // The settings tab synonyms survive the mapping, including the renamed ids.
  consumeSession({pathname:'/',search:'',hash:'#page=settings&section=companion_knowledge'},storage,url=>address=url);
  assert.equal(address,'/settings?tab=companion-knowledge');
});
test('adapter submits and cancels only through official turn endpoints and preserves failure replies', async()=>{
  const calls=[];const session={pairing:{userId:'u',characterId:'c',characterInstanceId:'i'},sessionId:'s',effectiveConfigRevision:4};
  const adapter=createRuntime(()=> 'anonymous',async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return new Response(JSON.stringify(path.endsWith('/cancel')?{cancelled:true,turnId:'t'}:{turnId:'t',status:'failed',reply:null,error:'provider unavailable'}));});
  const result=await adapter.submitTurn(session,'hello','stable-op');assert.equal(result.reply,null);assert.equal(result.status,'failed');
  assert.deepEqual(calls[0].body,{pairing:session.pairing,sessionId:'s',expectedConfigRevision:4,text:'hello',operationId:'stable-op'});
  await adapter.cancelTurn('t');assert.equal(calls[1].path,'/api/playground/turns/t/cancel');
});
test('adapter rejects missing sessions, external paths, and preserves API failures', async () => {
  let calls = 0;
  const locked = createRuntime(() => '', async () => { calls++; });
  await assert.rejects(locked.listCharacters(), /管理入口/); assert.equal(calls,0);
  await assert.rejects(locked.request('https://evil.invalid/api'), /同源/);
  const refused = createRuntime(() => 'anonymous', async () => new Response(JSON.stringify({error:{message:'修订冲突'}}),{status:409}));
  await assert.rejects(refused.savePrompt('companion',1,'new'), e=>e.status===409&&e.message==='修订冲突');
});
test('preview byte reads keep Bearer authentication and preserve API errors', async()=>{
  let headers;
  const adapter=createRuntime(()=> 'anonymous',async(_path,options)=>{headers=options.headers;return new Response(new Uint8Array([0,128,255]));});
  assert.deepEqual(new Uint8Array(await adapter.request('/api/skins/test/asset/image.png',{responseType:'bytes'})),new Uint8Array([0,128,255]));
  assert.equal(headers.Authorization,'Bearer anonymous');
  const denied=createRuntime(()=> 'anonymous',async()=>new Response(JSON.stringify({error:{message:'资源不属于当前会话'}}),{status:403}));
  await assert.rejects(denied.request('/api/skins/test/asset/image.png',{responseType:'bytes'}),e=>e.status===403&&e.message==='资源不属于当前会话');
});
test('one unavailable statistics source does not hide available counts or fabricate zeros', async()=>{
  const adapter=createRuntime(()=> 'anonymous',async path=>new Response(JSON.stringify(path.startsWith('/api/records')?{total:3}:path.startsWith('/api/traces')?{total:5}:{error:{message:'not wired'}}),{status:path==='/api/playground/session'?503:200}));
  assert.deepEqual(await adapter.getStats('companion'),{companionshipDays:'未提供',conversationCount:5,longTermMemoryCount:3,wikiCount:'读取失败'});
});
test('source registration precedes optimistic role binding save; untouched selection fields survive', async () => {
  const calls=[];
  const adapter=createRuntime(()=> 'anonymous', async(path,options)=>{calls.push({path,body:JSON.parse(options.body),headers:options.headers});return new Response(JSON.stringify(path==='/api/provider-sources'?{entry:{source:{sourceId:'source',auth:{kind:'none'}},profile:{modelProfileId:'model'}}}:{configuration:{savedRevision:8}}));});
  await adapter.saveBinding('role-b','tts',{configuration:{savedRevision:7}},{adapterId:'local',model:'SAPI',auth:'none',characterMicros:0},'own');
  assert.equal(calls.length,2); assert.equal(calls[0].body.selection.characterMicros,0); assert.equal(calls[1].body.expectedRevision,7);
  assert.deepEqual(calls[1].body.bindings,{tts:{mode:'own',sourceInstanceId:'source',modelProfileId:'model'}});
  assert.equal(calls[1].headers.Authorization,'Bearer anonymous');
});
test('static routing only serves compiled SPA and bounded assets, in setup mode too', () => {
  const root=resolve('management');
  assert.match(characterUiAsset(root,'/characters/role-b/memory').path,/character-app/);
  // LUI-06: setup mode is served by the SAME SPA. It used to return null here, which is exactly why
  // first-run setup still rendered the retired console.
  assert.match(characterUiAsset(root,'/','setup').path,/character-app/);
  assert.match(characterUiAsset(root,'/setup','setup').path,/character-app/);
  for(const path of ['/assets/../index.html','/assets/%2e%2e/index.html','/assets/nested/file.js','/src/services/runtime.ts','/characters/unknown/private','/api/snapshot']) assert.equal(characterUiAsset(root,path),null,path);
  assert.equal(characterUiAsset(root,'/assets/avatar-neutral.svg').mime,'image/svg+xml');
});
test('production HTTP serves new entry / deep links / legacy and enforces auth & Origin', async t => {
  const f=await roleConsoleFixture(t);
  for(const path of ['/','/characters','/characters/role-b/memory','/settings']) {const response=await fetch(f.server.origin+path);assert.equal(response.status,200);const html=await response.text();assert.match(html,/id="root"/);assert.match(html,/\/assets\/index-/);assert.doesNotMatch(html,/fonts.googleapis/);}
  // LUI-06: the retired console is gone — the SPA is the only shell, so the old entry and the old
  // view scripts must answer 404 instead of being served from `uiRoot`.
  const legacy=await fetch(f.server.origin+'/legacy.html');assert.equal(legacy.status,404);
  const oldShell=await fetch(f.server.origin+'/app.mjs');assert.equal(oldShell.status,404);
  const unauthorized=await fetch(f.server.origin+'/api/characters');assert.equal(unauthorized.status,401);
  const noOrigin=await fetch(f.server.origin+'/api/characters',{method:'POST',headers:{Authorization:`Bearer ${f.server.token}`,'Content-Type':'application/json'},body:JSON.stringify({label:'bad',operationId:'bad'})});assert.equal(noOrigin.status,403);
  const js=readFileSync(resolve('management/character-app/index.html'),'utf8').match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(f.server.origin+js)).headers.get('content-type'),'text/javascript; charset=utf-8');
});
test('adapter consumes real registry/profile/prompt/records/wiki; unknown roles and inactive chat are not fabricated', async t => {
  const f=await roleConsoleFixture(t);
  const productionPairing={userId:'local-user',characterId:'companion',characterInstanceId:'custom-running-instance'};
  const playground=new ProductionPlaygroundPort({pairing:productionPairing,getConfigRevision:()=>2,sendCommand(){throw Error('No model authorized')},cancelCurrent(){}});
  const server=await startManagementServer({uiRoot: resolve('management'),settings:f.settings,memory:f.memory,presets:await (await import('../../dist/management/character-preset-store.js')).CharacterPresetStore.open({memory:f.memory,settings:f.settings,skins:f.skins,base:f.c,roleConfigurations:f.roles}),roleConfigurations:f.roles,skins:f.skins,continuity:continuityManagement(f.continuity),playground,snapshot:()=>({apiVersion:1,runtime:{characterId:'companion'},modules:[],events:[],settings:f.settings.snapshot(),adapters:[],credentials:[],characters:f.memory.characters()})});
  t.after(()=>server.close());
  const transport=(path,options)=>fetch(server.origin+path,{...options,headers:{...options.headers,Origin:server.origin}});
  const adapter=createRuntime(()=>server.token,transport);
  assert.deepEqual((await adapter.listCharacters()).map(c=>c.id).sort(),['companion','role-b']);
  assert.equal((await adapter.getCharacter('role-b')).personality,'完整人设-role-b');
  assert.equal(await adapter.getCharacter('missing'),undefined);
  assert.deepEqual(await adapter.pairing('companion'),productionPairing);
  assert.deepEqual(await adapter.pairing('role-b'),{...productionPairing,characterId:'role-b',characterInstanceId:'role-b-default'});
  await assert.rejects(adapter.getSession('role-b'),/尚未运行/);
  const old=await adapter.prompt('role-b');await adapter.savePrompt('role-b',old.revision,'changed B');assert.equal((await adapter.prompt('role-b')).text,'changed B');assert.equal((await adapter.prompt('companion')).text,'完整人设-companion');
  const stats=await adapter.getStats('role-b');assert.equal(stats.companionshipDays,'未提供');assert.equal(stats.longTermMemoryCount,0);assert.equal(stats.wikiCount,0);
  assert.equal((await adapter.getSession('companion')).effectiveConfigRevision,2); // no model calls
});
