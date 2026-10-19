// CUX-01: 已登记形象资源的共享预览生命周期。
//
// 为什么单独成模块：形象页（`AppearancePanel`）、资源导入弹窗（`AppearanceResources`）和后续的
// 立绘头像（CUX-02）都要创建同一个预览引擎。把创建/释放集中在这里，才能保证：
//   * Live2D Core 只加载一次，且加载失败后**允许重试**（不保留永久 rejected promise）；
//   * 每个引擎由创建者成对释放（abort 请求 + dispose 引擎 + 取消 RAF + revoke Object URL）；
//   * 晚到的异步创建结果必须被 dispose，绝不覆盖到新画布上。
//
// 安全边界：资产一律经 `runtime.request` 鉴权读取（字节），不把 token 拼进 URL，也不新增任意文件路径能力。
import { runtime } from './runtime'

/** 七个角色状态，与 `contracts/character-state.ts` 的 CHARACTER_STATES 一致。 */
export const PREVIEW_STATES = ['idle', 'listening', 'thinking', 'speaking', 'working', 'happy', 'sleeping'] as const
export type PreviewState = typeof PREVIEW_STATES[number]

/** 状态标签，供 UI 复用（不重复散落在各组件里）。 */
export const PREVIEW_STATE_LABELS: Record<PreviewState, string> = {
  idle: '待机', listening: '倾听', thinking: '思考', speaking: '说话', working: '工作', happy: '开心', sleeping: '睡眠',
}

/** `createSkinPreview` 返回的引擎形状（诊断 `snapshot()` 不是图片；`captureFrame` 才是图片接口）。 */
export interface SkinPreviewEngine {
  setState(state: string): void
  snapshot(): unknown
  dispose(): void
}

/** DUX-02 契约的 PreviewOption（由 preview 引擎的 getPreviewOptions 提供，只读形状）。 */
export interface SkinPreviewOption {
  id: string; label: string; kind: 'expression' | 'motion' | 'clip' | 'static'; source: string;
  available: boolean; reason?: string; expressionName?: string; motionGroup?: string; motionIndex?: number; clipId?: string
}

/** 一次预览的句柄：`dispose()` 幂等，且释放引擎与它发出的全部请求。 */
export interface SkinPreviewHandle {
  setState(state: string): void
  /** 诊断对象（skinId / 状态 / 帧等），**不是图片**。 */
  snapshot(): unknown
  /**
   * DUX-02：模型包**自身**的动作/表情目录。
   * Live2D 为全部 expression + 全部 motion group/index；Sprite 为已声明 clips；静态资源为单项/空。
   * 可选：旧构建的 preview bundle 没有它时 UI 隐藏下拉，而不是崩溃。
   */
  getPreviewOptions?(): SkinPreviewOption[]
  /** DUX-02：选择一个包内选项，只在本预览引擎内播放；未知/不可用 id 拒绝。可选，同上。 */
  selectPreviewOption?(id: string): Promise<void>
  /** DUX-02：复位到默认预览（停止已选动作/表情）。可选，同上。 */
  resetPreview?(): void
  /**
   * CUX-02：把首个有效 idle 帧编码成 `size`×`size` PNG。
   *
   * 由 `desktop/presentation-preview.mjs` 在**同一绘制任务内**拷贝画布实现（WebGL 上下文没有开
   * `preserveDrawingBuffer`，离开该任务后缓冲区可能已被清空）。取消/超时/释放都会显式失败并清理。
   */
  captureFrame(options?: { signal?: AbortSignal; size?: number }): Promise<Blob>
  dispose(): void
}

export interface OpenSkinPreviewInput {
  canvas: HTMLCanvasElement | null | undefined
  skinId: string
  /** 取消信号：组件卸载时 abort，创建中途的请求与引擎都会被释放。 */
  signal?: AbortSignal
}

let corePromise: Promise<void> | undefined

/**
 * 加载 Live2D Cubism Core。
 *
 * 失败时**清空缓存**，下一次调用重新插入 `<script>`：加载失败是可重试的，不是永久拒绝。
 */
export function loadPreviewCore(): Promise<void> {
  if ((globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore) return Promise.resolve()
  return corePromise ||= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/presentation-runtime/core.js'
    script.onload = () => resolve()
    script.onerror = () => { script.remove(); corePromise = undefined; reject(Error('Live2D 预览组件加载失败')) }
    document.head.append(script)
  })
}

/** 资产基址；一律经管理会话鉴权读取，绝不把 token 放进 URL。 */
export const skinAssetBase = (skinId: string): string => `/api/skins/${encodeURIComponent(skinId)}/asset/`

/**
 * 打开一个资源预览。
 *
 * 返回的句柄拥有引擎与它发出的全部请求；`dispose()` 幂等。创建中途取消或失败时，已建立的引擎
 * 与已发出的请求都会被释放，调用方拿到的是一个已清理的异常，而不是泄漏的引擎。
 */
export async function openSkinPreview({ canvas, skinId, signal }: OpenSkinPreviewInput): Promise<SkinPreviewHandle> {
  if (!canvas) throw Error('预览画布不可用。')
  if (!skinId) throw Error('请先选择形象资源。')
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  const base = skinAssetBase(skinId)
  let engine: SkinPreviewEngine | undefined
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    controller.abort()
    engine?.dispose()
    engine = undefined
  }
  try {
    combined.throwIfAborted()
    const manifest = await runtime.request(base + 'pet.skin.json', { signal: combined })
    if (manifest?.type !== 'sprite') await loadPreviewCore()
    combined.throwIfAborted()
    // LUI-05: 共享渲染器工厂由固定同源路由提供，不属于已退役的旧控制台。
    const modulePath = '/preview-runtime/presentation-preview.js'
    const module = await import(/* @vite-ignore */ modulePath)
    combined.throwIfAborted()
    engine = await module.createSkinPreview({
      canvas,
      manifest,
      assetBase: new URL(base, location.href).href,
      shaderBase: new URL('/presentation-shaders/', location.href).href,
      readAsset: (path: string) => runtime.request(base + path.split('/').map(encodeURIComponent).join('/'), { signal: combined, responseType: 'bytes' }),
    }) as SkinPreviewEngine
    // 晚到的创建结果：句柄已被释放（或组件已卸载）时必须自己 dispose，绝不挂到画布上。
    if (disposed || combined.aborted) { engine.dispose(); engine = undefined; throw Error('预览已取消。') }
    const owned = engine as unknown as {
      setState(state: string): void; snapshot(): unknown; dispose(): void;
      captureFrame(o?: { signal?: AbortSignal; size?: number }): Promise<Blob>;
      getPreviewOptions?: () => SkinPreviewOption[];
      selectPreviewOption?: (id: string) => Promise<void>;
      resetPreview?: () => void;
    }
    return {
      setState: state => { if (!disposed) owned.setState(state) },
      snapshot: () => owned.snapshot(),
      getPreviewOptions: owned.getPreviewOptions ? () => { if (disposed) throw Error('预览已关闭。'); return owned.getPreviewOptions!() } : undefined,
      selectPreviewOption: owned.selectPreviewOption ? (id: string) => { if (disposed) return Promise.reject(Error('预览已关闭。')); return owned.selectPreviewOption!(id) } : undefined,
      resetPreview: owned.resetPreview ? () => { if (disposed) throw Error('预览已关闭。'); owned.resetPreview!() } : undefined,
      captureFrame: options => {
        if (disposed) return Promise.reject(Error('预览已关闭。'))
        return owned.captureFrame(options)
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
