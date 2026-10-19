// RWR-03: the bridge between the persisted role preset (the current write surface) and the versioned
// role configuration v2 the resolver consumes, plus the store the composition root reads at startup.
//
// D3 froze the authority split, and this module is where the two inputs are assembled ONCE so a saved
// role binding can no longer be a shadow record the runtime ignores:
//
//   * the role configuration v2 (this module) owns the three role-scoped capabilities;
//   * `ManagedSettings` keeps the global sources, the default template and the four background slots;
//   * `resolveEffectiveRoleConfiguration` turns them into the immutable effective config the runtime uses.
//
// Migration (CONTRACTS §2): a role's three slots start as `inherit-default`, so `settings.effective`'s
// models become the role's initial effective bindings. `settings.saved`'s not-yet-applied difference is
// preserved as the saved configuration. A preset model that disagrees with the real runtime is kept as an
// auditable draft rather than silently activated.
import { ManagementError, type ManagedSettings, type CharacterPreset } from '../contracts/management.js';
import type { RoleBindingsConfiguration, RoleConfigurationV2, RoleCapabilityBinding } from '../contracts/role-configuration.js';
import { resolveEffectiveRoleConfiguration, type SourceCatalogView } from './role-binding-resolver.js';
import { credentialRegistry } from './credentials.js';
import { availableAdapters, resolveSlotAdapter, validateManagedSettings } from './settings.js';
import { validateTrialConfiguration, type TrialConfiguration, type TrialModel } from '../app/trial-config.js';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { restrictPrivatePathSync } from '../core/platform-files.js';
import type { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { ProviderSourceStore } from './provider-sources.js';
import { ROLE_BINDING_SLOTS } from '../contracts/role-configuration.js';

const INHERIT: RoleCapabilityBinding = Object.freeze({ mode: 'inherit-default' });

/**
 * RWR-08 / AC-A: a persisted, replayable write receipt keyed by (character, domain, operationId).
 * The same operationId with the same payload replays the ORIGINAL configuration; the same id with a
 * different payload is a conflict. Receipts ride the same JSON document as the states, so a reopen
 * keeps dedupe working — exactly the discipline `character_registry_operations` uses in SQLite.
 */
interface AuthorOperationRecord { readonly signature: string; readonly configuration: RoleConfigurationV2 }

/** Deterministic payload signature: the same operationId with different content is a conflict. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Author metadata bounds. They are author prose, not a second persona body, so they stay modest. */
const MAX_AUTHOR_FIELD = 4000;
const MAX_INTRO = 200;

/** Author text is stored verbatim (minus control characters) — it is never interpreted as instructions. */
function authorText(value: string, name: string, max: number): string {
  if (typeof value !== 'string') throw new ManagementError('invalid_request', `${name}无效。`);
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ManagementError('invalid_request', `${name}无效或超长。`);
  }
  return value;
}

/**
 * RWR-06: only a VERIFIED import reference is stored — `<kind>:<id>` with bounded, control-free parts.
 *
 * A free-form file path is REFUSED rather than trimmed, because CONTRACTS §2 forbids persisting one:
 * a path in configuration is a promise the product will later have to honour by reading that file.
 */
function verifiedSourceRef(value: string): string {
  if (typeof value !== 'string') throw new ManagementError('invalid_request', '来源引用无效。');
  const trimmed = value.trim();
  const match = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._-]{1,96})$/.exec(trimmed);
  if (!match) {
    if (/[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
      throw new ManagementError('invalid_request', '不接受文件路径；只保存已验证的来源引用（kind:id）。');
    }
    throw new ManagementError('invalid_request', '来源引用格式无效（应为 kind:id）。');
  }
  return match[0];
}

/**
 * A source catalog backed by the EXISTING source/model/binding registry and credential registry.
 *
 * `resolveOwn` only succeeds for a model the settings validator already accepted for that slot, so a
 * role cannot point at a service the product does not actually know. The catalog is derived, not a new
 * registry: it reuses `availableAdapters`, `resolveSlotAdapter` and `credentialRegistry`.
 */
