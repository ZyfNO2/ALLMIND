import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CHATGPT_WEB_SOURCE } from '../../contracts/memory-book.js';
import { projectIdFromUrl, type ChatgptProjectBinding } from '../../contracts/chatgpt-project.js';
import { ChatgptBackgroundBridge } from '../../providers/chatgpt-background-bridge.js';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import { validateRuntime } from '../../memory/book-validation.js';
import { ChatgptWebModel } from '../../providers/chatgpt-web-model.js';

const binding: ChatgptProjectBinding = {id:'binding-1',characterId:'allmind',pairingId:'local-user',enabled:true,projectId:'g-p-'+'a'.repeat(32),name:'ALLMIND',account:'b'.repeat(64),memory:'unverified'};
const scope = {characterId:'allmind',pairingId:'local-user',sessionId:'session-a'};

function fixtureDirectory(prefix: string): string {
  // Windows sandbox temp permits creation but can reject atomic replacement.
  // Use the same explicit workspace fixtures as repository.test.ts; keep real I/O.
  const root = join(process.cwd(), '.local', 'memory-book-tests');
  mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, prefix));
}
test('project URL parser rejects GPTs, external origins, credentials and query destinations',()=>{
  assert.equal(projectIdFromUrl('https://chatgpt.com/g/'+binding.projectId+'-allmind/project'),binding.projectId);
  for(const url of ['https://evil.test/g/'+binding.projectId+'/project','https://chatgpt.com/g/g-123/project','https://user@chatgpt.com/g/'+binding.projectId+'/project','https://chatgpt.com/g/'+binding.projectId+'/project?next=evil'])assert.throws(()=>projectIdFromUrl(url));
});
test('project config is private, bounded and rejects duplicate project or non-embedded source',()=>{
  const directory=fixtureDirectory('aiki-project-config-');const repository=new FileBookRepository(directory);
  try{
    const current=repository.loadConfig(),config={...current,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded' as const},chatgptProjects:[{...binding,characterId:current.currentCharacterId}]};
    validateRuntime(config);assert.throws(()=>validateRuntime({...config,chatgptWeb:{...config.chatgptWeb,transport:'bridge'}}),/独立页面/);
    assert.throws(()=>validateRuntime({...config,characters:[...config.characters,{...config.characters[0]!,id:'second'}],chatgptProjects:[config.chatgptProjects[0]!,{...binding,id:'binding-2',characterId:'second'}]}),/重复绑定/);
  }finally{repository.close();rmSync(directory,{recursive:true,force:true});}
});
test('model routes only scoped replies into project, keeps wiki and debug outside, sends only systems on continuation',async()=>{
  const calls:any[]=[];
  const model=new ChatgptWebModel({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded',conversationMode:'regular',temporaryChatTests:false}),runtime:()=>({chatgptProjects:[binding]} as any),bridge:{ask:async input=>{calls.push(input);return {kind:'completed',text:'OK',conversationId:'c-1',durationMs:1};}}});
  const llm={kind:'chatgpt-web' as const,baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:4096,outputTokens:512},messages=[{role:'system' as const,content:'current system'},{role:'assistant' as const,content:'old history'},{role:'user' as const,content:'now'}];
  await model.complete(llm,messages,new AbortController().signal,{purpose:'reply',scope,localTurnId:'t-1',nextTurnId:'t-2'});
  assert.equal(calls[0].project.binding.projectId,binding.projectId);assert.equal(calls[0].temporary,false);assert.ok(calls[0].context.includes('old history'));assert.ok(!calls[0].continuationContext.includes('old history'));
  await model.complete(llm,messages,new AbortController().signal,{purpose:'wiki',scope});assert.equal(calls[1].project,undefined);assert.equal(calls[1].temporary,false);
  await model.complete(llm,messages,new AbortController().signal,{purpose:'test',scope:{...scope,sessionId:'debug-1'}});assert.equal(calls[2].project,undefined);assert.equal(calls[2].temporary,false);
});
test('project bridge verifies account and ancestry, persists thread across restart, never resends or repeats history',async()=>{
  const directory=fixtureDirectory('aiki-project-');try{
    const receiptPath=join(directory,'receipt.json'),calls:Array<{action:string,input:any}>=[];let currentNode='a-1',conversation='c-1';
    const host={async navigate(_temporary:boolean,target?:any){calls.push({action:'navigate',input:target});},async login(){},async execute(action:string,input:any={}){
      calls.push({action,input});
      if(action==='account')return {account:binding.account};
      if(action==='project')return {projectId:binding.projectId,name:'ALLMIND',conversationId:input.conversationId??null,currentNode};
      if(action==='probe'||action==='prepare')return {ready:true,temporary:false,hasTurns:false};
      if(action==='model')return {model:input.model};
      if(action==='submit')return {submitted:true};
      if(action==='read')return {state:'completed',text:'reply',conversationId:conversation,messageId:currentNode};
      return {ok:true};
    }};
    const create=()=>new ChatgptBackgroundBridge({config:()=>({...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'}),pageHost:host,receiptPath,intervalMs:0});
    const ask=(bridge:ChatgptBackgroundBridge,id:string,local:string|null,next:string|null)=>bridge.ask({requestId:id,prompt:'new question',context:'SYSTEM + OLD HISTORY',continuationContext:'SYSTEM ONLY',project:{binding,scope,localTurnId:local,nextTurnId:next},temporary:false,timeoutMs:5000});
    assert.equal((await ask(create(),'request-1',null,'turn-1')).kind,'completed');
    const bridge=create();currentNode='a-1';calls.length=0;
    assert.equal((await ask(bridge,'request-2','turn-1','turn-2')).kind,'completed');
    assert.equal(calls.find(row=>row.action==='navigate')?.input?.conversationId,'c-1');
    assert.ok(!calls.filter(row=>row.action==='write').some(row=>row.input.text.includes('OLD HISTORY')));
    const submissions=calls.filter(row=>row.action==='submit').length;
    assert.equal((await ask(bridge,'request-2','turn-2','turn-3')).kind,'failed');
    assert.equal(calls.filter(row=>row.action==='submit').length,submissions);
    const changed={...binding,id:'new-binding',projectId:'g-p-'+'c'.repeat(32),name:'另一个项目'};
    const oldArchive=bridge.projectThreads(changed,scope);
    assert.equal(oldArchive?.projectId,binding.projectId);assert.equal(oldArchive?.projectName,binding.name);assert.equal(oldArchive?.targetChanged,true);
    assert.equal(create().projectThreads(null,scope)?.conversationId,'c-1','confirmed original archive remains readable after unbinding/restart');
    const beforeChange=calls.filter(row=>row.action==='submit').length;
    const moved=await bridge.ask({requestId:'changed-binding-old-session',prompt:'must not migrate old history',project:{binding:changed,scope,localTurnId:'turn-2',nextTurnId:'turn-3'},temporary:false,timeoutMs:1000});
    assert.equal(moved.kind,'failed');assert.equal(calls.filter(row=>row.action==='submit').length,beforeChange);
    currentNode='external-edit';assert.equal((await ask(bridge,'request-3','turn-2','turn-3')).kind,'failed');
    assert.equal(calls.filter(row=>row.action==='submit').length,submissions);
    conversation='c-2';
    assert.equal((await bridge.ask({requestId:'wrong-account',prompt:'secret',project:{binding:{...binding,account:'c'.repeat(64)},scope,localTurnId:null,nextTurnId:'t'},temporary:false,timeoutMs:1000})).kind,'failed');
    assert.equal(calls.filter(row=>row.action==='submit').length,submissions);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
