// LUI-04 · 余额与微信（外部集成）行为层。
//
// 端点：
//   GET  /api/balances                          -> { providers: ProviderBalance[] }
//   POST /api/balances/refresh { provider:'aliyun'|'deepseek' }
//   PUT  /api/balances/aliyun-credentials { expectedRevision, accessKeyId, accessKeySecret }
//   GET  /api/wechat                            -> WeChatSnapshot（apiVersion '0.2'）
//   POST /api/wechat { action, expectedRevision, code?, replyMode? }
//
// 保留的诚实语义（旧 `balances-view.mjs` / `wechat-view.mjs` 是权威）：
//  - 快照读取**不等待网络**；后端有界缓存，本页不自行探测、不产生付费请求。
//  - 密钥不回显、不进 URL/日志/浏览器存储；保存后立刻清空输入框。凭据只以引用形式出现。
//  - 微信 `lastDelivery` 区分「服务已接受」与「用户已收到」；不把 accepted 说成已送达。
//  - 刷新余额只读官方余额，不创建云账号、不修改权限、不自动购买。

import { createEmitter, describeError, isAbort, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export type BalanceProvider = 'aliyun' | 'deepseek'

export interface BalanceRow { currency: string; amount: string; availableCredit?: string }
export interface BalanceView {
  provider: BalanceProvider
  status: string
  configured: boolean
  credentialRevision: number
  updatedAt: string | null
  stale: boolean
  rows: BalanceRow[]
  message: string | null
}

export const BALANCE_LABEL: Record<string, string> = {
  idle: '尚未查询', loading: '更新中', ready: '官方余额', error: '查询失败', unconfigured: '待配置',
}

export interface BalancesState {
  loading: boolean
  error: OpsError | null
  providers: BalanceView[]
  /** 只有真实读到过 providers 才为 true；否则 UI 显示「未读取」而不是「暂无余额」。 */
  loaded: boolean
  credentials: { editing: boolean; saving: boolean; error: OpsError | null }
}

function normalizeBalance(raw: any): BalanceView {
  return {
    provider: raw?.provider === 'deepseek' ? 'deepseek' : 'aliyun',
    status: String(raw?.status ?? 'idle'),
    configured: raw?.configured === true,
    credentialRevision: typeof raw?.credentialRevision === 'number' ? raw.credentialRevision : 0,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    stale: raw?.stale === true,
    rows: Array.isArray(raw?.rows) ? raw.rows.map((row: any) => ({
      currency: String(row?.currency ?? ''), amount: String(row?.amount ?? ''),
      ...(row?.availableCredit === undefined ? {} : { availableCredit: String(row.availableCredit) }),
    })) : [],
    message: typeof raw?.message === 'string' ? raw.message : null,
  }
}

export function createBalancesSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state: BalancesState = { loading: false, error: null, providers: [], loaded: false, credentials: { editing: false, saving: false, error: null } }
  const notify = () => emitter.emit()
  const patch = (next: Partial<BalancesState>) => { state = { ...state, ...next }; notify() }

  async function accept(path: string, options?: { method?: string; body?: unknown }): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request(path, { ...options, signal: ticket.controller.signal })
      if (!ticket.current()) return
      const providers = Array.isArray(value?.providers) ? value.providers.map(normalizeBalance) : []
      patch({ providers, loaded: true, error: null, loading: false })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '余额状态暂时无法读取，其他功能仍可使用。') })
    } finally { guard.end(ticket.controller) }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): BalancesState { return state },
    refresh: () => accept('/api/balances'),
    /** 手动刷新一个提供方；本页不会在挂载时自动触发任何网络探测。 */
    async refreshProvider(provider: BalanceProvider): Promise<void> {
      patch({ loading: true })
      await accept('/api/balances/refresh', { method: 'POST', body: { provider } })
    },
    beginCredentials() { patch({ credentials: { ...state.credentials, editing: true, error: null } }) },
    cancelCredentials() { patch({ credentials: { editing: false, saving: false, error: null } }) },
    /**
     * 保存阿里云财务只读凭据。密钥只在本机后端保存，保存后立刻丢弃本地引用。
     * `expectedRevision` 取当前已读到的凭据修订，冲突时服务端 409。
     */
    async saveCredentials(accessKeyId: string, accessKeySecret: string): Promise<void> {
      const revision = state.providers.find(p => p.provider === 'aliyun')?.credentialRevision ?? 0
      patch({ credentials: { ...state.credentials, saving: true, error: null } })
      const ticket = guard.begin()
      try {
        const value = await client.request('/api/balances/aliyun-credentials', {
          method: 'PUT', signal: ticket.controller.signal,
          body: { expectedRevision: revision, accessKeyId, accessKeySecret },
        })
        if (!ticket.current()) return
        const providers = Array.isArray(value?.providers) ? value.providers.map(normalizeBalance) : state.providers
        patch({ providers, loaded: true, credentials: { editing: false, saving: false, error: null } })
      } catch (error) {
        if (isAbort(error) || !ticket.current()) return
        patch({ credentials: { ...state.credentials, saving: false, error: describeError(error, '凭据未保存，请刷新配置后检查输入；密钥不会回显。') } })
      } finally { guard.end(ticket.controller) }
    },
    dispose() { guard.invalidate() },
  }
}
export type BalancesSession = ReturnType<typeof createBalancesSession>

// ---------------------------------------------------------------------------
// 微信个人 Bot
// ---------------------------------------------------------------------------

