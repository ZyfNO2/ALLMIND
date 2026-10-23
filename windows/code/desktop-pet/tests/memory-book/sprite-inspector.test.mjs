import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {inspectSprite} from '../../dist/management/sprite-inspector.js';
test('sprite decode validates PNG and WebP without showing a window and refuses broken bytes or impossible grids',{timeout:30000},async()=>{
  const image=resolve('tests/companion-knowledge/fixtures/ocr/blank.png');
  const sprite=await inspectSprite(image);assert.ok(sprite.width>0&&sprite.height>0);assert.equal(sprite.frameCount,1);
  const webp=await inspectSprite(resolve('tests/companion-knowledge/fixtures/ocr/probe.webp'));
  assert.equal(webp.width,2);assert.equal(webp.height,2);assert.equal(webp.frameCount,1);
  const atlas=await inspectSprite(resolve('tests/companion-knowledge/fixtures/ocr/probe.webp'),{rows:2,columns:1,frameCount:2});
  assert.deepEqual(atlas.contentBounds,{x:0,y:0,width:2,height:1},'atlas bounds must be local to a single frame');
  mkdirSync('.local/ui-v4/tests',{recursive:true});const directory=mkdtempSync('.local/ui-v4/tests/image-'),broken=join(directory,'broken.png');writeFileSync(broken,'not an image');
  await assert.rejects(inspectSprite(broken),/解码/);await assert.rejects(inspectSprite(image,{rows:sprite.height+1}),/行列|尺寸/);
});
