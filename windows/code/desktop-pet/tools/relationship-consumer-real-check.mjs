import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {BookRuntime} from '../dist/app/book-runtime.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
const root=resolve('../../../docs/next/allmind-companion-v2/evidence'),path=join(root,process.env.AIKI_RELATIONSHIP_EVIDENCE??'relationship-consumer-real.json');mkdirSync(root,{recursive:true});mkdirSync('.local/allmind-m4/tests',{recursive:true});
const repository=new FileBookRepository(mkdtempSync('.local/allmind-m4/tests/relationship-real-')),scope={characterId:'aika',pairingId:'local-user',sessionId:'seed'},report={status:'IN_PROGRESS',productionFactsWritten:false,consumer:'isolated production Book/Builder -> authorized regular models/test; not native formal desktop acceptance',rows:[],startedAt:new Date().toISOString()},save=()=>writeFileSync(path,JSON.stringify(report,null,2));
try{
  save();const session=JSON.parse(readFileSync(resolve('../../.local/memory-book/management-session.json'),'utf8')),url=new URL(session.url),headers={Authorization:'Bearer '+new URLSearchParams(url.hash.slice(1)).get('token'),'Content-Type':'application/json'};
  const request=async(route,body)=>{const response=await fetch(url.origin+'/api/memory-book/v1'+route,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(170000)}),data=await response.json();if(!response.ok)throw Error(data.error?.message??'HTTP '+response.status);return data};
  const current=(await request('/runtime')).config;if(current.mainModel?.kind!=='chatgpt-web'||current.chatgptWeb?.temporaryChatTests!==false)throw Error('Expected the authorized regular web source, refusing alternate source');report.model=current.mainModel.model;
  const runtime=new BookRuntime(repository,{async complete(){throw Error('local Inspector must not call provider')}}),wiki=new FactWikiService(repository);
  async function run(stage,query){if(process.env.AIKI_RELATIONSHIP_STAGES&&!process.env.AIKI_RELATIONSHIP_STAGES.split(',').includes(stage))return;const context=await runtime.inspect({...scope,sessionId:stage},query,new AbortController().signal),row={stage,query,relationshipUsed:context.relationshipUsed??null,selected:context.consumed};report.rows.push(row);save();
    const response=await request('/models/test',{binding:current.mainModel,debugSessionId:'relationship-'+randomUUID(),prompt:'合成验收资料，不把例子作为真实账号用户经历。按下列生产上下文回答最后问题：有据偏好和共同经历自然消费；没有依据时明确不知道，不猜称呼、不声称记得已删除的经历。\n'+context.messages.map(message=>`[${message.role}] ${message.content}`).join('\n')});if(!response.ok)throw Error(response.error?.message??'Model test failed');row.reply=response.reply;row.durationMs=response.durationMs;save();process.stdout.write(JSON.stringify({stage,reply:row.reply})+'\n');}
  await run('new-user','你知道我喜欢怎样被称呼，以及我们以前一起做过什么吗？');
  const p=wiki.preview(scope,{sourceId:'relationship-evidence',title:'用户',text:'称呼：小岚\n回复长度：希望简短些\n共同经历：昨天我和你一起整理旧照片',private:true});wiki.apply(scope,p.id,'seed');
  await run('experienced','关于一起整理旧照片，我们做过什么？请自然地称呼我，按我的回复长度偏好回答。');
  wiki.revoke(scope,'relationship-evidence',repository.snapshot(scope).revision,'revoke');runtime.invalidate(scope.characterId);
  await run('forgotten','我们以前一起整理旧照片了吗？你还知道我喜欢怎样被称呼吗？');
  report.status='AWAITING_SEMANTIC_REVIEW';save();
}catch(error){report.status='FAILED';report.error=error instanceof Error?error.message:String(error);save();process.stderr.write(report.error+'\n');process.exitCode=1}finally{repository.close();}
