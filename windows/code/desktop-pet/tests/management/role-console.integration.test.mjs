import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cp, rename, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { roleConsoleFixture } from './role-console-fixture.mjs';
import { loadEffectiveRoleConfiguration } from '../../dist/management/role-configuration.js';
import { ProviderTransport } from '../../dist/providers/transport.js';
import { ModelDiscovery } from '../../dist/management/model-discovery.js';

test('读取失效独立来源按槽位报错，不展示其他来源的默认配置',async t=>{
  const f=await roleConsoleFixture(t),configuration=f.roles.get('role-b');
  await f.roles.save({...configuration,bindings:{...configuration.bindings,dialogue:{mode:'own',sourceInstanceId:'missing-source',modelProfileId:'missing-profile'}}});
  const view=await f.request('/api/characters/bindings?characterId=role-b');
  assert.equal(view.selections.dialogue,null);assert.match(view.readErrors.dialogue,/来源|模型/);assert.ok(view.selections.tts);assert.ok(view.selections.asr);
});

test('聊天偏移分页与陪伴事件游标分页保留日期、角色和实例作用域',async t=>{
  const f=await roleConsoleFixture(t),pairing={userId:'local-user',characterId:'role-b',characterInstanceId:'role-b-custom'};
  for(let i=0;i<55;i++)f.store.append({characterId:'role-b',sessionId:'pagination',turnId:`page-${i}`,generation:1},[{characterId:'role-b',id:`page-chat-${i}`,role:'user',text:`分页聊天 ${i}`,createdAt:new Date(Date.UTC(2026,9,6,1,0,i)).toISOString()}]);
  const page1=await f.request('/api/records?characterId=role-b&kind=transcript&limit=50&offset=0'),page2=await f.request('/api/records?characterId=role-b&kind=transcript&limit=50&offset=50');
  assert.equal(page1.total,55);assert.equal(page1.records.length,50);assert.equal(page2.records.length,5);assert.equal(new Set([...page1.records,...page2.records].map(row=>row.id)).size,55);
  for(let i=0;i<3;i++)await f.timeline.recordEvent({schemaVersion:1,eventId:`page-event-${i}`,domain:'companion',type:'companion.invitation.presented',pairing,turnId:`page-${i}`,sourceRef:{id:`page-chat-${i}`,version:1},occurredAt:`2026-10-06T02:00:0${i}.000Z`,receivedAt:`2026-10-06T02:00:0${i}.000Z`,payload:{invitationId:`invitation-${i}`,actionKind:'text',status:'presented'},summary:'fixture'});
  const query=new URLSearchParams({...pairing,domains:'companion',activitiesOnly:'true',order:'desc',limit:'2',from:'2026-10-06T02:00:00Z',to:'2026-10-07T00:00:00Z'});
  const events1=await f.request('/api/unified-timeline?'+query);query.set('cursor',events1.nextCursor);const events2=await f.request('/api/unified-timeline?'+query);
  assert.deepEqual([...events1.items,...events2.items].map(row=>row.eventId),['page-event-2','page-event-1','page-event-0']);assert.equal(events2.nextCursor,null);
  query.delete('cursor');query.set('characterInstanceId','role-b-other');assert.equal((await f.request('/api/unified-timeline?'+query)).items.length,0);
});

