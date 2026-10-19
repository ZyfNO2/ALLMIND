import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {FileBookRepository} from '../dist/memory/file-book-repository.js';
import {FactWikiService} from '../dist/memory/fact-wiki.js';
import {DEFAULT_COMPANION_SETTINGS} from '../dist/contracts/book-companion.js';
const production=resolve('../../.local/memory-book'),original=JSON.parse(readFileSync(join(production,'runtime.json'),'utf8')).data;
if(original.mainModel?.kind!=='chatgpt-web'||original.wikiModel?.kind!=='chatgpt-web'||original.chatgptWeb?.transport!=='embedded'||original.chatgptWeb?.conversationMode!=='regular'||original.chatgptWeb?.temporaryChatTests!==false||!original.chatgptWeb.authorizedPurposes.includes('wiki'))throw Error('Requires original authorized regular embedded Wiki binding');
mkdirSync('.local/allmind-m4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/allmind-m4/tests/weekly-real-')),repository=new FileBookRepository(directory),config=repository.loadConfig();
repository.commitConfig({...config,mainModel:original.mainModel,wikiModel:original.wikiModel,chatgptWeb:original.chatgptWeb,companion:{...DEFAULT_COMPANION_SETTINGS,proactive:false,autoMemory:false,cloudMemoryConsent:true}},config.revision,'weekly-real-config');
const scope={characterId:'aika',pairingId:'local-user',sessionId:'web-chat'},wiki=new FactWikiService(repository),preview=wiki.preview(scope,{sourceId:'weekly-real-synthetic',title:'合成验收资料，不是真人用户信息',text:'爱好：园艺\n回复长度：希望简短些\n共同经历：昨天我和你一起整理旧照片',private:true});wiki.apply(scope,preview.id,'weekly-real-source');repository.close();
const profile=join(process.env.APPDATA,'AikaNext','desktop');if(!existsSync(profile))throw Error('Original profile missing');const savedPreferences=[];for(const name of ['windows-display.json']){const path=join(profile,name);if(existsSync(path)){const backup=join(directory,'original-'+name);copyFileSync(path,backup);savedPreferences.push({path,backup})}}
const input={directory,profile,savedPreferences,backend:resolve('dist/app/book-backend.js'),evidence:resolve('../../../docs/next/allmind-companion-v2/evidence/weekly-narrative-real.json'),model:original.wikiModel.model,scope,startedAt:new Date().toISOString()};
if(existsSync(input.evidence))throw Error('Evidence already exists; inspect before any new real submission');
writeFileSync(join(directory,'input.json'),JSON.stringify(input));writeFileSync('.local/weekly-real-current.json',JSON.stringify({directory}));console.log(JSON.stringify({directory,model:input.model}));
