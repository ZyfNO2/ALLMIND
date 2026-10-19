import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';
import {DEFAULT_CHATGPT_WEB_SOURCE} from '../../dist/contracts/memory-book.js';

test('project links are discoverable before source selection and check-save-readback uses the current role',{timeout:30000},async t=>{
 mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=resolve(mkdtempSync('.local/ui-v4/tests/project-path-')),repository=new FileBookRepository(directory);
 const config=repository.loadConfig();repository.commitConfig({...config,chatgptWeb:{...DEFAULT_CHATGPT_WEB_SOURCE}},config.revision,'seed');
 let checks=0;const projectId='g-p-'+'a'.repeat(32);
 const runtime=new BookRuntime(repository,{async complete(){throw Error('No model calls for project settings')}});
 const server=await startBookServer({runtime,credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),chatgptWeb:{
   async probe(){return {state:'signed-in',checkedAt:new Date().toISOString()}},async openLoginPage(){},
   async inspectProject(id){checks++;assert.equal(id,projectId);return {projectId:id,name:'链接测试项目',account:'b'.repeat(64)}}
 }});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage();page.setDefaultTimeout(7000);await page.goto(server.url);await page.getByRole('link',{name:'设置',exact:true}).click();
 const section=page.getByRole('region',{name:'对话所属 ChatGPT 项目',exact:true});await section.getByLabel('已有项目链接',{exact:true}).waitFor();
 assert.equal(await section.getByRole('button',{name:'检查项目链接',exact:true}).isDisabled(),true);
 await page.getByLabel('ChatGPT 连接方式',{exact:true}).selectOption('embedded');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText(/设置已保存并生效/).waitFor();
 const input=section.getByLabel('已有项目链接',{exact:true});await input.fill('https://example.com/project');await section.getByRole('button',{name:'检查项目链接',exact:true}).click();await page.getByRole('alert').filter({hasText:'仅接受 chatgpt.com'}).waitFor();assert.equal(checks,0);assert.equal(await input.inputValue(),'https://example.com/project');
 await input.fill('https://chatgpt.com/g/'+projectId+'/project');await section.getByRole('button',{name:'检查项目链接',exact:true}).click();await section.getByText(/待绑定：链接测试项目/).waitFor();
 await section.getByRole('button',{name:'保存项目绑定',exact:true}).click();await section.getByText('项目绑定已保存并回读。',{exact:true}).waitFor();
 const saved=repository.loadConfig().chatgptProjects[0];assert.equal(saved.projectId,projectId);assert.equal(saved.characterId,'aika');assert.equal(checks,1);
 await page.reload();await section.getByText(/项目：链接测试项目/).waitFor();
});
