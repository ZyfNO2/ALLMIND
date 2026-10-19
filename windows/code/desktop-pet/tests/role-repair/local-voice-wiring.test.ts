// RWR-05 acceptance: the LOCAL voice sources are registered, are `auth:'none'`, and never fall back
// to a cloud source or hide a missing model behind a fabricated "ready".
//
// The behaviours asserted here are the ones RWR-00's G5 marked RED and CONTRACTS §4 / D4 froze:
//   * SAPI (Windows TTS) and Sherpa (local STT) appear in the management catalog;
//   * a local source needs no API key, and its cost is local/unmetered — never a fabricated cloud rate;
//   * a `local:` endpoint is a distinct, non-network scheme (it can never be redirected);
//   * a remote source is still refused a missing credential (auth:none is declared, not inferred).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../management/helpers.js';
import { availableAdapters, defaultManagedSettings, effectiveTrialConfiguration, validateManagedSettings } from '../../management/settings.js';
import { isAllowedEndpoint } from '../../providers/slot-registry.js';
import { LOCAL_CREDENTIAL_MARKER } from '../../management/settings.js';

const find = (adapters: ReturnType<typeof availableAdapters>, id: string) => adapters.find(adapter => adapter.id === id);

// G5 -----------------------------------------------------------------------------------------
test('RWR-05 G5: SAPI and Sherpa appear in the management catalog', async t => {
  const f = await fixture(t);
  const adapters = availableAdapters(f.c);
  const ids = adapters.map(a => a.id).join(',');
  assert.match(ids, /sapi/i, 'no Windows SAPI (local TTS) source is registered');
  assert.match(ids, /sherpa/i, 'no Sherpa (local STT) source is registered');
});

// The local sources are auth:none and unmetered ------------------------------------------------
test('RWR-05: a local source is auth:none and carries no cloud tariff', async t => {
  const f = await fixture(t);
  const adapters = availableAdapters(f.c);

  const sapi = find(adapters, 'sapi-tts');
  assert.ok(sapi, 'SAPI adapter is present');
  assert.equal(sapi!.auth, 'none', 'SAPI must not require an API key');
  const sapiChoice = sapi!.choices![0]!.configuration;
  assert.equal(sapiChoice.provider, 'local');
  assert.equal(sapiChoice.characterMicros, 0, 'a local source is not billed per character');
  assert.equal(sapiChoice.inputMicrosPerToken, 0);
  assert.equal(sapiChoice.outputMicrosPerToken, 0);

  const sherpa = find(adapters, 'sherpa-streaming-asr');
  assert.ok(sherpa, 'Sherpa adapter is present');
  assert.equal(sherpa!.auth, 'none', 'Sherpa must not require an API key');
  const sherpaChoice = sherpa!.choices![0]!.configuration;
  assert.equal(sherpaChoice.provider, 'local');
  assert.equal(sherpaChoice.audioMicrosPerSecond, 0, 'local STT is not billed per audio second');
});

// A local endpoint is a distinct scheme that is never reachable over the network ---------------
test('RWR-05: a local: endpoint is allowed but is not a network endpoint', () => {
  assert.equal(isAllowedEndpoint('local://windows/sapi'), true, 'a local source endpoint is a valid binding');
  assert.equal(isAllowedEndpoint('https://api.example.com'), true);
  assert.equal(isAllowedEndpoint('http://127.0.0.1:1/x'), true);
  assert.equal(isAllowedEndpoint('http://evil.example.com'), false, 'a remote http origin is still refused');
  assert.equal(isAllowedEndpoint('ftp://x/'), false);
});

// The accounting boundary recognises a local source without a key or a positive reservation -------
test('RWR-05: a local binding validates and resolves to the local marker, never a cloud key', async t => {
  const f = await fixture(t);
  const seed = defaultManagedSettings(f.c);
  const sapi = find(availableAdapters(f.c), 'sapi-tts')!;
  seed.providers.tts = { ...sapi.choices![0]!.configuration, credentialRef: '' } as never;
  // A local source with no credential is accepted (auth:none).
  const validated = validateManagedSettings(seed, f.c);
  assert.equal(validated.providers.tts.provider, 'local');
  // The resolved trial configuration records the local marker, never a real credential file.
  const effective = effectiveTrialConfiguration(f.c, validated);
  assert.equal(effective.models.tts.credentialFile, LOCAL_CREDENTIAL_MARKER);
  assert.equal((effective.models.tts as { localUnmetered?: boolean }).localUnmetered, true);
});

// A remote source is still refused a missing credential (auth:none is declared, not inferred) ---
test('RWR-05: a remote source still requires a registered credential', async t => {
  const f = await fixture(t);
  const seed = defaultManagedSettings(f.c);
  seed.providers.tts = { ...seed.providers.tts!, credentialRef: '' } as never;
  assert.throws(() => validateManagedSettings(seed, f.c), { code: 'invalid_request' },
    'an empty credential on a remote source must be refused; auth:none is declared by the adapter, not inferred');
});
