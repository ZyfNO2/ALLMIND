// RWR-03 / CONTRACTS §2: the single resolver that turns a role configuration + global settings into the
// immutable effective configuration the runtime actually consumes.
//
// Why this is its own module and not a branch inside `effectiveTrialConfiguration`: D3 froze two inputs
// with two different authorities. `ManagedSettings` owns the global sources, the default template and
// the four background slots; the role configuration v2 owns the three role-scoped capabilities. The old
// code had exactly one input, so a role binding could be saved and then never reach the runtime — which
// is the gap RWR-00's G3 marked RED.
//
// The rules this module exists to enforce:
//   * `inherit-default` is a visible choice that takes the global default. It is NOT a failure fallback.
//   * `own` names a concrete source; if that source cannot be resolved, resolution FAILS. It is never
//     quietly replaced by another role's source or by a cloud default.
//   * `auth.kind === 'none'` needs no credential. A `credentialRef` whose service has no stored
//     credential is REFUSED, not treated as "no auth required".
//   * The four background slots pass through untouched and are never role-scoped.
import { ManagementError, type ManagedSettings } from '../contracts/management.js';
import {
  GLOBAL_BACKGROUND_SLOTS, ROLE_BINDING_SLOTS,
  type EffectiveRoleConfiguration, type GlobalBackgroundSlot, type ResolvedCapability, type RoleBindingSlot, type RoleConfigurationV2,
} from '../contracts/role-configuration.js';
import type { TrialModel } from '../app/trial-config.js';

/** What the resolver needs from the existing source/model/binding registry. No second registry. */
export interface SourceCatalogView {
  /**
   * Resolve one `own` binding to a concrete model. Returning undefined means "this source instance does
   * not exist", which is a hard failure — never a silent substitution.
   */
  resolveOwn(input: {
    readonly slot: RoleBindingSlot;
    readonly sourceInstanceId: string;
    readonly modelProfileId: string;
    readonly credentialRef: string | undefined;
  }): { readonly adapterId: string; readonly provider: string; readonly model: TrialModel; readonly authKind: 'none' | 'credentialRef' } | undefined;
  /** Resolve a `credentialRef` to its stored file, or undefined when the service has no stored key. */
  credentialFile(input: { readonly credentialRef: string; readonly provider: string }): string | undefined;
  /** The declared capabilities of a source, used to validate voice/language/temperature. */
  capabilities(input: { readonly adapterId: string }): { temperature?: boolean; language?: boolean; voice?: boolean } | undefined;
  /**
   * RWR-08 (F04): the declared auth kind of an adapter, for inherit-default LOCAL sources. A source
   * whose adapter declares `auth:'none'` is unmetered-local and needs no key; adapters that do not
   * implement this probe are treated as credential-bearing (the pre-existing rule).
   */
  authKind?(input: { readonly adapterId: string }): 'none' | 'credentialRef' | undefined;
}

function invalid(message: string): never { throw new ManagementError('invalid_request', message); }
function unavailable(message: string): never { throw new ManagementError('unavailable', message); }

function requiredNumber(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) invalid(`${name}无效。`);
  return value as number;
}

/**
 * Resolve ONE capability. Both modes end at the same place: a fully specified, credential-backed model
 * with the reservation/cost bounds the runtime authorizer needs.
 */
