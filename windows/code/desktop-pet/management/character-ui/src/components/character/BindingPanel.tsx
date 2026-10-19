// LUI-02: 模型 / 语音高级参数绑定。
//
// 真实契约（`management/provider-source-routes.ts`）：
//  * `GET  /api/characters/bindings?characterId=` → `{ apiVersion, configuration, selections, readErrors, effective }`
//  * `POST /api/provider-sources`               → 登记一个来源实例 + 模型配置（**先**注册）
//  * `PUT  /api/characters/bindings`            → 写绑定（`expectedRevision` + `operationId`）
//  * `POST /api/provider-sources/discover`      → 只读模型列表（只接受凭据引用或 `auth:'none'`）
//  * `GET  /api/snapshot`                       → 适配器目录与凭据列表
//
// 页面必须保留的语义：`inherit-default`/`own` 两种来源方式；`own` 时先注册来源再写绑定；
// 同一 body 的重试复用同一个 operationId；写后回读；`readErrors` 逐槽显示而不是显示成空；
// `savedRevision`/`effectiveRevision` 与「重启后生效」文案。
import { useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { ADVANCED_KEYS, createCharacterSession, draftFromView, isConflict, messageOf, type BindingDraft, type BindingView, type OperationHolder, type SlotId } from './session'
import { ErrorNotice, Field, Panel, SaveRow, SelectField, SuccessNotice, Unavailable } from './primitives'

const session = createCharacterSession(runtime)

const SLOT_TITLES: Record<SlotId, string> = { dialogue: 'LLM · 对话', tts: 'TTS · 文字转语音', stt: 'STT · 语音转文字' }
const SLOT_API: Record<SlotId, 'dialogue' | 'tts' | 'asr'> = { dialogue: 'dialogue', tts: 'tts', stt: 'asr' }

export default function BindingsPanel({ characterId, slots }: { characterId: string; slots: SlotId[] }) {
  const loaded = useAsync(() => session.loadBindings(characterId), [characterId], undefined)
  if (loaded.error) return <ErrorNotice message={`读取 API 配置失败：${loaded.error}`} />
  if (!loaded.data) return <Spinner />
  return (
    <BindingsEditor
      key={characterId}
      characterId={characterId}
      slots={slots}
      view={loaded.data.view}
      adapters={loaded.data.adapters}
      credentials={loaded.data.credentials}
      onView={next => loaded.setData({ ...loaded.data!, view: next })}
    />
  )
}

function BindingsEditor({ characterId, slots, view, adapters, credentials, onView }: {
  characterId: string; slots: SlotId[]; view: BindingView; adapters: any[]; credentials: any[]; onView: (next: BindingView) => void
}) {
  const savedRevision = view.configuration?.savedRevision
  const effectiveRevision = view.configuration?.effectiveRevision
  const pendingRestart = typeof savedRevision === 'number' && typeof effectiveRevision === 'number' && savedRevision !== effectiveRevision
  return (
    <Panel
      title="API 配置"
      description="三组能力分别配置：STT 转文字 → LLM 回复 → TTS 播放。每组保存都是独立事务，保存后重启生效。"
      extra={<span className="chip bg-slate-100 text-ink-500">保存修订 {savedRevision} / 生效修订 {effectiveRevision}</span>}
    >
      {pendingRestart && <Notice>绑定已保存为 v{savedRevision}，当前进程仍在使用 v{effectiveRevision}；重启桌宠后生效。</Notice>}
      {slots.map(slot => (
        <BindingCard
          key={`${characterId}:${slot}`}
          characterId={characterId}
          slot={slot}
          view={view}
          adapters={adapters}
          credentials={credentials}
          onView={onView}
        />
      ))}
    </Panel>
  )
}

function BindingCard({ characterId, slot, view, adapters, credentials, onView }: {
  characterId: string; slot: SlotId; view: BindingView; adapters: any[]; credentials: any[]; onView: (next: BindingView) => void
}) {
  const [draft, setDraft] = useState<BindingDraft>(() => draftFromView(view, slot))
  const [models, setModels] = useState<{ id: string; label?: string }[]>([])
  const [discovery, setDiscovery] = useState({ busy: false, stale: false, message: '', error: '' })
  const [save, setSave] = useState({ busy: false, message: '', error: '', conflict: '' })
  const [applied, setApplied] = useState('')
  const holder = useRef<OperationHolder>({})
  // CUX-03：凭据写入与绑定写入是**两个** holder。共用会让两阶段互相覆盖 operationId，
  // 造成重试时重复存 Key。
  const credentialHolder = useRef<OperationHolder>({})
  /**
   * CUX-03：已保存凭据「属于哪一个连接」。
   *
   * 更换端点/provider 时不得把旧凭据静默发给新地址。初始视图里的引用是服务端按当前连接解析出来的，
   * 因此初始就视为已确认；连接一变即进入待确认。
   */
  const [confirmedConnection, setConfirmedConnection] = useState(() => `${draftFromView(view, slot).selection.endpoint || ''}\u0000${draftFromView(view, slot).selection.provider || ''}`)

  const apiSlot = SLOT_API[slot]
  const available = useMemo(
    () => adapters.filter((item: any) => (item.slots || []).includes(apiSlot) && item.status === 'available'),
    [adapters, apiSlot],
  )
  const adapter = available.find((item: any) => item.id === draft.selection.adapterId)
  const readError = draftFromView(view, slot).readError
  const effective = view.effective?.capabilities?.[apiSlot]
  const own = draft.mode === 'own'
  const hasNewKey = String(draft.key || '').trim().length > 0
  const connectionKey = `${draft.selection.endpoint || ''}\u0000${draft.selection.provider || ''}`
  const storedCredential = String(draft.selection.credentialRef || '')
  /** 连接变更后旧引用进入「待确认」：不能自动发给新目标。 */
  const credentialStaleForConnection = Boolean(storedCredential) && confirmedConnection !== connectionKey
  /** 实际可用于本次发现的引用：新 Key 优先；连接变更后的旧引用必须先显式复用。 */
  const effectiveCredentialRef = credentialStaleForConnection ? '' : storedCredential
  // 免 Key 与「有可用凭据」时按钮语义不同：只有新 Key 才会先落盘。
  const keyWillBeSaved = own && hasNewKey && draft.selection.auth !== 'none'

  const patch = (values: Record<string, any>) => setDraft(current => ({ ...current, selection: { ...current.selection, ...values }, error: '', message: '' }))

  /**
   * CUX-03：连接信息变更后，已有模型列表立即过期（不从旧服务闪回）。
   *
   * 更换端点/provider 时**不**把旧凭据静默发给新地址：旧引用进入待确认状态，用户必须重新填 Key
   * 或在 Key 区显式复用。
   */
  function patchConnection(values: Record<string, any>) {
    setDraft(current => ({ ...current, selection: { ...current.selection, ...values }, error: '', message: '' }))
    setModels([])
    setDiscovery(current => ({ ...current, stale: true, message: '', error: '' }))
  }

  function chooseAdapter(id: string) {
    const next = available.find((item: any) => item.id === id)
    // A REVIEWED preset carries its own tariff. An OPEN adapter (`openai-compatible-text`) does not,
    // and the server requires the usage/price bounds on every `own` selection — seeding from this
    // slot's current selection (the effective configuration) keeps real values instead of sending an
    // incomplete selection that the server can only refuse with a generic error.
    const reviewed = next?.choices?.[0]?.configuration ? structuredClone(next.choices[0].configuration) : undefined
    setDraft(current => ({
      ...current,
      mode: 'own',
      selection: {
        ...(reviewed ?? { ...current.selection, provider: next?.provider ?? current.selection.provider ?? 'openai', protocol: id.startsWith('gemini') ? 'gemini' : 'openai-compatible' }),
        adapterId: id, credentialRef: '', key: '', auth: next?.auth === 'none' ? 'none' : 'credentialRef',
      },
      error: '', message: '',
    }))
    setModels([])
    setDiscovery({ busy: false, stale: true, message: '', error: '' })
  }

  async function discover() {
    // 连接变更后旧引用待确认：不得静默发给新地址。前端直接说明，不发必失败请求。
    // 常驻 Notice 已经解释了原因，这里只补一句「下一步做什么」，不重复同一段文案。
    if (credentialStaleForConnection && !hasNewKey) {
      setDiscovery({ busy: false, stale: true, message: '', error: '已取消发送：请先重新填写 API Key，或在「已有凭据」中显式选择复用。' })
      return
    }
    setDiscovery({ busy: true, stale: false, message: '', error: '' })
    try {
      const result = await session.discoverForDraft({
        characterId, slot,
        // 只把**本次连接可用**的引用交给发现编排；新 Key 仍优先。
        draft: { ...draft, selection: { ...draft.selection, credentialRef: effectiveCredentialRef } },
        credentialOperation: credentialHolder.current,
        onCredentialSaved: receipt => {
          // 回执在发现**开始之前**到达：立刻清空明文草稿，并把新引用写进本次草稿。
          // 成功保存 Key 后，来源或绑定再失败也不会把 Key 留在输入框里。
          setDraft(current => ({ ...current, key: '', selection: { ...current.selection, credentialRef: receipt.credentialRef } }))
        },
      })
      if (result.credentialRef) {
        patch({ credentialRef: result.credentialRef })
        // 这次引用确认属于当前连接；之后换地址会再次进入待确认。
        setConfirmedConnection(connectionKey)
      }
      setModels(result.items)
      if (result.phase === 'success') {
        setDiscovery({
          busy: false, stale: false, error: '',
          message: result.items.length
            ? `已获取 ${result.items.length} 个模型，选择后保存。`
            : '服务返回空模型列表，可手填模型。',
        })
      } else if (result.phase === 'cancelled') {
        setDiscovery({ busy: false, stale: true, message: '', error: '获取模型已取消；已保存的凭据与草稿都保留。' })
      } else {
        // 凭据已持久化但发现失败：明确区分「Key 已保存在本机」与「获取模型失败」。
        setDiscovery({
          busy: false, stale: true, message: '',
          error: result.credentialSaved
            ? `Key 已保存在本机；获取模型失败：${result.error || '未知原因'}。下次只需重试获取模型。`
            : `获取模型失败：${result.error || '未知原因'}`,
        })
      }
    } catch (error) {
      setDiscovery({ busy: false, stale: true, message: '', error: `获取模型失败：${messageOf(error)}` })
    }
  }

  async function persist() {
    setSave({ busy: true, message: '', error: '', conflict: '' })
    try {
      const result = await session.saveBinding({
        characterId, slot, draft,
        expectedRevision: view.configuration.savedRevision,
        holder: holder.current,
      })
      if (result.view) onView(result.view)
      if (result.outcome === 'confirmed') {
        // 只有 confirmed 才替换草稿并显示成功；不再强行保留旧 draft.mode。
        setDraft(result.draft)
        holder.current = {}
        setModels([])
        setDiscovery({ busy: false, stale: false, message: '', error: '' })
        const applyOn = result.writeReceipt?.applyOn
        setSave({
          busy: false, conflict: '', error: '',
          message: `${applyOn === 'restart' ? '绑定已保存并回读，重启后生效。' : '绑定已保存并回读。'}${result.concurrentChanges ? '（期间有其他更改一并保存。）' : ''}`,
        })
        setApplied(`保存修订 ${result.writeReceipt?.savedRevision} / 生效修订 ${result.writeReceipt?.effectiveRevision}`)
        return
      }
      // 非 confirmed：**保留草稿与凭据引用**，明确说明写入与回读各处在什么状态。
      // 重读不重复 POST 来源、不重复 PUT 绑定 —— 只刷新视图。
      const prefix = result.outcome === 'written-unconfirmed' ? '写入已完成，回读未确认'
        : result.outcome === 'superseded' ? '写入已完成，随后配置又发生变化'
          : '写入结果未知'
      setSave({ busy: false, conflict: '', message: '', error: `${prefix}：${result.reason}` })
    } catch (error) {
      // 409 不是普通失败：草稿必须保留，提示刷新而不是静默覆盖。
      setSave({
        busy: false, message: '',
        error: isConflict(error) ? '' : `保存失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 当前草稿已保留，请刷新后合并再保存。` : '',
      })
    }
  }

  /** 显式重新读取：只刷新视图，不重发来源登记、不重发绑定写入。 */
  async function reload() {
    setSave(current => ({ ...current, busy: true, message: '', error: '', conflict: '' }))
    try {
      const fresh = await session.loadBindings(characterId)
      onView(fresh.view)
      const next = draftFromView(fresh.view, slot)
      // 保留用户尚未提交的编辑字段，只同步读取到的错误。
      setDraft(current => ({ ...current, readError: next.readError, error: '', message: '' }))
      setSave({ busy: false, message: '已重新读取服务端配置。', error: '', conflict: '' })
    } catch (error) {
      setSave(current => ({ ...current, busy: false, message: '', error: `重新读取失败：${messageOf(error)}` }))
    }
  }

  const busy = save.busy
  const advanced = ADVANCED_KEYS[slot]
  const voiceField = slot === 'tts' ? (
    <Field id={`binding-${slot}-voice`} label="音色 · Voice" value={String(draft.selection.voice ?? '')} disabled={busy || !own} onChange={v => patch({ voice: v })} />
  ) : null
  const languageField = adapter?.capabilities?.language ? (
    <Field id={`binding-${slot}-language`} label="语言 · Language" value={String(draft.selection.language ?? '')} disabled={busy || !own} onChange={v => patch({ language: v })} />
  ) : null

  return (
    <section className="space-y-4 rounded-3xl border border-slate-100 p-5" aria-label={SLOT_TITLES[slot]}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-bold">{SLOT_TITLES[slot]}</h3>
        <span className="chip bg-slate-100 text-ink-500">{applied || (own ? '此角色独立来源' : '沿用全局默认')}</span>
      </div>
      <p className="text-xs text-ink-500">
        {readError ? '已保存配置：读取失败。' : `已保存配置：${view.selections?.[apiSlot]?.model || '沿用默认'} · ${view.selections?.[apiSlot]?.endpoint || '默认来源'}`}
      </p>
      <p className="text-xs text-ink-500">{effective ? `当前生效：${effective.model} · ${effective.endpoint}` : '该角色当前未运行，生效配置以重启后为准。'}</p>
      {/* 读失败逐槽显示，绝不渲染成「没有配置」。 */}
      {readError && <ErrorNotice message={readError} />}

      <SelectField
        id={`binding-${slot}-mode`}
        label="来源方式"
        value={draft.mode}
        disabled={busy}
        options={[['inherit-default', '显式继承全局默认'], ['own', '角色独立来源']]}
        onChange={value => setDraft(current => ({ ...current, mode: value as BindingDraft['mode'], error: '', message: '' }))}
      />

      {own && <>
        {available.length === 0 && <Unavailable>本机没有可用于该槽位的适配器；未接入不等于可用，这里不显示替代来源。</Unavailable>}
        <SelectField
          id={`binding-${slot}-adapter`}
          label="服务 / 适配器"
          value={draft.selection.adapterId || ''}
          disabled={busy}
          options={[['', '请选择服务'], ...available.map((item: any) => [item.id, item.label] as [string, string])]}
          onChange={chooseAdapter}
        />
        <SelectField
          id={`binding-${slot}-protocol`}
          label="协议"
          value={draft.selection.protocol || 'openai-compatible'}
          disabled={busy}
          options={slot === 'dialogue' ? [['openai-compatible', 'OpenAI compatible'], ['gemini', 'Gemini']] : [['openai-compatible', 'OpenAI compatible']]}
          onChange={value => patchConnection({ protocol: value })}
        />
        <Field id={`binding-${slot}-endpoint`} label="服务端点 · Endpoint" value={String(draft.selection.endpoint ?? '')} disabled={busy} placeholder="https://…/v1/chat/completions" onChange={v => patchConnection({ endpoint: v })} />
        <Field id={`binding-${slot}-provider`} label="供应商标识" value={String(draft.selection.provider ?? '')} disabled={busy} onChange={v => patchConnection({ provider: v })} />
        <SelectField
          id={`binding-${slot}-auth`}
          label="鉴权"
          value={draft.selection.auth || 'credentialRef'}
          disabled={busy || adapter?.auth === 'none'}
          options={[['credentialRef', '使用 API Key'], ['none', '本机免 Key 服务']]}
          onChange={value => patch({ auth: value, key: '', ...(value === 'none' ? { credentialRef: '' } : {}) })}
        />
        {draft.selection.auth !== 'none' && <>
          <SelectField
            id={`binding-${slot}-credential`}
            label="已有凭据"
            value={storedCredential}
            disabled={busy}
            options={[['', '填写新 Key 或选择已保存凭据'],
              ...credentials.filter((item: any) => item.provider === draft.selection.provider && item.status === 'configured').map((item: any) => [item.id, item.label] as [string, string]),
              ...(storedCredential && !credentials.some((item: any) => item.id === storedCredential)
                ? [[storedCredential, '本角色已保存凭据'] as [string, string]] : [])]}
            // 显式选择即视为「确认在这个连接上复用它」，清除待确认状态。
            onChange={value => { patch({ credentialRef: value }); setConfirmedConnection(connectionKey) }}
          />
          {/* CUX-03：连接变更后旧引用待确认 —— 明确提示，不静默发往新地址。 */}
          {credentialStaleForConnection && (
            <Notice>服务地址或供应商已变更，已保存的凭据不会自动发送到新地址。请重新填写 API Key，或在上方「已有凭据」中显式选择复用。</Notice>
          )}
          {/* 明文 Key 只存在于组件内存，保存成功后立即清空；不进 URL、不进 storage、不进日志。 */}
          <Field id={`binding-${slot}-key`} label="新 API Key（选填，留空保留已有凭据）" type="password" value={draft.key} disabled={busy} onChange={v => setDraft(current => ({ ...current, key: v }))} />
        </>}
        <details>
          <summary className="cursor-pointer text-sm text-ink-600">模型列表地址（可选）</summary>
          <div className="mt-3"><Field id={`binding-${slot}-models-endpoint`} label="Models Endpoint" value={String(draft.selection.modelsEndpoint ?? '')} disabled={busy} onChange={v => patch({ modelsEndpoint: v })} /></div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" id={`binding-${slot}-discover`} className="rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
            disabled={busy || discovery.busy || !draft.selection.endpoint || String(draft.selection.endpoint).startsWith('local:')}
            onClick={() => void discover()}>
            {discovery.busy ? '正在获取模型…' : keyWillBeSaved ? '保存 Key 并获取模型' : '获取模型'}
          </button>
          {discovery.message && <span className="text-xs text-ink-500">{discovery.message}</span>}
        </div>
        {/* CUX-03：告知必须在**点击前**可见，不用事后 toast 代替。 */}
        {keyWillBeSaved && <p className="text-xs text-ink-500" id={`binding-${slot}-key-notice`}>新 Key 会保存到本机凭据库；获取模型不会保存角色绑定。</p>}
        {!keyWillBeSaved && draft.selection.auth !== 'none' && !draft.selection.credentialRef && <p className="text-xs text-ink-400">获取模型需要一个已保存的本机凭据：填写新 Key，或在「已有凭据」中选择。</p>}
        {discovery.error && <ErrorNotice message={discovery.error} />}
        {discovery.stale && models.length > 0 && <Notice>来源已变化或获取失败，旧列表不可用于当前来源。</Notice>}
        {models.length > 0 && (
          <SelectField
            id={`binding-${slot}-models`}
            label="选择获取到的模型"
            value={String(draft.selection.model ?? '')}
            disabled={busy || discovery.stale}
            options={[['', '请选择模型'], ...models.map(item => [item.id, item.label || item.id] as [string, string])]}
            onChange={value => patch({ model: value })}
          />
        )}
      </>}

      <Field id={`binding-${slot}-model`} label="模型 · Model" value={String(draft.selection.model ?? '')} disabled={busy || !own} onChange={v => patch({ model: v })} />
      {voiceField}
      {languageField}

      {own && (
        <details open={advanced.some(([key]) => draft.selection[key] === undefined)}>
          <summary className="cursor-pointer text-sm text-ink-600">高级参数与计费</summary>
          <p className="mt-2 text-xs text-ink-400">自定义服务请填写实际参数；费率沿用已有配置，不自动估价。</p>
          <div className="mt-3 grid grid-cols-2 gap-4">
            {advanced.map(([key, label]) => (
              <Field key={key} id={`binding-${slot}-${key}`} label={label} type="number" min={0} step="any"
                value={draft.selection[key] === undefined ? '' : String(draft.selection[key])} disabled={busy}
                onChange={v => patch({ [key]: v === '' ? undefined : Number(v) })} />
            ))}
          </div>
        </details>
      )}

      {draft.error && <ErrorNotice message={draft.error} />}
      <SuccessNotice message={save.message} />
      <ErrorNotice message={save.error} />
      {save.conflict && <Notice>{save.conflict}</Notice>}
      {/* CUX-04：写入未确认时提供显式「重新读取」；它只回读，不重发来源登记或绑定写入。 */}
      {save.error && !save.conflict && (
        <button type="button" id={`binding-${slot}-reload`} disabled={busy} onClick={() => void reload()}
          className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40">重新读取服务端配置</button>
      )}
      <SaveRow
        busy={busy}
        disabled={own && !draft.selection.adapterId}
        onClick={() => void persist()}
        note={save.conflict ? '存在冲突，草稿已保留。' : `保存 ${SLOT_TITLES[slot]} 只作用于本槽位，并等待服务确认。`}
      >保存绑定</SaveRow>
    </section>
  )
}
