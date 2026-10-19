// LUI-04 · 授权感知（08-03 / N081）行为层。
//
// 端点（`management/perception-routes.ts`，字段以此为准）：
//   GET    /api/perception                      -> { enabled, capabilities:{local,cloud}, activeGrants, instruction }
//   POST   /api/perception/grants { scopeType:'window'|'region'|'screen', destination:'local'|'cloud', userConfirmed:true }
//   POST   /api/perception/captures { grantId, mimeType, imageBase64 }
//   POST   /api/perception/attach { observationId, userConfirmed:true }
//   DELETE /api/perception/grants/{grantId}
//   DELETE /api/perception/observations/{observationId}
//
// 保留的诚实语义（旧 `perception-session.mjs` 是权威）：
//  - 默认不采集。系统选择器打开后画面**只在本页本地预览**，定格后才单独确认是否上传。
//  - 上传必须由 `userConfirmed === true` 触发；没有确认就不发请求，也不做静默云端 fallback。
//  - 本地 OCR/VLM 未配置时如实显示「不可用」，不伪装能力。
//  - 撤销/清除会中止云端请求并清理授权与观察；卸载时释放媒体轨道与 object URL。
//  - 帧上限 1.5 MB；只接受 PNG / JPEG。

import { createEmitter, describeError, isAbort, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export const MAX_FRAME_BYTES = 1_500_000

export type PerceptionPhase = 'idle' | 'selecting' | 'streaming' | 'preview' | 'uploading' | 'observed' | 'attached'

export interface PerceptionObservation {
  observationId: string
  capturedAt: string
  vlm: { status?: string; summary?: string; visualElements?: string[]; uncertaintyNote?: string } | null
}

export interface PerceptionStatus {
  enabled: boolean
  capabilities: { local: boolean; cloud: boolean }
  instruction: string
}

export interface PerceptionState {
  status: PerceptionStatus | null
  statusError: OpsError | null
  phase: PerceptionPhase
  scopeType: 'window' | 'region' | 'screen' | null
  /** 本地预览帧；上传前只存在于本页。 */
  frameUrl: string | null
  frameBytes: number
  observation: PerceptionObservation | null
  attached: boolean
  error: OpsError | null
  busy: boolean
  /** 云端上传的显式同意；未勾选时按钮不可用且不发请求。 */
  cloudConsent: boolean
}

export interface PerceptionMedia {
  getDisplayMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
}

export interface PerceptionDeps {
  mediaDevices?: PerceptionMedia | undefined
  encodeFrame?: (blob: Blob) => Promise<string>
}

function emptyState(): PerceptionState {
  return {
    status: null, statusError: null, phase: 'idle', scopeType: null, frameUrl: null, frameBytes: 0,
    observation: null, attached: false, error: null, busy: false, cloudConsent: false,
  }
}

async function defaultEncodeFrame(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  bytes.fill(0)
  return btoa(binary)
}

export function createPerceptionSession(client: OpsClient, guard: RequestGuard, deps: PerceptionDeps = {}, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  let stream: MediaStream | null = null
  let activeRequest: AbortController | null = null
  let grantId: string | null = null
  /** 每次「打开系统来源选择」递增；取消/清除后旧选择的结果会被丢弃并停止轨道。 */
  let selectEpoch = 0
  const encodeFrame = deps.encodeFrame ?? defaultEncodeFrame
  const mediaDevices = deps.mediaDevices ?? (globalThis.navigator as any)?.mediaDevices
  const notify = () => emitter.emit()
  const patch = (next: Partial<PerceptionState>) => { state = { ...state, ...next }; notify() }

  function stopTracks(): void {
    for (const track of stream?.getTracks?.() ?? []) { try { track.stop() } catch { /* 已停止 */ } }
    stream = null
  }
  function releaseFrame(): void {
    if (state.frameUrl) { try { URL.revokeObjectURL(state.frameUrl) } catch { /* 已释放 */ } }
    state = { ...state, frameUrl: null, frameBytes: 0 }
  }

  async function readStatus(): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/perception', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      patch({
        status: {
          enabled: value?.enabled === true,
          // 缺失即不可用；绝不因为字段缺失而假定云端可用。
          capabilities: { local: value?.capabilities?.local === true, cloud: value?.capabilities?.cloud === true },
          instruction: typeof value?.instruction === 'string' ? value.instruction : '',
        },
        statusError: null,
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ status: null, statusError: describeError(error, '无法读取授权感知状态。') })
    } finally { guard.end(ticket.controller) }
  }

  /** 打开系统来源选择器：只做本地预览，不向服务发送任何画面。 */
  async function selectSource(): Promise<void> {
    if (typeof mediaDevices?.getDisplayMedia !== 'function') {
      patch({ error: describeError({ status: 0, message: '当前浏览器不支持系统屏幕选择。' }, '当前浏览器不支持系统屏幕选择。') })
      return
    }
    if (state.busy || state.phase === 'streaming' || state.phase === 'selecting') return
    patch({ phase: 'selecting', error: null })
    // 选择器是异步的：期间用户可能已经取消/清除，用一个代次判断这次选择是否仍然有效。
    const selectionEpoch = ++selectEpoch
    try {
      const next = await mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 5, max: 10 } } } as MediaStreamConstraints)
      if (selectionEpoch !== selectEpoch) { for (const track of next.getTracks()) track.stop(); return }
      const track = next.getVideoTracks?.()[0] ?? next.getTracks?.()[0]
      if (!track) { for (const item of next.getTracks()) item.stop(); throw Error('系统未提供可预览的视频来源。') }
      const surface = (track as any).getSettings?.().displaySurface
      stream = next
      patch({ phase: 'streaming', scopeType: surface === 'window' || surface === 'browser' ? 'window' : 'screen' })
      track.addEventListener?.('ended', () => {
        if (stream !== next) return
        stopTracks(); patch({ phase: 'idle', error: describeError({ status: 0, message: '屏幕来源已停止。' }, '屏幕来源已停止。') })
      }, { once: true })
    } catch (error) {
      patch({ phase: 'idle', error: describeError(error, '无法打开系统屏幕选择。') })
    }
  }

  /** 定格当前预览：立即停止采集轨道，帧只留在本页。 */
  function freeze(frame: Blob): void {
    if (state.phase !== 'streaming') throw Error('请先选取一个来源。')
    if (!(frame instanceof Blob) || !frame.size || frame.size > MAX_FRAME_BYTES) throw Error('预览帧无效或超过 1.5 MB。')
    stopTracks(); releaseFrame()
    patch({ phase: 'preview', frameUrl: URL.createObjectURL(frame), frameBytes: frame.size, error: null, cloudConsent: false })
    // 帧本体只存在于闭包；上传时由 view 重新编码，避免把二进制留在长期状态里。
    pendingFrame = frame
  }
  let pendingFrame: Blob | null = null

  /**
   * 上传并分析这一帧。`confirmed !== true` 时直接拒绝，**不发任何请求**。
   * 授权有效期是单次；中止后清理 grant 与 observation。
   */
  async function sendToCloud(confirmed: boolean): Promise<void> {
    if (confirmed !== true) {
      patch({ error: describeError({ status: 403, message: '请先确认本帧将发送至云端视觉模型。' }, '请先确认本帧将发送至云端视觉模型。') })
      return
    }
    if (state.phase !== 'preview' || !pendingFrame || state.busy) {
      patch({ error: describeError({ status: 400, message: '请先选取并预览一帧。' }, '请先选取并预览一帧。') })
      return
    }
    const frame = pendingFrame
    const scopeType = state.scopeType ?? 'screen'
    patch({ busy: true, phase: 'uploading', error: null })
    const controller = new AbortController(); activeRequest = controller
    let imageBase64 = ''
    try {
      if (frame.type !== 'image/png' && frame.type !== 'image/jpeg') throw Object.assign(Error('只支持 PNG 或 JPEG 图像。'), { status: 400 })
      imageBase64 = await encodeFrame(frame)
      if (!imageBase64 || imageBase64.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4) throw Object.assign(Error('截图超过上传上限。'), { status: 400 })
      const issued = await client.request('/api/perception/grants', {
        method: 'POST', signal: controller.signal,
        body: { scopeType, destination: 'cloud', userConfirmed: true },
      })
      const issuedGrant = issued?.grant?.grantId
      if (!issuedGrant) throw Error('服务没有返回单次授权。')
      if (controller.signal.aborted) { await client.request(`/api/perception/grants/${encodeURIComponent(issuedGrant)}`, { method: 'DELETE' }).catch(() => {}); return }
      grantId = issuedGrant
      const result = await client.request('/api/perception/captures', {
        method: 'POST', signal: controller.signal, body: { grantId: issuedGrant, mimeType: frame.type, imageBase64 },
      })
      if (controller.signal.aborted) {
        const observationId = result?.observation?.observationId
        if (observationId) await client.request(`/api/perception/observations/${encodeURIComponent(observationId)}`, { method: 'DELETE' }).catch(() => {})
        return
      }
      const observation = result?.observation
      if (!observation?.observationId) throw Error('服务没有返回有效观察。')
      pendingFrame = null
      releaseFrame()
      patch({ phase: 'observed', observation: normalizeObservation(observation), attached: false, error: null })
    } catch (error) {
      if (controller.signal.aborted) return
      patch({ phase: pendingFrame ? 'preview' : 'idle', error: describeError(error, '这次屏幕分析没有完成。') })
    } finally {
      imageBase64 = ''
      if (activeRequest === controller) { activeRequest = null; patch({ busy: false }) }
    }
  }

  /** 附加到下一轮：必须显式确认；不自动附加。 */
  async function attachToNextTurn(confirmed: boolean): Promise<void> {
    if (confirmed !== true) { patch({ error: describeError({ status: 403, message: '请确认只附加到下一轮对话。' }, '请确认只附加到下一轮对话。') }); return }
    const observationId = state.observation?.observationId
    if (!observationId || state.busy) { patch({ error: describeError({ status: 400, message: '当前没有可附加的有效观察。' }, '当前没有可附加的有效观察。') }); return }
    try {
      await client.request('/api/perception/attach', { method: 'POST', body: { observationId, userConfirmed: true } })
      patch({ attached: true, phase: 'attached', error: null })
    } catch (error) {
      patch({ error: describeError(error, '附加失败。') })
    }
  }

  /** 中止请求、停止轨道、释放帧 URL，并撤销授权与观察。 */
  async function clear(): Promise<void> {
    activeRequest?.abort(); activeRequest = null
    selectEpoch += 1
    stopTracks()
    pendingFrame = null
    releaseFrame()
    const revokedGrant = grantId, observationId = state.observation?.observationId
    grantId = null
    patch({ busy: false, phase: 'idle', observation: null, attached: false, error: null, cloudConsent: false })
    const cleanup: Promise<unknown>[] = []
    if (revokedGrant) cleanup.push(client.request(`/api/perception/grants/${encodeURIComponent(revokedGrant)}`, { method: 'DELETE' }).catch(() => {}))
    if (observationId) cleanup.push(client.request(`/api/perception/observations/${encodeURIComponent(observationId)}`, { method: 'DELETE' }).catch(() => {}))
    await Promise.all(cleanup)
  }

  return {
    subscribe: emitter.subscribe,
    get state(): PerceptionState { return state },
    /** 当前本地预览流；只交给本页 `<video>`，不上传、不录制。 */
    get stream(): MediaStream | null { return stream },
    refresh: readStatus,
    selectSource,
    freeze,
    setCloudConsent(value: boolean) { patch({ cloudConsent: value }) },
    sendToCloud,
    attachToNextTurn,
    clear,
    /** 卸载：不等回执，但必须立刻停止轨道与释放 URL。 */
    dispose() {
      guard.invalidate()
      activeRequest?.abort(); activeRequest = null
      selectEpoch += 1
      stopTracks(); pendingFrame = null; releaseFrame()
      const revokedGrant = grantId, observationId = state.attached ? null : state.observation?.observationId
      grantId = null
      if (revokedGrant) void client.request(`/api/perception/grants/${encodeURIComponent(revokedGrant)}`, { method: 'DELETE' }).catch(() => {})
      if (observationId) void client.request(`/api/perception/observations/${encodeURIComponent(observationId)}`, { method: 'DELETE' }).catch(() => {})
      notify()
    },
  }
}

function normalizeObservation(raw: any): PerceptionObservation {
  const vlm = raw?.vlm
  return {
    observationId: String(raw?.observationId ?? ''),
    capturedAt: typeof raw?.capturedAt === 'string' ? raw.capturedAt : '',
    vlm: vlm && typeof vlm === 'object' ? {
      status: typeof vlm.status === 'string' ? vlm.status : undefined,
      summary: typeof vlm.summary === 'string' ? vlm.summary : undefined,
      visualElements: Array.isArray(vlm.visualElements) ? vlm.visualElements.map((v: unknown) => String(v)) : undefined,
      uncertaintyNote: typeof vlm.uncertaintyNote === 'string' ? vlm.uncertaintyNote : undefined,
    } : null,
  }
}
export type PerceptionSession = ReturnType<typeof createPerceptionSession>
