import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {resolve} from 'node:path';
const repository=new FileBookRepository(resolve('../../.local/memory-book'));
try{
  const config=repository.loadConfig();if(!config.chatgptWeb)throw Error('Source missing');
  const result=repository.commitConfig({...config,chatgptWeb:{...config.chatgptWeb,conversationMode:'regular',temporaryChatTests:false}},config.revision,'regular-debug-'+Date.now());
  console.log(JSON.stringify({revision:result.revision,conversationMode:'regular',temporaryChatTests:false,transport:config.chatgptWeb.transport}));
}finally{repository.close();}
