import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ManagementError,
  type CharacterPreset,
  type CharacterPresetSaveInput,
  type CharacterPresetSaveReceipt,
  type ManagementMemoryPort,
} from '../contracts/management.js';
import type { ManagementSettingsStore } from './settings-store.js';
import type { SkinManagement } from '../contracts/skin.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import type { RoleConfigurationStore } from './role-configuration.js';
import { toRoleConfigurationV2 } from './role-configuration.js';

/**
 * A side effect that failed must surface as a management error, keeping the original code when it
 * already is one. Callers depend on `version_conflict` staying distinguishable from `unavailable`.
 */
function translateSideEffect(error: unknown, prefix: string): ManagementError {
  if (error instanceof ManagementError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ManagementError('unavailable', `${prefix}：${detail}`);
}

export interface CharacterPresetStoreOptions {
  filePath?: string | undefined;
  memory: ManagementMemoryPort;
  settings: ManagementSettingsStore;
  skins?: SkinManagement | undefined;
  base?: TrialConfiguration | undefined;
  /**
   * RWR-08 (F03): the v2 role-configuration authority the formal boot reads. When present, every
   * bindings save is mirrored here IN THE SAME save transaction, so the API save can no longer land
   * only in the legacy preset file while the runtime reads another authority (the review's R4 gap).
   */
  roleConfigurations?: RoleConfigurationStore | undefined;
}

export class CharacterPresetStore {
  private presets = new Map<string, CharacterPreset>();

  constructor(private readonly options: CharacterPresetStoreOptions) {}

  static async open(options: CharacterPresetStoreOptions): Promise<CharacterPresetStore> {
    const store = new CharacterPresetStore(options);
    if (options.filePath) {
      try {
        const raw = await readFile(options.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            store.presets.set(k, v as CharacterPreset);
          }
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') console.warn('Could not read presets file:', err);
      }
    }
    // Initialize default for companion if not already present
    if (!store.presets.has('companion')) {
      await store.initCompanionPreset();
    }
    return store;
  }

  private async initCompanionPreset(): Promise<void> {
    const snap = this.options.settings.snapshot();
    let promptText = '青梅竹马伴侣设定。';
    let promptRev = 1;
    try {
      const p = await this.options.memory.prompt('companion');
      if (p?.text) {
        promptText = p.text;
        promptRev = p.revision || 1;
      }
    } catch {}

    const activeSkin = this.options.skins?.active?.()?.skinId || 'default-skin';

    const dialogueModel = snap.effective.providers.dialogue?.model || 'deepseek-chat';
    const dialogueProvider = snap.effective.providers.dialogue?.provider || 'deepseek';
    const dialogueCred = snap.effective.providers.dialogue?.credentialRef || 'credential-ref-1';

    const ttsVoice = snap.effective.providers.tts?.voice || 'Cherry';
    const ttsModel = snap.effective.providers.tts?.model || 'qwen-tts';
    const ttsProvider = snap.effective.providers.tts?.provider || 'dashscope';
    const ttsCred = snap.effective.providers.tts?.credentialRef || 'credential-ref-1';

    const preset: CharacterPreset = {
      characterId: 'companion',
      presetId: 'companion-default',
      revision: 1,
      savedRevision: 1,
      effectiveRevision: 1,
      appearance: {
        type: 'live2d',
        resourceId: activeSkin,
        label: '默认桌宠形象',
      },
      persona: {
        text: promptText,
        revision: promptRev,
      },
      bindings: {
        dialogue: {
          provider: dialogueProvider,
          model: dialogueModel,
          credentialRef: dialogueCred,
          temperature: 0.7,
        },
        tts: {
          provider: ttsProvider,
          model: ttsModel,
          voice: ttsVoice,
          credentialRef: ttsCred,
        },
      },
    };

    this.presets.set('companion', preset);
  }

  /**
   * RWR-02: reading a character that was never registered is `not_found`.
   *
   * The previous implementation synthesized a complete default preset — including a fabricated
   * `credentialRef` and a persona body — for ANY id that passed the syntax regex, and then persisted it
   * into the in-memory map. That is how a typo produced a working-looking character with invented
   * settings. Creating a character is now an explicit management transaction (the registry), and this
   * read only ever projects a character that already exists.
   */
  async getPreset(characterId: string): Promise<CharacterPreset> {
    const preset = this.presets.get(characterId);
    if (preset) return preset;
    // The companion seed is the one role the shipped product initializes; it is registered by the
    // registry, so it is legitimate to materialize its preset projection on first read.
    if (characterId === 'companion') {
      await this.initCompanionPreset();
      return this.presets.get('companion')!;
    }
    // A role registered through the registry but never saved yet gets a blank, honest projection:
    // no invented persona text and no invented credential. It is NOT persisted until it is saved.
    //
    // RWR-07 (AI-3): the appearance here must NOT be the registry's ACTIVE skin. The active skin is
    // the running (companion) presentation; projecting it would stamp companion's saved choice onto
    // every role that never chose one — and because savePreset persists `current.appearance` when the
    // caller omits it, that leak would silently become role B's OWN saved appearance. The built-in
    // skin is the honest "no choice yet" default (D2's "a new role starts empty" applied to appearance).
    if (this.options.memory.registry?.get(characterId)) {
      const descriptor = this.options.memory.registry.get(characterId)!;
      const neverChose = this.options.skins?.list?.()?.find(skin => skin.origin === 'builtin')?.skinId ?? 'default-skin';
      return {
        characterId: descriptor.id, presetId: `${descriptor.id}-preset`,
        revision: 0, savedRevision: 0, effectiveRevision: 0,
        appearance: { type: 'live2d', resourceId: neverChose, label: `${descriptor.label} 外观` },
        persona: { text: '', revision: 0 },
        bindings: {} as CharacterPreset['bindings'],
      };
    }
    throw new ManagementError('not_found', '没有这个角色。');
  }

  /**
   * RWR-01: saving is ordered so no store reports success while another refused the change.
   *
   *   1. persona goes through its OWNER (memory.prompt); the owner's revision is the authority and
   *      this preset keeps only a projection of it.
   *   2. appearance goes through the skin registry.
   *   3. the presets file is written LAST and is the commit point — the in-memory map advances only
   *      after the bytes are on disk.
   *
   * Every failure propagates. Nothing is caught-and-logged, because a swallowed error is exactly how
   * the previous implementation reported success for a save that never happened.
   */
  async savePreset(input: CharacterPresetSaveInput): Promise<CharacterPresetSaveReceipt> {
    const current = await this.getPreset(input.characterId);
    if (input.expectedRevision !== current.revision) {
      throw new ManagementError('version_conflict', '角色预设已被更新，请刷新后再保存。');
    }

    const nextRevision = current.revision + 1;
    const nextPreset: CharacterPreset = {
      ...current,
      presetId: input.presetId || current.presetId,
      revision: nextRevision,
      savedRevision: nextRevision,
      effectiveRevision: current.effectiveRevision,
      appearance: input.appearance ? { ...current.appearance, ...input.appearance } : current.appearance,
      persona: input.persona ? { text: input.persona.text, revision: current.persona.revision + 1 } : current.persona,
      bindings: {
        dialogue: input.bindings?.dialogue ? { ...current.bindings.dialogue, ...input.bindings.dialogue } as any : current.bindings.dialogue,
        asr: input.bindings?.asr ? { ...current.bindings.asr, ...input.bindings.asr } as any : current.bindings.asr,
        tts: input.bindings?.tts ? { ...current.bindings.tts, ...input.bindings.tts } as any : current.bindings.tts,
      },
    };

    const applied = { persona: false, appearance: false };

    // 1. persona: the prompt owner decides; its returned revision replaces the locally guessed one.
    if (input.persona?.text && input.persona.text !== current.persona.text) {
      const saved = await this.applyPersona(input.characterId, current.persona.revision, input.persona.text);
      nextPreset.persona = { text: saved.text, revision: saved.revision };
      applied.persona = true;
    }

    // 2. appearance: the skin registry decides; a missing registry is a failure, not a no-op.
    if (input.appearance?.resourceId && input.appearance.resourceId !== current.appearance.resourceId) {
      await this.applyAppearance(input.appearance.resourceId);
      applied.appearance = true;
    }

    // 2b. RWR-08 (F03): mirror the bindings into the v2 authority BEFORE the legacy file is written, so
    // a v2 rejection fails the whole save (the legacy file keeps its previous content). Without this
    // the API save only landed in character-presets.json while the formal boot read role-configurations.json.
    let v2Mirrored = false;
    if (this.options.roleConfigurations && input.bindings) {
      try {
        const existing = this.options.roleConfigurations.get(input.characterId);
        const baseConfig = existing ?? toRoleConfigurationV2(nextPreset, this.options.base!, this.options.settings.snapshot().effective);
        if (!existing) await this.options.roleConfigurations.save(baseConfig);
        const bindings: Partial<Record<'dialogue' | 'asr' | 'tts', import('../contracts/role-configuration.js').RoleCapabilityBinding>> = {};
        for (const slot of ['dialogue', 'asr', 'tts'] as const) {
          if (!input.bindings[slot]) continue;
          const binding = nextPreset.bindings[slot];
          if (!binding?.model) { bindings[slot] = { mode: 'inherit-default' }; continue; }
          const effectiveSettings = this.options.settings.snapshot().effective;
          const saved = effectiveSettings.providers[slot];
          const choices = this.options.settings.base ? (await import('./settings.js')).availableAdapters(this.options.settings.base).flatMap(adapter => (adapter.choices || []).map(choice => choice.configuration)) : [];
          const source = saved?.provider === binding.provider ? saved : choices.find(choice => choice.provider === binding.provider && choice.model === binding.model);
          if (!source) throw new ManagementError('invalid_request', '旧接口没有可解析的来源，请使用角色 API 配置页登记来源。');
          const entry = await this.options.roleConfigurations.sources.save(slot, { ...source, ...binding, adapterId: source.adapterId } as import('../contracts/management.js').ProviderSelection, this.options.base!, effectiveSettings, this.options.settings.registeredVoices);
          bindings[slot] = { mode: 'own', sourceInstanceId: entry.source.sourceId, modelProfileId: entry.profile.modelProfileId,
            ...(entry.source.auth.kind === 'credentialRef' ? { credentialRef: entry.source.auth.ref } : {}), parameters: entry.profile.parameters as Record<string, string | number | boolean> };
        }
        await this.options.roleConfigurations.saveBindings(input.characterId, { bindings, expectedRevision: baseConfig.savedRevision, operationId: `legacy-preset-${randomUUID()}` });
        v2Mirrored = true;
      } catch (error) {
        throw translateSideEffect(error, '角色绑定未能进入运行配置权威');
      }
    }

    // 3. disk is the commit point.
    await this.persist({ ...Object.fromEntries(this.presets.entries()), [input.characterId]: nextPreset });
    this.presets.set(input.characterId, nextPreset);

    return { ...nextPreset, applyStatus: 'applied', applied, ...(v2Mirrored ? { v2Mirrored: true } : {}) } as CharacterPresetSaveReceipt;
  }

  /** persona.text authority is memory.prompt; a rejection here means the save did not happen. */
  private async applyPersona(characterId: string, expectedRevision: number, text: string): Promise<{ text: string; revision: number }> {
    let saved: { text?: string; revision?: number } | undefined;
    try {
      saved = await this.options.memory.savePrompt({
        characterId,
        expectedRevision,
        text,
        operationId: `preset-save-${randomUUID()}`,
      }) as { text?: string; revision?: number };
    } catch (error) {
      throw translateSideEffect(error, '角色人设未能保存');
    }
    return { text: saved?.text ?? text, revision: saved?.revision ?? expectedRevision + 1 };
  }

  /** appearance authority is the skin registry; a missing registry cannot silently succeed. */
  private async applyAppearance(resourceId: string): Promise<void> {
    if (!this.options.skins) throw new ManagementError('unavailable', '当前实例尚未接入外观换肤，形象未能应用。');
    try {
      await this.options.skins.activate(this.options.skins.state().revision, resourceId);
    } catch (error) {
      throw translateSideEffect(error, '形象未能应用');
    }
  }

  private async persist(entries: Record<string, CharacterPreset>): Promise<void> {
    if (!this.options.filePath) return;
    try {
      await mkdir(dirname(this.options.filePath), { recursive: true });
      await writeFile(this.options.filePath, JSON.stringify(entries, null, 2), 'utf8');
    } catch (error) {
      throw translateSideEffect(error, '角色预设未能写入磁盘');
    }
  }
}
