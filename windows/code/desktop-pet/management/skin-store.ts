// FIX61-05: the model-pack (skin) registry. It owns import, validation, activation and asset
// resolution for every skin the desktop may render. The renderer never resolves a path itself: it
// asks for a registry id and receives either registered bytes or nothing.
//
// Boundaries kept deliberately narrow:
//  * Cubism 3/4/5 model3 packs only. Cubism 2 rigs are refused instead of half-rendered.
//  * Every referenced file is resolved inside the pack with realpath, so '..', a drive letter, a
//    percent-escape or a symlink cannot escape the pack. Symlinks are refused outright.
//  * Two fingerprints are kept apart on purpose. modelFingerprint is the legacy binding over
//    model3 + moc + physics + expressions + motions that the existing presentation catalog check
//    already uses; assetFingerprint additionally covers textures, pose, display info and user
//    data. Re-skinning therefore changes the skin's own asset hash and never the pinned runtime
//    hash that app/trial-launcher verifies.
//  * A pack without a reviewed catalog gets a generated, fully disabled catalog. The built-in
//    preset ids are never copied onto another rig.
//  * A .moc3 is validated here by container header (magic + version). The renderer additionally
//    runs the official Cubism consistency check before it commits a skin, because only the real
//    Core can judge the payload.
import { createHash, randomUUID } from 'node:crypto';
import {existsSync} from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import { validatePresentationCatalog } from './presentation.js';
import { inspectMoc } from './moc-inspector.js';
import { inspectSprite } from './sprite-inspector.js';
import { extractModelArchive } from './model-archive.js';
import {resolveLocalPetSlot} from '../contracts/local-pet.js';
import type { PresentationCatalog, PresentationPreset } from '../contracts/presentation-presets.js';
import type {
  SkinCapabilities, SkinDescriptor, SkinImportInput, SkinManagement, SkinManifest, SkinParameterMap, SkinRoute, SkinState,
} from '../contracts/skin.js';

const ID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const HASH = /^[a-f0-9]{64}$/;
const MODEL_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,183}\.model3\.json$/;
const MAX_FILES = 512, MAX_BYTES = 512 * 1024 * 1024;
export const BUILT_IN_SKIN_ID = 'local-model';
const DEFAULT_PARAMETERS: SkinParameterMap = { headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', mouthForm: 'ParamMouthForm' };
function fail(message: string, code: 'invalid_request' | 'not_found' | 'unavailable' = 'invalid_request'): never { throw new ManagementError(code, message); }
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Model-relative reference exactly as a model3 manifest stores it. Never an absolute or escaped path. */
function referencePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) fail('模型引用缺少 ' + field + '。');
  const candidate = value as string;
  if (candidate.startsWith('/') || candidate.includes('\\') || candidate.includes(':') || candidate.includes('\0') || candidate.includes('%')) fail('模型引用路径不可用。');
  if (candidate.split('/').some((part: string) => !part || part === '.' || part === '..')) fail('模型引用路径不可用。');
  return candidate;
}
function isOutside(base: string, target: string) { const part = relative(base, target); return !part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part); }

interface References {
  readonly entry: string; readonly moc: string; readonly physics: string | null; readonly pose: string | null;
  readonly displayInfo: string | null; readonly userData: string | null;
  readonly textures: readonly string[];
  readonly expressions: readonly { readonly name: string; readonly file: string }[];
  readonly motions: Readonly<Record<string, readonly string[]>>;
  /** Every referenced file, deduplicated and sorted: the complete asset closure of the pack. */
  readonly closure: readonly string[];
  /** The legacy subset the existing catalog check hashes. */
  readonly legacy: readonly string[];
}

