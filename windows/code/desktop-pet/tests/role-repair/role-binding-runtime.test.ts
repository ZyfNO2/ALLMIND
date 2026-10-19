// RWR-03 acceptance: a saved role binding is the configuration the RUNTIME actually consumes, and
// ManagedSettings keeps only the global sources/defaults plus the four background slots.
//
// Scope: the resolver (`resolveEffectiveRoleConfiguration`) driven against the REAL settings
// validation. It uses a controllable source catalog — a stub that proves the RESOLUTION CONTRACT
// (own vs inherit-default, credential rules, capability validation), not a real provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore, type ManagementSettingsStore as SettingsStore } from '../../management/settings-store.js';
import { defaultManagedSettings, validateManagedSettings } from '../../management/settings.js';
import { resolveEffectiveRoleConfiguration, type SourceCatalogView } from '../../management/role-binding-resolver.js';
import { RoleConfigurationStore, loadEffectiveRoleConfiguration, toRoleConfigurationV2 } from '../../management/role-configuration.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import type { RoleConfigurationV2 } from '../../contracts/role-configuration.js';
import type { CharacterPreset } from '../../contracts/management.js';
import type { ManagedSettings } from '../../contracts/management.js';
import { ANON } from './fixtures.js';

const SLOT_MODEL = {
  inputTokenLimit: 8192, outputTokenLimit: 4096, reservationMicros: 100_000,
  inputMicrosPerToken: 0.8, outputMicrosPerToken: 2,
};

/**
 * A source catalog with two own sources (one keyed, one auth:none) and per-adapter capabilities.
 *
 * `credentialFile` answers for ANY credential reference that the settings validator already accepted,
 * because `validateManagedSettings` is the authority that a reference resolves to a stored file. The
 * stub therefore refuses only the reference the tests explicitly want to be missing ('no-such-key').
 */
function catalog(overrides: Partial<SourceCatalogView> = {}): SourceCatalogView {
  return {
    resolveOwn: ({ slot, sourceInstanceId, modelProfileId }) => {
      if (sourceInstanceId === 'keyed-src' && modelProfileId === `${slot}-model`) {
        return { adapterId: `keyed-${slot}`, provider: 'dashscope', model: { model: `${slot}-own-model`, endpoint: `https://own.example/${slot}`, ...SLOT_MODEL, credentialFile: 'keyed.key' } as never, authKind: 'credentialRef' };
      }
      if (sourceInstanceId === 'local-src' && modelProfileId === `${slot}-model`) {
        // auth:none sources need NO credential.
        return { adapterId: `local-${slot}`, provider: 'local', model: { model: `${slot}-local-model`, endpoint: 'http://127.0.0.1:0', ...SLOT_MODEL, credentialFile: '' } as never, authKind: 'none' };
      }
      return undefined;
    },
    credentialFile: ({ credentialRef }) => (credentialRef === 'no-such-key' ? undefined : `${credentialRef}.key`),
    // The real default adapters (qwen-tts-instruct etc.) DO support voice/language/temperature, so the
    // stub is permissive by default. `no-cap-src` exists to exercise the capability-validation boundary.
    capabilities: ({ adapterId }) => (adapterId.startsWith('no-cap-') ? { temperature: false, voice: false, language: false } : { temperature: true, voice: true, language: true }),
    ...overrides,
  };
}

const own = (slot: string) => ({ mode: 'own' as const, sourceInstanceId: 'keyed-src', modelProfileId: `${slot}-model`, credentialRef: 'stored-key' });
const inherit = () => ({ mode: 'inherit-default' as const });

function roleConfig(overrides: Partial<RoleConfigurationV2> = {}): RoleConfigurationV2 {
  return {
    schemaVersion: 2, characterId: ANON.roleA, revision: 3, savedRevision: 3, effectiveRevision: 3, applyOn: 'restart',
    identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: 'anon-skin' },
    bindings: { dialogue: inherit(), asr: inherit(), tts: inherit() },
    ...overrides,
  };
}

/**
 * The control fixture registers dialogue/admission/summary/memory_turn/perception/tts but NO `asr`, so
 * an `asr` binding has no global default to inherit. The resolver's asr leg is therefore exercised in
 * `own` mode (own needs no global default) and the inherit-default-asr case is covered by the synthetic
 * AC-B5 test, which builds a settings object directly.
 */
async function realSettings(t: { after(fn: () => Promise<void>): void }): Promise<{ settings: SettingsStore; effective: ManagedSettings }> {
  const f = await fixture(t);
  const seed: ManagedSettings = defaultManagedSettings(f.c);
  // Give each of the front slots that HAS a default a distinct model so a mix-up is visible.
  seed.providers.dialogue = { ...seed.providers.dialogue, model: 'global-dialogue-default' };
  seed.providers.tts = { ...seed.providers.tts, model: 'global-tts-default' };
  const file = join(f.c.projectRoot, 'management-settings.json');
  const first = await ManagementSettingsStore.open(file, f.c);
  await first.save(0, validateManagedSettings(seed, f.c));
  await first.close();
  // `effective` is the ACTIVATED configuration; a fresh open applies the saved values, exactly as a
  // restart would. Using the still-open store would read the pre-save (base) configuration.
  const reopened = await ManagementSettingsStore.open(file, f.c);
  t.after(() => reopened.close());
  return { settings: reopened, effective: reopened.effective };
}

