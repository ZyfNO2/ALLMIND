import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {draftCharacterPack} from '../../memory/draft-character-pack.js';
import {BookImportService} from '../../memory/book-import.js';
import {FileBookRepository} from '../../memory/file-book-repository.js';

function fixture(){return {manifest:{schema:'aiki.character-pack.draft/1',id:'synthetic.dragon',display_name:'测试龙娘',memory:{default_state:'empty'},assets:{portrait:null},wiki:{required:['wiki/identity.md','wiki/personality.md'],retrievable:['wiki/worldbook.md','wiki/interactions.md']}},files:new Map([
  ['wiki/identity.md',Buffer.from('---\nid: identity\n---\n# 身份\n合成角色，不是真实用户。')],
  ['wiki/personality.md',Buffer.from('# 人格\n冷幽默，诚实。')],
  ['wiki/worldbook.md',Buffer.from('# 世界书\n## WB-CODE\n- 触发：编程、bug、调试。\n- 内容：先定位问题。\n## WB-RECALL\n- 触发：还记得、上次。\n- 内容：不编造经历。')],
  ['wiki/interactions.md',Buffer.from('# 交互建议\n截图需要授权，不代表已经启用截图。')],
  ['memory/examples/events.jsonl',Buffer.from('{"demo_only":true,"private":"不得入库"}')],
])};}
test('draft character pack preview/apply keeps core and keyword lore but never seeds demo memories',t=>{
  const root=mkdtempSync(join(tmpdir(),'allmind-dragon-')),repo=new FileBookRepository(root);t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
  const {manifest,files}=fixture(),converted=draftCharacterPack(manifest,'',files);
  const service=new BookImportService(repo),scope={characterId:'aika',pairingId:'local-user',sessionId:'draft'};
  const before=repo.snapshot(scope),preview=service.preview(scope,converted.text,'draft.zip');
  assert.equal(repo.snapshot(scope).revision,before.revision,'preview is read only');assert.deepEqual(preview.diagnostics,[]);assert.equal(preview.entries.length,4);
  assert.equal(preview.entries.filter(row=>row.type==='persona'&&row.trigger.strategy==='always').length,1);
  assert.deepEqual(preview.entries.find(row=>row.title==='WB-CODE')!.trigger.keys,['编程','bug','调试']);
  assert.ok(!converted.text.includes('不得入库'));assert.ok(!converted.used.some(path=>path.startsWith('memory/')));
  service.apply(scope,preview.id,'import-draft');assert.equal(repo.snapshot(scope).entries.length,before.entries.length+4);assert.equal(repo.readSession(scope).length,0);
  const second=service.preview(scope,converted.text,'draft.zip');assert.ok(second.changes.every(row=>row.action==='noop'));
});
test('draft adapter rejects missing files, traversal, oversized persona and nonempty memory initialization',()=>{
  for(const change of [
    (f:ReturnType<typeof fixture>)=>f.files.delete('wiki/identity.md'),
    (f:ReturnType<typeof fixture>)=>{f.manifest.wiki.required=['wiki/../identity.md'];},
    (f:ReturnType<typeof fixture>)=>{f.files.set('wiki/identity.md',Buffer.from('长'.repeat(2000)));},
    (f:ReturnType<typeof fixture>)=>{f.manifest.memory.default_state='seeded';},
  ]){const f=fixture();change(f);assert.throws(()=>draftCharacterPack(f.manifest,'',f.files));}
});