/** Flatten one model3 manifest into explicit references. No file is opened here. */
function parseManifest(entry: string, raw: string): References {
  let parsed: { FileReferences?: unknown; Version?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return fail('入口模型文件不是有效 JSON。'); }
  const version = parsed.Version;
  if (!Number.isInteger(version) || ![3, 4, 5].includes(version as number)) return fail('只支持 Cubism 3/4/5 的 model3 模型包，当前文件版本不受支持。');
  const rawRefs = parsed.FileReferences;
  if (!rawRefs || typeof rawRefs !== 'object' || Array.isArray(rawRefs)) return fail('入口模型文件缺少 FileReferences。');
  const files = rawRefs as Record<string, unknown>;
  const prefix = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const packReference = (value: unknown, field: string) => prefix + referencePath(value, field);
  const moc = packReference(files.Moc, 'Moc');
  const textures = Array.isArray(files.Textures) ? files.Textures.map((item: unknown) => packReference(item, 'Textures')) : [];
  if (!textures.length) return fail('模型包没有声明纹理。');
  const optional = (key: string) => files[key] === undefined ? null : packReference(files[key], key);
  const expressions = (Array.isArray(files.Expressions) ? files.Expressions : []).map((rawItem: unknown) => {
    const item = rawItem as { Name?: unknown; File?: unknown };
    if (typeof item?.Name !== 'string' || !item.Name.trim()) return fail('模型预设缺少名称。');
    return { name: item.Name as string, file: packReference(item.File, 'Expressions') };
  });
  const motions: Record<string, string[]> = {};
  const groups = files.Motions;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) for (const [group, list] of Object.entries(groups as Record<string, unknown>)) {
    if (!Array.isArray(list)) return fail('模型动作组无效。');
    motions[group] = list.map((rawItem: unknown) => packReference((rawItem as { File?: unknown })?.File, 'Motions'));
  }
  const physics = optional('Physics'), pose = optional('Pose'), displayInfo = optional('DisplayInfo'), userData = optional('UserData');
  const closure = [...new Set([entry, moc, ...(physics ? [physics] : []), ...(pose ? [pose] : []), ...(displayInfo ? [displayInfo] : []),
    ...(userData ? [userData] : []), ...textures, ...expressions.map(item => item.file), ...Object.values(motions).flat()])].sort();
  const legacy = [...new Set([entry, moc, ...(physics ? [physics] : []), ...expressions.map(item => item.file), ...Object.values(motions).flat()])].sort();
  return { entry, moc, physics, pose, displayInfo, userData, textures, expressions, motions, closure, legacy };
}

/** Copy a pack directory, refusing links so an import cannot smuggle a path outside its source. */
async function copyPack(source: string, destination: string): Promise<void> {
  let count = 0;
  let bytes = 0;
  const walk = async (from: string, to: string) => {
    await mkdir(to, { recursive: true });
    for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const raw = join(from, entry.name), target = join(to, entry.name);
      const info = await lstat(raw);
      if (info.isSymbolicLink()) return fail('模型包内不允许符号链接。');
      if (info.isDirectory()) { await walk(raw, target); continue; }
      if (!info.isFile()) return fail('模型包内包含不支持的文件类型。');
      if (++count > MAX_FILES) return fail('模型包文件数量超出上限。');
      bytes += info.size;
      if (bytes > MAX_BYTES) return fail('模型包体积超出上限。');
      await cp(raw, target);
    }
  };
  await walk(source, destination);
}

/** Per-pack procedural parameter mapping. A pack may ship its own; the built-in falls back to the shared file. */
async function readParameters(base: string, fallbackFile: string | null = null): Promise<SkinParameterMap> {
  for (const candidate of [join(base, 'parameter-map.json'), ...(fallbackFile ? [fallbackFile] : [])]) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(await readFile(candidate, 'utf8')) as Record<string, unknown>; } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const declared = raw as Record<string, unknown>;
    const pick = (key: 'headYaw' | 'headPitch' | 'headRoll' | 'mouthForm') => typeof declared[key] === 'string' && (declared[key] as string).trim() ? declared[key] as string : DEFAULT_PARAMETERS[key];
    const overrides: Record<string, number> = {};
    const extra = declared.parameterOverrides;
    if (extra && typeof extra === 'object' && !Array.isArray(extra))
      for (const [id, value] of Object.entries(extra as Record<string, unknown>)) if (typeof value === 'number' && Number.isFinite(value)) overrides[id] = value;
    return { headYaw: pick('headYaw'), headPitch: pick('headPitch'), headRoll: pick('headRoll'), mouthForm: pick('mouthForm'),
      ...(Object.keys(overrides).length ? { parameterOverrides: overrides } : {}) };
  }
  return DEFAULT_PARAMETERS;
}

