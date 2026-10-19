// LUI-04 · 隐私与采集面板：本地采集 / 授权感知 / 主动陪伴 / 主动邀请 / 语音唤醒。
//
// 全部默认关闭。本页只做「读取真实状态 + 显式确认后的写入」；不签发授权、不打开麦克风、
// 不上传画面，除非用户在本页逐个确认。

import { useEffect, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useOpsSession, useRequestGuard } from './useOps'
import { COLLECTION_SOURCE_KINDS, SOURCE_LABEL, STATE_LABEL, createCollectionSession, type CollectionSampleView, type CollectionSession, type CollectionState } from './collection'
import { createPerceptionSession, type PerceptionSession } from './perception'
import { createScreenGrantSession, type ScreenGrantSession } from './screen-grants'
import { WAKE_PHASE_LABEL, createCompanionSession, createProactiveSession, createWakeSession, type CompanionSession, type Pairing, type ProactiveSession, type WakeSession } from './companion'
import { OpsBadge, OpsButton, OpsCard, OpsConfirm, OpsDefinition, OpsErrorNotice, OpsNotice, OpsReadState } from './Panel'

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0') + ':00')
const formatTime = (value: string | null): string => {
  if (!value) return '—'
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString()
}
const STATE_TONE: Record<string, 'ok' | 'warn' | 'muted' | 'error'> = {
  active: 'ok', paused: 'warn', stopped: 'warn', revoked: 'muted', expired: 'warn', disabled: 'muted', unavailable: 'error',
}

export type PrivacySection = 'collection' | 'perception' | 'screen-grant' | 'companion' | 'proactive' | 'wake'

/**
 * 隐私域面板。`sections` 用来把子域挂到不同的设置 tab（`/settings?tab=privacy|collection|companion`）；
 * 缺省渲染全部。**每个子域只在自己的 tab 挂载时才读取**，避免未选能力被提前启动。
 */
export default function PrivacyPanel({ characterId, sections }: { characterId?: string; sections?: PrivacySection[] }) {
  const show = (id: PrivacySection) => !sections || sections.includes(id)
  return <div className="space-y-6">
    {show('collection') && <CollectionCard />}
    {show('perception') && <PerceptionCard />}
    {show('screen-grant') && <ScreenGrantCard characterId={characterId} />}
    {show('companion') && <CompanionCard characterId={characterId} />}
    {show('proactive') && <ProactiveCard characterId={characterId} />}
    {show('wake') && <WakeCard />}
  </div>
}

// ---------------------------------------------------------------------------
// 本地采集
// ---------------------------------------------------------------------------

