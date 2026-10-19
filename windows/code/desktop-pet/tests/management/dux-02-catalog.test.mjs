/**
 * DUX-02 · skin-store 生成的动作/表情目录必须**全量**枚举模型包自身引用的能力。
 *
 * 失败证据（RED 记录于 docs/next/ui-rework/reports/DUX-00.md 矩阵第 2 行）：
 * 旧 `disabledCatalog` 只给每个 expression 一项 + **首组 index 0** 一个 motion 项；
 * 多组/多 index 的包无法在预览里播放其余动作。DUX-02 目标：每个 expression 一项、
 * 每个 motion group 的每个 index 一项，id 稳定（kind+真实 name/group/index）。
 *
 * 被测对象：generated-disabled 路径（包内无 presets.json）。用真实 rig 文件（Hiyori 的
 * moc3/贴图/cdi3/表情/动作，全部能被真实 Cubism Core 校验）组装一个无 authored catalog 的
 * 临时包，走真实 `SkinStore.import` 登记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('DUX-02 生成目录枚举全部 expressions 与每个 motion group 的每个 index', async t => {
  await mkdir(join(resolve('.local/dux-02/tmp')), { recursive: true });
  const base = await mkdtemp(join(resolve('.local/dux-02/tmp'), 'store-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const packs = join(base, 'packs');
  const src = resolve('desktop/assets/local-model');
  // 组装临时包：真实 moc/贴图/物理/姿态/显示信息 + 2 个表情引用 + 3 组动作引用（Idle 2 + Tap 1）。
  const model3 = {
    Version: 3,
    FileReferences: {
      Moc: 'm.moc3', Textures: ['t0.png', 't1.png'], Physics: 'p.json', Pose: 'pose.json',
      DisplayInfo: 'd.cdi3.json', UserData: 'u.json',
      Expressions: [{ Name: 'smile', File: 'e1.exp3.json' }, { Name: 'angry', File: 'e2.exp3.json' }],
      Motions: {
        Idle: [{ File: 'i1.motion3.json' }, { File: 'i2.motion3.json' }],
        TapBody: [{ File: 'i3.motion3.json' }],
      },
    },
    Groups: [
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
    ],
  };
  const root = join(packs, 'dux02-motion-pack');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'pet.model3.json'), JSON.stringify(model3));
  await copyFile(join(src, 'Hiyori.moc3'), join(root, 'm.moc3'));
  await copyFile(join(src, 'Hiyori.2048/texture_00.png'), join(root, 't0.png'));
  await copyFile(join(src, 'Hiyori.2048/texture_01.png'), join(root, 't1.png'));
  await copyFile(join(src, 'Hiyori.physics3.json'), join(root, 'p.json'));
  await copyFile(join(src, 'Hiyori.pose3.json'), join(root, 'pose.json'));
  await copyFile(join(src, 'Hiyori.cdi3.json'), join(root, 'd.cdi3.json'));
  await copyFile(join(src, 'Hiyori.userdata3.json'), join(root, 'u.json'));
  // 表情/动作引用真实文件（参数 id 必须存在于 cdi3 参数表）。
  await copyFile(join(src, 'exp/Normal.exp3.json'), join(root, 'e1.exp3.json'));
  await copyFile(join(src, 'exp/Normal.exp3.json'), join(root, 'e2.exp3.json'));
  await copyFile(join(src, 'motions/Hiyori_m01.motion3.json'), join(root, 'i1.motion3.json'));
  await copyFile(join(src, 'motions/Hiyori_m02.motion3.json'), join(root, 'i2.motion3.json'));
  await copyFile(join(src, 'motions/Hiyori_m04.motion3.json'), join(root, 'i3.motion3.json'));
  const { SkinStore } = await import('../../dist/management/skin-store.js');
  const store = await SkinStore.open(join(base, 'registry.json'), packs, resolve('desktop'));
  await store.import(root, { skinId: 'dux02-motion-pack' });
  const manifest = store.manifest('dux02-motion-pack');
  const items = manifest.catalog.items;
  const ids = items.map(item => item.id);
  // 每个 expression 一项，id 用真实名字（稳定）。
  for (const name of ['smile', 'angry']) assert.ok(ids.includes(`skin-expression-${name}`), `缺少 expression 项 ${name}：${ids.join(',')}`);
  // 每个 group 的每个 index 一项（不止首组 index 0）。
  for (const [group, count] of [['Idle', 2], ['TapBody', 1]]) for (let i = 0; i < count; i++) {
    const item = items.find(entry => entry.motionGroup === group && entry.motionIndex === i);
    assert.ok(item, `缺少 motion 项 ${group}#${i}：${ids.join(',')}`);
    assert.equal(item.id, `skin-motion-${group}-${i}`, 'motion id 必须按 kind+group+index 稳定生成');
  }
  assert.equal(ids.filter(id => id.startsWith('skin-motion-')).length, 3, 'motion 项必须是 3 个（2×Idle + 1×TapBody），不是 1 个');
  // manual + previewable：默认不启用（automatic 语义不变），但可在预览中播放。
  for (const item of items) { assert.equal(item.availability, 'manual'); assert.equal(item.defaultEnabled, false); assert.equal(item.previewable, true); }
  assert.equal(manifest.capabilities.automaticPresets, 0, '生成目录不得改变 automatic 语义');
});