/**
 * A cheap structural pre-check. It rejects an obviously wrong file before the (much more expensive)
 * Core build, but it is deliberately not the authority: only the real Cubism Core decides whether a
 * rig can be built. Field 4 is the moc3 file-format version. The documentation enum is 3/4/5
 * (MocVersion_30/33/40/42/50/53 in the vendored typings), and the rig this repository actually
 * ships declares 1, which this build of the Core still loads, so 1 is accepted too.
 */
const MOC_FORMAT_VERSIONS = [1, 3, 4, 5];
const MOC_HEADER_SIZE = 16;
function mocVersionOf(bytes: Buffer): number {
  if (bytes.byteLength < MOC_HEADER_SIZE || bytes.subarray(0, 4).toString('latin1') !== 'MOC3') return fail('模型 moc 文件头无效，不是可用的 moc3。');
  const version = bytes.readUInt32LE(4);
  if (!MOC_FORMAT_VERSIONS.includes(version)) return fail('只支持 Cubism 3/4/5 的 moc3 文件，当前版本 ' + version + ' 不受支持。');
  if (bytes[5] !== 0) return fail('模型 moc 文件头无效，不是可用的 moc3。');
  return version;
}

/** The declared parameter ids of a rig, taken from its own display-info file. */
function declaredParameters(raw: string | null): Set<string> {
  if (!raw) return new Set();
  let parsed: { Parameters?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return fail('模型显示信息文件不是有效 JSON。'); }
  if (!Array.isArray(parsed.Parameters)) return fail('模型显示信息文件无效。');
  const ids = new Set<string>();
  for (const item of parsed.Parameters as { Id?: unknown }[]) { if (typeof item?.Id !== 'string') return fail('模型显示信息文件无效。'); ids.add(item.Id as string); }
  return ids;
}
function validateExpressionFile(raw: string, ids: ReadonlySet<string>): void {
  let parsed: { Parameters?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return fail('模型预设文件不是有效 JSON。'); }
  if (!Array.isArray(parsed.Parameters)) return fail('模型预设文件缺少 Parameters。');
  for (const item of parsed.Parameters as { Id?: unknown; Value?: unknown }[]) {
    if (typeof item?.Id !== 'string' || !ids.has(item.Id)) return fail('预设引用了模型不存在的参数。');
    if (typeof item.Value !== 'number' || !Number.isFinite(item.Value)) return fail('模型预设的取值无效。');
  }
}
function validateMotionFile(raw: string, ids: ReadonlySet<string>): void {
  let parsed: { Curves?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return fail('模型动作文件不是有效 JSON。'); }
  if (!Array.isArray(parsed.Curves)) return fail('模型动作文件缺少 Curves。');
  for (const item of parsed.Curves as { Target?: unknown; Id?: unknown }[]) {
    if (item.Target === 'Parameter' && (typeof item.Id !== 'string' || !ids.has(item.Id))) return fail('动作引用了模型不存在的参数。');
  }
}
function validatePhysicsFile(raw: string): void {
  let parsed: { Version?: unknown; PhysicsSettings?: unknown };
  try { parsed = JSON.parse(raw) as typeof parsed; } catch { return fail('模型物理文件不是有效 JSON。'); }
  // A rig legitimately has no physics settings; the document itself must still be a physics3 file.
  if (parsed.Version !== 3 || !Array.isArray(parsed.PhysicsSettings)) return fail('模型物理文件无效。');
}

/**
 * A pack with no reviewed catalog still needs a routable, entirely manual directory.
 *
 * DUX-02: the directory enumerates EVERY model-referenced expression and EVERY motion of EVERY
 * group at EVERY index (not just the first group's index 0), so the preview can play each one.
 * Generated ids are stable for as long as the pack's own references stay unchanged
 * (kind + real name/group/index). Sprite clips come from the manifest's declared clips only.
 */
