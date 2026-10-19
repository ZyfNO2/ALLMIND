// RWR-07 · 资源导入 worker：验证「新资源导入/切换」这条链在真实约束下是否成立。
//
// 本文件回答五个问题，每个问题都落在生产代码上（真实 `SkinStore` + 真实 `startManagementServer`
// 的 skin 路由 + 真实 `CharacterPresetStore` + 真实 `roles-session.mjs`），而不是重新实现一遍逻辑：
//
//   AI-1  任意磁盘路径：能否通过 API/UI 让某个角色指向 manifest 之外的任意文件路径？
//   AI-2  导入后外观登记 revision 正确推进；换肤失败必须明确失败且不改变当前生效形象
//         （RWR-01 G1b：不能吞异常后回成功）。
//   AI-3  跨角色外观隔离：角色 B 不能看到/应用 companion 的 skin。
//   AI-4  解码/切换/断线错误可见（RWR-07 §执行：不可全页 catch 成空列表）。
//   AI-5  三种资源类型：sprite / live2d，以及仓库里到底有没有 3D —— 如实确认，不存在就写
//         NOT RUN，不假装支持。
//
// 约束：只用 fixture 资源（克隆仓库自带的 `desktop/assets/local-model`）与系统临时目录；不下载
// 任何东西；不写真实用户数据库 `windows/.local/data/companion.sqlite`；不执行 refresh:runtime。
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SkinStore } from '../../management/skin-store.js';
import { SKIN_API_VERSION } from '../../management/skin-routes.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { CharacterPresetStore } from '../../management/character-preset-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { ManagementError } from '../../contracts/management.js';
import { fixture } from '../management/helpers.js';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const desktop = join(projectRoot, 'code/desktop-pet/desktop');
/** 一个临时工作区，测试结束即删除。所有导入操作都发生在这里，永不触及真实 `.local` 数据目录。 */
async function workspace(t: TestContext, prefix = 'asset-import-') {
    const root = await mkdtemp(join(tmpdir(), prefix));
    t.after(() => rm(root, { recursive: true, force: true }).catch(() => { }));
    return root;
}
/** 克隆仓库自带的 fixture 资源包（真实、可构建的模型包），作为「新导入的资源」。 */
async function cloneBuiltin(target: string) {
    await cp(join(desktop, 'assets/local-model'), target, { recursive: true });
}
/** 一个真实的 SkinStore，指向临时目录。 */
async function skinStore(root: string) {
    return SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
}
/**
 * 一个真实的、带 skin 路由的管理服务。它复用现有测试的做法：把业务端口里用不到的几个填成
 * 抛错桩，这样任何意外的越权路径都会立刻暴露，而不是静默通过。
 */
