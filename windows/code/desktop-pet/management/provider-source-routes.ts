import { ManagementError, type ProviderSelection } from '../contracts/management.js';
import { ROLE_BINDING_SLOTS, type RoleBindingSlot, type RoleCapabilityBinding } from '../contracts/role-configuration.js';
import type { ManagementSettingsStore } from './settings-store.js';
import { settingsBackedCatalog, type RoleConfigurationStore } from './role-configuration.js';
import { credentialRegistry } from './credentials.js';
import { readSetupKey } from './self-setup.js';
import { ModelDiscovery, managementFailure } from './model-discovery.js';

export async function providerSourceRoute(method: string | undefined, url: URL, body: () => Promise<Record<string, unknown>>,
  settings: ManagementSettingsStore, roles: RoleConfigurationStore | undefined, admit: (id: unknown) => boolean, signal?: AbortSignal): Promise<unknown> {
  if (!url.pathname.startsWith('/api/provider-sources') && url.pathname !== '/api/characters/bindings') return undefined;
  if (!roles) throw new ManagementError('unavailable', '角色来源配置尚未接入。');
  const slot = (value: unknown): RoleBindingSlot => {
    if (!ROLE_BINDING_SLOTS.includes(value as RoleBindingSlot)) throw new ManagementError('invalid_request', '角色能力无效。');
    return value as RoleBindingSlot;
  };
  const role = (value: unknown): string => {
    if (!admit(value)) throw new ManagementError('not_found', '没有这个角色。');
    return value as string;
  };
  if (url.pathname === '/api/provider-sources/discover' && method === 'POST') {
    const input = await body(); role(input.characterId); slot(input.slot);
    if (['key', 'apiKey', 'token'].some(key => Object.hasOwn(input, key))) throw new ManagementError('invalid_request', '模型发现只接受凭据引用。');
    const credentials = credentialRegistry(settings.base);
    try {
      return await new ModelDiscovery({ credentials: { key: ref => {
        const info = credentials.list().find(item => item.id === ref && item.status === 'configured');
        if (!info?.provider) throw new Error('凭据未配置');
        return readSetupKey(credentials.file(ref, info.provider), settings.base.projectRoot);
      } } }).list({ protocol: input.protocol as 'openai-compatible' | 'gemini', endpoint: String(input.endpoint ?? ''),
        credentialRef: String(input.credentialRef ?? ''), ...(input.modelsEndpoint ? { modelsEndpoint: String(input.modelsEndpoint) } : {}),
        ...(input.auth === 'none' ? { authNone: true } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) { throw managementFailure(error); }
  }
  if (url.pathname === '/api/provider-sources') {
    if (method === 'GET') return { apiVersion: 1, entries: roles.sources.list() };
    if (method === 'POST') {
      const input = await body(); role(input.characterId);
      const entry = await roles.sources.save(slot(input.slot), input.selection as ProviderSelection, settings.base, settings.snapshot().saved, settings.registeredVoices);
      return { apiVersion: 1, entry };
    }
  }
  if (url.pathname === '/api/characters/bindings') {
    if (method === 'GET') {
      const characterId = role(url.searchParams.get('characterId')), configuration = await roles.ensureConfiguration(characterId);
      if (!configuration) throw new ManagementError('not_found', '没有该角色配置。');
      const catalog = settingsBackedCatalog(settings.base, settings.effective, settings.registeredVoices, roles.sources);
      const readErrors: Partial<Record<RoleBindingSlot, string>> = {};
      const selections = Object.fromEntries(ROLE_BINDING_SLOTS.map(name => {
        const binding = configuration.bindings[name];
        const stored = binding.mode === 'own' ? roles.sources.resolve(name, binding.sourceInstanceId!, binding.modelProfileId!) : undefined;
        const own = binding.mode === 'own' ? catalog.resolveOwn({ slot: name, sourceInstanceId: binding.sourceInstanceId!, modelProfileId: binding.modelProfileId!, credentialRef: binding.credentialRef }) : undefined;
        if (binding.mode === 'own' && !own) {
          readErrors[name] = '已保存的来源或模型配置无法解析，请重新选择此角色的来源。';
          return [name, null];
        }
        return [name, stored?.selection ?? (own ? { ...own.model, adapterId: own.adapterId, credentialRef: binding.credentialRef ?? '', ...binding.parameters } : settings.snapshot().saved.providers[name])];
      }));
      // Do not expose credential file paths from a legacy resolved TrialModel.
      for (const selection of Object.values(selections)) if (selection) delete (selection as unknown as Record<string, unknown>).credentialFile;
      const effective = structuredClone(roles.effectiveConfigurations.get(characterId) ?? null);
      if (effective) for (const capability of Object.values(effective.capabilities)) delete (capability as unknown as Record<string, unknown>).credentialFile;
      return { apiVersion: 1, configuration, selections, readErrors, effective };
    }
    if (method === 'PUT') {
      const input = await body(), characterId = role(input.characterId);
      if (!input.bindings || typeof input.bindings !== 'object' || Array.isArray(input.bindings)
        || !Number.isSafeInteger(input.expectedRevision) || typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 160) throw new ManagementError('invalid_request', '角色绑定请求无效。');
      const bindings: Partial<Record<RoleBindingSlot, RoleCapabilityBinding>> = {};
      for (const [name, raw] of Object.entries(input.bindings)) {
        const capability = slot(name), binding = raw as RoleCapabilityBinding;
        if (binding?.mode === 'inherit-default') bindings[capability] = { mode: 'inherit-default' };
        else {
          const stored = roles.sources.resolve(capability, binding?.sourceInstanceId!, binding?.modelProfileId!);
          if (binding?.mode !== 'own' || !stored) throw new ManagementError('invalid_request', '请选择已登记的来源及模型配置。');
          const credentialRef = stored.source.auth.kind === 'credentialRef' ? stored.source.auth.ref : undefined;
          if (binding.credentialRef !== credentialRef && !(stored.source.auth.kind === 'none' && !binding.credentialRef)) throw new ManagementError('invalid_request', '凭据与来源不匹配。');
          bindings[capability] = { mode: 'own', sourceInstanceId: stored.source.sourceId, modelProfileId: stored.profile.modelProfileId,
            ...(credentialRef ? { credentialRef } : {}), parameters: stored.profile.parameters as Record<string, string | number | boolean> };
        }
      }
      if (!Object.keys(bindings).length) throw new ManagementError('invalid_request', '没有需要保存的绑定。');
      const configuration = await roles.saveBindings(characterId, { bindings, expectedRevision: input.expectedRevision as number, operationId: input.operationId });
      return { configuration, applyOn: 'restart' };
    }
  }
  throw new ManagementError('not_found', '没有这个来源配置接口。');
}