const SPRITE_CLIP_LABELS: Record<string, string> = { idle: '待机', listening: '倾听', thinking: '思考', speaking: '说话', working: '工作', happy: '开心', sleeping: '睡眠' };
function disabledCatalog(
  skinId: string, modelFingerprint: string,
  expressionNames: readonly string[],
  motions: Readonly<Record<string, readonly string[]>>,
  clips?: readonly { id: string; label: string }[],
): PresentationCatalog {
  const items: PresentationPreset[] = expressionNames.map(name => ({ id: `skin-expression-${name}`, label: name,
    category: 'expression', source: 'model-expression', availability: 'manual', defaultEnabled: false, previewable: true, expressionName: name }));
  for (const [group, files] of Object.entries(motions)) for (let index = 0; index < files.length; index++)
    items.push({ id: `skin-motion-${group}-${index}`, label: `${group} #${index + 1}`, category: 'pose', source: 'model-motion',
      availability: 'manual', defaultEnabled: false, previewable: true, motionGroup: group, motionIndex: index });
  if (clips?.length) for (const clip of clips) items.push({ id: `skin-clip-${clip.id}`, label: clip.label, category: 'pose',
    source: 'model-motion', availability: 'manual', defaultEnabled: false, previewable: true });
  if (!items.length) items.push({ id: 'skin-static', label: '静态外观', category: 'idle', source: 'procedural', availability: 'manual', defaultEnabled: false, previewable: false });
  return { schemaVersion: 1, modelId: skinId, modelFingerprint, items };
}

interface Imported { schemaVersion: 1; revision: number; activeSkinId: string; skins: Record<string, SkinDescriptor> }
interface Loaded { readonly descriptor: SkinDescriptor; readonly manifest: SkinManifest; readonly closure: readonly string[] }

/** Owns the registry file and the installed pack directory. One live backend owns writes. */
export class SkinStore implements SkinManagement {
  readonly kind = 'skins' as const;
  onActivate?: (manifest: SkinManifest, routes: ReadonlyMap<string, SkinRoute>) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly loaded = new Map<string, Loaded>();
  private builtin!: Loaded;
  private builtinRoot:string|null=null;
  private constructor(readonly file: string, readonly packs: string, readonly desktop: string, private registry: Imported) {}

  static async open(file: string, packs: string, desktop: string): Promise<SkinStore> {
    const target = resolve(file), directory = resolve(packs), rig = resolve(desktop);
    let registry: Imported;
    try {
      const parsed = JSON.parse(await readFile(target, 'utf8')) as Imported;
      if (parsed?.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0
        || typeof parsed.activeSkinId !== 'string' || !parsed.skins || typeof parsed.skins !== 'object' || Array.isArray(parsed.skins)) throw new Error('invalid');
      for (const [id, skin] of Object.entries(parsed.skins))
        if (!ID.test(id) || skin.skinId !== id || !HASH.test(skin.modelFingerprint) || !HASH.test(skin.assetFingerprint)) throw new Error('invalid');
      registry = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ManagementError('unavailable', '已保存的模型包登记无效，请重新导入模型包。');
      registry = { schemaVersion: 1, revision: 0, activeSkinId: BUILT_IN_SKIN_ID, skins: {} };
    }
    const store = new SkinStore(target, directory, rig, registry);
    // Re-validate every registered pack so a pack whose bytes changed or disappeared on disk cannot
    // stay selectable. Only a pack that still passes is cached and listed.
    for (const id of Object.keys(registry.skins)) {
      const restored = await store.load(id).catch(() => null);
      if (restored && restored.descriptor.modelFingerprint === registry.skins[id]!.modelFingerprint) store.loaded.set(id, restored);
      else delete registry.skins[id];
    }
    if(!existsSync(resolve(rig,'assets/local-model'))){store.builtinRoot=resolve(rig,'assets/allmind');process.stderr.write('ALLMIND: 未配置私人默认模型，使用随包静态标志；可在角色页面导入立绘。\n');}
    store.builtin = await store.load(BUILT_IN_SKIN_ID).catch(cause => {throw new ManagementError('unavailable','内建形象无法载入：'+String(cause));});
    if (registry.activeSkinId !== BUILT_IN_SKIN_ID && !registry.skins[registry.activeSkinId]) registry.activeSkinId = BUILT_IN_SKIN_ID;
    return store;
  }

