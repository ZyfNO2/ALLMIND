import {mkdirSync,mkdtempSync,readFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
const production=resolve('../../.local/memory-book');mkdirSync('.local/allmind-m23/real',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m23/real/book-'));
const saved=JSON.parse(readFileSync(join(production,'runtime.json'),'utf8')).data;
if(saved.mainModel?.kind!=='chatgpt-web'||saved.chatgptWeb?.transport!=='bridge')throw Error('This replay requires the existing explicitly selected Chat bridge source.');
// Reuse the authorized local transport binding. No pairing reset, credential export, profile copy or new browser.
for(const name of ['chatgpt-bridge-key','chatgpt-bridge-key.client'])if(existsSync(join(production,name)))copyFileSync(join(production,name),join(directory,name));
const repository=new FileBookRepository(directory),config=repository.loadConfig();repository.commitConfig({...config,mainModel:saved.mainModel,wikiModel:saved.wikiModel,chatgptWeb:saved.chatgptWeb},0,'real-replay-source');repository.close();
const child=spawn(process.execPath,['dist/app/book-backend.js'],{windowsHide:true,env:{...process.env,AIKI_BOOK_DATA:directory,AIKI_BOOK_WEB_ONLY:'1',AIKI_BOOK_PORT:'0'},stdio:['pipe','ignore','pipe']});let stderr='';child.stderr.on('data',part=>stderr+=part);
try{
 const deadline=Date.now()+20000;while(!existsSync(join(directory,'management-session.json'))){if(child.exitCode!==null||Date.now()>deadline)throw Error(`Isolated backend unavailable: ${stderr}`);await new Promise(r=>setTimeout(r,100));}
 const evaluation=spawn(process.execPath,['tools/allmind-real-model-eval.mjs',directory],{windowsHide:true,stdio:['ignore','inherit','inherit']});process.exitCode=await new Promise((resolve,reject)=>{evaluation.once('error',reject);evaluation.once('exit',resolve);});
}finally{child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill();resolve()},5000).unref();});}
