// Read-only verification of the normal production instance and its current B03 UI assets.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {presentationAssetRoutes} from '../dist/management/presentation-assets.js';
import {chromium} from '@playwright/test';
const data=resolve(process.env.AIKI_BOOK_DATA??'../../.local/memory-book');
const output=resolve('../../../docs/next/ui-rework/evidence/b03-review-20261016');mkdirSync(output,{recursive:true});
const session=JSON.parse(readFileSync(join(data,'management-session.json'),'utf8'));
const entry=new URL(session.url),token=new URLSearchParams(entry.hash.slice(1)).get('token');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const audit=()=>{const bytes=readFileSync(join(data,'runtime.json')),requests=JSON.parse(readFileSync(join(data,'chatgpt-web-requests.json'),'utf8'));return{configSha256:sha(bytes),revision:JSON.parse(bytes).data.revision,used:requests.used.length,threads:requests.threads.length,active:!!requests.active}};
const before=audit();assert.equal(before.active,false);
const report={status:'IN_PROGRESS',backendPid:session.pid,checkedAt:new Date().toISOString(),before,rows:[],assets:[],pageErrors:[],notes:['normal launcher, existing data, structural read only; no chat submit, config/binding/history writes or cloud calls']};
const previewAssets=await presentationAssetRoutes(resolve('../..'));
const browser=await chromium.launch({headless:true});
try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});page.on('pageerror',error=>report.pageErrors.push(error.message));
    await page.addInitScript(value=>sessionStorage.setItem('pet-management-session-v1',value),token);
    await page.goto(entry.origin);await page.getByLabel('聊天消息',{exact:true}).waitFor();
    for(const name of ['聊天','我们的回忆','陪伴','角色','设置']){
      await page.getByRole('link',{name,exact:true}).click();
      await page.getByRole('heading').first().waitFor();
      const noHorizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
      assert.equal(noHorizontalOverflow,true,name);
      if(name==='聊天')await page.getByLabel('本次回复风格',{exact:true}).waitFor();
      if(name==='设置')await page.getByLabel('默认回复风格',{exact:true}).waitFor();
      report.rows.push({viewport,page:name,noHorizontalOverflow,styleControlVisible:name==='聊天'||name==='设置'});
    }
    if(!report.assets.length){
      const assets=await page.locator('script[src],link[rel=stylesheet]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('src')??node.getAttribute('href')));
      for(const asset of assets){const response=await page.request.get(new URL(asset,page.url()).href),bytes=await response.body(),local=readFileSync(previewAssets.get(asset)??resolve('management/character-app',asset.replace(/^\//u,'')));assert.equal(sha(bytes),sha(local));report.assets.push({asset,sha256:sha(bytes)});}
    }
    await page.close();
  }
  report.after=audit();assert.deepEqual(report.after,before);assert.deepEqual(report.pageErrors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error).replace(/#token=[A-Za-z0-9_-]+/gu,'#token=[redacted]');process.exitCode=1;}
finally{await browser.close();writeFileSync(join(output,'normal.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,rows:report.rows.length,assets:report.assets,pageErrors:report.pageErrors}));}