function CollectionCard() {
  const guard = useRequestGuard()
  const session = useOpsSession<CollectionSession>(() => createCollectionSession(runtime, guard), [guard])
  const state = session.state
  const [directory, setDirectory] = useState('')
  useEffect(() => { void session.refresh() }, [session])
  return <OpsCard title="本地采集与留存" extra={<OpsBadge tone="muted">默认零采集</OpsBadge>}>
    <p className="text-sm text-ink-500">
      本地采集默认关闭。只有你在这里为某个来源选择范围并确认后才会开始；键盘只记录活动次数与区间（不含任何按键内容），
      图片副本存在本机受管目录，用户原图永不被采集模块删除。
    </p>
    <OpsErrorNotice error={state.error} fallback="采集状态" />
    <OpsErrorNotice error={state.action.error} fallback="采集操作" />
    {state.action.message && <OpsNotice tone="ok">{state.action.message}</OpsNotice>}
    <OpsErrorNotice error={state.samplesError} fallback="样本读取" />

    {!state.status
      ? <OpsNotice tone="warn">当前运行实例未装配本地采集，或状态读取失败；其他功能不受影响。本页不会用空列表冒充健康。</OpsNotice>
      : <>
        <OpsDefinition rows={[
          ['受管字节', String(state.status.managedBytes)],
          ['队列', `${state.status.queueItems} 项 / ${state.status.queueBytes} 字节`],
          ['策略版本', String(state.status.policyVersion)],
          ['采集修订', String(state.status.collectionRevision)],
          ['保留期', state.status.retentionDays === null ? '未提供' : `${state.status.retentionDays} 天`],
          ['受管上限', state.status.managedByteLimit === null ? '未提供' : `${state.status.managedByteLimit} 字节`],
          ['配置档', state.status.profile === 'smoke' ? '快速测试（smoke，短保留期）' : '正常（normal）'],
        ]} />

        <div className="grid gap-4 md:grid-cols-3">
          {COLLECTION_SOURCE_KINDS.map(kind => {
            const source = state.status!.sources.find(item => item.kind === kind) ?? null
            const sourceState = source?.state ?? 'disabled'
            const busy = state.action.busy && state.action.target === kind
            return <section key={kind} className="space-y-2 rounded-2xl border border-slate-100 p-4">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-bold">{SOURCE_LABEL[kind]}</h4>
                <OpsBadge tone={STATE_TONE[sourceState] ?? 'muted'}>{STATE_LABEL[sourceState] ?? sourceState}</OpsBadge>
              </header>
              <OpsDefinition rows={[
                ['授权修订', String(source?.revision ?? 0)],
                ['授权截止', formatTime(source?.grantExpiresAt ?? null)],
                ['最近采集', formatTime(source?.lastAcceptedAt ?? null)],
                ['接受/重复/拒绝/丢弃', source ? `${source.accepted} / ${source.duplicates} / ${source.rejected} / ${source.dropped}` : '—'],
                ...(kind === 'screenshot_directory' && source?.directoryDisplayPath ? [['已授权目录', source.directoryDisplayPath] as [string, string]] : []),
                ...(source?.lastErrorCode ? [['最近错误码', source.lastErrorCode] as [string, string]] : []),
              ]} />
              {sourceState === 'unavailable' && <OpsNotice tone="warn">当前运行实例没有该来源的实现（例如采集 helper 未构建）。基础对话不受影响。</OpsNotice>}
              {kind === 'screenshot_directory' && sourceState !== 'unavailable' && sourceState !== 'active' && sourceState !== 'paused' && (
                <label className="block text-sm"><span className="text-ink-700">授权目录（仅本机可见）</span>
                  <input className="soft-input mt-1.5" value={directory} placeholder="例如 D:\\Screenshots"
                    onChange={event => { setDirectory(event.target.value); session.setDirectoryDraft(event.target.value) }} /></label>
              )}
              <div className="flex flex-wrap gap-2">
                {sourceState === 'active' && <>
                  <OpsButton tone="ghost" disabled={busy} onClick={() => void session.pause(kind)}>暂停</OpsButton>
                  <OpsButton tone="ghost" disabled={busy} onClick={() => void session.stop(kind)}>停止</OpsButton>
                </>}
                {sourceState === 'paused' && <>
                  <OpsButton tone="ghost" disabled={busy} onClick={() => void session.resume(kind)}>继续</OpsButton>
                  <OpsButton tone="ghost" disabled={busy} onClick={() => void session.stop(kind)}>停止</OpsButton>
                </>}
                {sourceState !== 'active' && sourceState !== 'paused' && sourceState !== 'unavailable' && (
                  <OpsButton disabled={busy || (kind === 'screenshot_directory' && !directory.trim())} onClick={() => void session.activate(kind)}>
                    {busy ? '处理中…' : '启用该来源'}
                  </OpsButton>
                )}
                {sourceState !== 'disabled' && sourceState !== 'unavailable' && (
                  <OpsButton tone="danger" disabled={busy} onClick={() => session.requestRevoke(kind)}>撤销并删除该来源样本</OpsButton>
                )}
              </div>
            </section>
          })}
        </div>

        <OpsCard title={`当前配对最近样本（${state.samples.length} 条，最多 50 条）`}>
          <OpsReadState loading={state.loading} error={state.samplesError} loaded={state.samplesLoaded} empty={state.samples.length === 0}
            loadingText="正在读取…" errorText="样本读取失败" emptyText="暂无有效样本。0 条不代表来源健康。">
            <div className="space-y-3">
              {state.samples.map(sample => <SampleCard key={sample.id} sample={sample} session={session} state={state} />)}
            </div>
          </OpsReadState>
        </OpsCard>

        <OpsCard title="删除与漏采">
          <p className="text-sm text-ink-500">清空会删除当前配对试运行的全部样本，并保留无正文 tombstone 防止重放；用户原图不受影响。</p>
          <div className="flex flex-wrap gap-3">
            <OpsButton tone="ghost" disabled={state.action.busy} onClick={() => void session.recordMissing()}>记录一次漏采标记（无正文）</OpsButton>
            <OpsButton tone="ghost" disabled={state.action.busy} onClick={() => session.requestDeleteRange()}>删除当前时间段的样本</OpsButton>
            <OpsButton tone="danger" disabled={state.action.busy} onClick={() => session.requestClear()}>清空当前配对样本</OpsButton>
          </div>
        </OpsCard>

        {state.confirmation && <OpsConfirm
          title={state.confirmation.kind === 'revoke' ? '撤销该来源并删除其样本？' : state.confirmation.kind === 'clear' ? '清空当前配对样本？' : '删除该时间段的样本？'}
          description={state.confirmation.text} confirmLabel="确认执行"
          busy={state.action.busy}
          onCancel={() => session.cancelConfirmation()}
          onConfirm={() => {
            if (state.confirmation!.kind === 'revoke') void session.confirmRevoke()
            else if (state.confirmation!.kind === 'clear') void session.confirmClear()
            else if (state.confirmation!.kind === 'range') void session.confirmDeleteRange()
            else void session.confirmDelete()
          }} />}
      </>}
  </OpsCard>
}

