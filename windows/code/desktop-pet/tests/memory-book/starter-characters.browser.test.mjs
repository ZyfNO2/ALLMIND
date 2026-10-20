import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {FileBookRepository} from '../../dist/memory/file-book-repository.js';
import {SkinStore} from '../../dist/management/skin-store.js';
import {ensureGptNiangStarter} from '../../dist/management/starter-characters.js';
import {BookRuntime} from '../../dist/app/book-runtime.js';
import {BookCredentials} from '../../dist/management/book-credentials.js';
import {startBookServer} from '../../dist/management/book-server.js';

test('initial GPT-Niang role is visible with its real image and editable empty persona/Wiki',{timeout:30000},async t=>{
 const output=resolve(process.env.ALLMIND_STARTER_TEST_OUTPUT??'.local/starter-tests');mkdirSync(output,{recursive:true});const directory=mkdtempSync(join(output,'browser-')),repository=new FileBookRepository(directory),skins=await SkinStore.open(join(directory,'skins.json'),join(directory,'packs'),resolve('desktop'));
 await ensureGptNiangStarter(repository,skins,resolve('desktop'));let calls=0;
 const server=await startBookServer({runtime:new BookRuntime(repository,{async complete(){calls++;throw Error('No model needed for starter setup')}}),credentials:new BookCredentials(join(directory,'credentials')),uiRoot:resolve('management'),appearance:{skins}});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();repository.close()});const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(10000);
 await page.goto(server.url);await page.getByRole('heading',{name:'和 GPT 龙娘 说点什么',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'当前角色',exact:true}).inputValue(),'gpt-niang');
 const image=page.getByRole('img',{name:'GPT-Niang 龙娘',exact:true});await image.evaluate(image=>image.decode());assert.ok(await image.evaluate(image=>image.naturalWidth>0));await page.screenshot({path:join(output,'gpt-niang-home.png'),fullPage:true});
 await page.getByRole('link',{name:'角色',exact:true}).click();await page.getByRole('button',{name:'人设与说话方式',exact:true}).click();await page.getByRole('button',{name:'添加核心人设',exact:true}).waitFor();
 await page.getByRole('link',{name:'记忆',exact:true}).click();await page.getByText('没有匹配的回忆。',{exact:true}).waitFor();assert.equal(calls,0);
});
