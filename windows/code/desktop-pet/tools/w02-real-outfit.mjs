// Only normal product HTTP endpoints are used. The product uploads, discovers and receives bytes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const evidence='../../../docs/next/chatgpt-integration/wiki-handoff/evidence/w02/review-20261016';mkdirSync(evidence,{recursive:true});
const session=new URL(JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8')).url),headers={Authorization:'Bearer '+new URLSearchParams(session.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const mode=process.argv.includes('--regular')?'regular':'temporary',report={startedAt:new Date().toISOString(),kind:'normal-product-real-GPT-image-generation',conversationMode:mode,phase:'preparing'},save=()=>writeFileSync(evidence+'/real-outfit-'+mode+'.json',JSON.stringify(report,null,2)+'\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const call=async(path,body,method)=>{const response=await fetch(session.origin+'/api/memory-book/v1'+path,{method:method??(body?'POST':'GET'),headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(300000)}),result=await response.json();if(!response.ok)throw Error(path.split('?')[0]+' HTTP '+response.status+' '+JSON.stringify(result));return result;};
try{
 const runtime=await call('/runtime'),config=runtime.config;report.configHashBefore=hash(JSON.stringify(config));
 report.scope={characterId:config.currentCharacterId,sessionId:'w02-review-outfit-'+Date.now().toString(36)};
 const query='?'+new URLSearchParams(report.scope),status=await call('/chatgpt-web/status');
 if(status.activeRequest||status.state!=='signed-in')throw Error('网页来源不空闲或未登录。');
 const source=readFileSync('../../../docs/next/chatgpt-integration/wiki-handoff/inputs/w02-allmind/portrait-01-original.png');
 const upload=await fetch(session.origin+'/api/memory-book/v1/resources/upload'+query+'&name=w02-outfit-reference.png&operationId=w02-review-ref',{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':'image/png'},body:source});const record=await upload.json();if(!upload.ok)throw Error('参考图上传失败：'+upload.status);
 report.reference={id:record.id,bytes:record.bytes,sha256:record.sha256,revision:record.revision};
 const portraits=await call('/appearance/portraits'+query);
 report.operationId='w02-real-outfit-'+Date.now().toString(36);report.phase='submitting';save();
 let job=await call('/appearance/outfits',{...report.scope,conversationMode:mode,operationId:report.operationId,expectedAppearanceRevision:portraits.revision,references:[{resourceId:record.id,sha256:record.sha256,resourceRevision:record.revision}],instruction:'这是合成产品验收，只使用本次附件。请实际编辑并返回一张图片：保留参考人物的脸、发型、坐姿与完整鞋子，将黑色西装外套改为深蓝色，背景透明。不要输出代码、提示词或仅文字说明，请调用网页版原生图像生成能力生成图片。'});
 const deadline=Date.now()+300000;
 while(['preparing','submitted','receiving'].includes(job.phase)&&Date.now()<deadline){report.job=job;save();await new Promise(done=>setTimeout(done,1800));job=await call('/appearance/outfits/'+job.id+query);}
 report.job=job;report.phase=job.phase;report.outputs=[];
 for(const image of job.images){const response=await fetch(session.origin+'/api/memory-book/v1/resources/'+image.resourceId+'/content'+query,{headers,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('生成图片回读失败：'+response.status);const bytes=Buffer.from(await response.arrayBuffer());const output={...image,bytes:bytes.length,hashAgrees:hash(bytes)===image.sha256};report.outputs.push(output);if(!output.hashAgrees)throw Error('生成图片哈希不一致。');writeFileSync(evidence+'/generated-'+report.outputs.length+(image.mime==='image/webp'?'.webp':image.mime==='image/jpeg'?'.jpg':'.png'),bytes);}
 report.configHashAfter=hash(JSON.stringify((await call('/runtime')).config));report.configUnchanged=report.configHashAfter===report.configHashBefore;report.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({evidence,phase:job.phase,images:report.outputs.length,error:job.error,configUnchanged:report.configUnchanged}));
 if(job.phase!=='ready'||!report.outputs.length||!report.configUnchanged)process.exitCode=1;
}catch(error){report.error=String(error);report.phase='failed';save();console.error(String(error));process.exitCode=1;}
