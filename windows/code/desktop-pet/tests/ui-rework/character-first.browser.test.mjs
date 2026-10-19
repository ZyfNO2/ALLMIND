import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { roleConsoleFixture } from '../management/role-console-fixture.mjs';
import { startManagementServer } from '../../dist/management/server.js';
import { ProductionPlaygroundPort } from '../../dist/management/playground-port.js';
import { continuityManagement } from '../../dist/management/continuity-routes.js';
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';

test('Character-first browser: real reads, author/prompt/binding round-trip, isolation, legacy and unavailable features', {timeout:120000}, async t=>{
  const f=await roleConsoleFixture(t);
  const label=f.memory.characters().find(c=>c.id==='companion').label;
  const pairing={userId:'local-user',characterId:'companion',characterInstanceId:'companion-default'};
  const playground=new ProductionPlaygroundPort({pairing,getConfigRevision:()=>1,sendCommand(){throw Error('not authorized in browser test')},cancelCurrent(){}});
  const presets=await CharacterPresetStore.open({memory:f.memory,settings:f.settings,skins:f.skins,base:f.c,roleConfigurations:f.roles});
  const server=await startManagementServer({uiRoot: resolve('management'),settings:f.settings,memory:f.memory,presets,roleConfigurations:f.roles,skins:f.skins,continuity:continuityManagement(f.continuity),playground,
    unifiedTimeline:query=>f.timeline.queryTimeline(query),snapshot:()=>f.request('/api/snapshot')});
  t.after(()=>server.close());
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
  const errors=[], external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).origin!==server.origin)external.push(r.url())});
  f.store.append({characterId:'companion',sessionId:'cfw',turnId:'fixture',generation:1},[{characterId:'companion',id:'cfw-chat-a',role:'user',text:'匿名历史 A',createdAt:'2026-10-08T01:00:00.000Z'}]);
  f.continuity.record({pairing,operationId:'cfw-wiki',layer:'user_wiki',kind:'fact',text:'匿名真实存储知识 A',origin:'user',sourceIds:['cfw-chat-a'],status:'active'});
  await page.goto(`${server.origin}/#token=${server.token}`);
  await expect(page.getByRole('button',{name:new RegExp(label)})).toBeVisible();await expect(page.getByText('夜子',{exact:true})).toHaveCount(0);assert.ok(!page.url().includes(server.token));
  await page.getByRole('button',{name:new RegExp(label)}).click();await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible();
  await expect(page.getByText('未提供',{exact:true}).first()).toBeVisible();
  await page.getByRole('link',{name:'记忆',exact:true}).click();await page.getByRole('button',{name:'沉淀知识 / 陪伴 Wiki',exact:true}).click();await expect(page.getByText('匿名真实存储知识 A',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'角色设定 / Canon',exact:true}).click();await expect(page.getByText('完整人设-companion',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'配置',exact:true}).click();await page.getByLabel('简介',{exact:true}).fill('真实保存的新简介');await page.getByRole('button',{name:'保存角色资料',exact:true}).click();await expect(page.getByText(/角色资料已保存/)).toBeVisible();assert.equal(f.roles.get('companion').identity.intro,'真实保存的新简介');
  await page.getByLabel('完整人格设定（独立保存）',{exact:true}).fill('真实保存的新人格');await page.getByRole('button',{name:'保存人设',exact:true}).click();await expect(page.getByText(/完整人设已保存（修订 \d+）/)).toBeVisible();assert.equal((await f.request('/api/prompt?characterId=companion')).text,'真实保存的新人格');
  await page.reload();await expect(page.getByLabel('完整人格设定（独立保存）',{exact:true})).toHaveValue('真实保存的新人格');await expect(page.getByLabel('简介',{exact:true})).toHaveValue('真实保存的新简介');
  const prompt=await f.request('/api/prompt?characterId=companion');await f.request('/api/prompt','PUT',{characterId:'companion',expectedRevision:prompt.revision,text:'其他客户端的新版本',operationId:'cfw-concurrent-prompt'});
  await page.getByLabel('完整人格设定（独立保存）',{exact:true}).fill('冲突时保留的草稿');await page.getByRole('button',{name:'保存人设',exact:true}).click();await expect(page.getByText(/数据已变更，请刷新后重试。/)).toBeVisible();await expect(page.getByLabel('完整人格设定（独立保存）',{exact:true})).toHaveValue('冲突时保留的草稿');assert.equal((await f.request('/api/prompt?characterId=companion')).text,'其他客户端的新版本');
  await page.getByRole('button',{name:'模型',exact:true}).click();await page.getByRole('button',{name:'保存绑定',exact:true}).click();await expect(page.getByText('绑定已保存并回读，重启后生效。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'语音',exact:true}).click();await expect(page.getByRole('region',{name:'TTS · 文字转语音'})).toBeVisible();await expect(page.getByRole('heading',{name:'本地能力诊断'})).toBeVisible();
  await page.goto(server.origin+'/characters/role-b/memory');await page.getByRole('button',{name:'沉淀知识 / 陪伴 Wiki',exact:true}).click();await expect(page.getByText('暂无已存条目。',{exact:true})).toBeVisible();await expect(page.getByText('匿名真实存储知识 A',{exact:true})).toHaveCount(0);
  await page.goto(server.origin+'/characters/role-b/chat');await expect(page.getByText(/该角色尚未运行/)).toBeVisible();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  await page.goto(server.origin+'/characters/companion/chat');await expect(page.getByText('匿名历史 A',{exact:true})).toBeVisible();await expect(page.getByText(/我已经把这件事记下来了/)).toHaveCount(0);
  // LUI-03: the timeline reads the real unified-timeline API and reports the server's own counts.
  await page.goto(server.origin+'/characters/companion/timeline');await expect(page.getByRole('heading',{name:'动态与统一时间线'})).toBeVisible();await expect(page.getByText(/分页由服务端游标推进/)).toBeVisible();
  await page.goto(server.origin+'/characters/companion/plugins');await expect(page.getByText(/包管理未接入/).first()).toBeVisible();await expect(page.getByText('Wiki 提炼插件',{exact:true})).toHaveCount(0);
  await page.goto(server.origin+'/settings');await page.getByRole('button',{name:'更新',exact:true}).click();await expect(page.getByText(/自动更新检查与更新渠道未实现/)).toBeVisible();await page.getByRole('button',{name:'基本设置',exact:true}).click();
  // LUI-06: the shortcuts entry stays inside the SPA (Settings → 快捷键与语音 tab, HostPanel);
  // the old shell link that used to navigate to /legacy.html no longer exists.
  await page.getByRole('button',{name:'快捷键与语音',exact:true}).click();await expect(page.getByText(/输入框外按住发言|尚未读取到宿主设置/)).toBeVisible();await expect(page.getByText(/请从桌宠的管理入口/)).toHaveCount(0);assert.doesNotMatch(page.url(),/legacy\.html/);assert.match(page.url(),/tab=shortcuts/);
  await page.goto(server.origin+'/characters/unknown/overview');await expect(page.getByRole('button',{name:new RegExp(label)})).toBeVisible();
  await page.goto(server.origin+'/characters/companion/overview');await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible();const reports=resolve('.local/reports/character-first');await mkdir(reports,{recursive:true});await page.screenshot({path:resolve(reports,'overview.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
