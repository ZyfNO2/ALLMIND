// Isolated upstream role-provider fixture. The backend, transport, renderer and frame acknowledgement
// stay real. This contributes one declared resource to the optional public manifest contract.
import {runBookBackend} from '../dist/app/book-backend.js';
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(chunk,...args)=>{
  if(typeof chunk==='string'&&chunk.startsWith('{')){
    const message=JSON.parse(chunk);
    if(message.channel==='appearance'&&message.manifest.sprite?.clips?.happy){
      message.manifest.localInteractions={schemaVersion:'local-pet/v1',skinId:message.manifest.skinId,assetFingerprint:message.manifest.assetFingerprint,bindings:{feeding:{kind:'sprite',targetId:'happy'}}};
      chunk=JSON.stringify(message)+'\n';
    }
  }
  return write(chunk,...args);
};
await runBookBackend(process.env.AIKI_BOOK_DATA);