function SampleCard({ sample, session, state }: { sample: CollectionSampleView; session: CollectionSession; state: CollectionState }) {
  const isImage = sample.sampleKind === 'image'
  const busy = state.action.busy && state.action.target === sample.id
  const thumbnail = state.thumbnails[sample.id]
  useEffect(() => { if (isImage && !thumbnail) void session.loadThumbnail(sample.id) }, [isImage, thumbnail, sample.id, session])
  return <section className="space-y-2 rounded-2xl border border-slate-100 p-4">
    <h4 className="font-bold">{isImage ? `图片候选 · ${sample.origin}` : `键盘活动区间 · ${sample.activityCount ?? 0} 次活动`}</h4>
    {/* 键盘样本只展示区间与聚合次数：没有任何按键正文可展示，也不伪造。 */}
    <OpsDefinition rows={[
      ['采集时间', formatTime(sample.receivedAt)],
      ['到期', formatTime(sample.expiresAt)],
      ['来源可信度', sample.sourceConfidence || '未提供'],
      ['修订', String(sample.revision)],
      ...(!isImage && sample.bucketStart ? [['区间', `${formatTime(sample.bucketStart)} → ${formatTime(sample.bucketEnd)}${sample.afkBoundary ? '（AFK 边界）' : ''}`] as [string, string]] : []),
    ]} />
    {isImage && (thumbnail
      ? <img className="max-h-40 rounded-xl" alt="本地样本缩略图" src={thumbnail} />
      : <p className="text-xs text-ink-400">缩略图读取中或已失效（撤销/删除后不可读）。</p>)}
    <div className="flex flex-wrap gap-2">
      {([['有用', 'useful'], ['无用', 'not_useful'], ['错配', 'mismatch']] as const).map(([label, value]) =>
        <OpsButton key={value} tone="ghost" disabled={busy} onClick={() => void session.feedback(sample.id, value, sample.revision)}>{label}</OpsButton>)}
      <OpsButton tone="danger" disabled={busy} onClick={() => session.requestDelete(sample.id)}>删除</OpsButton>
    </div>
  </section>
}

// ---------------------------------------------------------------------------
// 授权感知
// ---------------------------------------------------------------------------

function PerceptionCard() {
  const guard = useRequestGuard()
  const session = useOpsSession<PerceptionSession>(() => createPerceptionSession(runtime, guard), [guard])
  const state = session.state
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => { void session.refresh() }, [session])
  // 预览流由 session 持有；进入 streaming 阶段才挂到本页 <video>，离开即被 stopTracks 释放。
  useEffect(() => {
    const node = videoRef.current
    if (!node) return
    node.srcObject = state.phase === 'streaming' ? session.stream : null
    if (state.phase === 'streaming') void node.play().catch(() => {})
  }, [state.phase, session])
  const canCloud = state.status?.capabilities.cloud === true
  return <OpsCard title="授权感知" extra={<OpsBadge tone={state.status?.capabilities.cloud ? 'ok' : 'warn'}>{state.status?.capabilities.cloud ? '云端视觉模型已配置' : '云端视觉模型不可用'}</OpsBadge>}>
    <p className="text-sm text-ink-500">
      默认不采集。系统窗口选择器打开后，画面只在此页本地预览；定格后再单独确认是否将这一帧发送到已登记的云端视觉模型。
      截图不会写入历史，Observation 最多附加到下一轮并在两分钟后失效。
    </p>
    <OpsErrorNotice error={state.statusError} fallback="感知能力" />
    <OpsErrorNotice error={state.error} fallback="感知操作" />
    <OpsDefinition rows={[
      ['云端视觉模型', state.status ? (state.status.capabilities.cloud ? '已配置（本次请求仍需单独确认）' : '不可用') : '未读取'],
      ['本地 OCR/VLM', state.status?.capabilities.local ? '已配置' : '未配置'],
    ]} />

    {state.phase === 'streaming' && <div className="space-y-3">
      <video ref={videoRef} autoPlay muted playsInline className="max-h-64 w-full rounded-2xl bg-slate-900" />
      <p className="text-xs text-ink-400">来源由系统选择器提供。点「定格预览」后会立即停止采集轨道。</p>
      <div className="flex gap-3">
        <OpsButton onClick={() => { const node = videoRef.current; if (node) void freezeFrame(node, session) }}>定格预览</OpsButton>
        <OpsButton tone="ghost" onClick={() => void session.clear()}>停止采集</OpsButton>
      </div>
    </div>}

    {state.phase === 'preview' && state.frameUrl && <div className="space-y-3">
      <img className="max-h-64 rounded-2xl" src={state.frameUrl} alt="待处理的本地截图预览" />
      <p className="text-xs text-ink-400">画面尚未上传。勾选并点击确认后，才会把这一帧发送到云端模型。</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={state.cloudConsent} onChange={event => session.setCloudConsent(event.target.checked)} />
        <span>我确认将这张截图发送到已配置的云端视觉模型进行分析。</span>
      </label>
      {/* 未确认时不发请求；能力不可用时按钮禁用，不做静默降级。 */}
      <div className="flex gap-3">
        <OpsButton disabled={!canCloud || !state.cloudConsent || state.busy} onClick={() => void session.sendToCloud(state.cloudConsent)}>
          {state.busy ? '处理中…' : '确认并发送这一帧'}
        </OpsButton>
        <OpsButton tone="ghost" onClick={() => void session.clear()}>丢弃截图</OpsButton>
      </div>
      {!canCloud && <OpsNotice tone="warn">当前实例没有可用的云端视觉模型；本页不会改用其它路径发送画面。</OpsNotice>}
    </div>}

    {state.phase === 'uploading' && <div className="space-y-3">
      <p className="text-sm">授权有效期为单次。可以立即撤销；撤销会中止云端请求并清除临时结果。</p>
      <OpsButton tone="danger" onClick={() => void session.clear()}>撤销并清除</OpsButton>
    </div>}

    {state.phase === 'selecting' && <div className="space-y-3">
      <p className="text-sm">请在系统对话框中选择一个窗口或显示器；尚未向服务发送画面。</p>
      <OpsButton tone="ghost" onClick={() => void session.clear()}>取消</OpsButton>
    </div>}

    {state.observation && <div className="space-y-3 rounded-2xl bg-slate-50 p-4">
      <h4 className="font-bold">{state.attached ? '已附加到下一轮' : '本次观察结果'}</h4>
      <p className="text-xs text-ink-400">系统选择器 · {formatTime(state.observation.capturedAt)}</p>
      {state.observation.vlm?.summary && <p className="text-sm">{state.observation.vlm.summary}</p>}
      {!!state.observation.vlm?.visualElements?.length && <div className="flex flex-wrap gap-2">{state.observation.vlm.visualElements.map(item => <OpsBadge key={item}>{item}</OpsBadge>)}</div>}
      {state.observation.vlm?.uncertaintyNote && <OpsNotice tone="warn">{state.observation.vlm.uncertaintyNote}</OpsNotice>}
      {state.attached
        ? <OpsNotice tone="ok">已排队。现在回到桌宠发送下一条消息即可；该画面只用于那一轮，不进入聊天历史。</OpsNotice>
        : <OpsButton onClick={() => void session.attachToNextTurn(true)}>附加到下一条桌宠消息</OpsButton>}
      <OpsButton tone="ghost" onClick={() => void session.clear()}>清除观察</OpsButton>
    </div>}

    {(state.phase === 'idle') && <div className="space-y-3">
      <p className="text-sm text-ink-500">每次只选择一个窗口或显示器，不录制、不保存视频。系统会要求你确认共享来源。</p>
      <OpsButton onClick={() => void session.selectSource()}>打开系统来源选择器</OpsButton>
    </div>}
  </OpsCard>
}