test('同名模型按精确来源和凭据隔离，单槽保存、修订冲突与免 Key transport', async t => {
  const f = await roleConsoleFixture(t);
  for (const [index, characterId] of ['companion','role-b'].entries()) {
    const credential = await f.request('/api/self-setup/credentials', 'POST', { instanceId: (await f.request('/api/self-setup')).instanceId,
      provider: 'openai', key: `anonymous-token-${index}`, expectedRevision: index, operationId: `credential-test-${index}` });
    const source = await f.request('/api/provider-sources', 'POST', { characterId, slot: 'dialogue', selection: {
      adapterId: 'openai-compatible-text', provider: 'openai', protocol: 'openai-compatible', endpoint: `https://role-${index}.example.invalid/v1/chat/completions`,
      credentialRef: credential.credentialRef, model: 'same-model', inputTokenLimit: 8192, outputTokenLimit: 2048, reservationMicros: 10000, inputMicrosPerToken: 1, outputMicrosPerToken: 2 } });
    await f.request('/api/characters/bindings','PUT',{ characterId, expectedRevision: 0, operationId: `binding-test-${index}`, bindings: { dialogue: { mode: 'own', sourceInstanceId: source.entry.source.sourceId,
      modelProfileId: source.entry.profile.modelProfileId, credentialRef: credential.credentialRef } } });
    const effective = loadEffectiveRoleConfiguration({ base: f.c, settings: f.settings.effective, store: f.roles, characterId });
    assert.equal(effective.capabilities.dialogue.endpoint, `https://role-${index}.example.invalid/v1/chat/completions`);
    assert.equal(effective.capabilities.dialogue.credentialRef, credential.credentialRef);
    assert.equal(f.roles.get(characterId).bindings.tts.mode, 'inherit-default');
  }
  assert.notEqual(f.roles.get('companion').bindings.dialogue.sourceInstanceId, f.roles.get('role-b').bindings.dialogue.sourceInstanceId);
  await assert.rejects(f.request('/api/characters/bindings','PUT',{ characterId:'companion', expectedRevision:0, operationId:'stale-bind-op', bindings:{ tts:{mode:'inherit-default'} } }), {status:409});
  const setup = await f.request('/api/self-setup');
  await assert.rejects(f.request('/api/self-setup/credentials','POST',{ instanceId:setup.instanceId, provider:'openai', key:'anonymous-third', expectedRevision:0, operationId:'stale-key-operation' }), {status:409});
  const none = await f.request('/api/provider-sources','POST',{ characterId:'role-b', slot:'dialogue', selection:{ ...f.roles.sources.list()[0].selection, endpoint:'http://127.0.0.1:13337/v1/chat/completions', credentialRef:'', auth:'none' } });
  assert.equal(none.entry.source.auth.kind,'none');
  let sent;
  const transport = new ProviderTransport(async (url, options) => { sent=options; return new Response(JSON.stringify({choices:[{message:{content:'fixture-response'}}]}),{headers:{'Content-Type':'application/json'}}); });
  await transport.request({ model:'fixture', endpoint:'http://127.0.0.1:13337/v1/chat/completions', authNone:true, apiKey:()=>{throw Error('免鉴权不应读取 Key');}, timeoutMs:200,
    authorizer:{async authorize(){return {async settle(){}};}} },{characterId:'role-b',sessionId:'test',turnId:'test',generation:0},'dialogue',{messages:[]},new AbortController().signal);
  assert.equal(new Headers(sent.headers).has('Authorization'),false);
});

test('简介只写简介，故事书字段保留；角色资料库和真实聊天按角色隔离', async t => {
  const f=await roleConsoleFixture(t), before=f.roles.get('companion');
  assert.equal((await f.request('/api/characters/profile?characterId=role-b')).identity.intro,'简介-role-b');
  await f.request('/api/characters/profile','PUT',{characterId:'companion',expectedFieldRevision:0,operationId:'intro-only-test',intro:'新简介'});
  assert.equal(f.roles.get('companion').persona.scenario,before.persona.scenario);
  assert.equal((await f.request('/api/prompt?characterId=companion')).text,'完整人设-companion');
  const lib=await f.request('/api/knowledge/libraries?characterId=role-b','POST',{name:'B 资料'});
  assert.equal((await f.request('/api/knowledge?characterId=companion')).libraries.length,0);
  await assert.rejects(f.request('/api/knowledge/documents/list?characterId=companion','POST',{libraryId:lib.libraries[0].id}),{status:404});
  for(const id of ['companion','role-b']) f.store.append({characterId:id,sessionId:'test',turnId:id,generation:1},[{characterId:id,id:`chat-${id}`,role:'user',text:`真实聊天-${id}`,createdAt:'2026-10-06T01:00:00.000Z'}]);
  const page=await f.request('/api/records?characterId=role-b&kind=transcript&from=2026-10-06T00:00:00Z&to=2026-10-07T00:00:00Z');
  assert.equal(page.total,1); assert.equal(page.records[0].text,'真实聊天-role-b');
  assert.equal((await f.request('/api/records?characterId=role-b&kind=transcript&from=2026-10-07T00:00:00Z')).total,0);
});