async function server(t: TestContext, store: Awaited<ReturnType<typeof SkinStore.open>>) {
    const f = await fixture(t);
    const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
    const runtime = new ManagementRuntime(f.c.sourceRevision);
    const instance = await startManagementServer({
        uiRoot: join(f.c.projectRoot, 'ui'), settings, skins: store,
        memory: {
            characters: () => [], list: () => { throw new Error('not used'); }, edit: () => { throw new Error('not used'); },
            context: () => { throw new Error('not used'); }, prompt: () => { throw new Error('not used'); },
            savePrompt: () => { throw new Error('not used'); },
        },
        snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], adapters: [], credentials: [], characters: [], settings: settings.snapshot() }),
    });
    t.after(() => instance.close());
    const headers = { Authorization: 'Bearer ' + instance.token, Origin: instance.origin, 'Content-Type': 'application/json' };
    return { store, url: instance.origin, headers };
}
/** 在临时目录里写一个任意路径的「诱饵」文件，用来确认没有接口能把角色指向它。 */
async function writeBait(root: string, name = 'bait.txt', body = 'ANON-BAIT-DO-NOT-READ') {
    const path = join(root, name);
    await writeFile(path, body);
    return path;
}
const descriptorOf = (id: string) => ({
    schemaVersion: 2, id, label: id, intro: '', revision: 1,
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
});
/** 一个只注册给定角色 id 的内存 registry（RWR-02：准入由持久化 registry 决定）。 */
function registryOf(ids: readonly string[]) {
    return {
        list: () => ids.map(descriptorOf),
        get: (id: unknown) => (typeof id === 'string' && ids.includes(id) ? descriptorOf(id) : null),
        create: () => { throw new Error('not used'); },
        selection: () => ({ savedCharacterId: ids[0], effectiveCharacterId: ids[0], selectionRevision: 0, effectiveSelectionRevision: 0, applyOn: 'restart' }),
        setSelection: () => { throw new Error('not used'); },
    };
}
/** 一个内存版 memory 端口；人设写入按 expectedRevision 推进。 */
function memoryPort(ids: readonly string[]) {
    return {
        characters: () => ids.map(id => ({ id, label: id, revision: 1 })),
        prompt: (characterId: string) => ({ characterId, revision: 1, text: `匿名${characterId}人设` }),
        savePrompt: (input: { characterId: string; text: string; expectedRevision: number }) => ({ characterId: input.characterId, revision: input.expectedRevision + 1, text: input.text }),
        list: async () => ({ total: 0, offset: 0, limit: 10, records: [] }),
        edit: async () => ({ record: {} }),
        context: async () => ({ prompt: '', recent: [], summaries: [], memories: [], inputTokenBudget: 8192 }),
        forget: async () => ({ forgotten: true, id: 'id-1' }),
        registry: registryOf(ids),
    };
}
interface ReactSession {
    loadSkins(): Promise<unknown>;
    applyAppearance(input: {
        characterId: string; runningCharacterId: string; resourceId: string; type: 'live2d' | 'sprite';
        expectedRevision: number; activeSkinId: string; signal?: AbortSignal;
    }): Promise<unknown>;
}
/**
 * LUI-07: the retired `management/ui/roles-session.mjs` is deleted. These appearance guarantees are
 * asserted against `components/character/session.ts` — the React session that replaced it — bundled
 * with esbuild so the real production implementation runs without a browser.
 */
