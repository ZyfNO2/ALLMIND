import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ManagementError, type ManagedSettings, type ProviderSelection, type ProviderSlot } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import type { SourceInstance, ModelProfile } from '../contracts/provider-source.js';
import { validateManagedSettings, availableAdapters } from './settings.js';
import { migrateLegacySlot } from '../plugins/legacy-slot.js';
import { createOpenAiAdapterDescriptor, createAudioAdapterDescriptor } from '../plugins/legacy-provider-adapter.js';
import { validateSourceInstance, validateModelProfile } from '../plugins/manifest.js';
import type { RegisteredVoiceStore } from '../providers/registered-voices.js';

export interface StoredProviderSource {
  readonly slot: ProviderSlot;
  readonly selection: ProviderSelection;
  readonly source: SourceInstance;
  readonly profile: ModelProfile;
}

/** Immutable source/profile definitions. References use both IDs, never just a model name. */
export class ProviderSourceStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly file: string, private entries: StoredProviderSource[]) {}
  static async open(file: string): Promise<ProviderSourceStore> {
    let entries: StoredProviderSource[] = [];
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('来源登记格式无效');
      entries = parsed.entries;
      for (const entry of entries) if (!entry.selection || validateSourceInstance(entry.source).length || validateModelProfile(entry.profile).length
        || entry.profile.sourceId !== entry.source.sourceId) throw new Error('来源登记内容无效');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new ProviderSourceStore(file, entries);
  }
  list(): readonly StoredProviderSource[] { return structuredClone(this.entries); }
  resolve(slot: ProviderSlot, sourceId: string, profileId: string): StoredProviderSource | undefined {
    return this.entries.find(entry => entry.slot === slot && entry.source.sourceId === sourceId && entry.profile.modelProfileId === profileId);
  }
  save(slot: ProviderSlot, selection: ProviderSelection, base: TrialConfiguration, settings: ManagedSettings, voices?: RegisteredVoiceStore): Promise<StoredProviderSource> {
    const run = this.tail.then(async () => {
      const normalized = validateManagedSettings({ ...settings, providers: { ...settings.providers, [slot]: selection } }, base, voices, false, undefined, true).providers[slot]!;
      const adapter = availableAdapters(base, voices).find(item => item.id === normalized.adapterId)!;
      const descriptor = slot === 'tts' || slot === 'asr' ? createAudioAdapterDescriptor()
        : normalized.protocol === 'gemini' ? { ...createOpenAiAdapterDescriptor(), adapterId: 'legacy.gemini.adapter', label: 'Legacy Gemini', protocol: 'gemini' } : createOpenAiAdapterDescriptor();
      const migrated = migrateLegacySlot(slot, { ...normalized, protocol: normalized.protocol! }, descriptor);
      const none = adapter.auth === 'none' || normalized.auth === 'none';
      const source: SourceInstance = { ...migrated.source,
        ...(none ? { deployment: 'local-service' as const, auth: { kind: 'none' as const }, dataDestination: 'local-machine' as const } : {}),
      };
      const id = createHash('sha256').update(JSON.stringify({ slot, normalized })).digest('hex').slice(0, 24);
      const entry: StoredProviderSource = { slot, selection: normalized,
        source: { ...source, sourceId: `source.${id}` },
        profile: { ...migrated.modelProfile, sourceId: `source.${id}`, modelProfileId: `profile.${id}` },
      };
      if (validateSourceInstance(entry.source).length || validateModelProfile(entry.profile).length) throw new ManagementError('invalid_request', '来源或模型配置无效。');
      const existing = this.resolve(slot, entry.source.sourceId, entry.profile.modelProfileId);
      if (existing) return structuredClone(existing);
      const next = [...this.entries, entry], temporary = `${this.file}.${randomUUID()}.next`;
      await mkdir(dirname(this.file), { recursive: true });
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, entries: next }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      this.entries = next;
      return structuredClone(entry);
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
