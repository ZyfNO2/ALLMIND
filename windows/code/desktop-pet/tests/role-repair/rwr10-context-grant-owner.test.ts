import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { CompanionModeRuntime } from '../../core/companion-mode-runtime.js';

const pairing = productionPairing('companion', 'rwr10-context-owner');

test('RWR-10-05: ContextUseGrant is owned by CompanionModeRuntime and survives runtime reconstruction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rwr10-context-grant-'));
  const memory = new SqliteMemoryStore({ filename: resolve(root, 'memory.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  try {
    const db = memory.rawDatabaseForKnowledge();
    const grantRequest = { operationId: 'context-operation-1', expectedRevision: 0,
      observationSourceScopes: ['screen:display-1'], modelBinding: 'provider:model', destination: 'cloud' as const, ttlMs: 60_000 };
    const firstOwner = new CompanionModeRuntime({ db, pairing });
    const issued = await firstOwner.issueContextUseGrant(grantRequest);
    assert.equal(issued.revision, 1);
    const replay = await firstOwner.issueContextUseGrant(grantRequest);
    assert.deepEqual(replay, issued);

    const restartedOwner = new CompanionModeRuntime({ db, pairing });
    assert.deepEqual(restartedOwner.getContextUseGrant(), issued);
    const revoked = await restartedOwner.revokeContextUseGrant({ grantId: issued.grantId, expectedRevision: issued.revision,
      operationId: 'context-revoke-1' });
    assert.equal(revoked.state, 'revoked');
    assert.equal(restartedOwner.getContextUseGrant()?.state, 'revoked');
  } finally {
    memory.close();
  }
});