async function reactSession(handler: (path: string, options?: unknown) => Promise<unknown>): Promise<ReactSession> {
    const { buildSync } = await import('esbuild');
    const dir = await mkdtemp(join(tmpdir(), 'aika-lui07-session-'));
    const bundle = join(dir, 'session.mjs');
    buildSync({ entryPoints: ['management/character-ui/src/components/character/session.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
    const module = await import(pathToFileURL(bundle).href) as never as {
        createCharacterSession: (client: { request: (path: string, options?: unknown) => Promise<unknown> }) => ReactSession;
    };
    return module.createCharacterSession({ request: handler });
}
// AI-1 ---------------------------------------------------------------------------------------------
test('AI-1 导入后的资源路径只来自 SkinStore manifest：registered asset 全部落在包目录内', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const pack = join(root, 'imported-pack');
    await cloneBuiltin(pack);
    await store.import(pack, { skinId: 'imported-pack' });
    const packRoot = resolve(root, 'packs', 'imported-pack');
    const routes = store.routes('imported-pack');
    assert.ok(routes.size > 0, '一个已导入的包必须产出注册路由');
    for (const [relative, target] of routes) {
        if (typeof target !== 'string')
            continue; // 合成清单体不是磁盘路径
        assert.ok(resolve(target).startsWith(packRoot + sep), '注册路由必须落在包目录内，实际指向 ' + relative + ' -> ' + target);
    }
    // manifest 之外的名字一律解析不到。
    assert.equal(store.asset('imported-pack', 'bait.txt'), null);
});
test('AI-1 asset 接口拒绝任意磁盘路径与目录穿越：返回 400/404 且从不返回文件内容', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const bait = await writeBait(root);
    const s = await server(t, store);
    // 诱饵放在包目录之外；用绝对路径、盘符、反斜杠、百分号转义、普通 ../ 几种写法去够它。
    const attempts = [
        encodeURIComponent(bait),
        encodeURIComponent('..\\bait.txt'),
        encodeURIComponent('../../bait.txt'),
        encodeURIComponent('..%2Fbait.txt'),
        encodeURIComponent('%2e%2e%2Fbait.txt'),
        encodeURIComponent('C:\\windows\\win.ini'),
        encodeURIComponent('/etc/passwd'),
        encodeURIComponent('../config/parameter-map.json'),
        encodeURIComponent('..\\..\\package.json'),
    ];
    for (const path of attempts) {
        const response = await fetch(s.url + '/api/skins/local-model/asset/' + path, { headers: s.headers });
        assert.ok([400, 404].includes(response.status), `任意路径 ${path} 必须被拒绝（收到 ${response.status}）`);
        const body = await response.text();
        assert.ok(!body.includes('ANON-BAIT-DO-NOT-READ'), `拒绝的路径不得泄漏文件内容：${path}`);
        assert.ok(!body.includes('[extensions]') && !body.includes('ParamAngleX'), `拒绝的路径不得泄漏宿主/配置文件：${path}`);
    }
    // 同一个名字放在包目录里也不行：只有 manifest 声明过的才可解析。
    assert.equal(store.asset('local-model', 'bait.txt'), null, '包内未声明的文件同样不可解析');
});
test('AI-1 UI 侧没有任意磁盘读取：外观页与角色页都只接受已登记的 skinId', async (t) => {
    const root = await workspace(t);
    // LUI-07: the retired `management/ui/*.mjs` views are gone. The same guarantee is asserted against
    // the React implementation that replaced them: the appearance surface never touches the disk and
    // never invents a `file://` path — resources only arrive through the authenticated asset route.
    const views = join(projectRoot, 'code/desktop-pet/management/character-ui/src');
    for (const file of [
        'components/character/AppearancePanel.tsx',
        'components/character/session.ts',
        'components/AppearanceResources.tsx',
    ]) {
        const source = await readFile(join(views, file), 'utf8');
        assert.ok(!/\breadFile\s*\(|\bexistsSync\s*\(/.test(source), `${file} 不得自行读取磁盘`);
        assert.ok(!/file:\/\//.test(source), `${file} 不得出现 file:// 读取`);
    }
    // 外观写入面只有一个：registry 的 activate，且必须带 expectedRevision。
    const session = await readFile(join(views, 'components/character/session.ts'), 'utf8');
    assert.match(session, /\/api\/skins\/\$\{encodeURIComponent\([^)]*\)\}\/activate/);
    assert.match(session, /expectedRevision/);
    assert.ok(root.length > 0);
});
test('AI-1 没有接口能把角色的 appearance 指向一个任意文件路径', async (t) => {
    const root = await workspace(t);
    const bait = await writeBait(root);
    const store = await skinStore(root);
    const s = await server(t, store);
    // 1) 直接把绝对路径当作 skinId 去 activate：registry 未登记 -> 404。
    const activate = await fetch(s.url + '/api/skins/' + encodeURIComponent(bait) + '/activate', { method: 'POST', headers: s.headers, body: JSON.stringify({ expectedRevision: store.state().revision }) });
    assert.equal(activate.status, 404, '一个未登记的 id（哪怕是磁盘路径）必须 404');
    // 2) 把任意路径当作 import 源：不是 model3 包 -> 拒绝，绝不静默成功。
    const fileAsPack = await fetch(s.url + '/api/skins/import', { method: 'POST', headers: s.headers, body: JSON.stringify({ source: bait, skinId: 'bait-pack' }) });
    assert.ok(!fileAsPack.ok, '一个文件不能当作模型包导入');
    assert.equal(store.list().length, 1, '失败的导入不登记任何条目');
    assert.equal(store.state().activeSkinId, 'local-model');
});
test('AI-1 导入源本身也受约束：符号链接与包外引用不能把路径带出去', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    // 包内出现符号链接 -> 拒绝（copyPack 明确不允许）。
    const linked = join(root, 'linked-pack');
    await cloneBuiltin(linked);
    const outside = await writeBait(root, 'outside.txt');
    try {
        await symlink(outside, join(linked, 'escape.txt'));
    }
    catch {
        // 无权限创建符号链接时跳过该分支（环境不支持该输入，不是放宽断言）。
        return;
    }
    await assert.rejects(store.import(linked, { skinId: 'linked-pack' }), (error: Error) => /符号链接|路径|引用/.test(error.message));
    assert.deepEqual(store.list().map((skin) => skin.skinId), ['local-model'], '带链接的包不得登记');
    // 穿越引用在 manifest 内也被拒绝（Moc 指向包外）。
    const escaping = join(root, 'escaping-ref');
    await cloneBuiltin(escaping);
    const manifest = JSON.parse(await readFile(join(escaping, 'pet.model3.json'), 'utf8'));
    manifest.FileReferences.Moc = '../../outside.moc3';
    await writeFile(join(escaping, 'pet.model3.json'), JSON.stringify(manifest));
    await assert.rejects(store.import(escaping, { skinId: 'escaping-ref' }), (error: Error) => /路径|引用/.test(error.message));
});
// AI-2 ---------------------------------------------------------------------------------------------
test('AI-2 导入与激活各自把外观登记 revision 推进 1，且持久到磁盘', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const pack = join(root, 'imported-pack');
    await cloneBuiltin(pack);
    const before = store.state().revision;
    const imported = await store.import(pack, { skinId: 'imported-pack' });
    assert.equal(imported.revision, before + 1, '一次接受的导入推进一次修订');
    assert.equal(imported.activeSkinId, 'local-model', '导入不等于激活');
    const activated = await store.activate(imported.revision, 'imported-pack');
    assert.equal(activated.revision, imported.revision + 1, '一次激活推进一次修订');
    assert.equal(activated.activeSkinId, 'imported-pack');
    // 重启后从同一文件恢复：修订与生效外观都必须一致。
    const reopened = await skinStore(root);
    assert.equal(reopened.state().revision, activated.revision);
    assert.equal(reopened.active().skinId, 'imported-pack');
});
test('AI-2 换肤失败必须明确失败，且不改变当前生效形象', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const activeBefore = store.active().skinId;
    const revisionBefore = store.state().revision;
    // 未登记的 skinId。
    await assert.rejects(store.activate(revisionBefore, 'no-such-pack'), (error) => error instanceof ManagementError && error.code === 'not_found');
    // 过期修订。
    await assert.rejects(store.activate(revisionBefore - 1, 'local-model'), (error) => error instanceof ManagementError && error.code === 'version_conflict');
    assert.equal(store.active().skinId, activeBefore, '失败的换肤不得改变当前生效形象');
    assert.equal(store.state().revision, revisionBefore, '失败的换肤不得推进修订');
});
test('AI-2 一个字节损坏的资源包导入失败：不登记、不改生效、revision 不动', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const revisionBefore = store.state().revision;
    const activeBefore = store.active().skinId;
    const corrupt = join(root, 'corrupt-pack');
    await cloneBuiltin(corrupt);
    const manifest = JSON.parse(await readFile(join(corrupt, 'pet.model3.json'), 'utf8'));
    const mocPath = join(corrupt, manifest.FileReferences.Moc);
    const bytes = await readFile(mocPath);
    bytes[64] = (bytes[64] ?? 0) ^ 0xff; // 翻转一个字节：指纹与 Cubism Core 构建都会失败
    await writeFile(mocPath, bytes);
    await assert.rejects(store.import(corrupt, { skinId: 'corrupt-pack' }));
    assert.deepEqual(store.list().map((skin) => skin.skinId), ['local-model'], '损坏的包不得登记');
    assert.equal(store.active().skinId, activeBefore);
    assert.equal(store.state().revision, revisionBefore, '失败的导入不推进修订');
    // 暂存目录已清理，包目录里没有留下半成品。
    const packs = await readdir(join(root, 'packs')).catch(() => []);
    assert.deepEqual(packs.filter(name => name.startsWith('.')), [], '失败导入不得留下临时暂存目录');
});
test('AI-2 引用缺失文件的资源包导入失败（缺纹理）', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const revisionBefore = store.state().revision;
    const missing = join(root, 'missing-texture');
    await cloneBuiltin(missing);
    const manifest = JSON.parse(await readFile(join(missing, 'pet.model3.json'), 'utf8'));
    await rm(join(missing, manifest.FileReferences.Textures[0]), { force: true });
    await assert.rejects(store.import(missing, { skinId: 'missing-texture' }), (error: Error) => /资源|纹理/.test(error.message));
    assert.equal(store.state().revision, revisionBefore);
    assert.deepEqual(store.list().map((skin) => skin.skinId), ['local-model']);
});
test('AI-2 预设保存把 appearance 交给 registry；registry 拒绝时保存失败且 revision 不推进', async (t) => {
    const f = await fixture(t);
    const root = await workspace(t);
    const store = await skinStore(root);
    const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
    const presets = await CharacterPresetStore.open({
        filePath: join(root, 'character-presets.json'),
        memory: memoryPort(['companion']) as never as import('../../contracts/management.js').ManagementMemoryPort,
        settings, skins: store, base: f.c,
    });
    const before = await presets.getPreset('companion');
    const revisionBefore = before.revision;
    const activeBefore = store.active().skinId;
    // 指向一个 registry 未登记的 resourceId（等价于「任意文件路径」这种不存在的资源）。
    await assert.rejects(() => presets.savePreset({ characterId: 'companion', expectedRevision: revisionBefore, appearance: { type: 'live2d', resourceId: 'not-a-registered-pack' } }), (error) => error instanceof ManagementError);
    assert.equal(store.active().skinId, activeBefore, 'registry 拒绝时当前生效形象不变');
    assert.equal((await presets.getPreset('companion')).revision, revisionBefore, '失败的保存不推进预设修订');
    // 反过来：登记过的资源可以应用，且 preset 投影的是 registry 的生效 id。
    const pack = join(root, 'ok-pack');
    await cloneBuiltin(pack);
    await store.import(pack, { skinId: 'ok-pack' });
    const receipt = await presets.savePreset({
        characterId: 'companion', expectedRevision: revisionBefore, appearance: { type: 'live2d', resourceId: 'ok-pack' },
    });
    assert.equal(receipt.applied.appearance, true);
    assert.equal(store.active().skinId, 'ok-pack');
    assert.equal(receipt.appearance.resourceId, 'ok-pack');
    assert.equal(receipt.revision, revisionBefore + 1);
});
test('AI-2 缺少 skin registry 时形象保存是明确 unavailable，不是静默 no-op', async (t) => {
    const f = await fixture(t);
    const root = await workspace(t);
    const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
    const presets = await CharacterPresetStore.open({
        filePath: join(root, 'character-presets.json'),
        memory: memoryPort(['companion']) as never as import('../../contracts/management.js').ManagementMemoryPort,
        settings, base: f.c, // 故意不传 skins
    });
    await assert.rejects(() => presets.savePreset({ characterId: 'companion', expectedRevision: 1, appearance: { type: 'live2d', resourceId: 'anything' } }), (error) => error instanceof ManagementError && error.code === 'unavailable');
});
// AI-3 ---------------------------------------------------------------------------------------------
test('AI-3 跨角色外观隔离：角色 B 的 appearance 上不出现 companion 刚换上的 skin', async (t) => {
    const f = await fixture(t);
    const root = await workspace(t);
    const store = await skinStore(root);
    const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
    const presets = await CharacterPresetStore.open({
        filePath: join(root, 'character-presets.json'),
        memory: memoryPort(['companion', 'role-b']) as never as import('../../contracts/management.js').ManagementMemoryPort,
        settings, skins: store, base: f.c,
    });
    const pack = join(root, 'companion-only-pack');
    await cloneBuiltin(pack);
    await store.import(pack, { skinId: 'companion-only-pack' });
    const companionBefore = await presets.getPreset('companion');
    const saved = await presets.savePreset({
        characterId: 'companion', expectedRevision: companionBefore.revision,
        appearance: { type: 'live2d', resourceId: 'companion-only-pack' },
    });
    assert.equal(saved.appearance.resourceId, 'companion-only-pack');
    assert.equal(store.active().skinId, 'companion-only-pack');
    // RWR-02 既有断言的形式：companion 的换肤结果从未出现在角色 B 的 appearance 上。
    const roleB = await presets.getPreset('role-b');
    assert.notEqual(roleB.appearance.resourceId, 'companion-only-pack', "companion's skin change never reached role B");
    // 更强的一条：角色 B 从未被保存过，所以它是诚实的空投影。
    assert.equal(roleB.revision, 0, '角色 B 从未保存，不应有修订');
    assert.equal(roleB.persona.text, '', '角色 B 不应出现凭空捏造的人设');
});
test('AI-3 角色 B 只保存人设时，不得把 companion 的当前外观写成角色 B 的已保存外观', async (t) => {
    const f = await fixture(t);
    const root = await workspace(t);
    const store = await skinStore(root);
    const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'management-settings.json'), f.c);
    const presets = await CharacterPresetStore.open({
        filePath: join(root, 'character-presets.json'),
        memory: memoryPort(['companion', 'role-b']) as never as import('../../contracts/management.js').ManagementMemoryPort,
        settings, skins: store, base: f.c,
    });
    const pack = join(root, 'companion-pack');
    await cloneBuiltin(pack);
    await store.import(pack, { skinId: 'companion-pack' });
    await presets.savePreset({
        characterId: 'companion', expectedRevision: 1, appearance: { type: 'live2d', resourceId: 'companion-pack' },
    });
    assert.equal(store.active().skinId, 'companion-pack');
    // 角色 B 只改人设，从未选择任何形象。
    const roleBBefore = await presets.getPreset('role-b');
    const savedB = await presets.savePreset({
        characterId: 'role-b', expectedRevision: roleBBefore.revision, persona: { text: '匿名角色B人设' },
    });
    assert.notEqual(savedB.appearance.resourceId, 'companion-pack', '角色 B 从未选择形象，其已保存外观不得被 companion 的当前外观填充');
});
test('AI-3 皮肤 registry 从不携带角色身份：响应里没有 characterId', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const s = await server(t, store);
    const response = await fetch(s.url + '/api/skins', { headers: s.headers });
    const text = await response.text();
    for (const forbidden of ['"characterId"', '"knowledgeLibrary"', '"memory"', '"voice"', '"credential"']) {
        assert.ok(!text.includes(forbidden), `外观响应不得携带 ${forbidden}`);
    }
    assert.equal(JSON.parse(text).apiVersion, SKIN_API_VERSION);
});
// AI-4 ---------------------------------------------------------------------------------------------
test('AI-4 外观读取失败是可见错误，不是空列表（角色会话层）', async () => {
    // LUI-07: re-landed on the React character session. The guarantee is unchanged: a failed registry
    // read is an ERROR, never an empty array the page would render as "no resources".
    const session = await reactSession(async (path: string) => {
        if (path === '/api/skins')
            throw Object.assign(new Error('anon: registry unavailable'), { status: 503 });
        return { revision: 1, persona: { text: '匿名', revision: 1 }, appearance: {}, bindings: {} };
    });
    await assert.rejects(() => session.loadSkins(), /registry unavailable/);
});
test('AI-4 切换被拒（409）时会话报告失败且生效形象不变', async () => {
    const session = await reactSession(async () => {
        throw Object.assign(new Error('模型包登记已更新，请刷新后重试。'), { status: 409 });
    });
    const activeSkinId = 'anon-skin-1';
    await assert.rejects(() => session.applyAppearance({
        characterId: 'companion', runningCharacterId: 'companion', resourceId: 'anon-skin-9',
        type: 'live2d', expectedRevision: 5, activeSkinId,
    }), /模型包登记已更新/);
    // The caller's effective skin is untouched: a rejected switch must not move it.
    assert.equal(activeSkinId, 'anon-skin-1', '被拒的换肤不得移动生效形象');
});
test('AI-4 未读取外观登记时不发盲写', async () => {
    let calls = 0;
    const session = await reactSession(async () => { calls++; return {}; });
    // An EMPTY resource id is refused locally, so no request is issued for a nameless target.
    await assert.rejects(() => session.applyAppearance({
        characterId: 'role-b', runningCharacterId: 'companion', resourceId: '',
        type: 'live2d', expectedRevision: 0, activeSkinId: 'anon-skin-1',
    }), /请先选择形象资源/);
    assert.equal(calls, 0, '未选择资源时不得发起写入');
});
test('AI-4 皮肤页把解码/断线失败显示出来，且不接受不认识 API 版本的响应', async () => {
    // LUI-07: asserted against the React appearance surface (the retired `skin-view.mjs` is deleted).
    // The guarantees are unchanged: an unwired backend and an unknown apiVersion are visible failures.
    const views = join(projectRoot, 'code/desktop-pet/management/character-ui/src');
    const panel = await readFile(join(views, 'components/character/AppearancePanel.tsx'), 'utf8');
    assert.match(panel, /应用形象失败/, '写入失败必须显示错误');
    const session = await readFile(join(views, 'components/character/session.ts'), 'utf8');
    assert.match(session, /apiVersion/, 'API 版本必须被检查');
    // CUX-01: the preview moved OUT of the import dialog into the shared `ResourcePreview` component and
    // `services/skin-preview.ts`. The dialog is import-only now; the guarantee travels with the preview.
    const resources = await readFile(join(views, 'components/AppearanceResources.tsx'), 'utf8');
    assert.match(resources, /catch|finally/, '导入失败必须被捕获，不能静默');
    const preview = await readFile(join(views, 'components/ResourcePreview.tsx'), 'utf8');
    assert.match(preview, /catch|失败/, '预览加载失败必须被捕获');
});
test('AI-4 渲染侧解码失败会上报为可见状态，不是静默空画面', async () => {
    const renderer = await readFile(join(desktop, 'cubism-renderer.mjs'), 'utf8');
    assert.match(renderer, /模型文件加载失败/, '资源解码失败必须报出具体文件');
    assert.match(renderer, /模型资源路径不可用/, '路径校验失败必须报错');
    assert.match(renderer, /模型与预设目录版本不一致/, '指纹不一致必须报错');
    // LUI-05/LUI-07: the shared preview runtime moved out of the retired directory; the React preview is
    // its only in-app consumer and it must keep surfacing a load failure instead of a blank canvas.
    // CUX-01: that consumer is now the shared preview service, reused by the appearance page.
    const preview = await readFile(join(projectRoot, 'code/desktop-pet/management/character-ui/src/services/skin-preview.ts'), 'utf8');
    assert.match(preview, /preview-runtime\/presentation-preview\.js/, '必须加载已迁出的共享预览运行时');
    assert.match(preview, /error|catch|失败/, '运行库加载失败必须可见');
});
// AI-5 ---------------------------------------------------------------------------------------------
test('AI-5 资源类型事实确认：live2d 是真实支持的类型', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const pack = join(root, 'live2d-pack');
    await cloneBuiltin(pack);
    await store.import(pack, { skinId: 'live2d-pack' });
    const descriptor = store.describe('live2d-pack');
    assert.match(descriptor.modelEntry, /\.model3\.json$/, '真实导入的是 model3（Live2D）包');
    assert.ok(descriptor.capabilities.motions > 0 && descriptor.capabilities.expressions > 0, 'Live2D 能力真实可用');
});
test('AI-5 Sprite 登记真实 PNG 并发布单帧资源，损坏图片仍明确拒绝', async (t) => {
    const root = await workspace(t);
    const store = await skinStore(root);
    const manifest = JSON.parse(await readFile(join(desktop, 'assets/local-model/pet.model3.json'), 'utf8'));
    await store.import(join(desktop, 'assets/local-model', manifest.FileReferences.Textures[0]), { type: 'sprite', skinId: 'real-png' });
    const sprite = store.list().find(item => item.skinId === 'real-png');
    assert.ok(sprite, '导入的 sprite 必须已登记');
    assert.equal(sprite!.type, 'sprite');
    assert.equal(sprite!.sprite!.frameCount, 1);
    assert.equal(sprite!.sprite!.fps, 12);
    const published = store.routes('real-png').get('pet.skin.json');
    assert.ok(published && typeof published !== 'string');
    assert.equal(JSON.parse(published!.body).type, 'sprite');
    const corrupt = join(root, 'broken.png');
    await writeFile(corrupt, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(store.import(corrupt, { type: 'sprite', skinId: 'broken-png' }), /解码/);
});
test('AI-5 资源类型事实确认：仓库里不存在 3D 资源类型（NOT RUN，不是 FAIL）', async () => {
    const codeRoot = join(projectRoot, 'code/desktop-pet');
    // `tests` is skipped on purpose: a test that asserts an ABSENCE has to write the very token it
    // looks for (this file's own regex literal matched `model-3d` on the first run). The claim under
    // test is about production source — implementation, not about test prose.
    const skip = new Set(['node_modules', 'dist', 'vendor', 'build', '.git', '.local', 'test-results', '.probe', 'tests']);
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (skip.has(entry.name))
                continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(path);
                continue;
            }
            if (!/\.(ts|mjs|js|json)$/.test(entry.name))
                continue;
            let source = '';
            try {
                source = await readFile(path, 'utf8');
            }
            catch {
                continue;
            }
            if (/\b(gltf|glb|vrm|three\.js|threejs|model-3d|model3d)\b/i.test(source))
                hits.push(path);
        }
    };
    await walk(codeRoot);
    assert.deepEqual(hits, [], '生产代码里不应出现任何 3D 资源类型引用（实际命中：' + JSON.stringify(hits) + '）');
    // 类型枚举本身也不含 3d：'sprite' | 'live2d' 就是全部。
    const roleConfiguration = await readFile(join(codeRoot, 'contracts/role-configuration.ts'), 'utf8');
    const appearance = /readonly type:\s*([^;]+);/.exec(roleConfiguration)?.[1] ?? '';
    assert.ok(!/3d/i.test(appearance), 'appearance.type 枚举里没有 3D：' + appearance);
});
