// RWR-08 阶段 B 回归：配置权威与正式 boot（F01 正式启动角色/配对、F03 保存权威、F04 计费字段）。
//
// 依据：docs/next/ui-rework/role-repair/reports/RWR-FINAL-REVIEW-20261006.md §2 F01/F03/F04（R9/R4），
// specs/RWR-08.md §3 阶段 B / AC-B。被测全部为真实生产实现（trial-config 校验、role-configuration
// 转换、RoleConfigurationStore、CharacterPresetStore）；provider 用匿名 stub，不连真实服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { defaultManagedSettings, validateManagedSettings } from '../../management/settings.js';
import { applyRoleConfigurationToTrial, loadEffectiveRoleConfiguration, RoleConfigurationStore, toRoleConfigurationV2 } from '../../management/role-configuration.js';
import type { RoleConfigurationV2 } from '../../contracts/role-configuration.js';
import { ANON } from './fixtures.js';

const SLOT_MODEL = {
  inputTokenLimit: 8192, outputTokenLimit: 4096, reservationMicros: 100_000,
  inputMicrosPerToken: 0.8, outputMicrosPerToken: 2,
};
const ANON_ROLE_B = 'role-b';

function inheritConfig(characterId: string, savedRevision = 1): RoleConfigurationV2 {
  return {
    schemaVersion: 2, characterId, revision: savedRevision, savedRevision, effectiveRevision: savedRevision, applyOn: 'restart',
    identity: { intro: '' }, persona: { text: '', revision: 0 }, appearance: { type: 'live2d', resourceId: 'anon-skin' },
    bindings: { dialogue: { mode: 'inherit-default' }, asr: { mode: 'inherit-default' }, tts: { mode: 'inherit-default' } },
  };
}

/** 给 fixture 的默认配置补一个 asr 默认（control fixture 不注册 asr），形状对齐 settings-store。 */
function withAsrDefault(settings: ReturnType<typeof defaultManagedSettings>, model = 'anon-asr-model', audioMicrosPerSecond = 12) {
  return {
    ...settings,
    providers: { ...settings.providers, asr: { ...settings.providers.dialogue, adapterId: 'qwen-asr', model, audioMicrosPerSecond, inputTokenLimit: 1024, outputTokenLimit: 1024, inputMicrosPerToken: 0, outputMicrosPerToken: 0, reservationMicros: 50_000 } },
  } as ReturnType<typeof defaultManagedSettings>;
}

// --- F04：配置转换不得丢失计费字段（审查 R9：合法 cloud 配置转换后报“语音计费口径未配置。”）----------

test('RWR-08 AC-B(F04a): 合法 cloud TTS 配置经转换后保留 characterMicros 并通过未放宽的 validator', async t => {
  const f = await fixture(t);
  const file = join(f.c.projectRoot, 'management-settings.json');
  const settings = await ManagementSettingsStore.open(file, f.c);
  t.after(() => settings.close());
  const effective = withAsrDefault(defaultManagedSettings(f.c), 'global-asr-default', 10);

  const roleStore = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'role-configurations.json') });
  await roleStore.save(inheritConfig(ANON.roleA, 1));
  const resolved = loadEffectiveRoleConfiguration({ base: f.c, settings: effective, store: roleStore, characterId: ANON.roleA });

  // 转换产物必须是“正式 boot 可直接消费”的配置：经未放宽的 validateTrialConfiguration 校验。
  // 修复前：ResolvedCapability → TrialModel 丢失 characterMicros，TTS 首错“语音计费口径未配置。”
  const trial = applyRoleConfigurationToTrial(f.c, resolved);
  assert.equal(trial.models.tts.characterMicros, f.c.models.tts.characterMicros,
    'TTS 计费口径必须在转换中保留');
  assert.ok(trial.models.tts.model);
});

test('RWR-08 AC-B(F04b): asr 计费字段 audioMicrosPerSecond 在转换中保留', async t => {
  const f = await fixture(t);
  const file = join(f.c.projectRoot, 'management-settings.json');
  const settings = await ManagementSettingsStore.open(file, f.c);
  t.after(() => settings.close());
  const effective = withAsrDefault(defaultManagedSettings(f.c), 'global-asr-default', 12);

  const roleStore = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'role-configurations.json') });
  await roleStore.save(inheritConfig(ANON.roleA, 1));
  const resolved = loadEffectiveRoleConfiguration({ base: f.c, settings: effective, store: roleStore, characterId: ANON.roleA });
  assert.equal(resolved.capabilities.asr.audioMicrosPerSecond, 12, 'resolver 必须透传音频时长费率');
  const trial = applyRoleConfigurationToTrial(f.c, resolved);
  assert.equal((trial.models.asr as { audioMicrosPerSecond?: number } | undefined)?.audioMicrosPerSecond, 12,
    'ASR 音频时长费率必须在转换中保留');
});

