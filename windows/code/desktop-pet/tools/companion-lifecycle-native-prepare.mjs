import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zonedParts,addDays,zonedTime} from '../dist/core/book-proactive.js';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
const directory=JSON.parse(readFileSync('.local/native-combined-current.json','utf8')).directory,input=JSON.parse(readFileSync(join(directory,'native-combined-input.json'),'utf8'));
input.evidence=resolve('../../../docs/next/allmind-companion-v2/evidence/companion-lifecycle-native.json');input.backend=join(directory,'lifecycle-runner.mjs');input.clockOffset=join(directory,'native-clock-offset.json');writeFileSync(input.clockOffset,JSON.stringify({offset:0}));
const repository=new FileBookRepository(directory);let last;try{last=repository.loadCompanionData({characterId:'aika',pairingId:'local-user',sessionId:'desktop'}).lastInteractionAt??Date.now()}finally{repository.close()}
let day=addDays(zonedParts(Date.now(),'Asia/Singapore').date,2),base=zonedTime(day,14,40,'Asia/Singapore');
while(base-last<26*3600000){day=addDays(day,1);base=zonedTime(day,14,40,'Asia/Singapore')}
writeFileSync(input.backend,`import {runBookBackend} from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-backend.js')).href)};import{BookRuntime}from ${JSON.stringify(pathToFileURL(resolve('dist/app/book-runtime.js')).href)};import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';const originalChat=BookRuntime.prototype.chat;BookRuntime.prototype.chat=async function(...args){const result=await originalChat.apply(this,args);if(!result.turn.incognito)writeFileSync(join(${JSON.stringify(directory)},'native-context-'+result.turn.id+'.json'),JSON.stringify({turnId:result.turn.id,traceId:result.turn.traceId,context:result.context}));return result};const start=Date.now();await runBookBackend(${JSON.stringify(directory)},{clock:()=>${base}+(Date.now()-start)+JSON.parse(readFileSync(${JSON.stringify(input.clockOffset)},'utf8')).offset});`);
writeFileSync(join(directory,'native-lifecycle-input.json'),JSON.stringify(input));console.log('Lifecycle setup ready');