async function freezeFrame(video: HTMLVideoElement, session: PerceptionSession): Promise<void> {
  if (!video.videoWidth || !video.videoHeight) throw Error('所选窗口尚未提供可预览画面。')
  const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw Error('浏览器无法创建本地预览。')
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const frame = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('无法生成预览帧。')), 'image/jpeg', 0.72))
  canvas.width = 0; canvas.height = 0
  session.freeze(frame)
}

// ---------------------------------------------------------------------------
// 屏幕授权（RWR-10）：宿主目标选择 + 授权签发 / 撤销。
// ---------------------------------------------------------------------------

const PURPOSE_LABEL: Record<string, string> = {
  'capture-single': '单次观察', 'capture-continuous': '持续观察（仅本地）', 'context-use': '文本用途',
}

function ScreenGrantCard({ characterId }: { characterId?: string }) {
  const guard = useRequestGuard()
  const { pairing, error } = usePairing(characterId)
  const session = useOpsSession<ScreenGrantSession>(() => createScreenGrantSession(runtime, guard, () => pairing), [guard, pairing])
  const state = session.state
  useEffect(() => { if (pairing) void session.refresh() }, [pairing, session])
  const view = state.view
  const draft = state.draft
  return <OpsCard title="屏幕授权" extra={<OpsBadge tone={view?.target ? 'ok' : 'muted'}>{view?.target ? '已选目标' : '未选目标'}</OpsBadge>}>
    <p className="text-sm text-ink-500">
      保存陪伴偏好不会签发授权。屏幕目标由桌宠宿主选择器提供；授权必须在这里显式签发（始终带确认），
      目标变化会撤销已有授权。持续观察只支持本地处理。
    </p>
    {error && <OpsNotice tone="warn">{error}</OpsNotice>}
    <OpsErrorNotice error={state.error} fallback="屏幕授权" />
    {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
    {state.conflict && <OpsNotice tone="warn">屏幕授权已在别处更新。你的草稿仍保留在本页，请刷新核对后再签发。</OpsNotice>}

    {!view
      ? <OpsNotice tone="warn">尚未读取到屏幕授权状态（未装配或读取失败）。本页不显示假授权。</OpsNotice>
      : <>
        <OpsDefinition rows={[
          ['授权修订', String(view.revision)],
          ['当前目标', view.target ? `${view.target.displayName}（修订 ${view.target.targetRevision}）` : '未选择'],
          ['能力', `目标选择=${view.capabilities.screenTargets ? '可用' : '不可用'} · 捕获=${view.capabilities.capture ? '可用' : '不可用'} · 本地 OCR=${view.capabilities.localOcr ? '可用' : '不可用'} · 云端 VLM=${view.capabilities.cloudVlm ? '可用' : '不可用'}`],
          ...((!view.capabilities.screenTargets || !view.capabilities.capture) && view.missingReasons.length ? [['缺失原因', view.missingReasons.join('、')] as [string, string]] : []),
        ]} />
        <OpsButton tone="ghost" disabled={state.busy} onClick={() => void session.selectTarget()}>
          {state.busy ? '处理中…' : view.target ? '重新选择屏幕目标' : '打开宿主屏幕目标选择器'}
        </OpsButton>

        {view.grants.length === 0
          ? <p className="py-2 text-sm text-ink-400">当前没有有效的屏幕授权。</p>
          : <div className="space-y-2">
            {view.grants.map(record => (
              <section key={record.grantId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 p-3">
                <div>
                  <h4 className="font-bold">{PURPOSE_LABEL[record.purpose] ?? record.purpose}</h4>
                  <p className="text-xs text-ink-400">{record.state} · {record.destination} · 到期 {record.expiry || '未提供'}</p>
                </div>
                {state.pendingRevoke === record.grantId
                  ? <div className="flex gap-2">
                    <OpsButton tone="danger" disabled={state.busy} onClick={() => void session.confirmRevoke()}>确认撤销</OpsButton>
                    <OpsButton tone="ghost" disabled={state.busy} onClick={() => session.cancelRevoke()}>取消</OpsButton>
                  </div>
                  : <OpsButton tone="danger" disabled={state.busy} onClick={() => session.requestRevoke(record.grantId)}>撤销</OpsButton>}
              </section>
            ))}
          </div>}

        <div className="space-y-3 rounded-2xl border border-slate-100 p-4">
          <h4 className="font-bold">签发一次授权</h4>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm"><span className="text-ink-700">用途</span>
              <select className="soft-input mt-1.5" value={draft.purpose} disabled={state.busy} onChange={event => session.edit('purpose', event.target.value)}>
                <option value="capture-single">单次观察</option>
                <option value="capture-continuous">持续观察（仅本地）</option>
                <option value="context-use">文本用途</option>
              </select></label>
            <label className="block text-sm"><span className="text-ink-700">处理目的地</span>
              <select className="soft-input mt-1.5" value={draft.destination} disabled={state.busy} onChange={event => session.edit('destination', event.target.value)}>
                <option value="local">本地</option>
                <option value="cloud">云端</option>
              </select></label>
            <label className="block text-sm"><span className="text-ink-700">期限毫秒（留空用默认）</span>
              <input className="soft-input mt-1.5" inputMode="numeric" value={draft.ttlMs} disabled={state.busy}
                onChange={event => session.edit('ttlMs', event.target.value)} /></label>
            <label className="block text-sm"><span className="text-ink-700">持续观察间隔毫秒（留空用默认）</span>
              <input className="soft-input mt-1.5" inputMode="numeric" value={draft.minPollMs} disabled={state.busy}
                onChange={event => session.edit('minPollMs', event.target.value)} /></label>
            {draft.purpose === 'context-use' && <>
              <label className="block text-sm"><span className="text-ink-700">模型绑定</span>
                <input className="soft-input mt-1.5" value={draft.modelBinding} disabled={state.busy}
                  onChange={event => session.edit('modelBinding', event.target.value)} /></label>
              <label className="block text-sm"><span className="text-ink-700">观察来源（逗号分隔，留空用默认）</span>
                <input className="soft-input mt-1.5" value={draft.scopes} disabled={state.busy}
                  onChange={event => session.edit('scopes', event.target.value)} /></label>
            </>}
          </div>
          <OpsButton disabled={state.busy || !view.target} onClick={() => void session.issue()}>
            {state.busy ? '处理中…' : '确认并签发授权'}
          </OpsButton>
          {!view.target && <OpsNotice tone="warn">请先选择屏幕目标，再签发授权。</OpsNotice>}
        </div>
      </>}
  </OpsCard>
}

// ---------------------------------------------------------------------------
// 主动陪伴
// ---------------------------------------------------------------------------

/** pairing 必须显式来自运行实例；浏览器不自行编造 userId/instanceId。 */
function usePairing(characterId?: string) {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    if (!characterId) { setPairing(null); setError('本页需要从角色工作区进入，才能确定运行配对。'); return }
    runtime.pairing(characterId).then((value: Pairing) => { if (alive) setPairing(value) }, (cause: unknown) => { if (alive) setError((cause as Error).message || '配对读取失败。') })
    return () => { alive = false }
  }, [characterId])
  return { pairing, error }
}

