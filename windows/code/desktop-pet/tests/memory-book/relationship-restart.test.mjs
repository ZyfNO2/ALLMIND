import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {FactWikiService} from '../../dist/memory/fact-wiki.js';
import {emptyEntry} from '../../dist/contracts/memory-book.js';

test('independent Runtime processes preserve evolved relationship through model/template change and remove forgotten influence from all reply contexts',{timeout:30000},async t=>{
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/relationship-process-')),scope={characterId:'aika',pairingId:'local-user',sessionId:'restart'};
  const repository=new FileBookRepository(directory),wiki=new FactWikiService(repository),p=wiki.preview(scope,{sourceId:'private-relationship',title:'用户',text:'称呼：小林\n回复长度：希望简短些\n共同经历：昨天我和你一起整理旧照片',private:true});wiki.apply(scope,p.id,'seed');
  const before=repository.snapshot(scope).relationships[0],runtime=new BookRuntime(repository,{async complete(){throw Error('not called')}}),authored=emptyEntry('author-core','persona','作者角色','角色自主兴趣是阅读历史，核心身份保持。');
  const imported=runtime.imports.preview(scope,JSON.stringify({schemaVersion:'memory-book/v1',name:'作者模板',entries:[authored]}),'template.json');runtime.imports.apply(scope,imported.id,'import');
  const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9',model:'changed-model',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},config.revision,'change-model');repository.close();
  const runner=join(directory,'inspect.mjs');writeFileSync(runner,`import {FileBookRepository} from ${JSON.stringify(pathToFileURL(resolve('dist/memory/file-book-repository.js')).href)};import {BookRuntime} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-runtime.js')).href)};const repo=new FileBookRepository(${JSON.stringify(directory)}),runtime=new BookRuntime(repo,{async complete(){throw Error('local Inspector must not call model')}}),scope=${JSON.stringify(scope)};try{const own=await runtime.inspect(scope,'你好，我想继续聊天',new AbortController().signal),other=await runtime.inspect({...scope,pairingId:'other',sessionId:'other'},'你好',new AbortController().signal);console.log(JSON.stringify({own:own.messages,other:other.messages,relationship:repo.snapshot(scope).relationships[0],model:repo.loadConfig().mainModel.model}));}finally{repo.close();}`);
  async function inspect(){const child=spawn(process.execPath,[runner],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(code,0,stderr);return JSON.parse(stdout)}
  const restored=await inspect();assert.equal(restored.model,'changed-model');assert.deepEqual(restored.relationship,before);assert.match(JSON.stringify(restored.own),/小林/);assert.match(JSON.stringify(restored.own),/阅读历史/);assert.ok(!JSON.stringify(restored.other).includes('小林'));
  const reopened=new FileBookRepository(directory);new FactWikiService(reopened).revoke(scope,'private-relationship',reopened.snapshot(scope).revision,'forget');reopened.close();
  const forgotten=await inspect();assert.ok(!JSON.stringify(forgotten.own).includes('小林'));assert.ok(!JSON.stringify(forgotten.own).includes('旧照片'));assert.match(JSON.stringify(forgotten.own),/阅读历史/);assert.equal(forgotten.relationship.commonExperiences,0);assert.equal(forgotten.relationship.preferences.length,0);
});
