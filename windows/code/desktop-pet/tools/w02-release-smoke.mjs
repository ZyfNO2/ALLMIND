import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('.');mkdirSync('.local/release-smoke',{recursive:true});const directory=resolve(mkdtempSync('.local/release-smoke/instance-'));
const child=spawn(process.execPath,[resolve('dist/app/book-backend.js')],{cwd:root,env:{...process.env,AIKI_BOOK_WEB_ONLY:'1',AIKI_BOOK_PORT:'0',AIKI_BOOK_DATA:directory},windowsHide:true,stdio:['pipe','ignore','pipe']});let stderr='';child.stderr.on('data',data=>stderr+=data);
const report={kind:'independent exported production backend and built UI, isolated data, no external model calls',directory,startedAt:new Date().toISOString(),status:'IN_PROGRESS'};
try{
 const file=join(directory,'management-session.json'),deadline=Date.now()+20000;while(!existsSync(file)){if(child.exitCode!==null)throw Error('Export backend exited '+child.exitCode);if(Date.now()>deadline)throw Error('Export startup timeout');await new Promise(done=>setTimeout(done,80));}
 const url=new URL(JSON.parse(readFileSync(file,'utf8')).url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token')};
 const runtime=await fetch(url.origin+'/api/memory-book/v1/runtime',{headers});if(!runtime.ok)throw Error('Export runtime HTTP '+runtime.status);report.runtimeStatus=runtime.status;
 const page=await fetch(url.origin+'/character');report.uiTitleAllmind=(await page.text()).includes('<title>ALLMIND');if(!page.ok||!report.uiTitleAllmind)throw Error('Built ALLMIND UI did not load');
 const query='?characterId=aika&sessionId=release-smoke',bytes=Buffer.from('# Export smoke\n合成资料验证。');const upload=await fetch(url.origin+'/api/memory-book/v1/resources/upload'+query+'&name=release.md&operationId=release-upload',{method:'POST',headers:{...headers,'Content-Type':'text/markdown'},body:bytes});const record=await upload.json();if(!upload.ok)throw Error('Export upload failed');
 const material=await fetch(url.origin+'/api/memory-book/v1/resources/'+record.id+'/material'+query,{headers}),value=await material.json();report.resourceHashAgrees=value.sha256===createHash('sha256').update(bytes).digest('hex')&&value.text.includes('合成资料验证');if(!material.ok||!report.resourceHashAgrees)throw Error('Export material readback failed');report.status='PASS';
}catch(error){report.status='FAILED';report.error=String(error);process.exitCode=1;}finally{
 child.stdin.end();const timeout=setTimeout(()=>child.kill(),10000);const code=await new Promise(done=>{if(child.exitCode!==null)done(child.exitCode);else child.once('exit',done)});clearTimeout(timeout);report.exitCode=code;report.lockRemoved=!existsSync(join(directory,'writer.lock'));report.stderr=stderr.replace(/(#token=|Bearer )[A-Za-z0-9_-]+/g,'$1[redacted]');if(code!==0||!report.lockRemoved){report.status='FAILED';process.exitCode=1;}report.finishedAt=new Date().toISOString();writeFileSync('.local/release-smoke/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
