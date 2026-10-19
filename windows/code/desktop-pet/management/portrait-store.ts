import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open } from 'node:fs/promises';
import { replaceResourceFile } from '../memory/resource-atomic-replace.js';
import { dirname } from 'node:path';
import { BookError } from '../contracts/memory-book.js';
import type { PortraitSet, PortraitVariant } from '../contracts/portraits.js';
import type { SkinManagement } from '../contracts/skin.js';

interface PortraitFile { schemaVersion: 'allmind-portraits/v1'; characters: Record<string, PortraitSet>; operations: { id: string; fingerprint: string; characterId: string }[] }
const empty = (characterId: string): PortraitSet => ({ schemaVersion: 'allmind-portraits/v1', characterId, revision: 0, variants: [], selectedVariantId: null, fallbackSkinId: null, framing: 'full' });

export class PortraitStore {
  private queue: Promise<unknown> = Promise.resolve();
  onChange?: (next:PortraitSet)=>Promise<void>;
  private constructor(private readonly file: string, private readonly skins: SkinManagement, private data: PortraitFile) {}
  static async open(file: string, skins: SkinManagement): Promise<PortraitStore> {
    let data: PortraitFile = { schemaVersion: 'allmind-portraits/v1', characters: {}, operations: [] };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as PortraitFile;
      if (parsed?.schemaVersion !== 'allmind-portraits/v1' || !parsed.characters || !Array.isArray(parsed.operations)) throw new Error('invalid');
      data = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BookError('corrupt_data', '立绘集合文件无法读取。'); }
    return new PortraitStore(file, skins, data);
  }
  get(characterId: string): PortraitSet { return structuredClone(this.data.characters[characterId] ?? empty(characterId)); }
  list(): PortraitSet[] { return Object.values(this.data.characters).map(set => structuredClone(set)); }

  add(input: { characterId: string; name: string; file: string; origin: PortraitVariant['origin']; generationId?: string; operationId: string; expectedRevision: number; currentSkinId: string | null;contentHash?:string }): Promise<PortraitSet> {
    const fingerprint = createHash('sha256').update(JSON.stringify({ characterId: input.characterId, content: input.contentHash??input.file, name: input.name, origin: input.origin, generationId: input.generationId ?? null })).digest('hex');
    return this.enqueue(input.characterId, input.operationId, input.expectedRevision, fingerprint, async set => {
      const skinId = `pt${createHash('sha256').update(input.operationId + fingerprint).digest('hex').slice(0, 20)}`;
      if (set.variants.some(variant => variant.skinId === skinId)) return set;
      await this.skins.import(input.file, { skinId, label: input.name.trim() || '静态立绘', type: 'sprite', sprite: { rows: 1, columns: 1, frameCount: 1, fps: 1, framing: set.framing } });
      const skin = this.skins.list().find(item => item.skinId === skinId);
      if (!skin?.assetFingerprint) throw new BookError('unavailable', '立绘已导入但没有资产指纹。');
      const variant: PortraitVariant = { id: `pv-${randomUUID()}`, name: input.name.trim() || `立绘 ${set.variants.length + 1}`, skinId, assetFingerprint: skin.assetFingerprint, origin: input.origin, ...(input.generationId ? { generationId: input.generationId } : {}) };
      const next: PortraitSet = { ...set, revision: set.revision + 1, variants: [...set.variants, variant], selectedVariantId: set.selectedVariantId, fallbackSkinId: set.fallbackSkinId ?? (input.currentSkinId && input.currentSkinId !== skinId ? input.currentSkinId : null) };
      return next;
    });
  }

  rename(characterId: string, variantId: string, name: string, expectedRevision: number, operationId: string): Promise<PortraitSet> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) return Promise.reject(new BookError('invalid_input', '差分名称无效。'));
    const fingerprint = createHash('sha256').update(JSON.stringify({ op: 'rename', variantId, name: name.trim() })).digest('hex');
    return this.enqueue(characterId, operationId, expectedRevision, fingerprint, async set => {
      const variant = set.variants.find(item => item.id === variantId);
      if (!variant) throw new BookError('not_found', '没有这个差分。');
      return { ...set, revision: set.revision + 1, variants: set.variants.map(item => item.id === variantId ? { ...item, name: name.trim() } : item) };
    });
  }

  select(characterId: string, variantId: string | null, expectedRevision: number, operationId: string): Promise<PortraitSet> {
    const fingerprint = createHash('sha256').update(JSON.stringify({ op: 'select', variantId })).digest('hex');
    return this.enqueue(characterId, operationId, expectedRevision, fingerprint, async set => {
      if (variantId !== null && !set.variants.some(item => item.id === variantId)) throw new BookError('not_found', '没有这个差分。');
      return { ...set, revision: set.revision + 1, selectedVariantId: variantId };
    });
  }

  setFraming(characterId: string, framing: 'full' | 'bust', expectedRevision: number, operationId: string): Promise<PortraitSet> {
    if (framing !== 'full' && framing !== 'bust') return Promise.reject(new BookError('invalid_input', '立绘取景无效。'));
    const fingerprint = createHash('sha256').update(JSON.stringify({ op: 'frame', framing })).digest('hex');
    return this.enqueue(characterId, operationId, expectedRevision, fingerprint, async set => ({ ...set, revision: set.revision + 1, framing }));
  }

  bindState(characterId: string, state: 'neutral' | 'happy' | 'sad' | 'angry', variantId: string | null, expectedRevision: number, operationId: string): Promise<PortraitSet> {
    if (!['neutral', 'happy', 'sad', 'angry'].includes(state)) return Promise.reject(new BookError('invalid_input', '差分状态无效。'));
    const fingerprint = createHash('sha256').update(JSON.stringify({ op: 'bind', state, variantId })).digest('hex');
    return this.enqueue(characterId, operationId, expectedRevision, fingerprint, async set => {
      if (variantId && !set.variants.some(item => item.id === variantId)) throw new BookError('not_found', '没有这个差分。');
      const stateBindings = { ...set.stateBindings };
      if (variantId) stateBindings[state] = variantId; else delete stateBindings[state];
      return { ...set, revision: set.revision + 1, stateBindings };
    });
  }

  async remove(characterId: string, variantId: string, expectedRevision: number, operationId: string): Promise<PortraitSet> {
    const fingerprint = createHash('sha256').update(JSON.stringify({ op: 'remove', variantId })).digest('hex');
    let variant:PortraitVariant|undefined;
    const removed = await this.enqueue(characterId, operationId, expectedRevision, fingerprint, async set => {
      variant=set.variants.find(item=>item.id===variantId);
      if(!variant)throw new BookError('not_found','没有这个差分。');
      const rest=set.variants.filter(item=>item.id!==variantId),stateBindings={...set.stateBindings};
      for(const state of Object.keys(stateBindings) as (keyof typeof stateBindings)[])if(stateBindings[state]===variantId)delete stateBindings[state];
      return {...set,revision:set.revision+1,variants:rest,stateBindings,selectedVariantId:set.selectedVariantId===variantId?rest[0]?.id??null:set.selectedVariantId};
    });
    if(!variant)return removed;
    const skinId=variant.skinId;
    const shared = this.list().some(set => set.characterId !== characterId && set.variants.some(item => item.skinId === skinId));
    if (!shared && this.skins.list().some(skin => skin.skinId === skinId) && this.skins.state().activeSkinId !== skinId) {
      await this.skins.remove(this.skins.state().revision, skinId);
    }
    return removed;
  }

  ownsSkin(characterId: string, skinId: string): boolean {
    return this.get(characterId).variants.some(variant => variant.skinId === skinId);
  }

  private enqueue(characterId: string, operationId: string, expectedRevision: number, fingerprint: string, change: (set: PortraitSet) => Promise<PortraitSet>): Promise<PortraitSet> {
    const run = this.queue.then(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new BookError('invalid_input', 'operationId 无效。');
      const known = this.data.operations.find(item => item.id === operationId && item.characterId===characterId);
      if (known) {
        if (known.fingerprint !== fingerprint || known.characterId !== characterId) throw new BookError('conflict', '同一操作的立绘输入已变化。');
        return this.get(characterId);
      }
      const set = this.get(characterId);
      if (set.revision !== expectedRevision) throw new BookError('conflict', '立绘集合已更新，请刷新后重试。');
      const next = await change(set);
      if(next.selectedVariantId!==set.selectedVariantId||next.framing!==set.framing){
        try{await this.onChange?.(next);}catch(error){
          try{await this.onChange?.(set);}catch(rollback){throw new BookError('unavailable','载入失败且宿主回退未确认。',{cause:new AggregateError([error,rollback])});}
          throw error;
        }
      }
      this.data.characters[characterId] = next;
      this.data.operations.push({ id: operationId, fingerprint, characterId });
      if (this.data.operations.length > 256) this.data.operations.splice(0, this.data.operations.length - 256);
      try{await this.persist();}catch(error){this.data.characters[characterId]=set;this.data.operations.pop();await this.onChange?.(set);throw error;}
      return structuredClone(next);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.next';
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(this.data)+'\n');await handle.sync();}finally{await handle.close();}
    replaceResourceFile(temporary,this.file);
  }
}