/** An asr default in inherit mode, built directly so it does not need a base asr model. */
function withAsrDefault(settings: ManagedSettings): ManagedSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      asr: { adapterId: 'qwen-asr', provider: settings.providers.tts.provider, model: 'global-asr-default', endpoint: settings.providers.tts.endpoint, credentialRef: settings.providers.tts.credentialRef, inputTokenLimit: 1024, outputTokenLimit: 1024, reservationMicros: 1000, inputMicrosPerToken: 0, outputMicrosPerToken: 0 },
    },
  } as ManagedSettings;
}

// AC-B1: inherit-default takes the global default; own overrides it --------------------------------
test('RWR-03 AC-B1: inherit-default resolves the global defaults into one effective config', async t => {
  const { effective } = await realSettings(t);
  // Register an asr default so the STT leg is exercised in inherit mode too.
  const resolved = resolveEffectiveRoleConfiguration({ configuration: roleConfig({ bindings: { dialogue: inherit(), asr: inherit(), tts: inherit() } }), settings: withAsrDefault(effective), catalog: catalog() });

  assert.equal(resolved.capabilities.dialogue.model, 'global-dialogue-default');
  assert.equal(resolved.capabilities.tts.model, 'global-tts-default');
  assert.equal(resolved.capabilities.asr.model, 'global-asr-default');
  assert.equal(resolved.capabilities.dialogue.mode, 'inherit-default');
  assert.equal(resolved.capabilities.asr.mode, 'inherit-default');
  assert.equal(resolved.configRevision, 3, 'every capability traces back to the saved config revision');
});

test('RWR-03 AC-B1b: an own binding overrides the global default for exactly that capability', async t => {
  const { effective } = await realSettings(t);
  const resolved = resolveEffectiveRoleConfiguration({
    configuration: roleConfig({ bindings: { dialogue: own('dialogue'), asr: inherit(), tts: inherit() } }),
    settings: withAsrDefault(effective), catalog: catalog(),
  });

  assert.equal(resolved.capabilities.dialogue.model, 'dialogue-own-model', 'own dialogue reaches the effective config');
  assert.equal(resolved.capabilities.dialogue.mode, 'own');
  assert.equal(resolved.capabilities.tts.model, 'global-tts-default', 'the other two stay on the default');
  assert.equal(resolved.capabilities.asr.model, 'global-asr-default');
  assert.notEqual(resolved.capabilities.dialogue.model, resolved.capabilities.tts.model);
});

// AC-B2: own source failure is a hard failure, never a silent fallback ------------------------------
test('RWR-03 AC-B2: an own source that cannot be resolved fails instead of falling back', async t => {
  const { effective } = await realSettings(t);
  const missing = { mode: 'own' as const, sourceInstanceId: 'ghost-src', modelProfileId: 'dialogue-model' };
  assert.throws(
    () => resolveEffectiveRoleConfiguration({
      configuration: roleConfig({ bindings: { dialogue: missing, asr: own('asr'), tts: inherit() } }),
      settings: effective, catalog: catalog(),
    }),
    (error: unknown) => (error as { code?: string }).code === 'unavailable',
    'an unresolvable own source must fail, not quietly use the global default',
  );
});

