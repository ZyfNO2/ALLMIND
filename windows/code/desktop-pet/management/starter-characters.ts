import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {BookError} from '../contracts/memory-book.js';
import type {FileBookRepository} from '../memory/file-book-repository.js';
import type {SkinStore} from './skin-store.js';

export const GPT_NIANG_ROLE_ID='gpt-niang';
export const GPT_NIANG_SKIN_ID='starter-gpt-niang';
/** Install the supplied appearance and an empty role once. Never seed persona, Wiki or memories. */
export async function ensureGptNiangStarter(repository:FileBookRepository,skins:SkinStore,desktop:string):Promise<void>{
  if(repository.loadConfig().gptNiangStarterVersion===1)return;
  const source=join(desktop,'assets/gpt-niang/gpt-dragon-niang-bust.png');
  const hash=createHash('sha256').update(await readFile(source)).digest('hex');
  const existing=skins.state().skins.find(row=>row.skinId===GPT_NIANG_SKIN_ID);
  if(existing&&existing.assetFingerprint!==hash)throw new BookError('conflict','初始 GPT-Niang 形象标识已被其他素材使用，未覆盖。');
  if(!existing)await skins.import(source,{skinId:GPT_NIANG_SKIN_ID,label:'GPT-Niang · GPT 龙娘',type:'sprite',sprite:{rows:1,columns:1,frameCount:1,fps:12}});
  const config=repository.loadConfig();
  if(config.gptNiangStarterVersion===1)return;
  const emptyScope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},book=repository.snapshot(emptyScope);
  const pristine=config.revision===0&&config.characters.length===1&&config.characters[0]?.id==='aika'&&config.characters[0]?.name==='ALLMIND'&&!config.characters[0]?.intro&&!config.characters[0]?.appearancePath&&!config.characters[0]?.appearanceSkinId&&!config.mainModel&&book.revision===0&&!book.entries.length&&!book.wikiSources?.length&&!repository.listSessions('aika','local-user').length;
  const starter={id:GPT_NIANG_ROLE_ID,name:'GPT 龙娘',intro:'来自 GPT-Niang 的初始角色。人设与 Wiki 待补充。',appearancePath:null,appearanceSkinId:GPT_NIANG_SKIN_ID};
  const characters=config.characters.some(row=>row.id===GPT_NIANG_ROLE_ID)?config.characters:pristine?[starter]:[...config.characters,starter];
  repository.commitConfig({...config,characters,currentCharacterId:pristine?GPT_NIANG_ROLE_ID:config.currentCharacterId,gptNiangStarterVersion:1},config.revision,'gpt-niang-starter-v1');
}