export const WECHAT_STATUS_LABEL: Record<string, string> = {
  disconnected: '未连接', starting: '正在连接', waiting_scan: '等待扫码', scanned: '已扫码，等待确认',
  need_verification: '需要验证码', connected: '已连接', paused: '已暂停', expired: '二维码已过期', error: '连接遇到问题',
}
export const WECHAT_REPLY_MODE_LABEL: Record<string, string> = { follow_input: '跟随输入', text: '始终文字', voice: '始终语音' }
/** 「服务已接受」不等于「用户已收到」——这条区分必须在 UI 里保留。 */
export const WECHAT_DELIVERY_LABEL: Record<string, string> = {
  none: '尚无回复', accepted: '微信服务已接受，尚未确认用户收到', unknown: '是否发送成功尚未确认', failed: '发送失败',
}

export interface WeChatView {
  replyMode: string
  revision: number
  status: string
  enabled: boolean
  detail: string
  boundUser: { userId: string; botId: string } | null
  qr: { imageDataUrl: string; expiresAt: string } | null
  lastInputAt: string | null
  lastOutputAt: string | null
  lastDelivery: string
}

export interface WeChatState {
  loading: boolean
  error: OpsError | null
  view: WeChatView | null
  /** 草稿只含 replyMode；冲突时保留。 */
  replyDraft: string | null
  replyConflict: boolean
  message: string
  action: { busy: boolean; error: OpsError | null }
  verificationCode: string
}

export function normalizeWeChat(raw: any): WeChatView {
  const bound = raw?.boundUser
  const qr = raw?.qr
  return {
    replyMode: String(raw?.replyMode ?? 'follow_input'),
    revision: typeof raw?.revision === 'number' ? raw.revision : 0,
    status: String(raw?.status ?? 'disconnected'),
    enabled: raw?.enabled === true,
    detail: typeof raw?.detail === 'string' ? raw.detail : '',
    boundUser: bound && typeof bound.userId === 'string' ? { userId: bound.userId, botId: String(bound.botId ?? '') } : null,
    qr: qr && typeof qr.imageDataUrl === 'string' ? { imageDataUrl: qr.imageDataUrl, expiresAt: String(qr.expiresAt ?? '') } : null,
    lastInputAt: typeof raw?.lastInputAt === 'string' ? raw.lastInputAt : null,
    lastOutputAt: typeof raw?.lastOutputAt === 'string' ? raw.lastOutputAt : null,
    lastDelivery: String(raw?.lastDelivery ?? 'none'),
  }
}

export function createWeChatSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state: WeChatState = {
    loading: false, error: null, view: null, replyDraft: null, replyConflict: false, message: '',
    action: { busy: false, error: null }, verificationCode: '',
  }
  const notify = () => emitter.emit()
  const patch = (next: Partial<WeChatState>) => { state = { ...state, ...next }; notify() }

  async function refresh(): Promise<void> {
    if (state.action.busy) return
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/wechat', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const view = normalizeWeChat(value)
      const dirty = state.replyDraft !== null && state.replyDraft !== state.view?.replyMode
      patch({
        loading: false, view,
        replyDraft: dirty ? state.replyDraft : view.replyMode,
        // 服务端的回复方式变了而我们本地有草稿：保留草稿并提示核对。
        replyConflict: dirty && view.replyMode !== state.replyDraft,
        error: null,
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '暂时无法读取微信状态，请稍后刷新。'), view: null })
    } finally { guard.end(ticket.controller) }
  }

  /**
   * 提交一个动作。`expectedRevision` 来自最近一次真实回读；`verify` 需要验证码，
   * `set_reply_mode` 需要 replyMode。其余动作不接受额外字段（服务端会拒绝未知键）。
   */
  async function act(action: 'login' | 'verify' | 'start' | 'stop' | 'disconnect' | 'set_reply_mode'): Promise<void> {
    const current = state.view
    if (!current || state.action.busy) return
    const code = state.verificationCode.trim()
    if (action === 'verify' && !code) {
      patch({ action: { busy: false, error: describeError({ status: 400, message: '请填写验证码。' }, '请填写验证码。') } })
      return
    }
    patch({ action: { busy: true, error: null }, message: action === 'set_reply_mode' ? '正在保存回复方式…' : '' })
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/wechat', {
        method: 'POST', signal: ticket.controller.signal,
        body: {
          action, expectedRevision: current.revision,
          ...(action === 'verify' ? { code } : {}),
          ...(action === 'set_reply_mode' ? { replyMode: state.replyDraft ?? current.replyMode } : {}),
        },
      })
      if (!ticket.current()) return
      const view = normalizeWeChat(value)
      patch({
        view, action: { busy: false, error: null },
        verificationCode: action === 'verify' ? '' : state.verificationCode,
        replyDraft: view.replyMode,
        replyConflict: false,
        message: action === 'set_reply_mode' ? '回复方式已保存，将用于新收到的消息。' : '',
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      const described = describeError(error, '这次操作的结果尚未确认。')
      patch({
        action: { busy: false, error: described },
        // 保存回复方式失败：保留草稿并明确「结果未确认」，不谎称已保存。
        replyConflict: action === 'set_reply_mode' ? true : state.replyConflict,
        message: action === 'set_reply_mode' ? '保存结果尚未确认，请核对当前设置后再操作。' : '',
      })
    } finally { guard.end(ticket.controller) }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): WeChatState { return state },
    refresh,
    setReplyDraft(value: string) { patch({ replyDraft: value, message: '' }) },
    setVerificationCode(value: string) { patch({ verificationCode: value }) },
    login: () => act('login'),
    verify: () => act('verify'),
    start: () => act('start'),
    stop: () => act('stop'),
    disconnect: () => act('disconnect'),
    saveReplyMode: () => act('set_reply_mode'),
    keepDraft() { patch({ replyConflict: false }) },
    dispose() { guard.invalidate() },
  }
}
export type WeChatSession = ReturnType<typeof createWeChatSession>