function CompanionCard({ characterId }: { characterId?: string }) {
  const guard = useRequestGuard()
  const { pairing, error } = usePairing(characterId)
  const session = useOpsSession<CompanionSession>(() => createCompanionSession(runtime, guard, () => pairing), [guard, pairing])
  const state = session.state
  useEffect(() => { if (pairing) void session.refresh() }, [pairing, session])
  const draft = state.draft
  return <OpsCard title="主动陪伴 · 保存偏好" extra={<OpsBadge tone="muted">只保存策略意图</OpsBadge>}>
    <p className="text-sm text-ink-500">此处只保存策略意图，不签发屏幕授权，也不表示自动调度已经可运行。屏幕目标与授权必须在「授权感知」单独完成。</p>
    {error && <OpsNotice tone="warn">{error}</OpsNotice>}
    <OpsErrorNotice error={state.error} fallback="主动陪伴" />
    <OpsErrorNotice error={state.triggerError} fallback="单次触发" />
    {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
    {state.conflict && <OpsNotice tone="warn">陪伴设置已在别处更新。你的改动仍保留在本页，请刷新核对后再保存。</OpsNotice>}

    {!state.view || !draft
      ? <OpsNotice tone="warn">尚未读取到主动陪伴偏好（未装配或读取失败）。本页不显示默认值冒充已保存。</OpsNotice>
      : <>
        <OpsDefinition rows={[
          ['运行状态', `${state.view.runState}${state.view.reason ? ` · ${state.view.reason}` : ''}`],
          ['屏幕自动观察', state.view.effective.screen.enabled ? '有效' : '未生效'],
          ['目标', state.view.capabilityStatus.targetSelected ? '已匹配' : '未选择/已变化'],
          ['持续授权', state.view.capabilityStatus.continuousGrant ? '有效' : '无'],
          ['能力', `capture=${state.view.capabilityStatus.capture ? '可用' : '不可用'}，local OCR=${state.view.capabilityStatus.localOcr ? '可用' : '不可用'}，cloud VLM=${state.view.capabilityStatus.cloudVlm ? '可用' : '不可用'}`],
          ['有效每日上限', String(state.view.effective.dailyMax)],
          ['有效回复冷却', `不少于 ${Math.round(state.view.effective.replyCooldownMs / 60000)} 分钟`],
          ['下次可触发', state.view.nextEligibleAt ?? '未提供'],
        ]} />

        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={draft.screen.enabled} disabled={state.saving}
            onChange={event => session.edit(next => { next.screen.enabled = event.target.checked })} />
          <span>允许自动屏幕观察</span>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-ink-700">观察间隔（毫秒）</span>
            <input type="number" className="soft-input mt-1.5" min={1000} max={86400000} step={1000} disabled={state.saving}
              value={draft.observationIntervalMs} onChange={event => session.edit(next => { next.observationIntervalMs = Number(event.target.value) })} /></label>
          <label className="block text-sm"><span className="text-ink-700">回复冷却（分钟）</span>
            <input type="number" className="soft-input mt-1.5" min={0} max={10080} step={1} disabled={state.saving}
              value={Math.round(draft.replyCooldownMs / 60000)} onChange={event => session.edit(next => { next.replyCooldownMs = Number(event.target.value) * 60000 })} />
            <span className="mt-1 block text-xs text-ink-400">实际冷却不得低于现有共享邀请间隔。</span></label>
          <label className="block text-sm"><span className="text-ink-700">每日自动上限</span>
            <input type="number" className="soft-input mt-1.5" min={0} max={8} step={1} disabled={state.saving}
              value={draft.dailyMax} onChange={event => session.edit(next => { next.dailyMax = Number(event.target.value) })} />
            <span className="mt-1 block text-xs text-ink-400">有效值还受共享仲裁上限约束。</span></label>
          {/* 时区仍由既有 CompanionMode policy 作为唯一 owner；本页不复制也不覆盖它。 */}
          <label className="block text-sm"><span className="text-ink-700">时区（由现有陪伴策略管理）</span>
            <input className="soft-input mt-1.5" value={draft.timezone} disabled readOnly /></label>
          <label className="block text-sm"><span className="text-ink-700">免打扰开始</span>
            <select className="soft-input mt-1.5" value={String(draft.dndStartHour)} disabled={state.saving}
              onChange={event => session.edit(next => { next.dndStartHour = Number(event.target.value) })}>
              {HOURS.map((hour, index) => <option key={hour} value={index}>{hour}</option>)}
            </select></label>
          <label className="block text-sm"><span className="text-ink-700">免打扰结束</span>
            <select className="soft-input mt-1.5" value={String(draft.dndEndHour)} disabled={state.saving}
              onChange={event => session.edit(next => { next.dndEndHour = Number(event.target.value) })}>
              {HOURS.map((hour, index) => <option key={hour} value={index}>{hour}</option>)}
            </select></label>
        </div>

        <div className="flex flex-wrap gap-3">
          <OpsButton tone="ghost" disabled={state.saving} onClick={() => session.resetDraft()}>放弃未保存修改</OpsButton>
          <OpsButton disabled={state.saving} onClick={() => void session.save()}>{state.saving ? '保存中…' : '保存偏好'}</OpsButton>
          {state.conflict && <OpsButton tone="ghost" onClick={() => session.keepDraft()}>保留我的改动并继续编辑</OpsButton>}
        </div>
      </>}

    <div className="space-y-3 rounded-2xl border border-slate-100 p-4">
      <h4 className="font-bold">立即主动陪伴一次</h4>
      <p className="text-xs text-ink-400">只执行一次，不开启自动循环。必须先有宿主选择的目标和匹配的单次授权；屏幕材料按不可信情境处理。</p>
      {state.trigger && <OpsNotice tone={state.trigger.status === 'delivered' ? 'ok' : state.trigger.status === 'failed' ? 'error' : 'info'}>
        {`触发 ${state.trigger.triggerId ?? ''}：${state.trigger.status ?? state.trigger.outcome ?? '未知'}${state.trigger.reason ? ` · ${state.trigger.reason}` : ''}${state.trigger.outcome === 'accepted' ? '（已接单，不代表已回复）' : ''}`}
      </OpsNotice>}
      <div className="flex flex-wrap gap-3">
        <OpsButton disabled={state.triggerBusy || !pairing} onClick={() => void session.triggerOnce('screen')}>{state.triggerBusy ? '处理中…' : '立即触发屏幕陪伴'}</OpsButton>
        {state.trigger?.triggerId && <OpsButton tone="ghost" disabled={state.triggerBusy} onClick={() => void session.refreshTrigger()}>查询状态</OpsButton>}
        {state.trigger?.triggerId && ['accepted', 'captured', 'recognized', 'generating'].includes(state.trigger.status) &&
          <OpsButton tone="ghost" disabled={state.triggerBusy} onClick={() => void session.cancelTrigger()}>取消本次触发</OpsButton>}
      </div>
    </div>
  </OpsCard>
}

// ---------------------------------------------------------------------------
// 主动邀请策略
// ---------------------------------------------------------------------------

function ProactiveCard({ characterId }: { characterId?: string }) {
  const guard = useRequestGuard()
  const { pairing, error } = usePairing(characterId)
  const session = useOpsSession<ProactiveSession>(() => createProactiveSession(runtime, guard, () => pairing), [guard, pairing])
  const state = session.state
  useEffect(() => { if (pairing) void session.refresh() }, [pairing, session])
  const draft = state.draft
  return <OpsCard title="主动陪伴邀请策略" extra={<OpsBadge tone="muted">默认关闭</OpsBadge>}>
    <p className="text-sm text-ink-500">
      默认关闭。开启后，只会从此刻之后新晋升且来源有效的事实或里程碑生成邀请；未经确认的候选不会触发，
      邀请正文不包含事实原文。接受会进入普通文字轮次，不会开启麦克风或工作工具。
    </p>
    {error && <OpsNotice tone="warn">{error}</OpsNotice>}
    <OpsErrorNotice error={state.error} fallback="主动邀请" />
    {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
    {!state.policy || !draft
      ? <OpsNotice tone="warn">尚未读取到主动邀请策略（未装配或读取失败）。</OpsNotice>
      : <>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={draft.enabled} disabled={state.loading}
            onChange={event => session.edit('enabled', event.target.checked)} />
          <span>允许桌宠主动发起文字邀请</span>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm"><span className="text-ink-700">每天最多展示次数</span>
            <input type="number" className="soft-input mt-1.5" min={0} max={2} step={1} disabled={state.loading || !draft.enabled}
              value={draft.dailyMax} onChange={event => session.edit('dailyMax', Number(event.target.value))} />
            <span className="mt-1 block text-xs text-ink-400">与本地问候共享现有上限，不能高于每天 2 次。</span></label>
          <label className="block text-sm"><span className="text-ink-700">最小展示间隔（小时）</span>
            <input type="number" className="soft-input mt-1.5" min={3} max={168} step={1} disabled={state.loading || !draft.enabled}
              value={Math.round(draft.minIntervalMs / 3_600_000)} onChange={event => session.edit('minIntervalMs', Number(event.target.value) * 3_600_000)} />
            <span className="mt-1 block text-xs text-ink-400">至少 3 小时，并与既有邀请共用冷却。</span></label>
          <label className="block text-sm"><span className="text-ink-700">免打扰开始</span>
            <select className="soft-input mt-1.5" value={String(draft.dndStartHour)} disabled={state.loading || !draft.enabled}
              onChange={event => session.edit('dndStartHour', Number(event.target.value))}>
              {HOURS.map((hour, index) => <option key={hour} value={index}>{hour}</option>)}
            </select></label>
          <label className="block text-sm"><span className="text-ink-700">免打扰结束</span>
            <select className="soft-input mt-1.5" value={String(draft.dndEndHour)} disabled={state.loading || !draft.enabled}
              onChange={event => session.edit('dndEndHour', Number(event.target.value))}>
              {HOURS.map((hour, index) => <option key={hour} value={index}>{hour}</option>)}
            </select></label>
        </div>
        <OpsNotice tone="info">屏幕 Observation 与日程来源尚未接入，因此不能在这里选择；旧条目不会在首次启用时回溯生成邀请。</OpsNotice>
        <div className="flex flex-wrap gap-3">
          <OpsButton tone="ghost" disabled={state.loading} onClick={() => session.restore()}>恢复已保存设置</OpsButton>
          <OpsButton disabled={state.loading} onClick={() => void session.save()}>{state.loading ? '正在保存…' : '保存策略'}</OpsButton>
        </div>
        <OpsNotice tone="info">忙于输入、语音、对话或待确认工作卡时不展示。免打扰、配额、冷却和来源版本由后端持久仲裁；来源编辑、失效或遗忘会撤销关联候选。候选和审计仅保存邀请文案、来源 ID/版本与状态，不复制连续性事实正文。</OpsNotice>
      </>}
  </OpsCard>
}

// ---------------------------------------------------------------------------
// 语音唤醒
// ---------------------------------------------------------------------------

function WakeCard() {
  const guard = useRequestGuard()
  const session = useOpsSession<WakeSession>(() => createWakeSession(runtime, guard), [guard])
  const state = session.state
  useEffect(() => { void session.refresh() }, [session])
  const draft = state.draft
  const snapshot = state.snapshot
  return <OpsCard title="语音唤醒" extra={<OpsBadge tone={snapshot?.session.enabled ? 'ok' : 'muted'}>{snapshot ? WAKE_PHASE_LABEL[snapshot.session.phase] ?? snapshot.session.phase : '正在读取'}</OpsBadge>}>
    <p className="text-sm text-ink-500">默认关闭。开启后仅在本机持续监听唤醒词；退出或重启后需重新开启。未唤醒时不会发送云端转写。</p>
    <OpsErrorNotice error={state.error} fallback="语音唤醒" />
    {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
    {snapshot && !snapshot.available && <OpsNotice tone="warn">{snapshot.detail || '本地唤醒模块尚未就绪。'}</OpsNotice>}
    {snapshot?.session.detail && <OpsNotice tone={snapshot.session.phase === 'error' ? 'warn' : 'info'}>{snapshot.session.detail}</OpsNotice>}
    {state.conflict && <OpsNotice tone="warn">本页草稿已保留，请核对已保存值后再保存。</OpsNotice>}

    {!snapshot || !draft
      ? <OpsNotice tone="warn">尚未读取到唤醒状态（未装配或读取失败）。本页不会用默认值冒充已保存。</OpsNotice>
      : <>
        <OpsDefinition rows={[
          ['已保存', `${draft.keyword} · ${draft.sensitivity === 'standard' ? '标准' : draft.sensitivity === 'sensitive' ? '更灵敏' : '更严格'} · 静音 ${draft.silenceMs / 1000} 秒`],
          ['实例', snapshot.instanceId],
          ['设置修订', String(snapshot.revision)],
          ['本次监听代次', String(snapshot.session.generation)],
        ]} />
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block text-sm"><span className="text-ink-700">唤醒词</span>
            <input className="soft-input mt-1.5" maxLength={12} value={draft.keyword} disabled={state.writing}
              onChange={event => session.edit('keyword', event.target.value)} />
            <span className="mt-1 block text-xs text-ink-400">2–12 个汉字；「乐正绫」读作 yuè zhèng líng。</span></label>
          <label className="block text-sm"><span className="text-ink-700">灵敏度</span>
            <select className="soft-input mt-1.5" value={draft.sensitivity} disabled={state.writing}
              onChange={event => session.edit('sensitivity', event.target.value)}>
              <option value="standard">标准</option><option value="sensitive">更灵敏</option><option value="strict">更严格</option>
            </select></label>
          <label className="block text-sm"><span className="text-ink-700">说完后等待多久发送</span>
            <select className="soft-input mt-1.5" value={String(draft.silenceMs)} disabled={state.writing}
              onChange={event => session.edit('silenceMs', Number(event.target.value))}>
              {[1000, 1500, 2000, 2500, 3000].map(value => <option key={value} value={value}>{value / 1000} 秒</option>)}
            </select></label>
        </div>
        <div className="flex flex-wrap gap-3">
          <OpsButton tone="ghost" disabled={state.loading || state.writing} onClick={() => void session.refresh()}>刷新唤醒状态</OpsButton>
          <OpsButton tone="ghost" disabled={state.writing || state.loading} onClick={() => void session.save()}>保存唤醒设置</OpsButton>
          <OpsButton disabled={state.writing || state.loading} onClick={() => void (snapshot.session.enabled ? session.disable() : session.enable())}>
            {snapshot.session.enabled ? '关闭监听' : '开启本次监听'}
          </OpsButton>
        </div>
        <p className="text-xs text-ink-400">修改后保存会关闭旧监听，不会自动重新开启。按住语音键仍可直接说话；每次回复后回到等待唤醒。</p>
      </>}
  </OpsCard>
}
