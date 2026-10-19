import {app} from 'electron';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const directory=process.env.AIKI_BOOK_DATA,input=JSON.parse(readFileSync(join(directory,'wiki-native-input.json'),'utf8'));
const report={status:'IN_PROGRESS',productionFactsWritten:false,transport:'Production HTTP Wiki endpoint -> Runtime -> ChatgptWebModel -> embedded page host; isolated Book with original signed-in page profile',startedAt:new Date().toISOString()};
const save=()=>writeFileSync(input.evidence,JSON.stringify(report,null,2));
async function run(){try{
  save();await import('../desktop/electron/main.mjs');await app.whenReady();
  const deadline=Date.now()+30000;let session;
  while(Date.now()<deadline){try{session=JSON.parse(readFileSync(join(directory,'management-session.json'),'utf8'));break}catch(error){if(error.code!=='ENOENT')throw error}await new Promise(resolve=>setTimeout(resolve,100))}
  if(!session)throw Error('Native backend did not publish management session');
  const url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const request=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(330000)}),result=await response.json();if(!response.ok)throw Error(result.error?.message??'HTTP '+response.status);return result};
  const scope={characterId:input.characterId,sessionId:'native-wiki-check'};
  const queued=await request('/wiki/compilation/queue',{...scope,pageIds:[input.pageId],operationId:'native-real-queue'});report.jobId=queued.job.id;save();
  const started=Date.now(),generated=await request('/wiki/compilation/run',{...scope,jobId:queued.job.id});report.durationMs=Date.now()-started;report.job=generated.job;save();
  if(generated.job.status!=='review'||generated.job.results.length!==1)throw Error('Real Wiki endpoint did not produce a complete review draft');
  const paragraph=generated.job.results[0].paragraphs.map(row=>row.text).join('\n');
  if(!paragraph.includes('小岚'))throw Error('Real synthesis lost explicit synthetic nickname');
  report.status='GENERATED_REQUIRES_REVIEW';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,durationMs:report.durationMs,evidence:input.evidence}));
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.stack:String(error);save();console.error(report.error);process.exitCode=1}finally{app.quit()}}
void run();