  private packRoot(id: string) { return id === BUILT_IN_SKIN_ID ? this.builtinRoot??resolve(this.desktop, 'assets/local-model') : resolve(this.packs, id); }
  private async loadLogoBuiltin():Promise<Loaded>{
    const modelEntry='icon-256.png',file=join(this.packRoot(BUILT_IN_SKIN_ID),modelEntry),bytes=await readFile(file),fingerprint=sha256(bytes),sprite=await inspectSprite(file,{rows:1,columns:1,frameCount:1,fps:1});
    const capabilities:SkinCapabilities={textures:1,expressions:0,motions:0,presets:'generated-disabled',automaticPresets:0,mocVersion:0};
    const descriptor:SkinDescriptor={skinId:BUILT_IN_SKIN_ID,type:'sprite',sprite,label:'ALLMIND 标志（可导入角色立绘）',origin:'builtin',modelEntry,modelFingerprint:fingerprint,assetFingerprint:fingerprint,parameters:DEFAULT_PARAMETERS,capabilities,importedAt:'',bytes:bytes.length};
    return{descriptor,manifest:{...descriptor,schemaVersion:1,catalog:disabledCatalog(BUILT_IN_SKIN_ID,fingerprint,[],{}),revision:this.registry.revision},closure:[modelEntry]};
  }

  /**
   * Read one pack from disk and validate every byte it references. Nothing is cached until the whole
   * pack passes, so a failure can never leave a half-registered skin behind.
   */
  private async load(id: string, overrideRoot?: string): Promise<Loaded> {
    if(id===BUILT_IN_SKIN_ID&&this.builtinRoot)return this.loadLogoBuiltin();
    if (id !== BUILT_IN_SKIN_ID && !ID.test(id)) return fail('模型包标识无效。');
    const base = await realpath(overrideRoot ?? this.packRoot(id)).catch(() => fail('模型包目录不存在。', 'not_found'));
    if (!(await stat(base)).isDirectory()) return fail('模型包必须是一个目录。');
    const entry = id === BUILT_IN_SKIN_ID ? 'pet.model3.json' : this.registry.skins[id]?.modelEntry ?? 'pet.model3.json';
    if (this.registry.skins[id]?.type === 'sprite') {
      const known = this.registry.skins[id]!;
      referencePath(entry, 'image');
      if (!/\.(png|webp)$/i.test(entry)) return fail('精灵图只支持 PNG/WebP。');
      const local = join(base, entry), info = await lstat(local);
      if (!info.isFile() || info.isSymbolicLink() || isOutside(base, await realpath(local))) return fail('图片引用超出资源目录。');
      if (info.size > MAX_BYTES) return fail('图片体积超出上限。');
      const sprite = await inspectSprite(local, known.sprite), hash = sha256(await readFile(local));
      const descriptor: SkinDescriptor = { ...known, sprite, bytes: info.size, modelFingerprint: hash, assetFingerprint: hash };
      // DUX-02: only the clips the manifest actually declares become preview options — a stateless
      // atlas stays a single static option and never grows fake happy/sleeping states.
      const clips = Object.entries(sprite.clips ?? {}).map(([state, clip]) => ({
        id: state, label: SPRITE_CLIP_LABELS[state] ?? state }));
      const catalog = disabledCatalog(id, hash, [], {}, clips);
      const manifest:SkinManifest={ ...descriptor, schemaVersion: 1, catalog, revision: this.registry.revision };
      resolveLocalPetSlot(manifest.localInteractions??null,manifest,'petting');
      return { descriptor, manifest, closure: [entry] };
    }
    if (!MODEL_ENTRY.test(entry)) return fail('入口模型文件必须是包内的 model3.json 相对路径。');
    const manifestPath = await realpath(join(base, entry)).catch(() => fail('模型包缺少入口模型文件 ' + entry + '。'));
    if (isOutside(base, manifestPath)) return fail('入口模型文件超出模型包目录。');
    const parsed = parseManifest(entry, await readFile(manifestPath, 'utf8'));
    // A reviewed catalog is a pack file even though model3.json never references it. When it exists
    // it joins the closure, so it is hashed, routed and validated together with the rest of the pack.
    const hasCatalog = await lstat(join(base, 'presets.json')).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false);
    const references: References = hasCatalog ? { ...parsed, closure: [...new Set([...parsed.closure, 'presets.json'])].sort() } : parsed;
    const digests = new Map<string, string>();
    let bytes = 0;
    for (const path of references.closure) {
      const local = join(base, path);
      const info = await lstat(local).catch(() => fail('模型包缺少引用的资源：' + path));
      if (info.isSymbolicLink()) return fail('模型包内不允许符号链接。');
      if (!info.isFile()) return fail('模型引用不是普通文件：' + path);
      const actual = await realpath(local);
      if (isOutside(base, actual)) return fail('模型引用超出模型包目录。');
      const data = await readFile(actual);
      bytes += data.byteLength; if (bytes > MAX_BYTES) return fail('模型包体积超出上限。');
      digests.set(path, sha256(data));
    }
    const read = async (path: string) => readFile(join(base, path));
    const mocBytes = await read(references.moc);
    const mocVersion = mocVersionOf(mocBytes);
    // The real Cubism Core is the authority: whatever it refuses is refused here too, and its
    // parameter table is what preset/motion references are checked against.
    const moc = await inspectMoc(mocBytes, message => fail(message));
    const displayRaw = references.displayInfo ? (await read(references.displayInfo)).toString('utf8') : null;
    const declared = declaredParameters(displayRaw);
    if (!declared.size) return fail('模型缺少可核对的显示信息参数表，无法确认预设与动作引用。');
    for (const id of moc.parameterIds) declared.add(id);
    for (const expression of references.expressions) validateExpressionFile((await read(expression.file)).toString('utf8'), declared);
    for (const files of Object.values(references.motions)) for (const file of files) validateMotionFile((await read(file)).toString('utf8'), declared);
    if (references.physics) validatePhysicsFile((await read(references.physics)).toString('utf8'));
    if (references.userData) { try { JSON.parse((await read(references.userData)).toString('utf8')); } catch { return fail('模型附加数据不是有效 JSON。'); } }

