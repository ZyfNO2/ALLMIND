// LUI-04 · 集成面板：余额（官方只读查询）与微信个人 Bot。
//
// 边界：本页不自动刷新、不自动购买、不自动发送音频；密钥只在本机后端保存，保存后立刻清空输入框。

import { useEffect, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useOpsSession, useRequestGuard } from './useOps'
import {
  BALANCE_LABEL, WECHAT_DELIVERY_LABEL, WECHAT_REPLY_MODE_LABEL, WECHAT_STATUS_LABEL,
  createBalancesSession, createWeChatSession, type BalancesSession, type WeChatSession,
} from './integrations'
import { OpsBadge, OpsButton, OpsCard, OpsDefinition, OpsErrorNotice, OpsNotice } from './Panel'

const formatTime = (value: string | null): string => {
  if (!value) return '—'
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString()
}

export default function IntegrationsPanel() {
  return <div className="space-y-5">
    <BalancesCard />
    <WeChatCard />
  </div>
}

function BalancesCard() {
  const guard = useRequestGuard()
  const session = useOpsSession<BalancesSession>(() => createBalancesSession(runtime, guard), [guard])
  const state = session.state
  const [editing, setEditing] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  // 读取快照不会等待网络（后端有界缓存）；本页不自行探测、不产生付费请求。
  useEffect(() => { void session.refresh() }, [session])
  return <OpsCard title="官方余额" extra={<OpsBadge tone="muted">只读查询</OpsBadge>}>
    <p className="text-sm text-ink-500">来自官方余额接口的只读结果；刷新只读余额，不创建云账号、不修改权限、不自动购买。</p>
    <OpsErrorNotice error={state.error} fallback="余额状态" />
    {!state.loaded
      ? <OpsNotice tone="warn">尚未读取到余额状态；本页不显示假零。</OpsNotice>
      : <div className="grid gap-4 md:grid-cols-2">
        {state.providers.map(provider => <section key={provider.provider} className="space-y-2 rounded-2xl border border-slate-100 p-4">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-bold">{provider.provider === 'aliyun' ? '阿里云现金余额' : 'DeepSeek 可用余额'}</h4>
            <OpsBadge tone={provider.status === 'error' ? 'warn' : 'muted'}>{provider.stale ? '上次余额 · 已过期' : BALANCE_LABEL[provider.status] ?? '暂不可用'}</OpsBadge>
          </header>
          {provider.rows.length
            ? provider.rows.map(row => <div key={row.currency}>
              <p className="text-lg font-bold">{row.currency} {row.amount}</p>
              {row.availableCredit !== undefined && <p className="text-xs text-ink-400">可用额度：{row.currency} {row.availableCredit}</p>}
            </div>)
            : <p className="text-sm text-ink-400">{provider.status === 'unconfigured' ? '待配置凭据' : provider.status === 'error' ? '暂时无法取得余额' : '尚无官方余额'}</p>}
          <p className="text-xs text-ink-400">更新时间：{formatTime(provider.updatedAt)}</p>
          {provider.message && <OpsNotice tone="warn">{provider.message}</OpsNotice>}
          <div className="flex flex-wrap gap-3">
            <OpsButton tone="ghost" disabled={state.loading || provider.status === 'loading'} onClick={() => void session.refreshProvider(provider.provider)}>刷新余额</OpsButton>
            {provider.provider === 'aliyun' && <OpsButton tone="ghost" disabled={state.loading} onClick={() => { session.beginCredentials(); setEditing(true) }}>{provider.configured ? '更新财务凭据' : '配置财务凭据'}</OpsButton>}
          </div>
          <p className="text-xs text-ink-400">{provider.provider === 'aliyun' ? '来自阿里云账户；现金余额与可用额度分别展示。' : '来自 DeepSeek；各币种分别展示，含有效赠送余额。'}</p>
        </section>)}
      </div>}

    {editing && <section className="space-y-3 rounded-2xl border border-slate-100 p-4">
      <h4 className="font-bold">阿里云财务只读凭据</h4>
      <p className="text-sm text-ink-500">在本机保存具有余额查询权限的 RAM AccessKey。百炼 API Key 不能代替财务凭据；不要在聊天中发送密钥。</p>
      <OpsErrorNotice error={state.credentials.error} fallback="凭据保存" />
      <label className="block text-sm"><span className="text-ink-700">AccessKey ID</span>
        <input type="password" autoComplete="off" maxLength={256} className="soft-input mt-1.5" value={keyId} disabled={state.credentials.saving} onChange={event => setKeyId(event.target.value)} /></label>
      <label className="block text-sm"><span className="text-ink-700">AccessKey Secret</span>
        <input type="password" autoComplete="new-password" maxLength={256} className="soft-input mt-1.5" value={secret} disabled={state.credentials.saving} onChange={event => setSecret(event.target.value)} /></label>
      <p className="text-xs text-ink-400">所需只读权限：bss:DescribeAcccount。凭据仅在本机后端保存，不回显；此操作不会创建云账号或修改权限。</p>
      <div className="flex flex-wrap gap-3">
        <OpsButton disabled={state.credentials.saving || !keyId.trim() || !secret.trim()} onClick={() => {
          // 保存后立刻清空本地输入，密钥不留在组件状态里。
          void session.saveCredentials(keyId.trim(), secret).then(() => { setKeyId(''); setSecret(''); setEditing(false) })
        }}>{state.credentials.saving ? '保存中…' : '保存并查询'}</OpsButton>
        <OpsButton tone="ghost" disabled={state.credentials.saving} onClick={() => { setKeyId(''); setSecret(''); setEditing(false); session.cancelCredentials() }}>取消</OpsButton>
      </div>
    </section>}
  </OpsCard>
}