test('真实图片解码、规则图集、自定义 Live2D 入口与失败切换保留旧形象', async t => {
  const f=await roleConsoleFixture(t), browser=await chromium.launch(); t.after(()=>browser.close());
  const page=await browser.newPage();
  for(const type of ['png','webp']) {
    const data=await page.evaluate(type=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=16;const c=canvas.getContext('2d');c.fillStyle='red';c.fillRect(0,0,16,16);c.fillStyle='blue';c.fillRect(16,0,16,16);return canvas.toDataURL(`image/${type}`).split(',')[1];},type);
    const file=join(f.c.projectRoot,`sheet.${type}`); await writeFile(file,Buffer.from(data,'base64'));
    await f.skins.import(file,{type:'sprite',skinId:`sprite-${type}`,sprite:{rows:1,columns:2,frameCount:2,fps:12}});
    assert.equal(f.skins.describe(`sprite-${type}`).sprite.width,32);
  }
  await assert.rejects(f.skins.import(join(f.c.projectRoot,'sheet.png'),{type:'sprite',skinId:'invalid-frames',sprite:{rows:1,columns:2,frameCount:3}}),/帧数/);
  const corrupt=join(f.c.projectRoot,'broken.png');await writeFile(corrupt,'not a PNG');await assert.rejects(f.skins.import(corrupt,{type:'sprite',skinId:'broken-image'}),/解码/);
  const pack=join(f.c.projectRoot,'custom-live2d');await cp(join(f.root,'desktop/assets/local-model'),pack,{recursive:true});
  await rename(join(pack,'pet.model3.json'),join(pack,'custom.model3.json'));await rm(join(pack,'presets.json'));
  await f.skins.import(pack,{type:'live2d',skinId:'custom-live2d',entry:'custom.model3.json'});
  assert.equal(f.skins.describe('custom-live2d').modelEntry,'custom.model3.json');
  await assert.rejects(f.skins.import(pack,{skinId:'path-escape',entry:'../custom.model3.json'}),/超出|路径/);
  await f.skins.activate(f.skins.state().revision,'sprite-png');
  await f.request('/api/characters/appearance','PUT',{characterId:'role-b',resourceId:'custom-live2d',type:'live2d',operationId:'nonrunning-role-appearance'});
  assert.equal(f.roles.get('role-b').appearance.resourceId,'custom-live2d');assert.equal(f.skins.active().skinId,'sprite-png');
  f.skins.onActivate=async()=>{throw Error('injected renderer failure');};
  await assert.rejects(f.skins.activate(f.skins.state().revision,'custom-live2d'),/renderer failure/);
  assert.equal(f.skins.active().skinId,'sprite-png');
});

test('模型发现免 Key 和请求失败不产生推理成功', async () => {
  const discovery=new ModelDiscovery({credentials:{key(){throw Error('must not read a key');}},fetch:async(url,options)=>{assert.equal(new Headers(options.headers).has('Authorization'),false);return new Response(JSON.stringify({data:[{id:'fixture-model'}]}),{headers:{'Content-Type':'application/json'}});}});
  const value=await discovery.list({protocol:'openai-compatible',endpoint:'http://127.0.0.1:1234/v1/chat/completions',credentialRef:'',authNone:true});
  assert.ok(value.items.some(model=>model.id==='fixture-model'));
  const failing = new ModelDiscovery({ credentials:{key(){return 'anonymous';}},fetch:async()=>new Response('{}',{status:503}) });
  await assert.rejects(failing.list({protocol:'openai-compatible',endpoint:'https://example.invalid/v1/chat/completions',credentialRef:'fixture'}),error=>error.code==='unavailable');
  const timeout = new ModelDiscovery({ timeoutMs:10,credentials:{key(){return 'anonymous';}},fetch:async(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})) });
  const hold=setTimeout(()=>{},1000);
  try { await assert.rejects(timeout.list({protocol:'openai-compatible',endpoint:'https://example.invalid/v1/chat/completions',credentialRef:'fixture'}),error=>error.code==='timeout'); } finally { clearTimeout(hold); }
});

test('导入任务保存浏览角色与完整配对域，跨角色或实例任务不可操作',async t=>{
  const f=await roleConsoleFixture(t),pairing={userId:'local-user',characterId:'role-b',characterInstanceId:'role-b-custom'};
  const source=join(f.c.projectRoot,'history.jsonl');await writeFile(source,JSON.stringify({id:'history-user',timestamp:'2020-01-01T00:00:00Z',speaker:'user',text:'历史来源 B'})+'\n');
  const instanceId=(await f.request('/api/memory-import?characterId=role-b')).instanceId;
  const job=await f.request('/api/memory-import/start','POST',{instanceId,characterId:'role-b',pairing,operationId:'import-b-custom',source:{kind:'text-export',projectName:'anonymous B',path:source}});
  assert.deepEqual(job.pairing,pairing);
  assert.equal((await f.request('/api/memory-import?'+new URLSearchParams(pairing))).jobs.length,1);
  assert.equal((await f.request('/api/memory-import?'+new URLSearchParams({...pairing,characterInstanceId:'role-b-other'}))).jobs.length,0);
  assert.equal((await f.request('/api/memory-import?characterId=companion')).jobs.length,0);
  await assert.rejects(f.request('/api/memory-import/pause','POST',{instanceId,characterId:'role-b',pairing:{...pairing,characterInstanceId:'role-b-other'},jobId:job.id,expectedRevision:job.revision}),{status:409});
  const start=Date.now();while(f.memoryImport.snapshot('role-b',pairing).jobs[0].status!=='completed'){if(Date.now()-start>5000)throw Error(JSON.stringify(f.memoryImport.snapshot('role-b',pairing)));await new Promise(resolve=>setTimeout(resolve,10));}
  const db=f.store.rawDatabaseForKnowledge();
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE character_id='role-b' AND text='历史来源 B'").get().n,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE character_id='companion' AND text='历史来源 B'").get().n,0);
});
