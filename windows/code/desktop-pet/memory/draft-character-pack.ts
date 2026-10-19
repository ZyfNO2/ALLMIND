import {BookError,emptyEntry,type BookEntry} from '../contracts/memory-book.js';

/** Explicit compatibility adapter for the text-only draft format, not an executable plugin. */
export function draftCharacterPack(manifest: any, prefix: string, files: Map<string,Buffer>): {text:string;used:string[]} {
  const fail=(message:string):never=>{throw new BookError('invalid_input','角色草案包：'+message);};
  if(typeof manifest.id!=='string'||! /^[a-zA-Z0-9._-]{1,100}$/.test(manifest.id)||typeof manifest.display_name!=='string'||!manifest.display_name.trim()||manifest.display_name.length>200)fail('角色标识或名称无效。');
  if(manifest.memory?.default_state!=='empty')fail('仅支持初始记忆为空的草案。');
  if(manifest.assets?.portrait||manifest.assets?.spritesheet)fail('草案中的形象请通过本地形象入口单独预览导入。');
  const required=manifest.wiki?.required,retrievable=manifest.wiki?.retrievable;
  if(!Array.isArray(required)||!required.length||required.length>8||!Array.isArray(retrievable)||retrievable.length>24)fail('wiki 清单无效。');
  const used:string[]=[],entries:BookEntry[]=[];
  const read=(path:unknown)=>{
    if(typeof path!=='string'||!/^wiki\/[a-zA-Z0-9._/-]+\.md$/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))fail('Wiki 路径无效。');
    const name=prefix+path;if(used.includes(name))fail('Wiki 路径重复。');
    const bytes=files.get(name);if(!bytes)fail('Wiki 文件缺失：'+path);
    used.push(name);let body:string;try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('Wiki 必须是 UTF-8。');}
    return body!.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
  };
  const core=required.map(read).join('\n\n');
  if(!core||Buffer.byteLength(core)>4096)fail('核心身份与人格必须为非空且合计不超过 4 KiB。');
  const persona=emptyEntry(manifest.id+'.core','persona',manifest.display_name+' · 核心设定',core);persona.trigger.strategy='always';entries.push(persona);
  for(const path of retrievable){
    const body=read(path);if(!body)fail('Wiki 内容为空。');
    const sections=body.split(/^##\s+/m).slice(1);
    if(String(path).endsWith('/worldbook.md')&&sections.length){
      for(const [index,section] of sections.entries()){
        const title=section.split(/\r?\n/,1)[0]!.trim();
        const keys=/^[-*]\s*触发[：:]\s*(.+)$/m.exec(section)?.[1]?.split(/[、，,]/).map(key=>key.trim().replace(/[。；;]$/,'')).filter(Boolean)??[];
        if(!keys.length)fail('世界书条目缺少触发词：'+title);
        const entry=emptyEntry(manifest.id+'.world.'+index,'story',title,section.trim());
        entry.trigger.strategy='keyword';entry.trigger.operator='or';entry.trigger.keys=keys;entries.push(entry);
      }
    }else{
      const entry=emptyEntry(manifest.id+'.wiki.'+entries.length,'wiki',body.split(/\r?\n/,1)[0]!.replace(/^#+\s*/,''),body);
      entry.tags=['角色交互建议','非运行能力'];entries.push(entry);
    }
  }
  for(const entry of entries){entry.sourceRefs=['character-pack:'+manifest.id];entry.canon={level:'draft',confidence:'explicit'};}
  return {text:JSON.stringify({schemaVersion:'memory-book/v1',name:manifest.display_name,entries}),used};
}