function WeChatCard() {
  const guard = useRequestGuard()
  const session = useOpsSession<WeChatSession>(() => createWeChatSession(runtime, guard), [guard])
  const state = session.state
  useEffect(() => { void session.refresh() }, [session])
  const view = state.view
  const status = view?.status ?? ''
  const qrFresh = view?.qr && Date.parse(view.qr.expiresAt) > Date.now()
  return <OpsCard title="微信个人 Bot" extra={<OpsBadge tone={status === 'connected' ? 'ok' : 'muted'}>{view ? (status === 'waiting_scan' && !qrFresh ? '二维码已过期' : WECHAT_STATUS_LABEL[status] ?? status) : '未读取'}</OpsBadge>}>
    <p className="text-sm text-ink-500">用希望聊天或发指令的微信扫码。连接的是官方个人 Bot，支持绑定用户的文字和语音消息。</p>
    <OpsErrorNotice error={state.error} fallback="微信状态" />
    <OpsErrorNotice error={state.action.error} fallback="微信操作" />
    {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
    {state.replyConflict && <OpsNotice tone="warn">设置已变化或保存结果未确认。请核对当前方式；本页选择已保留。</OpsNotice>}

    {!view
      ? <OpsNotice tone="warn">尚未读取到微信状态；本页不显示假连接。</OpsNotice>
      : <>
        <OpsDefinition rows={[
          ['连接状态', WECHAT_STATUS_LABEL[status] ?? status],
          ['已启用', view.enabled ? '是' : '否'],
          ['当前回复方式', WECHAT_REPLY_MODE_LABEL[view.replyMode] ?? view.replyMode],
          ['记录版本', String(view.revision)],
        ]} />
        {view.detail && <OpsNotice tone="info">{view.detail}</OpsNotice>}
        {qrFresh && view.qr && <div className="space-y-2">
          <img src={view.qr.imageDataUrl} alt="微信连接二维码" width={224} height={224} draggable={false} referrerPolicy="no-referrer" />
          <p className="text-xs text-ink-400">有效至 {formatTime(view.qr.expiresAt)}</p>
        </div>}

        {status === 'need_verification' && <div className="space-y-2">
          <label className="block text-sm"><span className="text-ink-700">验证码</span>
            <input type="password" autoComplete="off" spellCheck={false} maxLength={256} className="soft-input mt-1.5"
              value={state.verificationCode} disabled={state.action.busy}
              onChange={event => session.setVerificationCode(event.target.value)} /></label>
          <OpsButton disabled={state.action.busy || !state.verificationCode.trim()} onClick={() => void session.verify()}>提交验证</OpsButton>
        </div>}

        <div className="flex flex-wrap gap-3">
          {['disconnected', 'expired', 'error', 'waiting_scan', 'scanned', 'need_verification'].includes(status) &&
            <OpsButton disabled={state.action.busy} onClick={() => void session.login()}>{status === 'disconnected' ? '生成连接二维码' : '刷新二维码'}</OpsButton>}
          {view.boundUser && !view.enabled && <OpsButton disabled={state.action.busy} onClick={() => void session.start()}>启用微信</OpsButton>}
          {(view.enabled || ['starting', 'waiting_scan', 'scanned', 'need_verification'].includes(status)) &&
            <OpsButton tone="ghost" disabled={state.action.busy} onClick={() => void session.stop()}>暂停微信</OpsButton>}
          {status && status !== 'disconnected' && <OpsButton tone="danger" disabled={state.action.busy} onClick={() => void session.disconnect()}>断开连接</OpsButton>}
        </div>

        <div className="space-y-2 rounded-2xl border border-slate-100 p-4">
          <h4 className="font-bold">回复方式</h4>
          <label className="block text-sm"><span className="text-ink-700">希望怎样回复</span>
            <select className="soft-input mt-1.5" value={state.replyDraft ?? view.replyMode} disabled={state.action.busy}
              onChange={event => session.setReplyDraft(event.target.value)}>
              {Object.entries(WECHAT_REPLY_MODE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          <p className="text-xs text-ink-400">跟随输入：语音回音频文件，文字回文字。选择「始终文字」可关闭语音回复。保存后用于新消息；已安排任务的后续通知保持原方式。</p>
          <div className="flex flex-wrap gap-3">
            {state.replyConflict && <OpsButton tone="ghost" onClick={() => session.keepDraft()}>已核对，保留本页选择</OpsButton>}
            <OpsButton disabled={state.action.busy || (state.replyDraft ?? view.replyMode) === view.replyMode} onClick={() => void session.saveReplyMode()}>保存回复方式</OpsButton>
          </div>
        </div>

        {view.boundUser && <OpsDefinition rows={[
          ['微信用户', view.boundUser.userId],
          ['个人 Bot', view.boundUser.botId],
          ['最近收到', formatTime(view.lastInputAt)],
          ['最近回复', formatTime(view.lastOutputAt)],
          // 「服务已接受」不等于「用户已收到」：这条区分必须保留。
          ['回复状态', WECHAT_DELIVERY_LABEL[view.lastDelivery] ?? view.lastDelivery],
        ]} />}
        <p className="text-xs text-ink-400">暂停后保留绑定；断开后需要重新扫码。微信消息不会让电脑出声，任务执行仍需你确认。</p>
      </>}
  </OpsCard>
}
