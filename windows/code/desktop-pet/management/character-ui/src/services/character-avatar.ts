// CUX-02: 按角色生成静态立绘头像（首版：浏览器端生成 + 内存缓存）。
//
// 为什么在前端生成：后端没有缩略图接口，`GET /api/skins/{id}/asset/` 只提供鉴权资产读取。
// 本模块复用 CUX-01 的 `services/skin-preview.ts` 打开一个短生命周期离屏预览，抓取首个有效
// idle 帧编码成 256×256 PNG，并在浏览器内存里按 `skinId + assetFingerprint + 渲染规格版本` 去重。
//
// 明确不做：不新增服务器截图 API、不建磁盘封面库、不写 Web Storage、不做智能头部裁切、
// 不用 Live2D 纹理整图冒充立绘。
//
// 所有权模型（SPEC §3）：同一个 key 的生成任务在所有订阅者之间共享，带**订阅者计数**。
// 任何一个组件的卸载只能释放它自己的订阅；只有最后一个订阅者释放（或显式取消）才会真正 abort
// 任务。Blob URL 同理：只在最后一个使用者释放后才 revoke。
import { runtime } from './runtime'
import { openSkinPreview, type SkinPreviewHandle } from './skin-preview'

/** 头像渲染规格版本：改变尺寸/构图/编码时必须递增，让旧缓存自动失效。 */
export const AVATAR_SPEC_VERSION = 1
/** 首版固定 256×256。 */
export const AVATAR_SIZE = 256
/** 内存上限：超过后按 LRU 淘汰未使用项。 */
export const AVATAR_CACHE_LIMIT = 32
/** 单个任务超时。 */
const TASK_TIMEOUT_MS = 30_000
/** 没有可解析立绘时的默认图（与旧占位图同一张静态资源）。 */
export const DEFAULT_AVATAR = '/assets/avatar-neutral.svg'

export type AvatarStatus = 'loading' | 'ready' | 'unset' | 'error'

export interface AvatarHandle {
  status: AvatarStatus
  /** `ready` 时的本地 Blob URL；其他状态为默认静态图。 */
  url: string
  /** 可访问状态文案（不显示另一角色的图）。 */
  message: string
  /** 释放本次订阅；最后一个使用者释放后才 revoke Blob URL。 */
  release(): void
}

/** 角色 → 已保存资源的映射缓存；键是 characterId，值是解析出的 skinId（'' 表示未设置）。 */
const mappingCache = new Map<string, string>()

interface CacheEntry {
  key: string
  url: string
  /** 当前订阅者数量；0 表示可被淘汰。 */
  users: number
  /** 最后一次被订阅的时间，用于 LRU。 */
  touched: number
}

/** 一个 key 的共享生成任务。`users` 是订阅者计数，归零才取消。 */
interface SharedTask {
  promise: Promise<Blob>
  controller: AbortController
  users: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, SharedTask>()
/** 失败原因，供 UI 显示与重试。 */
const failures = new Map<string, string>()
/** 队列：同时最多一个短生命周期渲染器。 */
let queue: Promise<unknown> = Promise.resolve()

/** 渲染缓存键：不能只用角色名或模型名。 */
export const avatarCacheKey = (skinId: string, assetFingerprint: string): string =>
  `${skinId}\u0000${assetFingerprint}\u0000${AVATAR_SPEC_VERSION}`

function evictIfNeeded() {
  if (cache.size <= AVATAR_CACHE_LIMIT) return
  const idle = [...cache.values()].filter(entry => entry.users === 0).sort((a, b) => a.touched - b.touched)
  for (const entry of idle) {
    if (cache.size <= AVATAR_CACHE_LIMIT) break
    cache.delete(entry.key)
    URL.revokeObjectURL(entry.url)
  }
}

/**
 * 取得（或加入）一个 key 的共享生成任务。
 *
 * 队列保证同时只有一个短生命周期渲染器；重复请求复用同一个任务而不是再开一个引擎。
 */
function acquireTask(key: string, skin: any): SharedTask {
  const existing = inflight.get(key)
  if (existing) { existing.users++; return existing }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS)
  const promise = queue.then(async () => {
    if (controller.signal.aborted) throw Error('头像生成已超时或已取消。')
    // 离屏画布必须有**真实非零布局尺寸**：display:none 会得到 1×1 空图。
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE; canvas.height = AVATAR_SIZE
    Object.assign(canvas.style, { position: 'fixed', left: '-10000px', top: '0', width: `${AVATAR_SIZE}px`, height: `${AVATAR_SIZE}px` })
    document.body.append(canvas)
    let handle: SkinPreviewHandle | undefined
    try {
      handle = await openSkinPreview({ canvas, skinId: skin.skinId, signal: controller.signal })
      return await handle.captureFrame({ signal: controller.signal, size: AVATAR_SIZE })
    } finally {
      handle?.dispose()
      canvas.remove()
      clearTimeout(timer)
      inflight.delete(key)
    }
  })
  queue = promise.catch(() => {})
  const task: SharedTask = { promise, controller, users: 1 }
  inflight.set(key, task)
  return task
}

/** 订阅者释放：计数归零且任务仍在进行时，才真正取消（不误伤其他消费者）。 */
function releaseTask(key: string, task: SharedTask) {
  task.users--
  if (task.users <= 0 && inflight.get(key) === task) {
    inflight.delete(key)
    task.controller.abort()
  }
}

/**
 * 解析一个角色应该使用哪个立绘资源。
 *
 * 运行角色用真实 `activeSkinId`；非运行角色用该角色**已保存**的 `configuration.appearance.resourceId`。
 * 浏览角色、下次运行角色、预览草稿都不参与。
 */
