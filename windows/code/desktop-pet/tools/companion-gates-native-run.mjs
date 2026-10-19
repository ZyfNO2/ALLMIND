// Independent native gate acceptance: local HTTP model fixture, production Book/host/ack.
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {SkinStore,BUILT_IN_SKIN_ID} from '../dist/management/skin-store.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
import {DEFAULT_COMPANION_SETTINGS} from '../dist/contracts/book-companion.js';
import {DEFAULT_CHATGPT_WEB_SOURCE} from '../dist/contracts/memory-book.js';
import {CHARACTER_STATES} from '../dist/contracts/character-state.js';
import {parseCompanionEvent,zonedTime} from '../dist/core/book-proactive.js';
mkdirSync('.local/allmind-m4/tests',{recursive:true});
const reminders=process.argv.includes('--reminders');
const live2d=process.argv.includes('--live2d'),interactions=process.argv.includes('--interactions')||live2d;if(reminders&&interactions)throw Error('Choose one isolated mode');
const directory=resolve(mkdtempSync('.local/allmind-m4/tests/native-gates-'));
const evidence=resolve('../../../docs/next/allmind-companion-v2/evidence/'+(live2d?'companion-interactions-live2d-native.json':interactions?'companion-interactions-native.json':reminders?'companion-reminders-native.json':'companion-gates-native.json'));
if(existsSync(evidence))throw Error('Evidence exists; archive explicitly before another run');
let calls=0,child;
const provider=createServer(async(request,response)=>{try{let raw='';for await(const part of request)raw+=part;JSON.parse(raw);calls++;if(interactions&&raw.includes('原生交互仲裁测试')){const until=Date.now()+20000;while(!existsSync(join(directory,'release-dialogue.json'))&&Date.now()<until)await new Promise(done=>setTimeout(done,20));if(!existsSync(join(directory,'release-dialogue.json')))throw Error('Native interaction dialogue gate was not released');}response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'隔离主动验收消息 '+calls}}]}));}catch(error){response.writeHead(500);response.end(String(error));}});
try{
 await new Promise(done=>provider.listen(0,'127.0.0.1',done));
 const skins=await SkinStore.open(join(directory,'appearance-registry.json'),join(directory,'appearance-packs'),resolve('desktop'));
 if(live2d){const original=skins.manifest(BUILT_IN_SKIN_ID),source=join(directory,'reviewed-model-source');cpSync(resolve('desktop/assets/local-model'),source,{recursive:true});writeFileSync(join(source,'presets.json'),JSON.stringify({schemaVersion:1,modelId:'native-live-interactions',modelFingerprint:original.modelFingerprint,items:[{id:'native-tap',label:'原始TapBody动作',category:'pose',source:'model-motion',availability:'manual',defaultEnabled:false,previewable:true,motionGroup:'TapBody',motionIndex:0}]}));await skins.import(source,{skinId:'native-live-interactions',entry:original.modelEntry,label:'隔离原模型真实TapBody动作'});}
 if(!live2d){const own=resolve('.local/allmind-m01'),image=readdirSync(own).map(name=>join(own,name,'original-test-pet.png')).find(existsSync);if(!image)throw Error('Synthetic sprite missing');await skins.import(image,{type:'sprite',skinId:'gate-fixture',label:'隔离验收',sprite:{rows:1,columns:14,frameCount:14,fps:8,clips:Object.fromEntries(CHARACTER_STATES.map((state,index)=>[state,{start:index*2,frameCount:2,fps:8}]))}});}
 const cases=interactions?['interaction-a','interaction-b']:reminders?['valid','reminder-delete']:['valid','hidden','dnd','focus','cancel','forget','role'],roles=cases.map((gate,index)=>({id:index?'gate-'+gate:'aika',name:'隔离 '+gate,intro:'',appearancePath:null,appearanceSkinId:live2d?'native-live-interactions':'gate-fixture'}));roles.push({id:'gate-other',name:'目标隔离角色',intro:'',appearancePath:null,appearanceSkinId:live2d?'native-live-interactions':'gate-fixture'});
 const repository=new FileBookRepository(directory),config=repository.loadConfig(),binding={baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,credentialId:'local-no-auth',model:'gate-fixture',inputTokens:16384,outputTokens:1024};
 repository.commitConfig({...config,characters:roles,mainModel:binding,wikiModel:binding,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded'},companion:{...DEFAULT_COMPANION_SETTINGS,autoMemory:true,extraction:'declarations',proactive:false}},config.revision,'gate-config');
 for(const role of reminders||interactions?[]:roles.slice(0,-1)){
  const scope={characterId:role.id,pairingId:'local-user',sessionId:'desktop'},wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'gate-source',title:'合成测试来源',private:true,text:'面试安排：2026-10-16 下午三点面试'});wiki.apply(scope,preview.id,'gate-source');
  const entry=repository.snapshot(scope).entries.find(row=>row.fact?.sourceId==='gate-source');if(!entry)throw Error('Fixture fact missing');
  const data=repository.loadCompanionData(scope);data.events=[parseCompanionEvent(entry.fact.quote,'2026-10-15T10:00:00+08:00','Asia/Singapore',entry.id,entry.revision)];if(!data.events[0]?.at)throw Error('Fixture event missing');repository.saveCompanionData(scope,data);
 }
 repository.close();
 const backend=join(directory,'runner.mjs'),at=zonedTime('2026-10-16',14,reminders?39:40,'Asia/Singapore'),clockOffset=join(directory,'clock-offset.json');writeFileSync(clockOffset,JSON.stringify({offset:0}));
 writeFileSync(backend,`import {readFileSync} from 'node:fs';import {runBookBackend} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-backend.js')).href)};const start=Date.now();await runBookBackend(${JSON.stringify(directory)},{clock:()=>${at}+Date.now()-start+JSON.parse(readFileSync(${JSON.stringify(clockOffset)},'utf8')).offset});`);
 writeFileSync(join(directory,'native-gates-input.json'),JSON.stringify({directory,evidence,cases,reminders,interactions,live2d,clockOffset,roles:roles.map(role=>role.id)}));
 child=spawn(createRequire(import.meta.url)('electron'),[resolve(interactions?'tools/companion-interactions-native-probe.mjs':'tools/companion-gates-native-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',backend,'--companion-probe','--background-acceptance','--probe-user-data',join(directory,'profile')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stdout.on('data',part=>process.stdout.write(part));child.stderr.on('data',part=>{stderr+=part;writeFileSync(join(directory,'native.stderr.log'),stderr)});
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});writeFileSync(join(directory,'provider-count.json'),JSON.stringify({calls}));process.exitCode=code??1;console.log(JSON.stringify({code,directory,calls,evidence}));
}finally{provider.closeAllConnections();await new Promise(done=>provider.close(done));}