export function settingsBackedCatalog(
  base: TrialConfiguration,
  settings: ManagedSettings,
  voices?: RegisteredVoiceStore,
  sources?: ProviderSourceStore,
): SourceCatalogView {
  const credentials = credentialRegistry(base);
  const adapters = availableAdapters(base, voices);
  return {
    resolveOwn: ({ slot, sourceInstanceId, modelProfileId, credentialRef }) => {
      // Resolve persisted source/profile IDs first. Older bindings naming an adapter/provider and
      // catalog model retain read compatibility below; an unknown binding fails without substitution.
      const stored = sources?.resolve(slot, sourceInstanceId, modelProfileId);
      if (stored) {
        if (stored.source.auth.kind === 'credentialRef' && credentialRef !== stored.source.auth.ref) return undefined;
        const selection = stored.selection;
        return { adapterId: selection.adapterId, provider: selection.provider, model: selection as unknown as TrialModel, authKind: stored.source.auth.kind };
      }
      const candidates = adapters.filter(adapter => adapter.slots.includes(slot as never));
      const adapter = candidates.find(candidate => candidate.id === sourceInstanceId)
        ?? candidates.find(candidate => candidate.provider === sourceInstanceId && candidate.choices?.some(choice => choice.configuration.model === modelProfileId));
      const choice = adapter?.choices?.find(c => c.configuration.model === modelProfileId);
      const provider = choice?.configuration.provider ?? adapter?.provider;
      if (!adapter || !provider || !choice) return undefined;
      return { adapterId: adapter.id, provider, model: choice?.configuration as never, authKind: adapter.auth === 'none' ? 'none' as const : 'credentialRef' as const };
    },
    credentialFile: ({ credentialRef, provider }) => {
      try { return credentials.file(credentialRef, provider); } catch { return undefined; }
    },
    capabilities: ({ adapterId }) => {
      const adapter = adapters.find(candidate => candidate.id === adapterId);
      return adapter?.capabilities as { temperature?: boolean; language?: boolean; voice?: boolean } | undefined;
    },
    // RWR-08 (F04): a LOCAL `auth:'none'` source must be recorded as unmetered through the inherit path
    // too — the review found SAPI (auth:none) hardcoded to `credentialRef`, which failed boot.
    authKind: ({ adapterId }) => {
      const adapter = adapters.find(candidate => candidate.id === adapterId);
      return adapter?.auth as 'none' | 'credentialRef' | undefined;
    },
  };
}

/** Build the role configuration v2 from a stored preset. The preset is the current write surface. */
export function toRoleConfigurationV2(preset: CharacterPreset, base: TrialConfiguration, settings: ManagedSettings): RoleConfigurationV2 {
  void base; void settings; // the saved binding carries its own identity; the catalog is consulted at resolve time
  /**
   * A preset that names a concrete model and a credential IS an explicit own choice. It becomes an
   * `own` binding as saved; whether that source is currently RESOLVABLE is decided by the resolver at
   * consumption time (an unresolvable own source is a hard failure there, never a silent fallback to the
   * default). A preset without a concrete model/credential stays `inherit-default`.
   */
  const own = (slot: 'dialogue' | 'asr' | 'tts'): RoleCapabilityBinding => {
    const binding = preset.bindings[slot] as CharacterPreset['bindings']['dialogue'] | undefined;
    if (!binding?.model || !binding.credentialRef) return INHERIT;
    // `sourceInstanceId` is the provider identity the binding was saved with; the model profile is the
    // model name. Both are what the resolver re-resolves against the real catalog.
    return { mode: 'own', sourceInstanceId: binding.provider, modelProfileId: binding.model, credentialRef: binding.credentialRef, ...(binding.temperature !== undefined ? { parameters: { temperature: binding.temperature } } : {}) };
  };
  return {
    schemaVersion: 2,
    characterId: preset.characterId,
    revision: preset.revision,
    savedRevision: preset.savedRevision,
    effectiveRevision: preset.effectiveRevision,
    applyOn: 'restart',
    identity: { intro: '' },
    persona: { text: preset.persona.text, revision: preset.persona.revision },
    appearance: { type: preset.appearance.type, resourceId: preset.appearance.resourceId },
    bindings: { dialogue: own('dialogue'), asr: own('asr'), tts: own('tts') },
  };
}

/**
 * The role configuration store. The role configuration v2 is the sole write surface for the three role
 * capabilities; ManagedSettings keeps the global defaults and the four background slots. This store lives
 * on disk beside the preset file and is what the composition root reads at startup.
 *
 * RWR-08 / AC-A: every save is ONE serial transaction — validate, build the candidate, persist, and only
 * then publish to memory. A persist failure leaves the previous file AND the previous in-memory revision
 * untouched, exactly like `ManagementSettingsStore.commit`. The file itself is replaced atomically
 * (same-directory temporary file + rename), never rewritten in place and never re-overwritten in a
 * `finally` that could commit content after a reported failure.
 */
