import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBundlePreview} from '../../memory/resource-bundle.js';
test('HTML package image and page links resolve, while encoded escapes and executable schemes block organizing', () => {
  const page=(html:string)=>{
    const files=new Map([['manifest.json',Buffer.from(JSON.stringify({schemaVersion:'aiki-resource-bundle/v1',entrypoint:'index.html',files:[{path:'index.html',role:'page',mime:'text/html'},{path:'note.md',role:'page',mime:'text/markdown'}]}))],['index.html',Buffer.from(html)],['note.md',Buffer.from('# synthetic')]]);
    return buildBundlePreview({scope:{characterId:'aika',pairingId:'local-user',sessionId:'bundle-html'},resourceId:'res-html',bundleSha256:'a'.repeat(64),archive:{files,totalBytes:100}});
  };
  const good=page('<a href="note.md#section">note</a>');assert.equal(good.canOrganize,true);assert.equal(good.links[0]?.target,'note.md');
  for(const link of ['%2e%2e/secret','javascript:alert(1)','%2fetc/passwd']){const bad=page(`<a href="${link}">bad</a>`);assert.equal(bad.canOrganize,false);assert.equal(bad.links[0]?.status,'broken');}
});
