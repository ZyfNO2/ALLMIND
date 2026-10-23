import {createHash} from 'node:crypto';
import {BookError} from '../contracts/memory-book.js';
import type {SynthesisResult,SynthesisTask} from '../contracts/wiki-synthesis.js';
import {validateSynthesisResult} from './wiki-synthesis-protocol.js';

/** Bound output work separately from the input context window. Never truncate a material. */
export function synthesisBatches(task:SynthesisTask,outputTokens:number):SynthesisTask[]{
  const size=Math.max(1,Math.min(16,Math.floor(outputTokens/1024))),batches:SynthesisTask[]=[];
  for(let start=0;start<task.materials.length;start+=size){
    const data={...task,materials:task.materials.slice(start,start+size)};
    batches.push({...data,inputHash:createHash('sha256').update(JSON.stringify({...data,inputHash:undefined})).digest('hex')});
  }
  return batches.length===1?[task]:batches;
}

/** No model-generated claims are repaired here: only IDs, references and exact duplicate paragraphs. */
export function mergeSynthesisBatches(task:SynthesisTask,parts:{task:SynthesisTask;result:SynthesisResult}[]):SynthesisResult{
  if(parts.length===1&&parts[0]!.task.inputHash===task.inputHash)return validateSynthesisResult(parts[0]!.result,task);
  const result:SynthesisResult={schemaVersion:'allmind-wiki/v1',inputHash:task.inputHash,pages:[],relations:[],coverage:[]};
  const covered=new Set<string>(),titles=new Map<string,string>();
  for(const [index,part] of parts.entries()){
    const validated=validateSynthesisResult(part.result,part.task),ids=new Map<string,string>();
    for(const row of part.task.materials){if(covered.has(row.id))throw new BookError('invalid_input','编纂分批材料重复。');covered.add(row.id);}
    for(const page of validated.pages){
      const key=page.domain+'\0'+page.title.normalize('NFKC').trim();
      const existing=task.existingPages.find(row=>row.domain===page.domain&&row.title.normalize('NFKC').trim()===page.title.normalize('NFKC').trim());
      const id=titles.get(key)??existing?.id??`b${index+1}.${page.id}`.slice(0,64);ids.set(page.id,id);titles.set(key,id);
      let target=result.pages.find(row=>row.id===id);
      if(!target){target={...page,id,paragraphs:[]};result.pages.push(target);}
      else {
        if ((target.pageType ?? 'topic') !== (page.pageType ?? 'topic')) throw new BookError('invalid_input', '同域同名页面类型冲突，请重新编纂。');
        if(target.category!==page.category)target.category='knowledge'; // conflicting suggestions remain neutral for explicit review
      }
      for(const paragraph of page.paragraphs)if(!target.paragraphs.some(row=>JSON.stringify(row)===JSON.stringify(paragraph)))target.paragraphs.push(paragraph);
    }
    for(const relation of validated.relations){
      const row={...relation,from:ids.get(relation.from)!,to:ids.get(relation.to)!};
      if(row.from===row.to)throw new BookError('invalid_input','合并后关系变成自连，请重新编纂。');
      const prior=result.relations.find(item=>item.from===row.from&&item.to===row.to&&item.label===row.label);
      if(prior){for(const ref of row.evidence)if(!prior.evidence.some(item=>item.entryId===ref.entryId&&item.quote===ref.quote))prior.evidence.push(ref);}else result.relations.push(row);
    }
    result.coverage.push(...validated.coverage.map(row=>({...row,pageIds:[...new Set(row.pageIds.map(id=>ids.get(id)!))]})));
  }
  return validateSynthesisResult(result,task);
}
