import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagementError } from '../contracts/management.js';
import type { SpriteFrames } from '../contracts/skin.js';
import { CHARACTER_STATES } from '../contracts/character-state.js';

/** Decode with the same Chromium image decoder as the Windows host before registering bytes. */
export async function inspectSprite(file: string, input: Partial<SpriteFrames> = {}): Promise<SpriteFrames> {
  const script = ['../tools/sprite-inspect.cjs', '../../tools/sprite-inspect.cjs'].map(path => new URL(path, import.meta.url)).find(existsSync);
  if (!script) throw new ManagementError('unavailable', '图片校验组件缺失。');
  let size: { width: number; height: number };
  let contentBounds: { x: number; y: number; width: number; height: number };
  let alpha: { min: number; max: number };
  const scratch = await mkdtemp(join(tmpdir(), 'aika-image-result-')), resultFile = join(scratch, 'result.json');
  try {
    const executable = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise<number | null>((resolve, reject) => {
      // Chromium grandchildren can retain inherited stdout pipes after the main process exits.
      // This helper has no output pipes; its private result file and exit are separate authorities.
      const child = spawn(executable, [fileURLToPath(script), file, resultFile], { windowsHide: true, env, stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(Error('图片校验进程超时')); }, 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', value => { clearTimeout(timer); resolve(value); });
    });
    const result = JSON.parse(await readFile(resultFile, 'utf8')) as { size?: typeof size; alpha?: { min: number; max: number; bounds: { x: number; y: number; width: number; height: number } }; error?: string };
    if (code !== 0 || !result.size || !result.alpha?.bounds || !Number.isInteger(result.alpha.min) || !Number.isInteger(result.alpha.max)) throw Error(result.error || '图片校验进程未正常退出');
    size = result.size;
    contentBounds = result.alpha.bounds;
    alpha = { min: result.alpha.min, max: result.alpha.max };
  } catch (error) { throw new ManagementError('invalid_request', `图片无法解码：${error instanceof Error ? error.message : String(error)}`); }
  finally { await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  const rows = input.rows ?? 1, columns = input.columns ?? 1, frameCount = input.frameCount ?? rows * columns, fps = input.fps ?? 12;
  if (![rows, columns, frameCount].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)
    || frameCount > rows * columns || !Number.isFinite(fps) || fps <= 0 || fps > 120
    || !size.width || !size.height || size.width > 16384 || size.height > 16384
    || size.width % columns || size.height % rows) throw new ManagementError('invalid_request', '图集行列、有效帧数或 FPS 无效；图片尺寸必须能被行列整除。');
  if (input.clips) for (const [state, clip] of Object.entries(input.clips)) {
    if (!CHARACTER_STATES.includes(state as never) || !clip || !Number.isSafeInteger(clip.start) || clip.start < 0
      || !Number.isSafeInteger(clip.frameCount) || clip.frameCount < 1 || clip.start + clip.frameCount > frameCount
      || (clip.fps !== undefined && (!Number.isFinite(clip.fps) || clip.fps <= 0 || clip.fps > 120))) throw new ManagementError('invalid_request', '角色状态动画帧范围或 FPS 无效。');
  }
  return { rows, columns, frameCount, fps, width: size.width, height: size.height, contentBounds, alpha, ...(input.clips ? { clips: input.clips } : {}), ...(input.framing === 'full' || input.framing === 'bust' ? { framing: input.framing } : {}) };
}
