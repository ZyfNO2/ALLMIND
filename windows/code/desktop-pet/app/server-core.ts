import {resolve,join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {BookRuntime} from './book-runtime.js';
import {FileBookRepository} from '../memory/file-book-repository.js';
import {BookCredentials} from '../management/book-credentials.js';
import {BookHttpModel} from '../providers/book-model.js';
import {startBookServer} from '../management/book-server.js';
import {resolveProductProfile} from './product-profile.js';
import {appRoot} from './module-runtime.js';
import {ensureCapabilityToken} from '../management/allmind-capabilities.js';
import {loadAstrbotSettings} from './astrbot-settings.js';
import {AstrbotConnector} from './astrbot-connector.js';
import {attachAstrbotChat} from './astrbot-chat.js';
import {BookError} from '../contracts/memory-book.js';
import {restrictPrivatePathSync} from '../core/platform-files.js';

process.env.ALLMIND_PROFILE??='server-core';
if(!process.env.AIKI_BOOK_DATA)throw Error('server-core requires an explicit AIKI_BOOK_DATA directory');
const directory=resolve(process.env.AIKI_BOOK_DATA),repository=new FileBookRepository(directory);
const credentials=new BookCredentials(join(directory,'credentials'));
const http=new BookHttpModel(id=>credentials.get(id));
const profile=resolveProductProfile();
const runtime=new BookRuntime(repository,{complete(binding,messages,signal,options){
  if(binding.kind==='chatgpt-web')throw new BookError('unavailable','server-core 不包含浏览器，请配置 API 模型或独立桌面文本服务。');
  return http.complete(binding,messages,signal,options);
}},{screenEnabled:profile.modules.screen});
const settings=loadAstrbotSettings(directory);
if(settings?.execution==='astrbot')attachAstrbotChat(runtime,new AstrbotConnector(directory,settings,()=>credentials.get(settings.credentialId)));
const server=await startBookServer({runtime,credentials,uiRoot:join(appRoot,'management'),profile,astrbotToken:ensureCapabilityToken(directory),...(process.env.AIKI_BOOK_PORT?{port:Number(process.env.AIKI_BOOK_PORT)}:{})});
const file=join(directory,'management-session.json');writeFileSync(file,JSON.stringify({version:1,url:server.url,...server.runtimeIdentity})+'\n',{mode:0o600});restrictPrivatePathSync(file);
console.log(JSON.stringify({status:'ready',profile:'server-core',origin:new URL(server.url).origin}));
let closing=false;async function close(){if(closing)return;closing=true;try{await server.close();}finally{repository.close();}}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
