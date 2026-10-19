// LUI-04 · 桌宠宿主设置（RWR-10-01）行为层。
//
// 端点（`management/desktop-host-routes.ts`）：
//   GET /api/desktop/preferences -> { apiVersion, revision, hotkey, replySound, display, capabilities }
//   PUT /api/desktop/preferences { expectedRevision, operationId, patch } -> DesktopHostPatchReceipt
//
// patch 键只有 `hotkey | replySound | mode | preferredWidth`；未知键服务端 400。
//
// 保留的诚实语义（旧 `desktop-host-view.mjs` 是权威）：
//  - 宿主是唯一持久 owner。没有读到偏好时不显示「已保存」。
//  - `capabilities.hotkey === 'native-global'` 才是系统级热键；`window-only` 必须说明
//    「仅在桌宠窗口获得焦点时生效」。
//  - 409（version_conflict）保留用户草稿并提示刷新，不静默重载覆盖。
//  - 每个用户动作一个新 operationId；同一次动作重试复用同一个。
//  - 宿主缺席（503 / bridge 未装配）显示 unavailable，绝不显示假数据。

import { createEmitter, describeError, isAbort, newOperationId, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export interface DesktopHostPreferences {
  revision: number
  hotkey: string | null
  replySound: boolean
  display: { mode: 'full' | 'half'; preferredWidth: number; modelWidth: number; modelHeight: number; drawerHeight: number } | null
  capabilities: { hotkey: 'window-only' | 'native-global'; filePicker: boolean; display: boolean; preferences: boolean } | null
}

export interface HostDraft { hotkey: string | null; replySound: boolean; mode: 'full' | 'half'; preferredWidth: number }

export interface DesktopHostState {
  loading: boolean
  saving: boolean
  error: OpsError | null
  message: string
  /** null = 尚未读到宿主真实状态（缺席或未读取）。绝不显示为「已保存」。 */
  preferences: DesktopHostPreferences | null
  draft: HostDraft | null
  /** 草稿是否已被本地修改（与最后一次服务端回执不同）。 */
  dirty: boolean
  /** 409 之后保留草稿并置位；UI 必须显示「请刷新」而不是覆盖。 */
  conflict: boolean
}

const HOTKEY_LABELS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: '空格', Enter: '回车',
}

export function hotkeyLabel(code: string | null): string {
  if (!code) return '未绑定'
  return HOTKEY_LABELS[code] ?? code.replace(/^Key|^Digit/, '')
}

/** `window-only` 必须说清不是系统级热键——把它叫成「全局热键」就是假陈述。 */
export function hotkeyScopeNote(capabilities: DesktopHostPreferences['capabilities']): string {
  return capabilities?.hotkey === 'native-global'
    ? '该按键由系统级注册，桌宠未获得焦点时也可按住发言。'
    : '该按键仅在桌宠窗口获得焦点时生效（按住发言）。这不是系统级全局热键。'
}

/** 与 `contracts/desktop-host.ts::VALID_HOTKEY_PATTERN` 一致；前端只做快速反馈，宿主仍是权威。 */
const VALID_HOTKEY = /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/
export const isValidHotkey = (value: unknown): value is string => typeof value === 'string' && VALID_HOTKEY.test(value)

export const DISPLAY_MIN_WIDTH = 220
export const DISPLAY_MAX_WIDTH = 720

function normalize(value: any): DesktopHostPreferences {
  const display = value?.display
  const capabilities = value?.capabilities
  return {
    revision: typeof value?.revision === 'number' ? value.revision : 0,
    hotkey: typeof value?.hotkey === 'string' ? value.hotkey : null,
    replySound: value?.replySound === true,
    display: display && typeof display === 'object' ? {
      mode: display.mode === 'half' ? 'half' : 'full',
      preferredWidth: Number(display.preferredWidth) || DISPLAY_MIN_WIDTH,
      modelWidth: Number(display.modelWidth) || 0,
      modelHeight: Number(display.modelHeight) || 0,
      drawerHeight: Number(display.drawerHeight) || 0,
    } : null,
    capabilities: capabilities && typeof capabilities === 'object' ? {
      hotkey: capabilities.hotkey === 'native-global' ? 'native-global' : 'window-only',
      filePicker: capabilities.filePicker === true,
      display: capabilities.display === true,
      preferences: capabilities.preferences === true,
    } : null,
  }
}