    const modelFingerprint = sha256(references.legacy.map(path => path + '\0' + digests.get(path) + '\n').join(''));
    const assetFingerprint = sha256(references.closure.map(path => path + '\0' + digests.get(path) + '\n').join(''));
    const parameters = await readParameters(base, id === BUILT_IN_SKIN_ID ? resolve(this.desktop, 'config/parameter-map.json') : null);

    // A reviewed catalog is only usable when it is bound to these exact bytes. A pack that ships a
    // stale one is refused outright: silently swapping it for a generated directory would hide a
    // real packaging defect.
    let catalog: PresentationCatalog;
    let presetSource: SkinCapabilities['presets'] = 'generated-disabled';
    if (references.closure.includes('presets.json')) {
      const shipped = JSON.parse((await read('presets.json')).toString('utf8')) as object;
      catalog = validatePresentationCatalog({ ...shipped, modelId: id });
      if (catalog.modelFingerprint !== modelFingerprint) return fail('模型包自带的预设目录与模型字节不一致。');
      presetSource = 'authored';
    } else catalog = disabledCatalog(id, modelFingerprint, references.expressions.map(item => item.name), references.motions);

    const capabilities: SkinCapabilities = { textures: references.textures.length, expressions: references.expressions.length,
      motions: Object.values(references.motions).flat().length, presets: presetSource,
      automaticPresets: catalog.items.filter(item => item.availability === 'automatic').length, mocVersion };
    const known = this.registry.skins[id];
    const descriptor: SkinDescriptor = { type: 'live2d', skinId: id, label: known?.label ?? (id === BUILT_IN_SKIN_ID ? '内建模型' : id),
      origin: id === BUILT_IN_SKIN_ID ? 'builtin' : 'imported', modelEntry: entry, modelFingerprint, assetFingerprint, parameters,
      capabilities, importedAt: known?.importedAt ?? '', bytes, ...(known?.localInteractions?{localInteractions:known.localInteractions}:{}) };
    const localInteractions=descriptor.localInteractions;
    if(localInteractions)resolveLocalPetSlot(localInteractions,{...descriptor,schemaVersion:1,catalog,revision:this.registry.revision},'petting');
    return { descriptor, manifest: { type: 'live2d', schemaVersion: 1, skinId: id, label: descriptor.label, modelEntry: entry, modelFingerprint, assetFingerprint,
      parameters, catalog, capabilities, revision: this.registry.revision,...(localInteractions?{localInteractions}:{}) }, closure: references.closure };
  }

  list(): readonly SkinDescriptor[] { return [this.builtin.descriptor, ...[...Object.values(this.registry.skins)].map(skin => this.loaded.get(skin.skinId)?.descriptor).filter((skin): skin is SkinDescriptor => Boolean(skin))]; }
  state(): SkinState { return { schemaVersion: 1, revision: this.registry.revision, activeSkinId: this.registry.activeSkinId, skins: this.list() }; }
  active(): SkinDescriptor { return this.describe(this.registry.activeSkinId); }
  describe(id: string): SkinDescriptor {
    const loaded = id === BUILT_IN_SKIN_ID ? this.builtin : this.loaded.get(id);
    if (!loaded) return fail('没有这个模型包。', 'not_found');
    return loaded.descriptor;
  }
  catalog(skinId: string): PresentationCatalog { return this.manifest(skinId).catalog; }
  manifest(skinId: string): SkinManifest {
    const loaded = skinId === BUILT_IN_SKIN_ID ? this.builtin : this.loaded.get(skinId);
    if (!loaded) return fail('没有这个模型包。', 'not_found');
    return { ...loaded.manifest, revision: this.registry.revision };
  }
  /** Every registered asset of one skin, as a relative path to absolute file map. Never a probed path. */
  routes(skinId: string): ReadonlyMap<string, SkinRoute> {
    const routes = new Map<string, SkinRoute>();
    const loaded = skinId === BUILT_IN_SKIN_ID ? this.builtin : this.loaded.get(skinId);
    if (!loaded) return routes;
    const base = this.packRoot(skinId);
    for (const path of loaded.closure) routes.set(path, join(base, path));
    if (!loaded.closure.includes('presets.json')) routes.set('presets.json', { body: JSON.stringify(loaded.manifest.catalog), type: 'application/json' });
    routes.set('pet.skin.json', { body: JSON.stringify({ ...loaded.manifest, revision: this.registry.revision }), type: 'application/json' });
    return routes;
  }
  /** One registered asset of one skin, or null. Unsafe paths and unknown ids never resolve. */
  asset(skinId: string, path: string): string | null {
    if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || path.includes('\0') || path.startsWith('/')) return null;
    if (path.split('/').some((part: string) => !part || part === '.' || part === '..')) return null;
    const loaded = skinId === BUILT_IN_SKIN_ID ? this.builtin : this.loaded.get(skinId);
    if (!loaded) return null;
    if (!loaded.closure.includes(path) && !(path === 'presets.json' && !loaded.closure.includes('presets.json'))) return null;
    return join(this.packRoot(skinId), path);
  }

  import(source: string, input: SkinImportInput = {}): Promise<SkinState> {
    const run = this.queue.then(async () => {
      if (typeof source !== 'string' || !source.trim() || source.includes('\0')) return fail('模型包目录无效。');
      const skinId = input.skinId ?? deriveId(source);
      if (!ID.test(skinId) || skinId === BUILT_IN_SKIN_ID) return fail('模型包标识只能使用小写字母、数字和连字符。');
      if (this.registry.skins[skinId]) throw new ManagementError('version_conflict', '已经存在同名模型包，请换一个标识。');
      if (input.type !== undefined && !['live2d', 'sprite'].includes(input.type)) return fail('形象类型无效。');
      const spriteImport = input.type === 'sprite';
      const entry = spriteImport ? 'sprite' + (/\.webp$/i.test(source) ? '.webp' : '.png') : input.entry ?? 'pet.model3.json';
      if (!spriteImport && !MODEL_ENTRY.test(entry)) return fail('入口模型文件必须是包内的 model3.json 相对路径。');
      if (spriteImport && !/\.(png|webp)$/i.test(source)) return fail('精灵图只支持 PNG/WebP。');
      const sourceBase = await realpath(resolve(source)).catch(() => fail('模型包目录不存在。', 'not_found'));
      const sourceInfo = await stat(sourceBase);
      const zipImport = !spriteImport && sourceInfo.isFile() && /\.zip$/i.test(sourceBase);
      if (spriteImport ? !sourceInfo.isFile() : !zipImport && !sourceInfo.isDirectory()) return fail(spriteImport ? '图片必须是一个文件。' : '模型包必须是一个目录或 ZIP 文件。');
      const staging = resolve(this.packs, '.' + skinId + '-' + randomUUID());
      try {
        await mkdir(this.packs, { recursive: true });
        if (spriteImport) { await mkdir(staging); await cp(sourceBase, join(staging, entry)); }
        else if (zipImport) { await mkdir(staging); await extractModelArchive(sourceBase, staging); }
        else await copyPack(sourceBase, staging);
        // Validate the staged copy under the prospective id, then publish it in one rename.
        const candidate = { ...placeholder(skinId, input.label?.trim() || skinId, entry), importedAt: new Date().toISOString(), ...(spriteImport ? { type: 'sprite' as const, sprite: input.sprite as import('../contracts/skin.js').SpriteFrames } : { type: 'live2d' as const }) };
        const previousSkins = this.registry.skins;
        this.registry = { ...this.registry, skins: { ...previousSkins, [skinId]: candidate } };
        let staged: Loaded;
        try { staged = await this.load(skinId, staging); } finally { this.registry = { ...this.registry, skins: previousSkins }; }
        if(input.localInteractions!==undefined){
          resolveLocalPetSlot(input.localInteractions,staged.manifest,'petting');
          staged={...staged,descriptor:{...staged.descriptor,localInteractions:structuredClone(input.localInteractions)},manifest:{...staged.manifest,localInteractions:structuredClone(input.localInteractions)}};
        }
        const destination = resolve(this.packs, skinId);
        await rm(destination, { recursive: true, force: true });
        await rename(staging, destination);
        this.loaded.set(skinId, staged);
        await this.persist({ ...this.registry, revision: this.registry.revision + 1, skins: { ...this.registry.skins, [skinId]: staged.descriptor } });
        return this.state();
      } catch (error) { this.loaded.delete(skinId); throw error; }
      finally { await rm(staging, { recursive: true, force: true }).catch(() => {}); }
    });
    this.queue = run.catch(() => {}); return run;
  }

  activate(expectedRevision: number, skinId: string): Promise<SkinState> {
    const run = this.queue.then(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.registry.revision) throw new ManagementError('version_conflict', '模型包登记已更新，请刷新后重试。');
      if (skinId !== BUILT_IN_SKIN_ID && !this.registry.skins[skinId]) return fail('没有这个模型包。', 'not_found');
      const loaded = await this.load(skinId);
      if (skinId === BUILT_IN_SKIN_ID) this.builtin = loaded; else this.loaded.set(skinId, loaded);
      const oldId = this.registry.activeSkinId;
      await this.onActivate?.({ ...loaded.manifest, revision: this.registry.revision + 1 }, this.routes(skinId));
      try { await this.persist({ ...this.registry, revision: this.registry.revision + 1, activeSkinId: skinId,
        skins: skinId === BUILT_IN_SKIN_ID ? this.registry.skins : { ...this.registry.skins, [skinId]: loaded.descriptor } }); }
      catch (error) { await this.onActivate?.(this.manifest(oldId), this.routes(oldId)); throw error; }
      return this.state();
    });
    this.queue = run.catch(() => {}); return run;
  }

  remove(expectedRevision: number, skinId: string): Promise<SkinState> {
    const run = this.queue.then(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.registry.revision) throw new ManagementError('version_conflict', '模型包登记已更新，请刷新后重试。');
      if (skinId === BUILT_IN_SKIN_ID) return fail('内建模型不能删除。');
      if (!this.registry.skins[skinId]) return fail('没有这个模型包。', 'not_found');
      if (this.registry.activeSkinId === skinId) return fail('请先切换到其它模型包再删除。');
      const skins = { ...this.registry.skins }; delete skins[skinId];
      await this.persist({ ...this.registry, revision: this.registry.revision + 1, skins });
      this.loaded.delete(skinId);
      await rm(resolve(this.packs, skinId), { recursive: true, force: true }).catch(() => {});
      return this.state();
    });
    this.queue = run.catch(() => {}); return run;
  }

  private async persist(next: Imported) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.next';
    try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    this.registry = next;
  }
  async drain() { await this.queue; }
}

function placeholder(skinId: string, label: string, entry: string): SkinDescriptor {
  return { skinId, label, origin: 'imported', modelEntry: entry, modelFingerprint: '0'.repeat(64), assetFingerprint: '0'.repeat(64),
    parameters: DEFAULT_PARAMETERS, capabilities: { textures: 0, expressions: 0, motions: 0, presets: 'generated-disabled', automaticPresets: 0, mocVersion: 0 },
    importedAt: '', bytes: 0 };
}
/** Derive a stable, legal skin id from a directory name without trusting its characters. */
export function deriveId(source: string): string {
  const base = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug.length >= 2 ? slug : 'skin-' + sha256(base).slice(0, 10);
}
