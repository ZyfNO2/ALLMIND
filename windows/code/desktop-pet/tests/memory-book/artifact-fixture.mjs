import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {FileResourceStore} from '../../dist/memory/file-resource-store.js';
import {BookResourceService} from '../../dist/memory/book-resources.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
export async function artifactFixture(t){mkdirSync('.local/artifact-review',{recursive:true});const directory=mkdtempSync(resolve('.local/artifact-review/http-'));const repository=new FileBookRepository(directory);const config=repository.loadConfig();repository.commitConfig({...config,mainModel:{baseUrl:'http://127.0.0.1:9999',model:'stub',credentialId:'local',inputTokens:16000,outputTokens:1000}},config.revision,'seed');const resources=new BookResourceService(new FileResourceStore({directory:join(directory,'resources')}));let prompts=[];const runtime=new BookRuntime(repository,{async complete(_binding,messages){prompts.push(messages);return '合成回复'}},{resources});const server=await startBookServer({runtime,uiRoot:resolve('management'),credentials:new BookCredentials(join(directory,'credentials'))});t.after(async()=>{await new Promise(done=>server.server.close(done));repository.close();rmSync(directory,{recursive:true,force:true})});return {server,runtime,resources,prompts,request:async(path,options={})=>fetch(new URL(server.url).origin+'/api/memory-book/v1'+path,{...options,headers:{Authorization:'Bearer '+server.token,...options.headers}})};}
