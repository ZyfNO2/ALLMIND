import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {SkinStore} from '../dist/management/skin-store.js';
import {DEFAULT_CHATGPT_WEB_SOURCE} from '../dist/contracts/memory-book.js';
import {CHARACTER_STATES} from '../dist/contracts/character-state.js';
import {createHash} from 'node:crypto';

const root=resolve('.local/chat-delivery-background');mkdirSync(root,{recursive:true});
const projectFixture=process.argv.includes('--project-fixture');
const embeddedFixture=projectFixture||process.argv.includes('--embedded-fixture');
const directory=mkdtempSync(join(root,'native-')),screenshots=resolve('../../../docs/next/chatgpt-integration/evidence/background');mkdirSync(screenshots,{recursive:true});
const evidence=resolve('../../../docs/next/chatgpt-integration/evidence/'+(projectFixture?'project-routing-native.json':embeddedFixture?'chat-delivery-embedded-background.json':'chat-delivery-background.json')),modelResponses=[];
let count=0;
const provider=createServer(async(request,response)=>{for await(const part of request){}const index=++count;await new Promise(r=>setTimeout(r,300));
  modelResponses.push({index,at:Date.now()});response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:`BACKGROUND-${index}-OK`}}]}));});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
try{
  const artworkRoot=resolve('.local/allmind-m01'),artwork=readdirSync(artworkRoot).map(name=>join(artworkRoot,name,'original-test-pet.png')).find(path=>existsSync(path));
  if(!artwork)throw Error('Original isolated test artwork missing.');
  const skins=await SkinStore.open(join(directory,'appearance-registry.json'),join(directory,'appearance-packs'),resolve('desktop'));
  await skins.import(artwork,{type:'sprite',skinId:'background-original',label:'后台隔离验收',sprite:{rows:1,columns:14,frameCount:14,fps:8,clips:Object.fromEntries(CHARACTER_STATES.map((state,i)=>[state,{start:i*2,frameCount:2,fps:8}]))}});
  const repository=new FileBookRepository(directory),config=repository.loadConfig();
  repository.commitConfig({...config,characters:[{...config.characters[0],name:'后台隔离验收',appearanceSkinId:'background-original'}],chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE,transport:'embedded',authorizedPurposes:embeddedFixture?['reply']:[]},mainModel:embeddedFixture?{kind:'chatgpt-web',baseUrl:'chatgpt-web',model:'GPT-6',credentialId:'none',inputTokens:8192,outputTokens:1024}:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'local-protocol-fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:1024}},0,'background-fixture');repository.close();
  if(projectFixture){const repository=new FileBookRepository(directory),saved=repository.loadConfig();repository.commitConfig({...saved,chatgptWeb:{...saved.chatgptWeb,conversationMode:'regular',temporaryChatTests:false},chatgptProjects:[{id:'fixture-binding',characterId:saved.currentCharacterId,pairingId:'local-user',enabled:true,projectId:'g-p-'+'a'.repeat(32),name:'项目隔离验收',account:createHash('sha256').update('isolated-fixture-account').digest('hex'),memory:'unverified'}]},saved.revision,'project-fixture');repository.close();}
  writeFileSync(join(directory,'background-input.json'),JSON.stringify({evidence,screenshotDirectory:screenshots,embeddedFixture,projectFixture}));
  const child=spawn(createRequire(import.meta.url)('electron'),[resolve('tools/chat-delivery-background-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',resolve('dist/app/book-backend.js'),'--companion-probe','--background-acceptance','--probe-user-data',join(directory,'user-data')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>{stderr+=data;writeFileSync(join(directory,'native.stderr.log'),stderr);});child.stdout.on('data',()=>{});
  const code=await new Promise((r,reject)=>{child.once('error',reject);child.once('exit',r);});
  const report=JSON.parse(readFileSync(evidence,'utf8'));report.exitCode=code;report.modelRequests=embeddedFixture?report.embeddedResponses?.length ?? 0:count;report.modelResponses=embeddedFixture?report.embeddedResponses ?? []:modelResponses;
  report.timings=report.turns.map(turn=>({index:turn.index,responseToDisplayObservedMs:turn.displayObservedAt-report.modelResponses.find(response=>response.index===turn.index).at}));
  report.stderr=stderr;report.productionDataChanged=false;report.fixtureDirectory=directory;writeFileSync(evidence,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,evidence,modelRequests:report.modelRequests,timings:report.timings,screenshots:report.screenshots}));process.exitCode=code || (report.status==='PASS'&&report.modelRequests===2?0:1);
}finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
