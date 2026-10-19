// One isolated, silent rig per canvas. The management host supplies only its
// fixed same-origin asset/shader routes and loads the official Core first.
import catalog from './assets/local-model/presets.json';
import { SpriteRenderer } from './sprite-renderer.mjs';
import { CHARACTER_STATES, CharacterStateMachine } from '../contracts/character-state.ts';

/** Registered resources use authenticated byte reads; no session token is placed in a URL. */
export async function createSkinPreview({ canvas, manifest, assetBase, shaderBase, readAsset }) {
  if (manifest.type !== 'sprite') {
    for (let attempt = 0; ; attempt++) {
      try { globalThis.Live2DCubismCore.Version.csmGetVersion(); break; }
      catch (error) { if (attempt >= 100) throw new Error('角色预览组件尚未就绪', { cause: error }); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
  }
  const Renderer = manifest.type === 'sprite' ? SpriteRenderer : (await import('./cubism-renderer.mjs')).JellyfishRenderer;
  const renderer = new Renderer(canvas, () => {}, { assetBase, shaderBase, readAsset });
  let frame = 0, disposed = false;
  /**
   * CUX-02: the pending capture request, settled from INSIDE the drawing task.
   *
   * Why it must be here and not in a caller-side `setTimeout`: the WebGL context is created WITHOUT
   * `preserveDrawingBuffer` (deliberately — enabling it costs desktop performance), so the drawing
   * buffer is cleared as soon as the task that drew it yields to the compositor. Copying the canvas
   * synchronously after `renderer.updateView(...)` in this same task is the only reliable read.
   */
  let capture = null;
  /** Settle a pending capture as a failure (timeout, cancel, supersede, dispose) and release its listeners. */
  function failCapture(pending, error) {
    if (capture === pending) capture = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    pending.reject(error);
  }
  function settleCapture() {
    if (!capture || !renderer.ready) return;
    const pending = capture; capture = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    try {
      const width = Math.max(1, canvas.width), height = Math.max(1, canvas.height);
      const out = document.createElement('canvas'); out.width = pending.size; out.height = pending.size;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('无法创建头像画布。');
      // Full-body contain on a transparent ground; never crop the character.
      const scale = Math.min(pending.size / width, pending.size / height);
      const dw = Math.max(1, Math.round(width * scale)), dh = Math.max(1, Math.round(height * scale));
      ctx.drawImage(canvas, 0, 0, width, height, Math.round((pending.size - dw) / 2), Math.round((pending.size - dh) / 2), dw, dh);
      out.toBlob(blob => { blob ? pending.resolve(blob) : pending.reject(new Error('头像编码失败。')); }, 'image/png');
    } catch (error) { pending.reject(error); }
  }
  try {
    renderer.bindSkin(manifest); await renderer.load(); renderer.setFraming('full');
    const view = { state: 'idle', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
    const states = new CharacterStateMachine();
    function tick() {
      if (disposed) return;
      view.mouth = view.state === 'speaking' ? .25 + .2 * Math.sin(performance.now() / 100) : 0;
      renderer.updateView({ ...view, characterState: states.update(view) });
      // Same drawing task: copy before the compositor can clear the buffer.
      settleCapture();
      frame = requestAnimationFrame(tick);
    }
    tick();
    /**
     * DUX-02: the pack's OWN action/expression directory, derived from the validated manifest
     * catalog (skin-store enumerates every expression and every motion group/index; sprite clips
     * come from the declared clips). Labels keep the authored catalog's id/label; availability and
     * reason travel through so a missing real reference is shown, never guessed.
     */
    const previewOptions = () => (manifest.catalog?.items ?? []).map(item => ({
      id: item.id, label: item.label,
      kind: item.category === 'expression' ? 'expression'
        : item.source === 'model-motion' ? (manifest.type === 'sprite' ? 'clip' : 'motion')
        : 'static',
      source: item.source, available: item.previewable && item.availability !== 'unavailable',
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.expressionName ? { expressionName: item.expressionName } : {}),
      ...(item.motionGroup !== undefined ? { motionGroup: item.motionGroup } : {}),
      ...(item.motionIndex !== undefined ? { motionIndex: item.motionIndex } : {}),
      ...(manifest.type === 'sprite' && item.id.startsWith('skin-clip-') ? { clipId: item.id.slice('skin-clip-'.length) } : {}),
    }));
    return {
      setState(state) { if (!CHARACTER_STATES.includes(state)) throw Error('角色状态无效。'); view.state = state; },
      snapshot() { return renderer.snapshot(); },
      getPreviewOptions() { return previewOptions(); },
      async selectPreviewOption(id) {
        if (disposed) throw Error('预览已关闭。');
        if (typeof id !== 'string' || !manifest.catalog?.items?.some(item => item.id === id)) throw Error('这个预览选项不存在。');
        await renderer.selectPreset(id);
        // A chosen option keeps playing on its own: freeze the runtime state machine so the
        // selection is not overridden by the idle drive on the next frame.
        view.state = 'idle'; view.mouth = 0;
      },
      resetPreview() {
        if (disposed) throw Error('预览已关闭。');
        renderer.stopPreview?.();
        view.state = 'idle';
      },
      /**
       * CUX-02: encode the first valid idle frame as a PNG at `size`×`size`.
       *
       * Deliberately NOT built on `snapshot()` (a diagnostic object, never pixels) and NOT on a fixed
       * `sleep` followed by a WebGL read (the buffer may already be gone). Cancel, supersede and timeout
       * all reject and leave nothing pending. The existing RAF loop settles this on its next frame, so
       * no second animation loop is created.
       */
      captureFrame({ signal, size = 256 } = {}) {
        if (disposed) return Promise.reject(new Error('预览已关闭。'));
        if (signal?.aborted) return Promise.reject(new Error('头像生成已取消。'));
        // Only one capture is ever in flight; a superseded request must fail rather than hang.
        if (capture) failCapture(capture, new Error('头像生成已取消。'));
        return new Promise((resolve, reject) => {
          const pending = { size: Math.max(1, Math.round(size)), resolve, reject, signal, timer: 0, onAbort: null };
          pending.onAbort = () => failCapture(pending, new Error('头像生成已取消。'));
          pending.timer = setTimeout(() => failCapture(pending, new Error('头像生成超时。')), 30000);
          signal?.addEventListener('abort', pending.onAbort, { once: true });
          capture = pending;
        });
      },
      dispose() {
        if (disposed) return;
        disposed = true; cancelAnimationFrame(frame);
        if (capture) failCapture(capture, new Error('预览已关闭。'));
        renderer.dispose();
      },
    };
  } catch (error) { renderer.dispose(); throw error; }
}
const instances = new WeakMap();
export async function createPresentationPreview({ canvas, onStatus = () => {}, assetBase, shaderBase }) {
  if (!canvas?.getContext) throw new Error('预览画布不可用');
  if (instances.has(canvas)) return instances.get(canvas);
  const pending = initialize(); instances.set(canvas, pending);
  try { return await pending; } catch (error) { instances.delete(canvas); throw error; }

  async function initialize() {
    let renderer, frame = 0, disposed = false, playing = false, settleUntil = 0;
    const status = (state, message, presetId = null) => onStatus({ state, message, presetId });
    const route = value => {
      const url = new URL(value, location.href);
      if (!value || url.origin !== location.origin || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) throw new Error('预览资源地址不可用');
      return url.href;
    };
    try {
      const options = { assetBase: route(assetBase), shaderBase: route(shaderBase) };
      status('loading', '正在加载角色…');
      for (let attempt = 0; ; attempt++) {
        try { globalThis.Live2DCubismCore.Version.csmGetVersion(); break; }
        catch { if (attempt >= 100) throw new Error('角色预览组件尚未就绪'); await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      const { JellyfishRenderer } = await import('./cubism-renderer.mjs');
      renderer = new JellyfishRenderer(canvas, () => {}, options); await renderer.load(); renderer.stopPreview();
      const view = { state:'idle', mouth:0, expression:{ emotion:'neutral', intensity:0, delivery:'', gesture:null } };
      function tick(at) {
        frame = 0; if (disposed) return;
        try { renderer.updateView(view); }
        catch { disposed = true; renderer.dispose(); instances.delete(canvas); status('error', '角色预览暂时不可用'); return; }
        if (playing || at < settleUntil) frame = requestAnimationFrame(tick);
      }
      function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(tick); }
      const api = {
        select(id) {
          if (disposed) throw new Error('预览已关闭');
          renderer.selectPreset(id);
          const category = catalog.items.find(item => item.id === id).category;
          renderer.setFraming(category === 'expression' || category === 'pose' ? 'half' : 'full');
          playing = true; schedule(); status('playing', '正在预览', id);
        },
        stop() {
          if (disposed) return;
          renderer.stopPreview(); playing = false; settleUntil = performance.now() + 1500; schedule(); status('stopped', '预览已停止');
        },
        restore() {
          if (disposed) return;
          renderer.restorePreview(); playing = false; settleUntil = performance.now() + 1500; schedule(); status('restored', '已恢复原样');
        },
        resize() { if (!disposed) { renderer.syncViewport(); schedule(); } },
        dispose() {
          if (disposed) return;
          disposed = true; cancelAnimationFrame(frame); frame = 0; renderer.dispose(); instances.delete(canvas); status('disposed', '预览已关闭');
        }
      };
      settleUntil = performance.now() + 1500; schedule(); status('ready', '选择一个预设查看效果'); return api;
    } catch (error) { cancelAnimationFrame(frame); renderer?.dispose(); status('error', '角色预览暂时不可用'); throw error; }
  }
}
