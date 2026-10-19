import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {SkinStore} from '../dist/management/skin-store.js';
import {PortraitStore} from '../dist/management/portrait-store.js';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {FileResourceStore} from '../dist/memory/file-resource-store.js';
import {BookResourceService} from '../dist/memory/book-resources.js';
import {createHash} from 'node:crypto';
const evidence=resolve('../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w02/review-20261016');mkdirSync(evidence,{recursive:true});mkdirSync('.local/w02-review',{recursive:true});
const directory=resolve(mkdtempSync('.local/w02-review/native-')),skins=await SkinStore.open(join(directory,'appearance-registry.json'),join(directory,'appearance-packs'),resolve('desktop'));
const portraits=await PortraitStore.open(join(directory,'portraits.json'),skins);let set=portraits.get('aika');
for(const [index,file]of ['portrait-01-original.png','portrait-02-original.png'].entries())set=await portraits.add({characterId:'aika',name:'原件差分 '+(index+1),file:resolve('../../../docs/next/chatgpt-integration/wiki-handoff/inputs/w02-allmind',file),origin:'user_supplied',operationId:'native-import-'+index,expectedRevision:set.revision,currentSkinId:skins.state().activeSkinId});
set=await portraits.select('aika',set.variants[0].id,set.revision,'native-select');
const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.close();
const real=JSON.parse(readFileSync(join(evidence,'real-outfit-resume.json'),'utf8')),actual=real.outputs[0];
if(real.job.phase!=='ready'||!actual?.hashAgrees||!actual.referenceDifferent)throw Error('真实生成接收证据尚未通过，不能用别的图片替代。');
const generated=readFileSync(join(evidence,'generated-1.png'));if(createHash('sha256').update(generated).digest('hex')!==actual.sha256)throw Error('归档生成图与产品接收回执不符。');
const scope={characterId:'aika',pairingId:'local-user',sessionId:'w02-native'},resources=new BookResourceService(new FileResourceStore({directory:join(directory,'resources')})),signal=new AbortController().signal;
const reference=await resources.receiveUpload(scope,{name:'real-reference.png',mime:'image/png'},readFileSync(resolve('../../../docs/next/chatgpt-integration/wiki-handoff/inputs/w02-allmind/portrait-01-original.png')),'native-reference',signal),output=await resources.receiveUpload(scope,{name:'real-generated.png',mime:'image/png'},generated,'native-real-output',signal);
const job={...real.job,scope,sourceFingerprint:createHash('sha256').update(JSON.stringify({binding:config.mainModel,web:config.chatgptWeb,currentCharacterId:config.currentCharacterId})).digest('hex'),expectedAppearanceRevision:set.revision,references:[{resourceId:reference.id,sha256:reference.sha256,resourceRevision:reference.revision}],outputResourceIds:[output.id],images:[{...real.job.images[0],resourceId:output.id,sha256:output.sha256}]};
writeFileSync(join(directory,'outfits.json'),JSON.stringify([job])+'\n');
writeFileSync(join(directory,'w02-native-input.json'),JSON.stringify({evidence,variants:set.variants,realJob:job,provenance:{source:'actual normal product GPT output replayed into isolated data for native apply; no fixture generation',normalJobId:real.job.id,normalScope:real.job.scope,sha256:actual.sha256}}));
const env={...process.env,AIKI_BOOK_DATA:directory,AIKI_BOOK_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
for(const stage of ['initial','restart']){
 const child=spawn(createRequire(import.meta.url)('electron'),[resolve('tools/w02-native-probe.mjs'),'--root',resolve('desktop'),'--node',process.execPath,'--backend',resolve('dist/app/book-backend.js'),'--companion-probe','--inactive-start','--probe-user-data',join(directory,'host-profile'),'--w02-stage',stage],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);const timeout=setTimeout(()=>child.kill(),120000);
 const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done)});clearTimeout(timeout);
 writeFileSync(join(evidence,'native-'+stage+'-log.json'),JSON.stringify({code,directory,stdout:stdout.replace(/(#token=|Bearer )[A-Za-z0-9_-]+/g,'$1[redacted]'),stderr:stderr.replace(/(#token=|Bearer )[A-Za-z0-9_-]+/g,'$1[redacted]')},null,2));
 const report=JSON.parse(readFileSync(join(evidence,'native-'+stage+'.json'),'utf8'));console.log(JSON.stringify({stage,code,status:report.status,checks:report.checks.length,evidence}));if(code!==0||report.status!=='AUTO_PASS_PENDING_USER_REVIEW'){process.exitCode=1;break;}
}