export class RoleConfigurationStore {
  private tail: Promise<unknown> = Promise.resolve();
  private authorOperations = new Map<string, AuthorOperationRecord>();
  sources!: ProviderSourceStore;
  readonly effectiveConfigurations = new Map<string, import('../contracts/role-configuration.js').EffectiveRoleConfiguration>();
  private constructor(private readonly file: string, private states: Map<string, RoleConfigurationV2>) {}

  static async open(options: { file: string }): Promise<RoleConfigurationStore> {
    const states = new Map<string, RoleConfigurationV2>();
    const authorOperations = new Map<string, AuthorOperationRecord>();
    let raw: string | undefined;
    try { raw = await readFile(options.file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (raw) {
      const parsed = JSON.parse(raw) as { states?: Record<string, RoleConfigurationV2>; authorOperations?: Record<string, { signature: string; configuration: RoleConfigurationV2 }> };
      for (const [id, value] of Object.entries(parsed.states ?? {})) if (value?.schemaVersion === 2) states.set(id, value);
      for (const [key, record] of Object.entries(parsed.authorOperations ?? {})) {
        if (typeof record?.signature === 'string' && record.configuration?.schemaVersion === 2) authorOperations.set(key, record);
      }
    }
    const store = new RoleConfigurationStore(options.file, states);
    store.authorOperations = authorOperations;
    store.sources = await ProviderSourceStore.open(join(dirname(options.file), 'provider-sources.json'));
    return store;
  }

  get(characterId: string): RoleConfigurationV2 | null { return this.states.get(characterId) ?? null; }
  list(): readonly RoleConfigurationV2[] { return [...this.states.values()]; }

  /**
   * RUX-01: the restart boundary for the role configuration. Opening the store IS the boundary: the
   * saved configuration becomes the running one, so the persisted `effectiveRevision` catches up with
   * `savedRevision` WITHOUT advancing the write cursor. Before this, a restart never promoted the
   * revision, so the console's「重启后生效」banner stayed up forever and a real "did it apply?" check
   * was impossible. The durable copy is written through the same serialized chain as every other
   * mutation; a crash before that write is harmless because the next boot re-promotes from the same
   * saved configuration.
   */
  promoteEffective(characterId: string): void {
    const current = this.get(characterId);
    if (!current || current.savedRevision <= current.effectiveRevision) return;
    const next = { ...current, effectiveRevision: current.savedRevision };
    this.states.set(next.characterId, next);
    this.tail = this.tail.then(() => this.#persist(states => states.set(next.characterId, next))).catch(() => {});
  }

  /**
   * Serializes ALL mutations so a concurrent save on the same revision can never interleave its
   * validate→persist→publish steps with another's. Exactly one of two same-revision writers commits.
   */
  save(configuration: RoleConfigurationV2): Promise<RoleConfigurationV2> {
    const run = this.tail.then(async () => {
      await this.#persist(next => next.set(configuration.characterId, configuration));
      return configuration;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  saveBindings(characterId: string, input: { bindings: Partial<RoleBindingsConfiguration>; expectedRevision: number; operationId: string }): Promise<RoleConfigurationV2> {
    const run = this.tail.then(async () => {
      const signature = digest(input), key = `${characterId}\u0000bindings\u0000${input.operationId}`;
      const prior = this.authorOperations.get(key);
      if (prior) { if (prior.signature !== signature) throw new ManagementError('version_conflict', '操作编号已用于不同配置。'); return prior.configuration; }
      const current = this.get(characterId);
      if (!current) throw new ManagementError('not_found', '没有这个角色。');
      if (current.savedRevision !== input.expectedRevision) throw new ManagementError('version_conflict', '角色配置已更新，请刷新后重试。');
      const next = { ...current, revision: current.revision + 1, savedRevision: current.savedRevision + 1, bindings: { ...current.bindings, ...input.bindings } };
      await this.#persist(states => states.set(characterId, next), { key, signature, configuration: next });
      return next;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * RWR-06: save the AUTHOR metadata of a role, versioning each field independently.
   *
   * The five author fields (`intro` / `scenario` / `firstMessage` / `exampleDialogue` / `sourceRef`) are
   * separate documents with their own cursors, so editing one cannot silently roll back another and a
   * conflict names the field that actually moved. The persona BODY is deliberately not editable here:
   * `memory.prompt` remains its single authority (CONTRACTS §2), and this never writes a second body.
   *
   * `firstMessage` is stored but marked display-only; nothing here turns it into a turn, a message, or a
   * memory record, so it can never become a fabricated user memory.
   *
   * `sourceRef` accepts only a VERIFIED reference form (`<kind>:<id>`, both bounded and control-free).
   * A free-form file path is refused, because CONTRACTS §2 forbids persisting one.
   *
   * RWR-08 / AC-A: the operationId is deduped per (character, 'author') domain BEFORE any write — the
   * same id with the same payload replays the original receipt (no revision advance), the same id with
   * a different payload is a version conflict, and a failed persist leaves both the file and memory at
   * their previous state.
   */
  async saveAuthorMetadata(characterId: string, input: {
    readonly intro?: string | undefined;
    readonly scenario?: string | undefined;
    readonly firstMessage?: string | undefined;
    readonly exampleDialogue?: string | undefined;
    readonly sourceRef?: string | undefined;
    /** Expected cursor of the field being written, when the caller wants an optimistic edit. */
    readonly expectedFieldRevision?: number | undefined;
    readonly operationId: string;
  }): Promise<RoleConfigurationV2> {
    if (typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 160) {
      throw new ManagementError('invalid_request', '操作编号无效。');
    }
    const operationSignature = digest({ domain: 'author', characterId, intro: input.intro ?? null, scenario: input.scenario ?? null, firstMessage: input.firstMessage ?? null, exampleDialogue: input.exampleDialogue ?? null, sourceRef: input.sourceRef ?? null, expectedFieldRevision: input.expectedFieldRevision ?? null });
    // Dedupe is keyed by (character, domain, operationId): replaying an OLD operationId with the same
    // payload returns its original receipt, and two DIFFERENT operationIds never conflict with each
    // other — their race is decided by expectedFieldRevision, not by the dedupe ledger.
    const replayKey = `${characterId}\u0000author\u0000${input.operationId}`;
    const prior = this.authorOperations.get(replayKey);
    if (prior) {
      if (prior.signature !== operationSignature) throw new ManagementError('version_conflict', '同一操作编号已用于不同内容。');
      // Replay returns the ORIGINAL receipt without touching the file or the cursors.
      return prior.configuration;
    }

    const run = this.tail.then(async () => {
      const current = this.get(characterId);
      // CONTRACTS §6: an unknown role is `not_found` — admission is the REGISTRY's decision, never this
      // store. A newly created role is seeded by the registry creation path (`ensureConfiguration`), so
      // a real author save never lands here without a configuration.
      if (!current) throw new ManagementError('not_found', '没有这个角色。');
      // A configuration written before RWR-06 has no field cursor; treat it as revision 0.
      const fieldRevision = current.fieldRevision ?? 0;
      if (input.expectedFieldRevision !== undefined && input.expectedFieldRevision !== fieldRevision) {
        throw new ManagementError('version_conflict', `角色资料已更新（期望字段修订 ${input.expectedFieldRevision}，当前 ${fieldRevision}），请刷新后再保存。`);
      }
      const next: RoleConfigurationV2 = {
        ...current,
        revision: current.revision + 1,
        savedRevision: current.savedRevision + 1,
        fieldRevision: fieldRevision + 1,
        identity: input.intro === undefined ? current.identity : { intro: authorText(input.intro, '角色简介', MAX_INTRO) },
        persona: {
          text: current.persona.text, revision: current.persona.revision,
          ...(input.scenario === undefined ? (current.persona.scenario === undefined ? {} : { scenario: current.persona.scenario })
            : { scenario: authorText(input.scenario, '背景与情境', MAX_AUTHOR_FIELD) }),
          ...(input.firstMessage === undefined ? (current.persona.firstMessage === undefined ? {} : { firstMessage: current.persona.firstMessage })
            : { firstMessage: authorText(input.firstMessage, '开场白', MAX_AUTHOR_FIELD) }),
          ...(input.exampleDialogue === undefined ? (current.persona.exampleDialogue === undefined ? {} : { exampleDialogue: current.persona.exampleDialogue })
            : { exampleDialogue: authorText(input.exampleDialogue, '示例对话', MAX_AUTHOR_FIELD) }),
          ...(input.sourceRef === undefined ? (current.persona.sourceRef === undefined ? {} : { sourceRef: current.persona.sourceRef })
            : { sourceRef: verifiedSourceRef(input.sourceRef) }),
        },
      };
      await this.#persist(mutate => {
        mutate.set(next.characterId, next);
        this.authorOperations.set(replayKey, { signature: operationSignature, configuration: next });
      });
      return next;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * RWR-08 (B1): seed a NEWLY created role's v2 configuration with visible `inherit-default` slots.
   *
   * CONTRACTS §2 requires a new role to start as inherit-default and to be writable straight away; the
   * registry is the admission authority, so this is called from the CREATION path (never from a save).
   * Idempotent: an existing configuration is returned untouched.
   */
  async ensureConfiguration(characterId: string): Promise<RoleConfigurationV2> {
    const existing = this.get(characterId);
    if (existing) return existing;
    const seeded: RoleConfigurationV2 = {
      schemaVersion: 2, characterId, revision: 0, savedRevision: 0, effectiveRevision: 0, applyOn: 'restart',
      identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
      bindings: { dialogue: INHERIT, asr: INHERIT, tts: INHERIT },
    };
    const run = this.tail.then(async () => {
      const current = this.get(characterId);
      if (current) return current;
      await this.#persist(mutate => { mutate.set(characterId, seeded); });
      return seeded;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * RWR-08 (F06): save ONE role's appearance choice through the v2 authority. Registration of skin
   * packs stays with the skin registry — this only records WHICH registered resource the role uses
   * (id + real type), so saving a non-running role can never activate a global skin.
   */
  async saveAppearance(characterId: string, input: { readonly resourceId: string; readonly type: 'sprite' | 'live2d' }): Promise<RoleConfigurationV2> {
    const run = this.tail.then(async () => {
      const current = this.get(characterId);
      if (!current) throw new ManagementError('not_found', '没有这个角色。');
      const next: RoleConfigurationV2 = {
        ...current,
        revision: current.revision + 1,
        savedRevision: current.savedRevision + 1,
        appearance: { type: input.type, resourceId: input.resourceId },
      };
      await this.#persist(mutate => { mutate.set(next.characterId, next); });
      return next;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Persist is part of the serial transaction: mutate a COPY of the authoritative map, serialize THAT,
   * write it to a same-directory temporary file, rename it over the real file, and only then swap the
   * published map. Any failure before the swap leaves the old file and old memory intact.
   */
  async #persist(mutate: (next: Map<string, RoleConfigurationV2>) => void, operation?: AuthorOperationRecord & { key: string }): Promise<void> {
    const nextStates = new Map(this.states);
    mutate(nextStates);
    const operations = new Map(this.authorOperations);
    if (operation) operations.set(operation.key, { signature: operation.signature, configuration: operation.configuration });
    const body = JSON.stringify({ version: 2, states: Object.fromEntries(nextStates), authorOperations: Object.fromEntries(operations) }, null, 2);
    let temporary: string | undefined;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      temporary = `${this.file}.${randomUUID()}.next`;
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      temporary = undefined;
    } catch (error) {
      if (temporary !== undefined) await unlink(temporary).catch(() => {});
      // A filesystem failure must surface as a management error with the old state untouched — never as
      // a raw fs error after a partial commit, and never as a silent success.
      if (error instanceof ManagementError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ManagementError('unavailable', `角色配置未能写入磁盘：${detail}`);
    }
    if (process.platform === 'win32') { try { restrictPrivatePathSync(this.file); } catch { /* ACL best-effort; the committed bytes are already durable */ } }
    this.states = nextStates;
    this.authorOperations = operations;
  }
}

/**
 * The single startup entry point: read the effective role for the running character, build its v2
 * configuration, and resolve it. Returns the frozen effective configuration plus the background slots.
 */
export function loadEffectiveRoleConfiguration(input: {
  readonly base: TrialConfiguration;
  readonly settings: ManagedSettings;
  readonly store: RoleConfigurationStore;
  readonly characterId: string;
  readonly voices?: RegisteredVoiceStore;
}): import('../contracts/role-configuration.js').EffectiveRoleConfiguration {
  // RUX-01: opening the store is the restart boundary. The configuration this process is ABOUT to run
  // becomes the effective one, so the console can compare saved/effective honestly after a restart.
  input.store.promoteEffective(input.characterId);
  const configuration = input.store.get(input.characterId);
  if (!configuration) {
    // A running role with no saved configuration would otherwise consume the global settings directly,
    // which is exactly the shadow-binding gap. Seed an inherit-default configuration for it so the role
    // still resolves through the ONE resolver and remains traceable.
    const seeded: RoleConfigurationV2 = {
      schemaVersion: 2, characterId: input.characterId, revision: 0, savedRevision: 0, effectiveRevision: 0, applyOn: 'restart',
      identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: '' },
      bindings: { dialogue: INHERIT, asr: INHERIT, tts: INHERIT },
    };
    const effective = resolveEffectiveRoleConfiguration({ configuration: seeded, settings: input.settings, catalog: settingsBackedCatalog(input.base, input.settings, input.voices, input.store.sources) });
    input.store.effectiveConfigurations.set(input.characterId, effective);
    return effective;
  }
  const effective = resolveEffectiveRoleConfiguration({ configuration, settings: input.settings, catalog: settingsBackedCatalog(input.base, input.settings, input.voices, input.store.sources) });
  input.store.effectiveConfigurations.set(input.characterId, effective);
  return effective;
}

/**
 * Apply the resolved role configuration to the trial configuration the runtime actually builds.
 *
 * Only the three role-scoped slots (dialogue / asr / tts) are replaced, each by the RESOLVED values —
 * adapter, endpoint, model and the credential FILE the runtime authorizer needs. The four background
 * slots are left exactly as the global settings produced them, so `memory_turn` / `summary` /
 * `perception` / `admission` never become role-scoped.
 *
 * The result is validated with `validateTrialConfiguration` so a role binding can never introduce a
 * configuration the runtime would reject after startup.
 */
export function applyRoleConfigurationToTrial(base: TrialConfiguration, effective: import('../contracts/role-configuration.js').EffectiveRoleConfiguration): TrialConfiguration {
  const models = { ...base.models } as Record<string, TrialModel & { voice?: string; language?: string }>;
  for (const slot of ROLE_BINDING_SLOTS) {
    const resolved = effective.capabilities[slot];
    const model: TrialModel & { voice?: string; language?: string } = {
      provider: resolved.provider,
      model: resolved.model,
      endpoint: resolved.endpoint,
      credentialFile: resolved.authNone || resolved.localUnmetered ? 'local://no-credential' : resolved.credentialFile,
      reservationMicros: resolved.reservationMicros,
      inputTokenLimit: resolved.inputTokenLimit,
      outputTokenLimit: resolved.outputTokenLimit,
      inputMicrosPerToken: resolved.inputMicrosPerToken,
      outputMicrosPerToken: resolved.outputMicrosPerToken,
      // RWR-08 (F04): the billing fields are part of the validated configuration. Dropping them here
      // made an ALREADY-VALID anonymous cloud config fail the trial validator after conversion with
      // 「语音计费口径未配置。」— so the resolver must carry them and this conversion must keep them.
      ...(resolved.authNone === true ? { authNone: true as const } : {}),
      ...(resolved.localUnmetered === true ? { localUnmetered: true as const } : {}),
      ...(resolved.audioMicrosPerSecond === undefined ? {} : { audioMicrosPerSecond: resolved.audioMicrosPerSecond }),
      ...(resolved.characterMicros === undefined ? {} : { characterMicros: resolved.characterMicros }),
      ...(resolved.protocol === undefined ? {} : { protocol: resolved.protocol }),
      ...(resolved.thinking === undefined ? {} : { thinking: resolved.thinking }),
    } as TrialModel & { voice?: string; language?: string };
    const voice = resolved.parameters.voice;
    if (slot === 'tts' && typeof voice === 'string') model.voice = voice;
    // RWR-08 (实机轮): the resolver stores the slot's language under `parameters.language`; the TTS
    // factory requires it, so dropping it here only surfaced on a REAL boot with the personal config.
    const language = resolved.parameters.language;
    if (slot === 'tts' && typeof language === 'string') model.language = language;
    models[slot] = model;
  }
  return validateTrialConfiguration({ ...base, models: models as TrialConfiguration['models'] });
}
