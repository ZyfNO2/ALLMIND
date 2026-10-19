/**
 * LUI-01: `/setup` — the React replacement for the retired `management/ui/self-setup-view.mjs`.
 *
 * This page is the only first-run surface and the shared global credential/voice surface in runtime
 * mode. It reads and writes exactly the real `/api/self-setup` endpoints; every safety rule of the
 * old console view (explicit cost consent, no automatic retry after an unconfirmed outcome, drafts
 * kept on a 409, key cleared after save, local-only audio conversion, samples only on a user action)
 * lives in `components/setup/setup-connection.ts` and is exercised by `tests/ui-rework/setup-*.test.mjs`.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { SetupSession, type SetupState } from '../components/setup/setup-connection'
import { Button, Definition, ExternalLink, Failure, Field, Help, Notice, Panel, Select } from '../components/setup/Panels'
import {
  CREDENTIAL_STATUS_LABELS, PROVIDERS, SLOT_LABELS, VOICE_MODELS, money, operationKey, settingsChanged,
  type SetupVoiceOperation,
} from '../components/setup/model'

const STATUS_TONE: Record<string, string> = {
  prepared: 'bg-slate-100 text-slate-600',
  cloning: 'bg-amber-50 text-amber-700',
  clone_ready: 'bg-aika-50 text-aika-700',
  activating: 'bg-amber-50 text-amber-700',
  registered: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700',
  unknown: 'bg-amber-50 text-amber-800',
  cancelled: 'bg-slate-100 text-slate-500',
}

export default function Setup() {
  const session = useMemo(() => new SetupSession(), [])
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)

  useEffect(() => {
    session.start()
    return () => session.dispose()
  }, [session])

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-10" id="setup">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">{state.data?.mode === 'first-run' ? '首次设置' : 'API Key 与自定义音色'}</h1>
          <p className="mt-1 text-sm text-ink-500">本页只与这台机器上的设置服务通信；不会自动启动桌宠，也不会自动调用云端。</p>
        </div>
        <Button id="setup-refresh" tone="secondary" disabled={state.loading || !!state.write} onClick={() => void session.refresh()}>
          {state.loading ? '读取中…' : '刷新设置状态'}
        </Button>
      </header>

      {state.authError && <Failure>{state.authError}</Failure>}
      {state.unavailable && <Notice tone="warning">本机没有可用的首次设置入口。请使用桌宠的启动入口打开管理页面。</Notice>}
      {state.readError && <Notice tone="warning">{state.readError}</Notice>}
      {state.error && <Failure>{state.error}</Failure>}
      {state.message && <Notice>{state.message}</Notice>}
      {state.stale && state.data && !state.readError && !state.error && (
        <Notice tone="warning">设置状态已过期，写操作已停用；请先刷新核对。</Notice>
      )}

      {state.loading && !state.data && <p className="text-sm text-ink-500">正在读取本机设置入口…</p>}
      {!state.loading && !state.data && !state.unavailable && !state.authError && !state.readError && (
        <Notice tone="warning">暂时没有读到设置状态。请点击「刷新设置状态」重试；不会自动重发任何请求。</Notice>
      )}

      {state.data && (
        <>
          <KeyPanel session={session} state={state} />
          {state.data.mode === 'first-run' && <ModelPanel session={session} state={state} />}
          <VoicePanel session={session} state={state} />
          {state.data.mode === 'first-run' && <FinishPanel session={session} state={state} />}
        </>
      )}
    </div>
  )
}

type SessionProps = { session: SetupSession; state: SetupState }

// ---------------------------------------------------------------- API keys

function KeyPanel({ session, state }: SessionProps) {
  const data = state.data!
  const busy = !!state.write
  return (
    <Panel id="setup-keys" title="保存 API Key">
      <Help>
        文本模型使用 DeepSeek；语音转写、多模态与 MiniMax 使用阿里云百炼。Key 只保存在本机，不在页面回显，
        保存后输入框立即清空。
      </Help>
      <ProviderHelp state={state} />
      <form onSubmit={event => { event.preventDefault(); void session.saveKey() }} className="grid gap-4 md:grid-cols-2">
        <Select id="setup-provider" label="供应商" value={state.credentialProvider} disabled={busy}
          options={PROVIDERS.map(provider => ({ value: provider.value, label: provider.label }))}
          onChange={value => session.setCredentialProvider(value)} />
        <Field id="setup-key" label="API Key" type="password" maxLength={4096} value={state.secret} disabled={busy}
          onInput={value => session.setSecret(value)} hint="保存不会发起模型调用，也不代表模型已经开通。" />
        <div className="md:col-span-2">
          <Button id="setup-key-save" type="submit" disabled={!session.canSaveKey() || busy}>
            {state.write === 'credentials' ? '保存中…' : '保存到本机'}
          </Button>
        </div>
      </form>
      <div className="space-y-1 text-xs text-ink-500">
        <ExternalLink label="DeepSeek Key 管理" url={data.links.deepseekKeys} />
        <span> · </span>
        <ExternalLink label="百炼 API Key 管理" url={data.links.dashscopeKeys} />
      </div>
      <ul className="space-y-1 text-xs text-ink-600">
        {data.credentials.map(credential => (
          <li key={credential.id}>
            {PROVIDERS.find(provider => provider.value === credential.provider)?.label || credential.provider}
            {' · '}{credential.label}
            {' · '}{CREDENTIAL_STATUS_LABELS[credential.status] || credential.status}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function ProviderHelp({ state }: { state: SetupState }) {
  const data = state.data
  if (!data) return null
  return (
    <Help>
      请先在阿里云百炼开通所选模型及调用权限。保存 API Key 不代表模型已经开通。
      {' '}<ExternalLink label="百炼控制台" url={data.links.dashscopeConsole} />
      {' · '}<ExternalLink label="API Key 管理" url={data.links.dashscopeKeys} />
    </Help>
  )
}

// ------------------------------------------------------------ model settings

function ModelPanel({ session, state }: SessionProps) {
  const data = state.data!
  const draft = state.settingsDraft
  const busy = !!state.write
  if (!draft) return null
  return (
    <Panel id="setup-models" title="选择模型与音色">
      <ProviderHelp state={state} />
      <Help>
        先保存对应服务的 Key，再选择已适配模型。保存不会发起模型调用；完成初始化并重启后生效。
        实际生效版本：{data.settings.effectiveRevision}（保存版本 {data.settings.revision}）。
      </Help>
      {Object.keys(draft.providers).map(slot => (
        <details key={slot} id={'setup-slot-' + slot} className="rounded-2xl border border-indigo-100 bg-white/70 p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">
            {(SLOT_LABELS[slot] || slot) + ' · ' + draft.providers[slot]!.model}
          </summary>
          <SlotEditor session={session} state={state} slot={slot} />
        </details>
      ))}
      {state.settingsConflict && (
        <Notice tone="warning">配置版本已变化。草稿已保留，请核对最新配置后再保存。</Notice>
      )}
      {state.settingsConflict && (
        <Button id="setup-model-review" tone="secondary" disabled={busy} onClick={() => session.discardModelDraft()}>
          读取最新配置，放弃本页模型修改
        </Button>
      )}
      <div>
        <Button id="setup-model-save" disabled={!session.canSaveModels() || busy} onClick={() => void session.saveModels()}>
          {state.write === 'settings' ? '保存中…' : '保存模型配置，重启后生效'}
        </Button>
      </div>
    </Panel>
  )
}

function SlotEditor({ session, state, slot }: SessionProps & { slot: string }) {
  const data = state.data!
  const draft = state.settingsDraft!
  const provider = draft.providers[slot]!
  const busy = !!state.write
  const adapters = session.adaptersFor(slot)
  const adapter = adapters.find(candidate => candidate.id === provider.adapterId)
  const credentialOptions = [
    { value: '', label: '请选择此服务的凭据引用' },
    ...data.credentials.map(credential => ({
      value: credential.id,
      label: credential.label + ' · ' + (CREDENTIAL_STATUS_LABELS[credential.status] || credential.status),
      disabled: credential.status !== 'configured',
    })),
  ]
  const modelOptions = Array.from(new Set([provider.model, ...(adapter?.models || [])].filter(Boolean)))
    .map(model => ({ value: model, label: model }))
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <Select id={'adapter-' + slot} label="服务商" value={provider.adapterId} disabled={busy}
        options={adapters.map(candidate => ({
          value: candidate.id,
          label: candidate.label + (candidate.status === 'not_integrated' ? '（尚未接入）' : ''),
          disabled: candidate.status !== 'available',
        }))}
        onChange={value => session.applyProviderChoice(slot, value, adapter?.models?.[0] || '')} />
      <Select id={'model-' + slot} label="型号 (Model ID)" value={provider.model} disabled={busy}
        options={modelOptions.length ? modelOptions : [{ value: provider.model, label: provider.model || '（未配置）' }]}
        onChange={value => session.editProvider(slot, 'model', value)} />
      <Field id={'endpoint-' + slot} label="服务地址（端点 Endpoint URL）" value={provider.endpoint} disabled={busy}
        onInput={value => session.editProvider(slot, 'endpoint', value.trim())} />
      <Select id={'credential-' + slot} label="凭据引用" value={provider.credentialRef} disabled={busy}
        options={credentialOptions}
        onChange={value => {
          session.editProvider(slot, 'credentialRef', value)
          const chosen = data.credentials.find(credential => credential.id === value)
          if (chosen?.provider) session.editProvider(slot, 'provider', chosen.provider)
        }} />
      {slot !== 'asr' && (
        <Field id={'input-limit-' + slot} label="上下文输入上界" type="number" min={1} step={1} value={provider.inputTokenLimit} disabled={busy}
          onInput={value => session.editProvider(slot, 'inputTokenLimit', Number(value))} />
      )}
      {slot === 'tts' && (
        <Field id={'voice-' + slot} label="音色标识" value={provider.voice || ''} disabled={busy}
          onInput={value => session.editProvider(slot, 'voice', value)} hint="填写已登记的音色标识；已登记音色可在下面的音色方案中查看。" />
      )}
      {slot === 'tts' && adapter?.capabilities.language && (
        <Field id={'language-' + slot} label="语言" value={provider.language || ''} disabled={busy}
          onInput={value => session.editProvider(slot, 'language', value)} />
      )}
      {slot === 'dialogue' && (adapter?.capabilities.temperature || adapter?.open) && (
        <Field id={'temperature-' + slot} label="温度" type="number" min={0} max={2} step={0.1} value={provider.temperature ?? ''} disabled={busy}
          onInput={value => session.editProvider(slot, 'temperature', value === '' ? undefined : Number(value))} hint="控制实际对话请求的随机性。" />
      )}
      {adapter?.status === 'not_integrated' && <div className="md:col-span-2"><Notice tone="warning">此服务暂未开放。</Notice></div>}
    </div>
  )
}

// --------------------------------------------------------------- voice clone

function VoicePanel({ session, state }: SessionProps) {
  const data = state.data!
  const busy = !!state.write
  return (
    <Panel id="setup-voice" title="创建自己的音色 · 阿里云百炼">
      <ProviderHelp state={state} />
      <Help>
        参考音频为 WAV、MP3 或 M4A，10 秒至 5 分钟，不超过 20 MiB。上传前仅在本机转换为单声道 24 kHz WAV，
        原文件不改动；上传成功只表示已保存到本机，尚未发送云端。
      </Help>
      <div className="space-y-2">
        <label htmlFor="setup-audio" className="block text-sm font-medium text-ink-700">选择自己的参考音频</label>
        <input id="setup-audio" type="file" accept=".wav,.mp3,.m4a" disabled={busy}
          onChange={event => session.setFile(event.target.files?.[0] || null)} />
        {state.selectedFile && <p className="text-xs text-ink-500">已选择：{state.selectedFile.name}</p>}
        <Button id="setup-upload" disabled={!session.canUpload() || busy} onClick={() => void session.uploadReference()}>
          {state.write === 'reference' ? '正在本机转换…' : '仅上传到本机'}
        </Button>
      </div>
      <ExternalLink label="支持的音频与音色复刻说明" url={data.links.voiceClone} />
      <div className="grid gap-4 md:grid-cols-2">
        <Select id="setup-reference" label="已保存的参考音频" value={state.referenceId} disabled={busy}
          options={[{ value: '', label: '请选择' }, ...session.referenceOptions()]}
          onChange={value => session.setVoiceField({ referenceId: value })} />
        <Field id="setup-voice-label" label="音色名称" maxLength={80} value={state.voiceLabel} disabled={busy}
          onInput={value => session.setVoiceField({ voiceLabel: value })} />
        <Select id="setup-voice-model" label="音色模型" value={state.targetModel} disabled={busy}
          options={VOICE_MODELS.map(model => ({ value: model.value, label: model.label }))}
          onChange={value => session.setVoiceField({ targetModel: value })} />
        <Select id="setup-voice-credential" label="百炼凭据" value={state.voiceCredentialRef} disabled={busy}
          options={[{ value: '', label: '请选择百炼凭据' }, ...session.dashscopeCredentials().map(credential => ({
            value: credential.id, label: credential.label, disabled: credential.status !== 'configured',
          }))]}
          onChange={value => session.setVoiceField({ voiceCredentialRef: value })} />
        <div className="md:col-span-2">
          <Field id="setup-voice-text" label="试听文本" type="textarea" maxLength={300} value={state.voiceText} disabled={busy}
            onInput={value => session.setVoiceField({ voiceText: value })} />
        </div>
      </div>
      <Help>
        云端创建会生成收费试听：Turbo 2 元 / 万字符，HD 3.5 元 / 万字符。首次正式启用克隆音色另收 9.9 元及合成字符费。
        {' '}<ExternalLink label="查看官方费用" url={data.links.voicePricing} />
      </Help>
      <div>
        <Button id="setup-voice-prepare" disabled={!session.canPrepare() || busy} onClick={() => void session.prepareVoice()}>
          {state.write === 'voice' ? '处理中…' : '准备音色方案（不调用云端）'}
        </Button>
      </div>
      <div className="space-y-4">
        {data.operations.map(operation => <OperationCard key={operation.operationId} session={session} state={state} operation={operation} />)}
      </div>
      {state.sample && (
        <div id="setup-sample" className="space-y-2 rounded-2xl border border-indigo-100 bg-white/70 p-4">
          <p className="text-sm text-ink-700">{state.sample.label} · 手动试听（不会自动播放）</p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="none" src={state.sample.url} aria-label={state.sample.label + '试听音频'} />
          <Button tone="secondary" onClick={() => session.releaseSample()}>关闭试听并释放音频</Button>
        </div>
      )}
    </Panel>
  )
}

function OperationCard({ session, state, operation }: SessionProps & { operation: SetupVoiceOperation }) {
  const data = state.data!
  const busy = !!state.write
  const key = operationKey(operation)
  const uncertain = session.isUncertain(operation)
  const canConfirm = session.canConfirm(operation)
  const consent = session.consentGiven(operation)
  const next = operation.phase === 'prepared' ? '创建收费试听' : '正式启用并登记音色'
  return (
    <article className="space-y-3 rounded-2xl border border-indigo-100 bg-white/70 p-4" data-setup-operation={operation.operationId}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-ink-900">{operation.label}</h3>
        <span className={`chip ${STATUS_TONE[operation.phase] || 'bg-slate-100 text-slate-600'}`}>{session.phaseLabel(operation)}</span>
      </div>
      <p className="text-xs text-ink-500">{operation.targetModel} · 阿里云百炼</p>
      <Help>试听文本：{operation.text}</Help>
      <Definition rows={[
        ['创建试听上限', money(operation.cloneUpperBoundMicros)],
        ['正式启用上限', money(operation.activationUpperBoundMicros)],
      ]} />
      {(operation.phase === 'unknown' || uncertain) && (
        <Notice tone="warning">结果尚未确认，已停用重复收费操作。请刷新核对，勿重复创建。</Notice>
      )}
      {operation.phase === 'failed' && (
        <Notice tone="warning">{session.errorText(operation)} 页面不会自动重试。</Notice>
      )}
      {operation.configRevision !== data.settings.revision && ['prepared', 'clone_ready'].includes(operation.phase) && (
        <Notice tone="warning">模型配置已变化，此方案不可继续提交，请重新准备。</Notice>
      )}
      {['prepared', 'clone_ready'].includes(operation.phase) && (
        <div className="space-y-2">
          <Help>
            {operation.phase === 'prepared'
              ? '确认后参考音频将发往阿里云百炼，生成试听也会计费。'
              : '确认后执行首次正式合成，收取 9.9 元及字符费；登记成功后仍需手动选择音色并保存配置。'}
          </Help>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input id={'setup-consent-' + operation.operationId} type="checkbox" checked={consent} disabled={!canConfirm}
              onChange={event => session.toggleConsent(operation, event.target.checked)} />
            <span>我同意本次操作及所示费用上限</span>
          </label>
          <Button data-setup-confirm={operation.operationId} disabled={!canConfirm || !consent || busy}
            onClick={() => void session.confirmVoice(operation)}>
            {next}
          </Button>
        </div>
      )}
      {operation.phase === 'registered' && (
        <Notice>音色已登记。请在模型配置中选择对应模型与音色，保存并重启后使用。</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {operation.phase === 'failed' && operation.retryAvailable === true && (
          <Button data-setup-retry={operation.operationId} tone="secondary" disabled={busy || uncertain}
            onClick={() => void session.retryVoice(operation)}>已处理开通问题，准备重试</Button>
        )}
        {operation.demoAvailable && (
          <Button data-setup-sample={operation.operationId} tone="secondary" disabled={busy}
            onClick={() => void session.loadSample(operation, 'demo')}>加载试听音频</Button>
        )}
        {operation.activationAvailable && (
          <Button tone="secondary" disabled={busy} onClick={() => void session.loadSample(operation, 'activation')}>加载正式样音</Button>
        )}
        {['prepared', 'clone_ready'].includes(operation.phase) && (
          <Button data-setup-cancel={operation.operationId} tone="danger" disabled={busy}
            onClick={() => void session.cancelVoice(operation)}>取消此方案</Button>
        )}
      </div>
      <Help>更新于 {new Date(operation.updatedAt).toLocaleString('zh-CN')} · 方案编号 {key}</Help>
    </article>
  )
}

// -------------------------------------------------------------------- finish

function FinishPanel({ session, state }: SessionProps) {
  const data = state.data!
  const busy = !!state.write
  const blockers = session.finishBlockers()
  const dirty = settingsChanged(state.settingsBase, state.settingsDraft)
  return (
    <Panel id="setup-finish" title="完成初始化">
      {blockers.length
        ? (
          <div className="space-y-2">
            <Notice tone="warning">以下项目完成后才能准备启动：</Notice>
            <ul className="list-disc space-y-1 pl-6 text-sm text-ink-600">
              {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
            </ul>
          </div>
        )
        : <p className="text-sm text-ink-600">初始化条件已满足。准备配置后，请重新启动桌宠。</p>}
      <div>
        <Button id="setup-finish" disabled={!session.canFinish() || busy} onClick={() => void session.finish()}>
          {state.write === 'finish' ? '准备中…' : '完成设置，准备重启'}
        </Button>
      </div>
      {dirty && !state.settingsConflict && <Help>模型配置还有未保存的修改，保存后才能准备启动。</Help>}
      {(state.activationReady || data.initialization.completed) && (
        <Notice>
          <p>在安装目录的终端中执行以下命令，随后使用原启动入口：</p>
          <code className="mt-2 block rounded-xl bg-white/70 p-2 text-xs">npm run configure-local -- --activate-existing</code>
        </Notice>
      )}
      <Help>
        工程任务需要另外安装并登录执行器：
        {' '}<ExternalLink label="DeepSeek Harness" url={data.links.harness} />
        {' · '}<ExternalLink label="Codex" url={data.links.codex} />
        。未安装时，对应任务转发不可用。
      </Help>
    </Panel>
  )
}
