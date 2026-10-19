import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
const session=JSON.parse(readFileSync('../../.local/memory-book/management-session.json','utf8'));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const entry=new URL(session.url),token=new URLSearchParams(entry.hash.slice(1)).get('token');await page.addInitScript(value=>sessionStorage.setItem('pet-management-session-v1',value),token);await page.goto(entry.origin);await page.getByLabel('聊天消息',{exact:true}).waitFor();await page.getByRole('link',{name:'设置',exact:true}).click();
 await page.getByRole('region',{name:'对话所属 ChatGPT 项目',exact:true}).waitFor();await page.getByLabel('最小回复字数',{exact:true}).waitFor();
 const assets=await page.locator('script[src],link[rel=stylesheet]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('src')??node.getAttribute('href')));
 const hashes=[];for(const asset of assets){const response=await page.request.get(new URL(asset,page.url()).href),bytes=await response.body(),local=readFileSync(resolve('management/character-app',asset.replace(/^\//u,'')));const sha=buffer=>createHash('sha256').update(buffer).digest('hex');if(sha(bytes)!==sha(local))throw Error('Normal endpoint bundle differs from disk');hashes.push({asset,sha256:sha(bytes)});}
 if(errors.length)throw Error(errors.join('\n'));
 const report={status:'PASS',checkedAt:new Date().toISOString(),backendPid:session.pid,source:'normal Book endpoint, real existing data, read-only headless page',path:'/settings',checks:['normal chat and settings render','project settings and minimum-length input visible','served JS/CSS exactly match current build'],assets:hashes,pageErrors:errors,notes:['No config/history write, no model call from this check; native launch path and isolated native proof are documented separately.']};
 const path=resolve('../../../docs/next/ui-rework/evidence/ui-v4-acceptance-20261015/normal-version.json');writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify({path,status:report.status,assets:hashes.map(row=>row.asset)}));
}catch(error){console.error(String(error.message).replace(/#token=[A-Za-z0-9_-]+/gu,'#token=[redacted]'));process.exitCode=1}finally{await browser.close()}

