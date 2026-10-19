import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {SkinStore} from '../dist/management/skin-store.js';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/native-repair-')),evidence=resolve(process.env.UI_V4_NATIVE_EVIDENCE??'../../../docs/next/ui-rework/evidence/ui-v4-acceptance-20261015/native.json');mkdirSync(resolve(evidence,'..'),{recursive:true});
const image=resolve('tests/companion-knowledge/fixtures/ocr/blank.png'),hash=createHash('sha256').update(readFileSync(image)).digest('hex');let modelRequests=0,lengthPolicySeen=false;
const model=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;modelRequests++;lengthPolicySeen=JSON.stringify(JSON.parse(body).messages).includes('最少 50 字');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'你好。'},finish_reason:'stop'}]}))});await new Promise(done=>model.listen(0,'127.0.0.1',done));
try{
 const skins=await SkinStore.open(join(directory,'appearance-registry.json'),join(directory,'appearance-packs'),resolve('desktop'));
 await skins.import(image,{type:'sprite',skinId:'declared-role',sprite:{clips:{happy:{start:0,frameCount:1}}},localInteractions:{schemaVersion:'local-pet/v1',skinId:'declared-role',assetFingerprint:hash,bindings:{feeding:{kind:'sprite',targetId:'happy'}}}});await skins.import(image,{type:'sprite',skinId:'generic-role'});
 const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.commitConfig({...config,characters:[{...config.characters[0],appearanceSkinId:'declared-role',replyLength:{minChars:50,maxChars:150}},{id:'other',name:'隔离角色',intro:'',appearancePath:null,appearanceSkinId:'generic-role'}],mainModel:{baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'local-protocol-fixture',credentialId:'local-no-auth',inputTokens:8192,outputTokens:512}},config.revision,'native-config');repository.close();writeFileSync(join(directory,'repair-native-input.json'),JSON.stringify({evidence,hash}));
 const env={...process.env,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(createRequire(import.meta.url)('electron'),[resolve('tools/ui-v4-native-repair-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',resolve('dist/app/book-backend.js'),'--companion-probe','--inactive-start','--probe-user-data',join(directory,'host-profile')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
 const timer=setTimeout(()=>child.kill(),120000);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});clearTimeout(timer);const report=JSON.parse(readFileSync(evidence,'utf8'));Object.assign(report,{exitCode:code,modelRequests,lengthPolicySeen,dataDirectory:directory,stdout:stdout.replace(/(#token=|Bearer )[A-Za-z0-9_-]+/gu,'$1[redacted]'),stderr:stderr.replace(/(#token=|Bearer )[A-Za-z0-9_-]+/gu,'$1[redacted]')});writeFileSync(evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({evidence,status:report.status,exitCode:code,modelRequests,lengthPolicySeen}));if(code!==0||report.status!=='AUTO_PASS_PENDING_USER_REVIEW'||modelRequests!==1||!lengthPolicySeen)process.exitCode=1;
}finally{await new Promise(done=>model.close(done))}
