import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portraitHits, portraitPlacement } from '../../desktop/portrait-geometry.js';
import { PortraitStore } from '../../management/portrait-store.js';
import { OutfitService, type OutfitGenerator } from '../../management/outfit-service.js';
import { BookResourceService } from '../../memory/book-resources.js';
import { FileResourceStore } from '../../memory/file-resource-store.js';
import { FileBookRepository } from '../../memory/file-book-repository.js';
import type { SkinManagement } from '../../contracts/skin.js';

function png(width=4): Buffer {
  const crc32 = (buffer: Buffer): number => { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, body: Buffer): Buffer => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length); const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed)); return Buffer.concat([head, typed, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

test('portrait geometry fits opaque content and uses that box for hits', () => {
  const placement = portraitPlacement({ width: 200, height: 300 }, { width: 100, height: 200 }, { x: 10, y: 20, width: 80, height: 100 }, 'full');
  assert.equal(placement.contentDest.y + placement.contentDest.height, 300);
  assert.ok(placement.contentDest.width <= 200 && placement.contentDest.height <= 300);
  assert.equal(portraitHits({ x: placement.contentDest.x + 1, y: placement.contentDest.y + 1 }, placement), true);
  assert.equal(portraitHits({ x: 0, y: 0 }, placement), false);
  const bust = portraitPlacement({ width: 200, height: 300 }, { width: 100, height: 200 }, { x: 10, y: 20, width: 80, height: 100 }, 'bust');
  assert.ok(bust.source.height < 100);
  assert.equal(bust.source.y, 20);
});

test('portrait sets stay per character and a failed import leaves the previous variant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w02-portraits-'));
  const registered: { skinId: string; assetFingerprint: string }[] = [];
  let revision = 1;
  const skins = {
    list: () => registered,
    state: () => ({ revision, activeSkinId: 'local-model' }),
    async import(_file: string, input: { skinId?: string }) {
      if (String(_file).includes('bad')) throw new Error('坏图');
      registered.push({ skinId: input.skinId!, assetFingerprint: 'ab'.repeat(32) });
      revision += 1;
    },
    async activate() { revision += 1; },
    async remove(_revision: number, skinId: string) { registered.splice(registered.findIndex(item => item.skinId === skinId), 1); }
  } as unknown as SkinManagement;
  const store = await PortraitStore.open(join(root, 'portraits.json'), skins);
  const first = await store.add({ characterId: 'role-a', name: '坐姿', file: 'a.png', origin: 'user_supplied', operationId: 'op-1', expectedRevision: 0, currentSkinId: 'local-model' });
  assert.equal(first.variants.length, 1);
  assert.equal(first.selectedVariantId, null);
  await assert.rejects(store.add({ characterId: 'role-a', name: '坏', file: 'bad.png', origin: 'user_import', operationId: 'op-bad', expectedRevision: first.revision, currentSkinId: 'local-model' }));
  assert.equal(store.get('role-a').variants.length, 1);
  const selected = await store.select('role-a', first.variants[0]!.id, store.get('role-a').revision, 'op-select');
  assert.equal(selected.selectedVariantId, first.variants[0]!.id);
  const other = await store.add({ characterId: 'role-b', name: '另一角色', file: 'b.png', origin: 'user_import', operationId: 'op-b', expectedRevision: 0, currentSkinId: 'local-model' });
  assert.equal(other.variants.length, 1);
  assert.equal(store.get('role-a').variants.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test('outfit generation does not resubmit and apply failure keeps the previous portrait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w02-outfit-'));
  const repository = new FileBookRepository(root);
  const scope = { characterId: 'aika', pairingId: 'local-user', sessionId: 'web-chat' };
  const resources = new BookResourceService(new FileResourceStore({ directory: join(root, 'resources') }));
  const uploaded = await resources.receiveUpload(scope, { name: 'ref.png', mime: 'image/png' }, png(), 'upload-ref', new AbortController().signal);
  let submits = 0;
  const generator: OutfitGenerator = {
    capabilities: () => ({ inputImages: 'available', outputImages: 'unknown' }),
    sourceFingerprint: () => 'source-a',
    async submit() {
      submits += 1;
      return { kind: 'completed', requestId: 'outfit-op-1', conversationId: 'c', messageId: 'm', submitted: 'yes', images: [{ name: 'out.png', mime: 'image/png', bytes: png(5) }] };
    },
    async resume() { throw new Error('不应重读未提交任务'); },
    async cancel() { return { kind: 'cancelled', code: 'cancelled', submitted: 'yes', message: '已取消' }; }
  };
  const registered: { skinId: string }[] = [];
  const skins = { list: () => registered.map(item => ({ ...item, assetFingerprint: 'cd'.repeat(32) })), state: () => ({ revision: 1, activeSkinId: 'local-model' }), async import(_file: string, input: { skinId?: string }) { registered.push({ skinId: input.skinId! }); }, async activate() {}, async remove() {} } as unknown as SkinManagement;
  const portraits = await PortraitStore.open(join(root, 'portraits.json'), skins);
  let activations = 0;
  const outfits = new OutfitService(join(root, 'outfits.json'), portraits, resources, generator, () => repository.loadConfig(), async () => ({ width: 10, height: 10, minAlpha: 255, maxAlpha: 255, touchesEdge: true }), async () => { activations += 1; throw new Error('宿主没有载入'); });
  const request = { operationId: 'op-1', expectedAppearanceRevision: 0, instruction: '换成大衣', references: [{ resourceId: uploaded.id, sha256: uploaded.sha256!, resourceRevision: uploaded.revision }] };
  const job = await outfits.create(scope, request, new AbortController().signal);
  const again = await outfits.create(scope, request, new AbortController().signal);
  assert.equal(submits, 1);
  assert.equal(again.id, job.id);
  assert.equal(job.images[0]?.warning?.includes('没有透明像素'), true);
  await assert.rejects(async () => { await outfits.apply(scope, job.id, { resourceId: job.images[0]!.resourceId, sha256: job.images[0]!.sha256, expectedAppearanceRevision: 0, operationId: 'apply-1' }, async () => 'generated.png'); });
  assert.equal(activations, 1);
  assert.equal(portraits.get('aika').selectedVariantId, null);
  await assert.rejects(async () => { outfits.get({ ...scope, characterId: 'other' }, job.id); });
  repository.close();
  rmSync(root, { recursive: true, force: true });
});