async function resolveAvatarSource(characterId: string, signal?: AbortSignal): Promise<{ skinId: string; skin: any }> {
  const [snapshot, skins] = await Promise.all([
    runtime.request('/api/snapshot', { signal }),
    runtime.request('/api/skins', { signal }),
  ])
  const runningCharacterId: string = snapshot?.runtime?.characterId || ''
  let skinId = ''
  if (runningCharacterId === characterId) {
    skinId = skins?.state?.activeSkinId || ''
  } else {
    const view = await runtime.request(`/api/characters/bindings?characterId=${encodeURIComponent(characterId)}`, { signal })
    skinId = view?.configuration?.appearance?.resourceId || ''
  }
  const skin = (skins?.state?.skins || []).find((item: any) => item.skinId === skinId)
  return { skinId, skin }
}

/**
 * 取得一个角色的头像句柄。
 *
 * 状态语义：`loading` → `ready`（本地 Blob URL）/ `unset`（该角色没有已保存立绘，或资源已不存在）/
 * `error`（读取或编码失败，保留原因）。读取失败或缺资源时**显示默认图**，绝不显示另一角色的图。
 */
export async function acquireAvatar(input: { characterId: string; signal?: AbortSignal }): Promise<AvatarHandle> {
  const { characterId } = input
  let resolved: { skinId: string; skin: any }
  try {
    resolved = await resolveAvatarSource(characterId, input.signal)
  } catch (error) {
    return { status: 'error', url: DEFAULT_AVATAR, message: `头像暂不可用：${(error as Error).message}`, release() {} }
  }
  mappingCache.set(characterId, resolved.skinId)
  if (!resolved.skinId) return { status: 'unset', url: DEFAULT_AVATAR, message: '该角色尚未设置立绘。', release() {} }
  if (!resolved.skin) return { status: 'unset', url: DEFAULT_AVATAR, message: '该角色的立绘资源已不存在，请重新选择。', release() {} }
  const key = avatarCacheKey(resolved.skin.skinId, String(resolved.skin.assetFingerprint || ''))

  const cached = cache.get(key)
  if (cached) {
    cached.users++; cached.touched = Date.now()
    let released = false
    return { status: 'ready', url: cached.url, message: '', release() { if (released) return; released = true; cached.users--; cached.touched = Date.now() } }
  }

  const task = acquireTask(key, resolved.skin)
  // 外层组件的卸载只释放自己的订阅；共享任务只在计数归零时被取消。
  let unsubscribed = false
  const unsubscribe = () => { if (unsubscribed) return; unsubscribed = true; releaseTask(key, task) }
  input.signal?.addEventListener('abort', unsubscribe, { once: true })
  try {
    const blob = await task.promise
    // 等任务期间组件已卸载：不再发布 Blob URL，避免无人释放的泄漏。
    if (input.signal?.aborted) { unsubscribe(); return { status: 'error', url: DEFAULT_AVATAR, message: '头像生成已取消。', release() {} } }
    unsubscribe()
    // 同一个 key 的多个订阅者会先后从同一个任务返回：只发布**一个** Blob URL，其余复用缓存项，
    // 否则每个调用者都会造一个自己的 URL，最后一个使用者永远 revoke 不到别人的那一份。
    const published = cache.get(key)
    if (published) {
      published.users++; published.touched = Date.now()
      let released = false
      return { status: 'ready', url: published.url, message: '', release() { if (released) return; released = true; published.users--; published.touched = Date.now() } }
    }
    const url = URL.createObjectURL(blob)
    const entry: CacheEntry = { key, url, users: 1, touched: Date.now() }
    cache.set(key, entry)
    evictIfNeeded()
    failures.delete(key)
    let released = false
    return {
      status: 'ready', url, message: '',
      release() {
        if (released) return
        released = true
        entry.users--; entry.touched = Date.now()
      },
    }
  } catch (error) {
    unsubscribe()
    const message = (error as Error).message || '头像生成失败。'
    failures.set(key, message)
    return { status: 'error', url: DEFAULT_AVATAR, message: `头像暂不可用：${message}`, release() {} }
  }
}

/** 失败原因（供重试入口显示）。 */
export const avatarFailureOf = (skinId: string, assetFingerprint: string): string => failures.get(avatarCacheKey(skinId, assetFingerprint)) || ''

// ---------------------------------------------------------------- 失效广播

/**
 * 失效广播：CUX-01 的应用/保存成功后必须让侧栏**立即**更新，而不是等下一次整页加载。
 *
 * `AppLayout` 只在首次挂载时 `listCharacters`，所以不能靠它重新渲染；订阅者自己重新解析权威映射。
 * 订阅粒度是 characterId（或 `'*'` 表示全部）。
 */
type AvatarListener = (characterId: string) => void
const listeners = new Set<AvatarListener>()

export function subscribeAvatarInvalidation(listener: AvatarListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 让受影响角色的映射失效并通知订阅者（未使用的旧图同时释放）。 */
export function invalidateAvatar(characterId: string): void {
  const previous = mappingCache.get(characterId)
  mappingCache.delete(characterId)
  if (previous) {
    for (const entry of [...cache.values()]) {
      // 只淘汰没人用的项；正在显示的图等它自己的 release 处理。
      if (entry.users === 0 && entry.key.startsWith(`${previous}\u0000`)) {
        cache.delete(entry.key)
        URL.revokeObjectURL(entry.url)
      }
    }
  }
  for (const listener of [...listeners]) listener(characterId)
}

/** 清 session：释放全部缓存（页面卸载/登出）。 */
export function releaseAllAvatars(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url)
  cache.clear()
  mappingCache.clear()
  failures.clear()
}
