import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {FileBookRepository} from '../../memory/file-book-repository.js';
import type {BookScope,SavedTurn} from '../../contracts/memory-book.js';

const scope:BookScope={characterId:'aika',pairingId:'local-user',sessionId:'archive-case'};
test('session archive is reversible, durable, idempotent and isolated without modifying turns',t=>{
  const root=resolve('.local/ui-v2-tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'archive-'));
  let repo=new FileBookRepository(directory);t.after(()=>repo.close());
  const turn:SavedTurn={...scope,id:'one',timestamp:new Date().toISOString(),user:'第一段对话',assistant:'回应',traceId:'trace-one'};repo.appendTurn(scope,turn);
  assert.throws(()=>repo.setSessionArchived({...scope,characterId:'other'},true),{code:'invalid_input'});
  assert.throws(()=>repo.setSessionArchived({...scope,pairingId:'other'},true),{code:'invalid_input'});
  assert.throws(()=>repo.setSessionArchived(scope,'true' as unknown as boolean),{code:'invalid_input'});
  repo.setSessionArchived(scope,true);const date=repo.listSessions(scope.characterId,scope.pairingId)[0]!.archivedAt;
  assert.ok(date);repo.setSessionArchived(scope,true);assert.equal(repo.listSessions(scope.characterId,scope.pairingId)[0]!.archivedAt,date);
  repo.close();repo=new FileBookRepository(directory);assert.equal(repo.listSessions(scope.characterId,scope.pairingId)[0]!.archivedAt,date);assert.deepEqual(repo.readSession(scope),[turn]);
  repo.setSessionArchived(scope,false);assert.equal(repo.listSessions(scope.characterId,scope.pairingId)[0]!.archivedAt,undefined);assert.deepEqual(repo.readSession(scope),[turn]);
  const file=join(directory,readdirSync(directory).find(name=>name.startsWith('session-archive-'))!);writeFileSync(file,'{broken');
  assert.throws(()=>repo.listSessions(scope.characterId,scope.pairingId),{code:'corrupt_data'});assert.equal(readFileSync(file,'utf8'),'{broken');
});
