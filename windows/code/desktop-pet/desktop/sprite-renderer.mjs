import { resolveCharacterState } from '../contracts/character-state.ts';
import { portraitPlacement } from './portrait-geometry.ts';
export class SpriteRenderer {
  constructor(canvas, report = () => {}, options = {}) { this.canvas = canvas; this.report = report; this.options = options; this.disposed = false; }
  bindSkin(manifest) { this.skin = manifest; }
  async load() {
    if (this.skin?.type !== 'sprite' || !this.skin.sprite) throw Error('精灵图配置缺失');
    const image = new Image();
    const imageUrl = this.options.readAsset ? URL.createObjectURL(new Blob([await this.options.readAsset(this.skin.modelEntry)])) : new URL(this.skin.modelEntry, this.options.assetBase).href;
    image.src = imageUrl; try { await image.decode(); } finally { if (this.options.readAsset) URL.revokeObjectURL(imageUrl); }
    const { rows, columns, frameCount, fps, width, height } = this.skin.sprite;
    if (image.naturalWidth !== width || image.naturalHeight !== height || !Number.isInteger(rows) || !Number.isInteger(columns)
      || rows < 1 || columns < 1 || !Number.isInteger(frameCount) || frameCount < 1 || frameCount > rows * columns || !Number.isFinite(fps) || fps <= 0 || fps > 120
      || width % columns || height % rows) throw Error('精灵图帧配置与图片不符');
    if (this.disposed) { image.src = ''; throw Error('形象加载已取消'); }
    this.image = image; this.context = this.canvas.getContext('2d');
    if (!this.context) throw Error('无法启用 Canvas');
    this.started = performance.now(); this.ready = true; this.updateView();
    this.report({ type: 'model-loaded', skinId: this.skin.skinId, runtime: 'SpriteCanvas', frames: frameCount });
  }
  updateView(view = { state: 'idle' }, interactionState = view.state, workFocus = false) {
    if (!this.ready || this.disposed) return;
    const canvas = this.canvas, ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const state = view.characterState ?? resolveCharacterState(view, interactionState, workFocus);
    if (state !== this.characterState) { this.characterState = state; this.started = performance.now(); }
    const config = this.skin.sprite;
    // DUX-02: an explicit preview selection wins over the runtime state so the canvas plays the
    // chosen clip; without one the runtime state drives playback exactly as before.
    const clip = this.previewClip ? config.clips?.[this.previewClip] : this.interactionClip ? config.clips?.[this.interactionClip] : config.clips?.[state] ?? config.clips?.idle;
    const frame = (clip?.start ?? 0) + Math.floor((performance.now() - this.started) / 1000 * (clip?.fps ?? config.fps)) % (clip?.frameCount ?? config.frameCount);
    const fw = config.width / config.columns, fh = config.height / config.rows;
    const cssWidth = Math.max(1, canvas.clientWidth), cssHeight = Math.max(1, canvas.clientHeight);
    const framing = this.framing === 'bust' || config.framing === 'bust' ? 'bust' : 'full';
    const placement = portraitPlacement({ width: cssWidth, height: cssHeight }, { width: fw, height: fh }, config.contentBounds, framing);
    const sx = frame % config.columns * fw, sy = Math.floor(frame / config.columns) * fh;
    this.context.clearRect(0, 0, width, height);
    this.context.drawImage(this.image, sx + placement.source.x, sy + placement.source.y, placement.source.width, placement.source.height, placement.dest.x * ratio, placement.dest.y * ratio, placement.dest.width * ratio, placement.dest.height * ratio);
    this.hit = placement.contentDest;
    this.placement=placement;this.drawnFraming=framing;
    this.frame = frame;
  }
  interactiveRect() {
    if (!this.hit) return null;
    const box = this.canvas.getBoundingClientRect();
    return { x: box.left + this.hit.x, y: box.top + this.hit.y, width: this.hit.width, height: this.hit.height };
  }
  setFraming(value) { this.framing = value === 'half' ? 'bust' : value; }
  setAutomaticPolicy() { return true; }
  /**
   * DUX-02: preview ONE declared clip by its state id. Only clips the manifest actually declares are
   * addressable; anything else is a real error, never a silent fallback to the atlas default.
   * The selection persists until `stopPreview()`/`reset()` so the canvas keeps playing that clip.
   */
  selectPreset(id) {
    const clip = this.skin?.sprite?.clips?.[id];
    if (!this.ready || !clip) throw new Error('这个动作片段暂时不能预览');
    this.previewClip = id; this.started = performance.now();
    return true;
  }
  stopPreview() { if (!this.ready) return; this.previewClip = null; this.started = performance.now(); }
  async startInteraction(id){if(!this.ready||this.disposed||!this.skin?.sprite?.clips?.[id])throw Error('当前资源没有该互动片段。');this.interactionClip=id;this.started=performance.now();return true;}
  stopInteraction(){this.interactionClip=null;this.started=performance.now();}
  reset() { this.previewClip = null; this.started = performance.now(); }
  snapshot() { return { skinId: this.skin?.skinId, characterState: this.characterState ?? 'idle', frame: this.frame ?? 0, runtime: 'SpriteCanvas',interactionTarget:this.interactionClip??null,framing:this.drawnFraming,placement:this.placement,interactiveRect:this.interactiveRect() }; }
  stroke() { return null; }
  dispose() { this.disposed = true; this.ready = false; if (this.image) this.image.src = ''; this.image = null; this.context?.clearRect(0, 0, this.canvas.width, this.canvas.height); }
}
