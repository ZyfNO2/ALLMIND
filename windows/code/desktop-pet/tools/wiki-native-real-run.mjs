import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
const original=JSON.parse(readFileSync(resolve('../../.local/memory-book/runtime.json'),'utf8')).data;
if(original.chatgptWeb?.transport!=='embedded'||original.chatgptWeb?.conversationMode!=='regular'||original.chatgptWeb?.temporaryChatTests!==false||original.wikiModel?.kind!=='chatgpt-web')throw Error('Requires the authorized regular embedded Wiki binding');
mkdirSync('.local/allmind-m4/tests',{recursive:true});const directory=mkdtempSync(resolve('.local/allmind-m4/tests/native-real-wiki-'));
const repository=new FileBookRepository(directory),config=repository.loadConfig(),characterId=original.currentCharacterId;
repository.commitConfig({...config,characters:[{id:characterId,name:'Wiki 合成验收',intro:'',appearancePath:null}],currentCharacterId:characterId,mainModel:original.mainModel,wikiModel:original.wikiModel,chatgptWeb:original.chatgptWeb},config.revision,'native-real-config');
const scope={characterId,pairingId:'local-user',sessionId:'native-wiki-check'},wiki=new FactWikiService(repository);
for(const [sourceId,text] of [['native-a','称呼：验收人物小岚'],['native-b','昵称：验收人物小岚']]){const preview=wiki.preview(scope,{sourceId,title:'用户',text,private:true});wiki.apply(scope,preview.id,sourceId)}
const page=repository.snapshot(scope).wikiPages.find(page=>page.kind==='profile');if(!page||page.sourceIds.length!==2)throw Error('Synthetic two-source profile missing');repository.close();
const evidence=resolve('../../../docs/next/allmind-companion-v2/evidence/wiki-native-real.json');
writeFileSync(join(directory,'wiki-native-input.json'),JSON.stringify({evidence,characterId,pageId:page.id}));
// The normal instance must be stopped before using this original profile. No cookies/profile copy.
const profile=join(process.env.APPDATA,'AikaNext','desktop');
const child=spawn(createRequire(import.meta.url)('electron'),[resolve('tools/wiki-native-real-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',resolve('dist/app/book-backend.js'),'--companion-probe','--background-acceptance','--probe-user-data',profile],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stdout.on('data',part=>process.stdout.write(part));child.stderr.on('data',part=>{stderr+=part;writeFileSync(join(directory,'native.stderr.log'),stderr)});
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
const report=JSON.parse(readFileSync(evidence,'utf8'));report.exitCode=code;report.isolatedBookDirectory=directory;writeFileSync(evidence,JSON.stringify(report,null,2));process.exitCode=code===0&&report.status==='GENERATED_REQUIRES_REVIEW'?0:1;
