import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {replyLengthInstruction,measureReplyLength} from '../dist/core/reply-length.js';
const evidence=resolve('../../../docs/next/ui-rework/evidence/ui-v4-acceptance-20261015/real-source.json');
const session=JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
const report={startedAt:new Date().toISOString(),status:'IN_PROGRESS',checks:[],lengthSamples:[],notes:['真实已选来源的显式模型测试，不写本地历史/记忆；沿用非临时调试策略，云端可能保留测试线程；非普通聊天路由全矩阵验收。']};
const save=()=>writeFileSync(evidence,JSON.stringify(report,null,2));
const api=async(path,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(165000)});const value=await response.json();if(!response.ok)throw Error(path+': '+response.status+' '+value.error?.message);return value};
try{
 const {config}=await api('/runtime'),state=await api('/chatgpt-web/status');if(state.activeRequest)throw Error('当前有在途请求，拒绝开始来源测试');
 report.source={kind:config.mainModel?.kind,transport:config.chatgptWeb?.transport,temporaryChatTests:config.chatgptWeb?.temporaryChatTests};
 const binding=config.chatgptProjects?.find(row=>row.enabled);if(binding){const project=await api('/chatgpt-web/projects/check',{url:'https://chatgpt.com/g/'+binding.projectId+'/project'});report.checks.push({kind:'existing-project-read-only',requestSucceeded:true,fields:Object.keys(project),projectHash:createHash('sha256').update(binding.projectId).digest('hex').slice(0,12)});save();}
 const range={minChars:40,maxChars:100};
 for(const [kind,input] of [['greeting','你好，今天见到你很高兴。'],['comfort','这是合成测试场景，不是用户经历：一个人今天很疲惫，请安慰他。'],['explanation','请简要解释为什么白天的天空看起来是蓝色的。'],['technical','请简要解释 HTTP 请求超时与连接被拒绝的区别。']]){
  console.log(JSON.stringify({sample:kind,status:'started'}));
  const result=await api('/models/test',{binding:config.mainModel,prompt:'这是独立工程验收，不代表用户事实，不要记住场景。使用简体中文。\n'+replyLengthInstruction(range)+'\n'+input});
  if(!result.ok)throw Error(kind+': '+result.error?.code+' '+result.error?.message);
  if(result.reply.endsWith('…'))throw Error(kind+': 测试返回被摘录，不能当作完整正文测量');
  report.lengthSamples.push({kind,reply:result.reply,durationMs:result.durationMs,...measureReplyLength(result.reply,range)});save();console.log(JSON.stringify({sample:kind,status:'measured',actualChars:report.lengthSamples.at(-1).actualChars}));
 }
 report.status='MEASURED_PENDING_USER_REVIEW';
}catch(error){report.status='FAILED';report.error=error.message;process.exitCode=1;console.error(error.message)}finally{report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({evidence,status:report.status,samples:report.lengthSamples.length}));}