function resolveCapability(input: {
  readonly slot: RoleBindingSlot;
  readonly binding: RoleConfigurationV2['bindings'][RoleBindingSlot];
  readonly fallback: ManagedSettings['providers'][RoleBindingSlot] | undefined;
  readonly configRevision: number;
  readonly catalog: SourceCatalogView;
}): ResolvedCapability {
  const { slot, binding, configRevision, catalog } = input;
  // RWR-08 (实机轮): audio slots (asr/tts) legitimately carry zero token limits — the trial validator
  // accepts `>= 0` there and the REAL global asr default uses 0. Text slots keep the `>= 1` floor.
  const tokenMin = slot === 'tts' || slot === 'asr' ? 0 : 1;

  if (binding.mode === 'own') {
    const sourceInstanceId = binding.sourceInstanceId;
    const modelProfileId = binding.modelProfileId;
    if (!sourceInstanceId || !modelProfileId) invalid(`${slot} 绑定缺少来源或模型标识。`);
    // An `own` binding that cannot be resolved FAILS. Falling back to the global default here would
    // silently run a different service than the user selected.
    const own = catalog.resolveOwn({ slot, sourceInstanceId, modelProfileId, credentialRef: binding.credentialRef });
    if (!own) unavailable(`${slot} 选择的来源不可用，未自动改用其他来源。`);
    const file: string = own.authKind === 'none' ? '' : (catalog.credentialFile({ credentialRef: binding.credentialRef ?? '', provider: own.provider }) ?? '');
    // A credential-bearing source with no stored key is refused; `auth:none` is the only keyless case.
    if (own.authKind !== 'none' && !file) invalid(`${slot} 选择的来源需要凭据，但尚未登记。`);
    const model = own.model;
    return {
      slot, mode: 'own', adapterId: own.adapterId, provider: own.provider, model: model.model,
      endpoint: model.endpoint, credentialRef: binding.credentialRef ?? '', credentialFile: file,
      inputTokenLimit: requiredNumber(model.inputTokenLimit, `${slot} 输入上限`, tokenMin),
      outputTokenLimit: requiredNumber(model.outputTokenLimit, `${slot} 输出上限`, tokenMin),
      reservationMicros: requiredNumber(model.reservationMicros, `${slot} 调用预留`),
      inputMicrosPerToken: requiredNumber(model.inputMicrosPerToken, `${slot} 输入计费`),
      outputMicrosPerToken: requiredNumber(model.outputMicrosPerToken, `${slot} 输出计费`),
      // RWR-08 (F04): carry the billing/wire fields the runtime validator and the provider factories
      // need — dropping them here produced a config that failed AFTER conversion.
      ...(model.characterMicros === undefined ? {} : { characterMicros: model.characterMicros }),
      ...(model.audioMicrosPerSecond === undefined ? {} : { audioMicrosPerSecond: model.audioMicrosPerSecond }),
      ...(model.protocol === undefined ? {} : { protocol: model.protocol }),
      ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
      ...(own.authKind === 'none' ? (model.endpoint.startsWith('local:') ? { localUnmetered: true as const } : { authNone: true as const }) : {}),
      parameters: Object.freeze({ ...(binding.parameters ?? {}) }), configRevision,
    };
  }

  // `inherit-default` is an explicit choice of the global default template, not a failure fallback.
  const fallback = input.fallback;
  if (!fallback) invalid(`${slot} 尚未配置默认来源。`);
  const model = {
    model: fallback.model, endpoint: fallback.endpoint, provider: fallback.provider,
    inputTokenLimit: fallback.inputTokenLimit, outputTokenLimit: fallback.outputTokenLimit,
    reservationMicros: fallback.reservationMicros, inputMicrosPerToken: fallback.inputMicrosPerToken,
    outputMicrosPerToken: fallback.outputMicrosPerToken,
  } as unknown as TrialModel;
  const none = catalog.authKind?.({ adapterId: fallback.adapterId }) === 'none' || fallback.auth === 'none';
  const file = none ? '' : catalog.credentialFile({ credentialRef: fallback.credentialRef, provider: fallback.provider });
  if (!file) invalid(`${slot} 的默认来源需要凭据，但尚未登记。`);

  // Capability-boundary validation, using the ADAPTER's declared capabilities (never a guess).
  const capabilities = catalog.capabilities({ adapterId: fallback.adapterId });
  const parameters: Record<string, string | number | boolean> = {};
  if ('voice' in fallback && fallback.voice !== undefined) {
    if (capabilities?.voice === false) invalid(`${slot} 的来源不支持音色。`);
    parameters.voice = fallback.voice;
  }
  if ('language' in fallback && fallback.language !== undefined) {
    if (capabilities?.language === false) invalid(`${slot} 的来源不支持语言参数。`);
    parameters.language = fallback.language;
  }
  if ('temperature' in fallback && fallback.temperature !== undefined) {
    if (capabilities?.temperature === false) invalid(`${slot} 的来源不支持温度参数。`);
    parameters.temperature = fallback.temperature;
  }

  return {
    slot, mode: 'inherit-default', adapterId: fallback.adapterId, provider: fallback.provider, model: model.model,
    endpoint: model.endpoint, credentialRef: fallback.credentialRef, credentialFile: file,
    inputTokenLimit: requiredNumber(fallback.inputTokenLimit, `${slot} 输入上限`, tokenMin),
    outputTokenLimit: requiredNumber(fallback.outputTokenLimit, `${slot} 输出上限`, tokenMin),
    reservationMicros: requiredNumber(fallback.reservationMicros, `${slot} 调用预留`),
    inputMicrosPerToken: requiredNumber(fallback.inputMicrosPerToken, `${slot} 输入计费`),
    outputMicrosPerToken: requiredNumber(fallback.outputMicrosPerToken, `${slot} 输出计费`),
    // RWR-08 (F04): the global default's billing/wire fields must survive exactly like an own binding's,
    // or a role inheriting a valid TTS/ASR default fails boot after conversion.
    ...(fallback.characterMicros === undefined ? {} : { characterMicros: fallback.characterMicros }),
    ...(fallback.audioMicrosPerSecond === undefined ? {} : { audioMicrosPerSecond: fallback.audioMicrosPerSecond }),
    ...(fallback.protocol === undefined ? {} : { protocol: fallback.protocol }),
    ...(fallback.thinking === undefined ? {} : { thinking: fallback.thinking }),
    ...(none ? (fallback.endpoint.startsWith('local:') ? { localUnmetered: true as const } : { authNone: true as const }) : {}),
    parameters: Object.freeze(parameters), configRevision,
  };
}

/**
 * The single consumption point. Returns a FROZEN snapshot: a later save cannot mutate the configuration
 * an in-flight turn already captured, and every capability records the `configRevision` it came from so
 * a real turn can be traced back to the save that produced it.
 */
export function resolveEffectiveRoleConfiguration(input: {
  readonly configuration: RoleConfigurationV2;
  readonly settings: ManagedSettings;
  readonly catalog: SourceCatalogView;
}): EffectiveRoleConfiguration {
  const { configuration, settings, catalog } = input;
  if (configuration.schemaVersion !== 2) invalid('角色配置版本不受支持。');
  const configRevision = configuration.savedRevision;

  const capabilities = {} as Record<RoleBindingSlot, ResolvedCapability>;
  for (const slot of ROLE_BINDING_SLOTS) {
    capabilities[slot] = Object.freeze(resolveCapability({
      slot, binding: configuration.bindings[slot], configRevision, catalog,
      fallback: settings.providers[slot as 'dialogue' | 'tts' | 'asr'],
    }));
  }

  // The four background slots are global and are never role-scoped: they pass through untouched.
  const background = {} as Record<GlobalBackgroundSlot, ManagedSettings['providers'][GlobalBackgroundSlot]>;
  for (const slot of GLOBAL_BACKGROUND_SLOTS) background[slot] = settings.providers[slot];

  return Object.freeze({
    characterId: configuration.characterId,
    configRevision,
    effectiveRevision: configuration.effectiveRevision,
    capabilities: Object.freeze(capabilities),
    background: Object.freeze(background),
  });
}