const draftOf = (p: DesktopHostPreferences): HostDraft => ({
  hotkey: p.hotkey, replySound: p.replySound,
  mode: p.display?.mode ?? 'full', preferredWidth: p.display?.preferredWidth ?? DISPLAY_MIN_WIDTH,
})

function emptyState(): DesktopHostState {
  return { loading: false, saving: false, error: null, message: '', preferences: null, draft: null, dirty: false, conflict: false }
}

export function createDesktopHostSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  /** 同一次用户动作在重试期间复用；成功后清空，冲突时清空（下一次是新动作）。 */
  let pendingOperationId: string | null = null
  const notify = () => emitter.emit()
  const patch = (next: Partial<DesktopHostState>) => { state = { ...state, ...next }; notify() }

  async function refresh(): Promise<void> {
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/desktop/preferences', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const preferences = normalize(value)
      patch({ loading: false, preferences, draft: draftOf(preferences), dirty: false, conflict: false, error: null, message: '' })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      // 未连接宿主：明确 unavailable，preferences 保持 null，不显示任何「已保存」。
      patch({ loading: false, error: describeError(error, '无法读取宿主设置。'), preferences: null, draft: null, dirty: false })
    } finally { guard.end(ticket.controller) }
  }

  function edit(key: keyof HostDraft, value: HostDraft[keyof HostDraft]): void {
    if (!state.draft) return
    patch({ draft: { ...state.draft, [key]: value } as HostDraft, dirty: true, message: '', error: null })
  }

  /**
   * 写一个 patch。`operationId` 在动作内保持不变：传输失败重试会复用同一个编号，
   * 宿主因此能返回原始回执而不是二次应用。
   */
  async function save(patchBody: Record<string, unknown>): Promise<void> {
    const current = state.preferences
    if (!current) { patch({ error: describeError({ status: 503, message: '尚未读到宿主设置，无法保存。' }, '尚未读到宿主设置，无法保存。') }); return }
    if (state.saving) return
    const draftSnapshot = state.draft
    pendingOperationId ||= newOperationId()
    patch({ saving: true, error: null, message: '' })
    const ticket = guard.begin()
    try {
      const receipt = await client.request('/api/desktop/preferences', {
        method: 'PUT', signal: ticket.controller.signal,
        body: { expectedRevision: current.revision, operationId: pendingOperationId, patch: patchBody },
      })
      if (!ticket.current()) return
      pendingOperationId = null
      const preferences = normalize(receipt?.preferences ?? receipt)
      patch({ saving: false, preferences, draft: draftOf(preferences), dirty: false, conflict: false, message: '已保存到桌宠宿主并生效。' })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '设置未保存。')
      if (described.code === 'version_conflict') {
        // 冲突意味着缓存的修订已过期：保留草稿、丢弃已用过的编号，并要求刷新。
        pendingOperationId = null
        patch({ saving: false, conflict: true, draft: draftSnapshot, dirty: true, error: describeError({ status: 409, message: '设置已在别处更新，请刷新后重试；你的改动没有保存。' }, '设置已在别处更新，请刷新后重试。') })
        return
      }
      patch({ saving: false, error: described })
    } finally { guard.end(ticket.controller) }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): DesktopHostState { return state },
    refresh,
    edit,
    /** 绑定按键：Escape 取消，组合键/重复键不接受，服务端仍会再校验一次。 */
    bindHotkey(code: string): Promise<void> {
      if (!isValidHotkey(code)) {
        patch({ error: describeError({ status: 400, message: '这个按键不能用于按住发言。' }, '这个按键不能用于按住发言。') })
        return Promise.resolve()
      }
      return save({ hotkey: code })
    },
    clearHotkey: () => save({ hotkey: null }),
    setReplySound: (value: boolean) => save({ replySound: value }),
    setMode: (value: 'full' | 'half') => save({ mode: value }),
    setPreferredWidth: (value: number) => {
      const clamped = Math.max(DISPLAY_MIN_WIDTH, Math.min(DISPLAY_MAX_WIDTH, Math.round(value)))
      return save({ preferredWidth: clamped })
    },
    /** 刷新前保留草稿：用户在冲突后可以选择继续编辑，而不是被静默覆盖。 */
    keepDraft: () => patch({ conflict: false }),
    dispose() { guard.invalidate() },
    newOperationId,
  }
}
export type DesktopHostSession = ReturnType<typeof createDesktopHostSession>