test('cancelled asynchronous outfit keeps cancellation when the provider returns a late failure',async t=>{
 const root=mkdtempSync(join(tmpdir(),'w02-cancel-'));const repository=new FileBookRepository(root),scope={characterId:'aika',pairingId:'local-user',sessionId:'cancel'};
 t.after(()=>{repository.close();rmSync(root,{recursive:true,force:true});});
 const resources=new BookResourceService(new FileResourceStore({directory:join(root,'resources')})),record=await resources.receiveUpload(scope,{name:'ref.png',mime:'image/png'},png(),'cancel-upload',new AbortController().signal);
 const portraits=await PortraitStore.open(join(root,'portraits.json'),{} as SkinManagement);let finish!:(result:any)=>void,started!:(value?:unknown)=>void;const began=new Promise(done=>started=done);let submitted=0;
 const generator:OutfitGenerator={capabilities:()=>({inputImages:'available',outputImages:'unknown'}),sourceFingerprint:()=> 'source',async submit(){submitted++;started();return await new Promise(done=>finish=done);},async resume(){throw Error('No resubmit');},async cancel(){return {kind:'cancelled',submitted:'yes',code:'cancelled',message:'已确认取消'};}};
 const outfits=new OutfitService(join(root,'outfits.json'),portraits,resources,generator,()=>repository.loadConfig(),async()=>{throw Error('Must not decode');},async()=>{});
 const input={operationId:'cancel-operation',expectedAppearanceRevision:0,instruction:'synthetic',references:[{resourceId:record.id,sha256:record.sha256!,resourceRevision:record.revision}]};
 const job=await outfits.begin(scope,input);await began;
 assert.throws(()=>outfits.get({...scope,sessionId:'foreign'},job.id),{code:'not_found'});
 await outfits.cancel(scope,job.id);finish({kind:'failed',submitted:'yes',code:'failed',message:'late provider failure'});await new Promise(done=>setTimeout(done,10));
 assert.equal(outfits.get(scope,job.id).phase,'cancelled');await outfits.begin(scope,input);assert.equal(submitted,1);
});

test('portrait selection rejects a host failure and retains the persisted previous variant',async()=>{
 const root=mkdtempSync(join(tmpdir(),'w02-host-fail-')),registered:{skinId:string;assetFingerprint:string}[]=[];
 const skins={list:()=>registered,state:()=>({activeSkinId:'original',revision:0}),async import(_file:string,input:{skinId:string}){registered.push({skinId:input.skinId,assetFingerprint:'ab'.repeat(32)});}} as unknown as SkinManagement;
 try{const store=await PortraitStore.open(join(root,'portraits.json'),skins);const added=await store.add({characterId:'aika',file:'fixture.png',name:'差分',origin:'user_import',expectedRevision:0,operationId:'add',currentSkinId:'original'});const attempts:(string|null)[]=[];
 store.onChange=async set=>{attempts.push(set.selectedVariantId);if(set.selectedVariantId)throw Error('native rejected');};
 await assert.rejects(store.select('aika',added.variants[0]!.id,added.revision,'select'),/native rejected/);assert.deepEqual(attempts,[added.variants[0]!.id,null]);
 const restored=await PortraitStore.open(join(root,'portraits.json'),skins);assert.equal(restored.get('aika').selectedVariantId,null);assert.equal(restored.get('aika').revision,added.revision);
 }finally{rmSync(root,{recursive:true,force:true});}
});