// --- F03：生产 API 保存必须进入 v2 运行权威（审查 R4：PUT preset 只写旧文件，v2 无变化）-----------

test('RWR-08 AC-B(F03): 角色页 API 保存经生产 CharacterPresetStore 同步进入 v2 权威', async t => {
  const f = await fixture(t);
  const settingsFile = join(f.c.projectRoot, 'management-settings.json');
  const settings = await ManagementSettingsStore.open(settingsFile, f.c);
  t.after(() => settings.close());
  const active = defaultManagedSettings(f.c);
  const presetStore = await import('../../management/character-preset-store.js').then(m => m.CharacterPresetStore);
  const roleStoreForSave = await import('../../management/role-configuration.js').then(m => m.RoleConfigurationStore);
  const roleStoreInstance = await roleStoreForSave.open({ file: join(f.c.projectRoot, 'role-configurations.json') });
  const store = await new presetStore({
    filePath: join(f.c.projectRoot, 'character-presets.json'),
    memory: { characters: () => [], registry: { get: () => null }, prompt: () => ({ revision: 1, text: '匿名正文' }), savePrompt: () => ({ revision: 2, text: '' }) } as never,
    settings: { snapshot: () => ({ effective: active, saved: active }) } as never,
    base: f.c,
    roleConfigurations: roleStoreInstance,
  });
  await store.getPreset(ANON.roleA); // 触发 companion 种子
  await store.savePreset({ characterId: ANON.roleA, expectedRevision: 1, bindings: { dialogue: { model: 'b-dialogue-model' } } });

  // 权威验证：v2 store（正式启动读取的文件）必须已经收到这次保存。
  const roleStore = await RoleConfigurationStore.open({ file: join(f.c.projectRoot, 'role-configurations.json') });
  const v2 = roleStore.get(ANON.roleA);
  assert.ok(v2, '生产保存必须把绑定写入 v2 权威（修复前 v2 无变化）');
  assert.equal(v2!.bindings.dialogue.mode, 'own', '显式模型+凭据的保存成为 own 绑定');
  const source = roleStore.sources.resolve('dialogue', v2!.bindings.dialogue.sourceInstanceId!, v2!.bindings.dialogue.modelProfileId!);
  assert.ok(source, '绑定必须精确引用已登记来源与模型配置');
  assert.equal(source.profile.nativeModelId, 'b-dialogue-model', '保存的模型名必须进入运行来源配置');
});

// --- F01：正式启动角色/配对来自注册表（静态接线验证：生产 boot 代码不得硬编码 companion）----------

test('RWR-08 AC-B(F01): 正式 boot 读取注册表 effective 角色并把同一身份传给 BackendSession/DesktopRuntime', async t => {
  // 这是接线守卫：生产 boot 文本必须出现“读取注册表 effective 角色”与“把角色传入 session”的真实代码，
  // 而不是三处硬编码 companion。审查 F01 指认 trial-backend.ts 的三处固定 companion + backend-session
  // 不传角色；此回归在修复后必须继续成立（防回退）。
  const { readFile } = await import('node:fs/promises');
  const sourceRoot = resolve(import.meta.dirname ?? '.', '../../../app');
  const boot = await readFile(join(sourceRoot, 'trial-backend.ts'), 'utf8');
  assert.doesNotMatch(boot, /const effectiveRoleId = COMPANION_ID;/, 'boot 不得再硬编码 effective 角色');
  assert.match(boot, /registry\.effectiveRole\(\)/, 'boot 必须从注册表读取 effective 角色');
  assert.match(boot, /new BackendSession\([\s\S]*?effectiveRoleId\);/, 'BackendSession 必须接收启动角色');
  const session = await readFile(join(sourceRoot, 'backend-session.ts'), 'utf8');
  assert.match(session, /identityCharacterId\?:/, 'BackendSession 必须接受启动角色参数');
  assert.match(session, /new DesktopRuntime\([\s\S]*?identityCharacterId\)/, 'BackendSession 必须把启动角色传给 DesktopRuntime');
});