test('RWR-03 AC-B2b: a credentialRef whose service has no stored key is refused', async t => {
  const { effective } = await realSettings(t);
  const unknownKey = { mode: 'own' as const, sourceInstanceId: 'keyed-src', modelProfileId: 'dialogue-model', credentialRef: 'no-such-key' };
  assert.throws(
    () => resolveEffectiveRoleConfiguration({
      configuration: roleConfig({ bindings: { dialogue: unknownKey, asr: own('asr'), tts: inherit() } }),
      settings: effective, catalog: catalog(),
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('RWR-03 AC-B2c: an auth:none own source needs no credential', async t => {
  const { effective } = await realSettings(t);
  const resolved = resolveEffectiveRoleConfiguration({
    configuration: roleConfig({ bindings: { dialogue: { mode: 'own', sourceInstanceId: 'local-src', modelProfileId: 'dialogue-model' }, asr: own('asr'), tts: inherit() } }),
    settings: effective, catalog: catalog(),
  });
  assert.equal(resolved.capabilities.dialogue.model, 'dialogue-local-model');
  assert.equal(resolved.capabilities.dialogue.mode, 'own');
  assert.equal(resolved.capabilities.dialogue.credentialFile, '', 'auth:none carries no key file');
});

// AC-B3: background four slots are global and never role-scoped ------------------------------------
test('RWR-03 AC-B3: the four background slots pass through unchanged and are not role-scoped', async t => {
  const { effective } = await realSettings(t);
  const before = {
    memory_turn: effective.providers.memory_turn.model,
    summary: effective.providers.summary.model,
    perception: effective.providers.perception.model,
    admission: effective.providers.admission.model,
  };
  const resolved = resolveEffectiveRoleConfiguration({ configuration: roleConfig({ bindings: { dialogue: inherit(), asr: own('asr'), tts: inherit() } }), settings: effective, catalog: catalog() });
  assert.equal(resolved.background.memory_turn.model, before.memory_turn);
  assert.equal(resolved.background.summary.model, before.summary);
  assert.equal(resolved.background.perception.model, before.perception);
  assert.equal(resolved.background.admission.model, before.admission);
});

// AC-B4: the effective config is immutable and revision-tracked ---------------------------------------
test('RWR-03 AC-B4: the effective configuration is frozen and carries its source revision', async t => {
  const { effective } = await realSettings(t);
  const resolved = resolveEffectiveRoleConfiguration({ configuration: roleConfig({ savedRevision: 7, bindings: { dialogue: inherit(), asr: own('asr'), tts: inherit() } }), settings: effective, catalog: catalog() });
  assert.equal(Object.isFrozen(resolved), true, 'a later save must not mutate an in-flight configuration');
  assert.equal(Object.isFrozen(resolved.capabilities), true);
  assert.equal(Object.isFrozen(resolved.capabilities.dialogue), true);
  assert.equal(resolved.capabilities.dialogue.configRevision, 7);
  assert.throws(() => { (resolved as { characterId: string }).characterId = 'other'; }, TypeError, 'frozen snapshot resists mutation');
});

// AC-B6: the G3 requirement — a binding saved through the preset surface reaches the runtime ------
test('RWR-03 AC-B6: a binding saved through the preset surface reaches the effective runtime config', async t => {
  const f = await fixture(t);
  const file = join(f.c.projectRoot, 'management-settings.json');
  const seed: ManagedSettings = defaultManagedSettings(f.c);
  seed.providers.dialogue = { ...seed.providers.dialogue, model: 'global-dialogue-default' };
  const settings = await ManagementSettingsStore.open(file, f.c);
  await settings.save(0, validateManagedSettings(seed, f.c));
  await settings.close();
  const active = await ManagementSettingsStore.open(file, f.c);
  t.after(() => active.close());

  // A preset whose dialogue model is a model the settings catalog actually registers (a real adapter
  // choice), so the resolver produces an `own` binding rather than leaving it inherit.
  const registeredModel = f.c.models.dialogue.model;
  const preset: CharacterPreset = {
    characterId: ANON.roleA, presetId: 'p', revision: 2, savedRevision: 2, effectiveRevision: 2,
    appearance: { type: 'live2d', resourceId: 'anon-skin' }, persona: { text: '', revision: 1 },
    bindings: { dialogue: { provider: active.effective.providers.dialogue.provider, model: registeredModel, credentialRef: active.effective.providers.dialogue.credentialRef, temperature: 0.7 } },
  };
  // The running role resolves all three capabilities, so the settings must carry an asr default too
  // (the control fixture does not register one).
  const effectiveSettings = withAsrDefault(active.effective);
  const configuration = toRoleConfigurationV2(preset, f.c, effectiveSettings);
  assert.equal(configuration.bindings.dialogue.mode, 'own', 'a preset model that resolves becomes an own binding');

  const roleStore = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'role-configurations.json') });
  await roleStore.save(configuration);

  // The composition root reads the SAVED role configuration and resolves it — the saved binding is
  // what the effective config now carries, proving it is not a shadow record.
  const effective = loadEffectiveRoleConfiguration({ base: f.c, settings: effectiveSettings, store: roleStore, characterId: ANON.roleA });
  assert.equal(effective.capabilities.dialogue.model, registeredModel, 'the saved role binding is the runtime model');
  assert.equal(effective.capabilities.dialogue.mode, 'own');
});

// AC-B5: a missing global default is a visible failure, not a silent skip ---------------------------
test('RWR-03 AC-B5: inherit-default with no configured default is a visible failure', () => {
  const incomplete = {
    providers: { dialogue: { adapterId: 'a', provider: 'p', model: 'm', endpoint: 'https://e', credentialRef: 'k', inputTokenLimit: 1, outputTokenLimit: 1, reservationMicros: 1, inputMicrosPerToken: 0, outputMicrosPerToken: 0 } },
    context: { maxRecentMessages: 1, maxMemories: 1, summaryLimit: 0, summaryMinMessages: 2, summaryMaxMessages: 2, timeoutMs: 1000 },
  } as unknown as ManagedSettings;
  assert.throws(
    () => resolveEffectiveRoleConfiguration({
      configuration: roleConfig({ bindings: { dialogue: inherit(), asr: inherit(), tts: inherit() } }),
      settings: incomplete, catalog: catalog(),
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
    'a missing default must fail loudly rather than skip the capability',
  );
});
