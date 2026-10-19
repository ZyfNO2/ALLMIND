import {createHash,randomUUID} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {BookError} from '../contracts/memory-book.js';

const invalid=(message:string)=>new BookError('invalid_input','GPT 娘本地适配：'+message);
async function readLocal(file:string,limit:number):Promise<Buffer>{
  // Do not follow junctions/symlinks out of an explicitly chosen installation.
  for(let part=resolve(file);;part=dirname(part)){const stat=await lstat(part);if(stat.isSymbolicLink())throw invalid('不读取符号链接或目录联接。');if(dirname(part)===part)break;}
  const handle=await open(file,'r');
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw invalid('文件不是普通文件或超过大小上限。');
    const buffer=Buffer.alloc(limit+1);let size=0;
    while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead;}
    if(size>limit)throw invalid('文件超过大小上限。');return buffer.subarray(0,size);
  }finally{await handle.close();}
}
async function optionalJson(file:string):Promise<any|null>{
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readLocal(file,128*1024)).replace(/^\uFEFF/,''));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw invalid('本地 JSON 无法读取：'+(error instanceof BookError?error.message:'格式无效'));}
}
export interface GptNiangReport {
  installed:boolean;portraits:{id:string;name:string;sha256:string}[];
  quota:{state:'fresh'|'stale'|'unavailable';observedAt:number|null;windows:{minutes:number|null;remaining:number;resetsAt:number|null}[]};
  notes:string[];
}
/** Read data/assets only. Never run a downloaded widget, read auth.json or change its state. */
export class GptNiangLocal {
  private tickets=new Map<string,{file:string;hash:string;expires:number;characterId:string}>();
  constructor(private readonly localData=process.env.LOCALAPPDATA??'',private readonly configuredRoot=process.env.ALLMIND_GPT_NIANG_DIR??''){}
  async inspect(characterId:string,sourceRoot?:string):Promise<GptNiangReport>{
    if(sourceRoot!==undefined&&(typeof sourceRoot!=='string'||sourceRoot.length>1000))throw invalid('项目目录无效。');
    const binding=this.localData?await optionalJson(join(this.localData,'GPTNiangUsage','update-agent','binding.json')):null;
    const root=sourceRoot?.trim()||this.configuredRoot||(typeof binding?.appDir==='string'?binding.appDir:'');
    const report:GptNiangReport={installed:!!root,portraits:[],quota:{state:'unavailable',observedAt:null,windows:[]},notes:['仅适配静态形象和本地额度快照；不调用模型，不读取登录凭据。','按压音效、音乐律动、自动语录和原挂件窗口跟随暂未迁移。']};
    if(!root){report.notes.push('未找到本地 GPT-Niang 安装；可填写已解压的 gpt-niang-usage 目录。');return report;}
    const assets=join(resolve(root),'assets');
    const catalog=await optionalJson(join(assets,'characters.json'));
    const rows=catalog?.characters??[{id:'gpt-dragon',name:'GPT 龙娘',file:'gpt-dragon-niang-bust.png'}];
    if(!Array.isArray(rows)||rows.length>100)throw invalid('形象目录无效或超过 100 项。');
    for(const row of rows){
      if(typeof row?.file!=='string'||! /^[A-Za-z0-9._-]+\.(png|webp)$/i.test(row.file)||row.file.includes('..'))throw invalid('形象文件名无效。');
      const file=join(assets,row.file),bytes=await readLocal(file,20*1024*1024),hash=createHash('sha256').update(bytes).digest('hex'),id=randomUUID();
      this.tickets.set(id,{file,hash,expires:Date.now()+15*60000,characterId});
      report.portraits.push({id,name:typeof row.name==='string'?row.name.slice(0,80):'GPT 龙娘',sha256:hash});
    }
    for(const [id,ticket]of this.tickets)if(ticket.expires<Date.now())this.tickets.delete(id);
    while(this.tickets.size>256)this.tickets.delete(this.tickets.keys().next().value!);
    // Use only the default state directory. A package cannot redirect the reader to private files.
    const status=this.localData?await optionalJson(join(this.localData,'GPTNiangUsage','state','status.json')):null;
    if(status?.ok===true&&Array.isArray(status.windows)&&status.windows.length<=16&&typeof status.observedAt==='number'&&Number.isFinite(status.observedAt)&&status.observedAt>0){
      const windows=status.windows.map((row:any)=>{
        if(typeof row?.remaining!=='number'||!Number.isFinite(row.remaining)||row.remaining<0||row.remaining>100||!(row.minutes===null||Number.isSafeInteger(row.minutes)&&row.minutes>0))throw invalid('额度窗口格式无效。');
        return {minutes:row.minutes,remaining:row.remaining,resetsAt:typeof row.resetsAt==='number'&&Number.isFinite(row.resetsAt)&&row.resetsAt>0?row.resetsAt:null};
      });
      const age=Date.now()-status.observedAt;
      report.quota={state:status.queryOk!==false&&windows.length>0&&age>=0&&age<=180000&&!windows.some((row:{resetsAt:number|null})=>row.resetsAt!==null&&row.resetsAt*1000<=Date.now())?'fresh':'stale',observedAt:status.observedAt,windows};
    }
    return report;
  }
  async portrait(characterId:string,id:string):Promise<Buffer>{
    const ticket=this.tickets.get(id);if(!ticket||ticket.characterId!==characterId||ticket.expires<Date.now())throw new BookError('not_found','本地形象预览已过期，请重新读取。');
    const bytes=await readLocal(ticket.file,20*1024*1024);if(createHash('sha256').update(bytes).digest('hex')!==ticket.hash)throw new BookError('conflict','本地形象已改变，请重新预览。');return bytes;
  }
}
