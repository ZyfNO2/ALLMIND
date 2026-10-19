// RWR-03 / CONTRACTS §2: the versioned role configuration and the immutable effective configuration.
//
// D3 froze the authority split, and this file is its type-level statement:
//
//   * the role configuration v2 is the ONLY write source for a role's dialogue/asr/tts bindings;
//   * `ManagedSettings` keeps the global sources, the default template and the four background slots
//     (memory_turn / summary / perception / admission), which are NOT role-scoped;
//   * one resolver turns those two inputs into a frozen `EffectiveRoleConfiguration` for the runtime.
//
// A binding is either an explicit `own` choice or an explicit `inherit-default` choice. `inherit-default`
// is a VISIBLE selection, not a failure fallback: when the chosen default source cannot be resolved, the
// configuration is rejected rather than silently substituted. An `own` source that is unavailable fails too.
import type { ManagedSettings, ProviderSlot } from './management.js';

/** The three role-scoped capabilities. STT is spelled `asr` in the API (CONTRACTS §2). */
export const ROLE_BINDING_SLOTS = ['dialogue', 'asr', 'tts'] as const;
export type RoleBindingSlot = typeof ROLE_BINDING_SLOTS[number];

/** The four global slots that stay with ManagedSettings and are never role-scoped. */
export const GLOBAL_BACKGROUND_SLOTS = ['memory_turn', 'summary', 'perception', 'admission'] as const;
export type GlobalBackgroundSlot = typeof GLOBAL_BACKGROUND_SLOTS[number];

/**
 * A single capability binding.
 *
 * `mode:'own'` names a concrete source instance; `mode:'inherit-default'` takes the global default
 * template. `sourceInstanceId`/`modelProfileId` are resolved against the EXISTING source/model/binding
 * registry — no second registry is introduced here.
 */
export interface RoleCapabilityBinding {
  readonly mode: 'own' | 'inherit-default';
  /** Required when `mode === 'own'`; must identify a registered source instance. */
  readonly sourceInstanceId?: string;
  /** Required when `mode === 'own'`; must identify a registered model profile on that source. */
  readonly modelProfileId?: string;
  /** Credential reference for this capability. Never a key. Absent for `auth.kind === 'none'` sources. */
  readonly credentialRef?: string;
  /** Slot-specific, validated against the source's declared capabilities. */
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

export interface RoleIdentityConfiguration {
  readonly intro: string;
}

export interface RolePersonaConfiguration {
  /**
   * Projected from `memory.prompt`; the prompt owner stays the single authority for the body text.
   * This field is a read projection of (text, revision), never a second editable body.
   */
  readonly text: string;
  readonly revision: number;
  /** Author metadata persisted by the role profile service and consumed by Context assembly. */
  readonly scenario?: string;
  readonly firstMessage?: string;
  readonly exampleDialogue?: string;
  /** Only a VERIFIED import reference is kept; a free-form file path is never stored. */
  readonly sourceRef?: string;
}

export interface RoleAppearanceConfiguration {
  readonly type: 'sprite' | 'live2d';
  /** A SkinStore manifest id only. Arbitrary file paths are never persisted (CONTRACTS §2). */
  readonly resourceId: string;
}

export interface RoleBindingsConfiguration {
  readonly dialogue: RoleCapabilityBinding;
  readonly asr: RoleCapabilityBinding;
  readonly tts: RoleCapabilityBinding;
}

/**
 * The saved, versioned role configuration. `savedRevision` is the write cursor; `effectiveRevision` is
 * what the running process actually applied. `applyOn:'restart'` is explicit because a model change
 * cannot be applied to an in-flight turn.
 */
export interface RoleConfigurationV2 {
  readonly schemaVersion: 2;
  readonly characterId: string;
  readonly revision: number;
  readonly savedRevision: number;
  readonly effectiveRevision: number;
  /**
   * RWR-06: the cursor for the AUTHOR metadata (intro / scenario / firstMessage / exampleDialogue /
   * sourceRef). It is separate from `revision` so an author edit reports its own conflict and cannot be
   * mistaken for a bindings change, and so a bindings save does not appear to have rolled it back.
   */
  readonly fieldRevision?: number;
  readonly applyOn: 'restart';
  readonly identity: RoleIdentityConfiguration;
  readonly persona: RolePersonaConfiguration;
  readonly appearance: RoleAppearanceConfiguration;
  readonly bindings: RoleBindingsConfiguration;
}

/** A per-slot receipt: what the resolver actually bound, and where the values came from. */
export interface ResolvedCapability {
  readonly slot: RoleBindingSlot;
  readonly mode: 'own' | 'inherit-default';
  readonly adapterId: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  /** Resolved through the SecretStore-backed registry; never the key itself. */
  readonly credentialRef: string;
  readonly credentialFile: string;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly reservationMicros: number;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  /**
   * RWR-08 (F04): billing and wire fields that must survive the conversion into the trial configuration.
   * A validated TTS binding without `characterMicros`, or an ASR binding without
   * `audioMicrosPerSecond`, would fail the un-widened validator AFTER conversion and block boot.
   */
  readonly characterMicros?: number;
  readonly audioMicrosPerSecond?: number;
  readonly protocol?: 'openai-compatible' | 'gemini';
  readonly thinking?: 'high';
  /** Set only for an `auth:'none'` LOCAL source; a remote model can never claim it. */
  readonly localUnmetered?: true;
  readonly authNone?: true;
  /** The config revision this capability came from, so a real turn can be traced back to its save. */
  readonly configRevision: number;
}

/**
 * The immutable snapshot the runtime consumes. Frozen on creation so a later save cannot mutate the
 * configuration an in-flight turn is already using.
 */
export interface EffectiveRoleConfiguration {
  readonly characterId: string;
  readonly configRevision: number;
  readonly effectiveRevision: number;
  readonly capabilities: Readonly<Record<RoleBindingSlot, ResolvedCapability>>;
  /** The four background slots, straight from ManagedSettings and never role-scoped. */
  readonly background: Readonly<Record<GlobalBackgroundSlot, ManagedSettings['providers'][GlobalBackgroundSlot]>>;
}

/** The per-panel save receipt (CONTRACTS §2/§6): persisted and applied are separate facts. */
export interface RoleConfigurationSaveReceipt {
  readonly characterId: string;
  readonly savedRevision: number;
  readonly effectiveRevision: number;
  readonly applyStatus: 'applied' | 'pending';
  readonly applyOn: 'restart';
  readonly error?: { readonly code: string; readonly message: string };
  /** A part of the save that was persisted but is not yet running. */
  readonly pending?: { readonly area: string; readonly message: string };
}

/**
 * RWR-06: the AUTHOR metadata as it reaches ONE turn's Context.
 *
 * `scenario` and `exampleDialogue` may inform the character's role prompt; `firstMessage` is
 * PRESENTATION-ONLY and is deliberately NOT carried here, so it can never be replayed as a real
 * opening turn or counted as a user memory record.
 */
export interface RoleAuthorPrompt {
  readonly scenario?: string;
  readonly exampleDialogue?: string;
  readonly fieldRevision: number;
}

/** Maps the API's `asr` name onto the existing settings slot name (both are the same slot). */
export function settingsSlotOf(slot: RoleBindingSlot): ProviderSlot {
  return slot;
}
