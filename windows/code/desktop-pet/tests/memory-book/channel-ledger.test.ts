import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelLedger} from '../../memory/channel-ledger.js';
import {normalizeQqEvent} from '../../providers/onebot-qq.js';
import {qqScope} from '../../memory/channel-publication.js';

function fixture(t:test.TestContext){const directory=mkdtempSync(join(tmpdir(),'allmind-qq-ledger-'));let ledger=new ChannelLedger(directory);t.after(()=>{ledger.close();rmSync(directory,{recursive:true,force:true});});return {get ledger(){return ledger;},restart(){ledger.close();ledger=new ChannelLedger(directory);return ledger;},directory};}
const message=normalizeQqEvent({post_type:'message',self_id:10001,user_id:20001,message_id:-1,message_type:'private',sub_type:'friend',message:[{type:'text',data:{text:'synthetic'}}]},{connectorId:'qq-test',selfId:'10001',privateIds:['20001'],groupIds:[]})!;
const scope=qqScope('aika',message,'initial'),publicationHash='a'.repeat(64),key=message.eventKey;

test('durable incoming dedup survives restart and conflicting text/route/publication cannot be replayed',t=>{
  const f=fixture(t);assert.equal(f.ledger.accept(message,scope,publicationHash).duplicate,false);assert.equal(f.ledger.accept(message,scope,publicationHash).duplicate,true);f.restart();
  assert.equal(f.ledger.accept(message,scope,publicationHash).duplicate,true);assert.equal(f.ledger.list().length,1);
  assert.throws(()=>f.ledger.accept({...message,text:'changed'},scope,publicationHash),/变化/);assert.throws(()=>f.ledger.accept(message,{...scope,sessionId:'other'},publicationHash),/变化/);assert.throws(()=>f.ledger.accept(message,scope,'b'.repeat(64)),/变化/);
});

test('restart during generation freezes unknown and cannot begin another generation',t=>{
  const f=fixture(t);f.ledger.accept(message,scope,publicationHash);f.ledger.begin(key);f.restart();assert.equal(f.ledger.get(key)!.state,'unknown');assert.throws(()=>f.ledger.begin(key),/重复/);assert.throws(()=>f.ledger.generated(key,'late'),/改变/);
});

test('saved result is recoverable before first send; sent segment and unknown later segment remain distinct across restart',t=>{
  const f=fixture(t);f.ledger.accept(message,scope,publicationHash);f.ledger.begin(key);f.ledger.generated(key,'😀'.repeat(1501));f.restart();let row=f.ledger.get(key)!;assert.equal(row.state,'generated');assert.equal(row.parts.length,2);assert.equal(Array.from(row.parts[0]!.text).length,1500);
  assert.throws(()=>f.ledger.intent(key,1),/不可发送/);f.ledger.intent(key,0);f.ledger.sent(key,0,'101');f.ledger.intent(key,1);f.restart();row=f.ledger.get(key)!;
  assert.equal(row.state,'unknown');assert.equal(row.parts[0]!.state,'sent');assert.equal(row.parts[0]!.messageId,'101');assert.equal(row.parts[1]!.state,'unknown');assert.throws(()=>f.ledger.intent(key,0));assert.throws(()=>f.ledger.intent(key,1));assert.throws(()=>f.ledger.stop(key,true));
});

test('positive receipts persist sent exactly; duplicate intake never creates another reply or resets completed state',t=>{
  const f=fixture(t);f.ledger.accept(message,scope,publicationHash);f.ledger.begin(key);f.ledger.generated(key,'one reply');f.ledger.intent(key,0);f.ledger.sent(key,0,'123');f.restart();
  assert.equal(f.ledger.accept(message,scope,publicationHash).row.state,'sent');assert.equal(f.ledger.list().length,1);assert.throws(()=>f.ledger.begin(key));assert.throws(()=>f.ledger.intent(key,0));
});

test('bounded outputs fail explicitly without truncation or changing the generation state; one writer only',t=>{
  const f=fixture(t);f.ledger.accept(message,scope,publicationHash);f.ledger.begin(key);for(const text of ['', 'x'.repeat(24001)])assert.throws(()=>f.ledger.generated(key,text),/未截断/);assert.equal(f.ledger.get(key)!.state,'generating');assert.throws(()=>new ChannelLedger(f.directory));
  f.ledger.generated(key,'ready');f.ledger.intent(key,0);f.ledger.unknown(key,0);f.restart();assert.equal(f.ledger.get(key)!.state,'unknown');
  assert.throws(()=>f.ledger.review(key,0,'delivered','201',false));f.ledger.review(key,0,'delivered','201',true);f.restart();assert.equal(f.ledger.get(key)!.parts[0]!.confirmation,'local');assert.equal(f.ledger.get(key)!.state,'sent');
});
