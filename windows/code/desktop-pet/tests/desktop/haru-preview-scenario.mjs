import { createSkinPreview } from '/preview-runtime/presentation-preview.js';
const result = document.querySelector('#result');
let preview;
try {
  const canvas = document.querySelector('#preview');
  const manifest = await (await fetch('/test-manifest.json')).json();
  for (let attempt = 0; ; attempt++) {
    try { globalThis.Live2DCubismCore.Version.csmGetVersion(); break; }
    catch { if (attempt === 100) throw Error('Core not ready'); await new Promise(done => setTimeout(done, 10)); }
  }
  preview = await createSkinPreview({ canvas, manifest, assetBase: new URL('/test-assets/', location.href).href,
    shaderBase: new URL('/presentation-shaders/', location.href).href,
    readAsset: async path => { const response = await fetch('/test-assets/' + path); if (!response.ok) throw Error('asset ' + path); return new Uint8Array(await response.arrayBuffer()); } });
  const states = ['idle', 'listening', 'thinking', 'speaking', 'working', 'happy', 'sleeping', 'idle'];
  const samples = [];
  for (const state of states) {
    preview.setState(state);
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const snapshot = preview.snapshot();
    if (snapshot.characterState !== state) throw Error('wrong state ' + state);
    const gl = canvas.getContext('webgl'), bytes = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    if (!bytes.some((value, index) => index % 4 === 3 && value > 0)) throw Error('empty rendering ' + state);
    samples.push({ state, skinId: snapshot.skinId });
  }
  const resources = performance.getEntriesByType('resource').map(item => new URL(item.name).pathname);
  result.textContent = JSON.stringify({ passed: 1, states: samples, resources });
} catch (error) { result.textContent = JSON.stringify({ error: error.message }); }
finally { preview?.dispose(); result.dataset.complete = 'true'; }
