import {BookError,type BookSnapshot,type BookScope} from '../contracts/memory-book.js';

/** Literal matching of private entries; the review lists every target, never semantic guessing. */
export function previewTopicForget(book:BookSnapshot,scope:BookScope,topic:unknown){
  if(typeof topic!=='string'||topic.trim().length<2||topic.trim().length>120)throw new BookError('invalid_input','请输入2～120字的具体话题，先核对删除范围。');
  const query=topic.trim().normalize('NFKC').toLocaleLowerCase(),entries=book.entries.filter(entry=>entry.pairingId===scope.pairingId&&['wiki','memory'].includes(entry.type)&&[entry.title,entry.body,...entry.entities,...entry.tags].some(value=>value.normalize('NFKC').toLocaleLowerCase().includes(query)));
  if(entries.length>256)throw new BookError('budget','话题匹配超过256条，请缩小话题后重新预览；没有执行删除。');
  return {topic:topic.trim(),expectedRevision:book.revision,entries:entries.map(entry=>({id:entry.id,title:entry.title,body:entry.body,pinned:entry.pinned,revision:entry.revision,sourceRefs:entry.sourceRefs}))};
}
