import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GptNiangLocal} from '../../management/gpt-niang-local.js';

test('local GPT-Niang reads whitelisted snapshot fields and character-bound image tickets without credentials',async t=>{
  const root=mkdtempSync(join(tmpdir(),'allmind-niang-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const app=join(root,'widget'),local=join(root,'local'),assets=join(app,'assets');mkdirSync(assets,{recursive:true});
  mkdirSync(join(local,'GPTNiangUsage','state'),{recursive:true});mkdirSync(join(local,'GPTNiangUsage','update-agent'),{recursive:true});
  writeFileSync(join(local,'GPTNiangUsage','update-agent','binding.json'),JSON.stringify({appDir:app,dataDir:'ignored-private-redirect'}));
  writeFileSync(join(assets,'gpt-dragon-niang-bust.png'),'synthetic image bytes');
  writeFileSync(join(assets,'characters.json'),JSON.stringify({version:1,characters:[{name:'合成龙娘',file:'gpt-dragon-niang-bust.png'}]}));
  const status=join(local,'GPTNiangUsage','state','status.json');
  writeFileSync(status,JSON.stringify({ok:true,observedAt:Date.now(),windows:[{minutes:300,remaining:45,resetsAt:null}],accountKey:'SECRET_ACCOUNT',token:'SECRET_TOKEN'}));
  const reader=new GptNiangLocal(local),report=await reader.inspect('role-a');assert.equal(report.quota.state,'fresh');assert.equal(report.portraits.length,1);
  assert.ok(!JSON.stringify(report).includes('SECRET'));assert.equal((await reader.portrait('role-a',report.portraits[0]!.id)).toString(),'synthetic image bytes');
  await assert.rejects(reader.portrait('role-b',report.portraits[0]!.id),{code:'not_found'});
  writeFileSync(join(assets,'gpt-dragon-niang-bust.png'),'changed');await assert.rejects(reader.portrait('role-a',report.portraits[0]!.id),{code:'conflict'});
  writeFileSync(status,JSON.stringify({ok:true,observedAt:Date.now()-400000,windows:[{minutes:300,remaining:45,resetsAt:null}]}));assert.equal((await reader.inspect('role-a')).quota.state,'stale');
  writeFileSync(status,JSON.stringify({ok:true,queryOk:false,observedAt:Date.now(),windows:[{minutes:300,remaining:45,resetsAt:null}]}));assert.equal((await reader.inspect('role-a')).quota.state,'stale','failed refresh must not advertise the cached result as current');
  writeFileSync(join(assets,'characters.json'),JSON.stringify({characters:[{file:'../../secret.png'}]}));await assert.rejects(reader.inspect('role-a'),{code:'invalid_input'});
});
test('missing installation is explicitly unavailable and never fabricated',async t=>{
  const root=mkdtempSync(join(tmpdir(),'allmind-no-niang-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const report=await new GptNiangLocal(root).inspect('role');assert.equal(report.installed,false);assert.equal(report.quota.state,'unavailable');assert.deepEqual(report.portraits,[]);
});
