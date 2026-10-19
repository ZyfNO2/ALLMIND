// CUX-06: dialogue 模型页的最小表单。
//
// 常驻五项（SPEC §2）：服务端点 Endpoint、API Key、获取模型、模型选择（可手填）、保存。
// 隐藏：来源方式下拉、服务/适配器、协议、供应商标识、独立已有凭据下拉、模型列表地址、
// 高级参数与计费、数字修订 chip。
//
// 隐藏字段**不丢**：由 `model-form.ts` 的 `projectModelForm` / `buildModelDraft` 原样继承，
// 输出仍是既有 `BindingDraft`，继续交给 `session.saveBinding` 校验/登记/写入。
// 本组件**不**直接 PUT 全量角色配置，也不复制 session 的写入逻辑。
import { useMemo, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { createCharacterSession, isConflict, messageOf, type BindingView, type OperationHolder, type SlotId } from './session'
import { buildModelDraft, projectModelForm, sameConnection, type ModelFormState } from './model-form'
import { ErrorNotice, Field, Panel, SaveRow, SelectField, SuccessNotice } from './primitives'

const session = createCharacterSession(runtime)
const SLOT: SlotId = 'dialogue'

export default function ModelPanel({ characterId }: { characterId: string }) {
  const loaded = useAsync(() => session.loadBindings(characterId), [characterId], undefined)
  if (loaded.error) return <ErrorNotice message={`读取模型配置失败：${loaded.error}`} />
  if (!loaded.data) return <Spinner />
  return (
    <ModelEditor
      key={characterId}
      characterId={characterId}
      view={loaded.data.view}
      adapters={loaded.data.adapters}
      credentials={loaded.data.credentials}
      onView={next => loaded.setData({ ...loaded.data!, view: next })}
    />
  )
}

function ModelEditor({ characterId, view, adapters, credentials, onView }: {
  characterId: string; view: BindingView; adapters: any[]; credentials: any[]; onView: (next: BindingView) => void
}) {
  const initial = useMemo(() => projectModelForm(view, credentials), [view, credentials])
  const [form, setForm] = useState<ModelFormState>(initial)
  // 用户是否编辑过可见字段：只有真的编辑了才把 inherit-default 转成 own。
  const [touched, setTouched] = useState(false)
  const [models, setModels] = useState<{ id: string; label?: string }[]>([])
  const [discovery, setDiscovery] = useState({ busy: false, stale: false, message: '', error: '' })
  const [save, setSave] = useState({ busy: false, message: '', error: '', conflict: '' })
  // RUX-02: the explicit「保存并重启」flow and its「立即重启」companion entry. `restarting` only
  // becomes true AFTER the save was confirmed AND the host acknowledged the restart request; a failed
  // save or a refused restart never flips it, and the page keeps the saved configuration.
  const [restart, setRestart] = useState({ busy: false, requested: false, error: '' })
  const holder = useRef<OperationHolder>({})
  const credentialHolder = useRef<OperationHolder>({})
  // RUX-02: persist() records whether THIS call was confirmed; persistAndRestart reads it afterwards.
  const lastSaveConfirmed = useRef(false)
  /**
   * 已确认「凭据属于哪个连接」。
   *
   * 初始值取自读到的基线连接（服务端就是按它解析出这个引用的）。用户换地址后，旧引用进入待确认；
   * 只有在**新地址上**重新填 Key 保存成功、或显式选择复用之后，才更新为当前地址。
   * 没有这个状态，用户在成功「保存 Key 并获取模型」之后再次点获取会被误拦。
   */
  const [confirmedEndpoint, setConfirmedEndpoint] = useState(() => initial.baselineEndpoint)

  const edit = (values: Partial<ModelFormState>) => { setTouched(true); setForm(current => ({ ...current, ...values })) }
  const plan = useMemo(
    () => buildModelDraft(form, { adapters, credentialConfirmedForEndpoint: sameConnection(form.endpoint, confirmedEndpoint) }, { touched }),
    [form, adapters, touched, confirmedEndpoint],
  )
  const hasNewKey = String(form.key || '').trim().length > 0
  const keyWillBeSaved = hasNewKey && !form.noKey
  /** 旧引用是否还不属于当前地址：属于则不拦。 */
  const credentialPendingForThisEndpoint = Boolean(form.credentialRef) && !sameConnection(form.endpoint, confirmedEndpoint)

  async function discover() {
    // 换地址又没显式复用、也没在新地址上确认过凭据：不得把旧凭据静默发给新目标。
    if (credentialPendingForThisEndpoint && !hasNewKey && !(form.useExisting && form.credentialRef)) {
      setDiscovery({ busy: false, stale: true, message: '', error: '服务地址已变更，已保存的凭据不会自动发送到新地址。请重新填写 API Key，或展开「更换 / 使用已有 Key」显式选择复用。' })
      return
    }
    setDiscovery({ busy: true, stale: false, message: '', error: '' })
    try {
      const result = await session.discoverForDraft({
        characterId,
        slot: SLOT,
        draft: {
          mode: 'own',
          selection: {
            ...plan.draft.selection,
            endpoint: String(form.endpoint || '').trim(),
            // 只把「已属于当前地址」的引用交给发现编排；新 Key 仍然优先。
            // 注意用 credentialPendingForThisEndpoint 而不是 changedConnection：前者在用户
            // 于新地址上成功保存 Key 后会解除，后者在整个会话里一直是 true（除非真的保存绑定）。
            credentialRef: form.useExisting ? form.credentialRef : (credentialPendingForThisEndpoint ? '' : form.credentialRef),
          },
          key: form.key,
          readError: form.readError, error: '', message: '',
        },
        credentialOperation: credentialHolder.current,
        onCredentialSaved: receipt => {
          // 回执在发现开始前到达：立刻清空明文并把新引用写进表单。
          setForm(current => ({ ...current, key: '', credentialRef: receipt.credentialRef }))
        },
      })
      if (result.credentialRef) {
        setForm(current => ({ ...current, credentialRef: result.credentialRef }))
        // 这个引用是在**当前**地址上确认的；之后的「获取模型」重试不再被拦。
        setConfirmedEndpoint(String(form.endpoint || ''))
      }
      setModels(result.items)
      if (result.phase === 'success') {
        setDiscovery({
          busy: false, stale: false, error: '',
          message: result.items.length ? `已获取 ${result.items.length} 个模型，选择或手填后保存。` : '服务返回空模型列表，可手填模型。',
        })
      } else if (result.phase === 'cancelled') {
        setDiscovery({ busy: false, stale: true, message: '', error: '获取模型已取消；已保存的凭据与草稿都保留。' })
      } else {
        setDiscovery({
          busy: false, stale: true, message: '',
          // 服务端文案可能自带句号；这里统一去掉尾部的「。」再拼，避免出现「。。」。
          error: result.credentialSaved
            ? `Key 已保存在本机；获取模型失败：${String(result.error || '未知原因').replace(/。+$/, '')}。下次只需重试获取模型。`
            : `获取模型失败：${result.error || '未知原因'}`,
        })
      }
    } catch (error) {
      setDiscovery({ busy: false, stale: true, message: '', error: `获取模型失败：${messageOf(error)}` })
    }
  }

  async function persist() {
    // 明确阻止：缺预算基线、缺 Key、缺 Endpoint 时不得保存，也不填任意数字求通过。
    lastSaveConfirmed.current = false
    if (plan.blocked) {
      setSave({ busy: false, message: '', conflict: '', error: plan.blocked })
      return
    }
    setSave({ busy: true, message: '', error: '', conflict: '' })
    try {
      const result = await session.saveBinding({
        characterId, slot: SLOT, draft: plan.draft,
        expectedRevision: view.configuration.savedRevision,
        holder: holder.current,
      })
      if (result.view) onView(result.view)
      if (result.outcome === 'confirmed') {
        lastSaveConfirmed.current = true
        const next = projectModelForm(result.view!, credentials)
        setForm(next)
        setTouched(false)
        setConfirmedEndpoint(next.baselineEndpoint)
        holder.current = {}
        setModels([])
        setDiscovery({ busy: false, stale: false, message: '', error: '' })
        const applyOn = result.writeReceipt?.applyOn
        setSave({
          busy: false, conflict: '', error: '',
          message: `${applyOn === 'restart' ? '已保存，重启后生效。' : '已保存。'}${result.concurrentChanges ? '（期间有其他更改一并保存。）' : ''}`,
        })
        return
      }
      const prefix = result.outcome === 'written-unconfirmed' ? '写入已完成，回读未确认'
        : result.outcome === 'superseded' ? '写入已完成，随后配置又发生变化'
          : '写入结果未知'
      setSave({ busy: false, conflict: '', message: '', error: `${prefix}：${result.reason}` })
    } catch (error) {
      setSave({
        busy: false, message: '',
        error: isConflict(error) ? '' : `保存失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 草稿已保留，请重新读取后再保存。` : '',
      })
    }
  }

  async function reload() {
    setSave(current => ({ ...current, busy: true, message: '', error: '', conflict: '' }))
    try {
      const fresh = await session.loadBindings(characterId)
      onView(fresh.view)
      const next = projectModelForm(fresh.view, credentials)
      // 保留用户尚未提交的可见编辑，只同步读取结果与错误。
      setForm(current => ({ ...next, endpoint: current.endpoint || next.endpoint, model: current.model || next.model, key: current.key }))
      setSave({ busy: false, message: '已重新读取服务端配置。', error: '', conflict: '' })
    } catch (error) {
      setSave(current => ({ ...current, busy: false, message: '', error: `重新读取失败：${messageOf(error)}` }))
    }
  }

  /**
   * RUX-02: ask the desktop host to restart the managed backend. Only an explicit user action calls
   * this; the host's bounded shutdown (EOF → timeout kill) drains the old instance before the new one
   * spawns, and the page then reloads to read the fresh instance. Any failure keeps the page usable
   * with the saved configuration still intact.
   */
  async function restartNow(notice: (message: string) => void) {
    setRestart({ busy: true, requested: false, error: '' })
    try {
      await runtime.restartDesktop()
      setRestart({ busy: true, requested: true, error: '' })
      notice('宿主已确认重启；正在重新加载管理页面…')
      // The old backend is going away; give the shutdown a beat so the reload lands on the NEW instance
      // instead of racing the dying one.
      setTimeout(() => { window.location.reload() }, 1200)
    } catch (error) {
      setRestart({ busy: false, requested: false, error: `重启请求未完成：${messageOf(error)}。已保存的配置仍然有效，可以稍后重试或手动重启桌宠。` })
    }
  }

  /** RUX-02: 保存 → 确认后才重启。保存失败/冲突/未知结果一律不重启。 */
  async function persistAndRestart() {
    setRestart({ busy: false, requested: false, error: '' })
    await persist()
    // persist() writes its own receipt into `save`; only a CONFIRMED save may trigger the restart.
    if (lastSaveConfirmed.current) await restartNow(message => setSave(current => ({ ...current, message })))
  }

  const busy = save.busy
  const pendingRestart = typeof view.configuration?.savedRevision === 'number' && typeof view.configuration?.effectiveRevision === 'number'
    && view.configuration.savedRevision !== view.configuration.effectiveRevision
  const own = form.mode === 'own'

  return (
    <Panel title="模型" description="只配置这一个角色使用的对话模型；保存后重启生效。">
      {pendingRestart && (
        <Notice>
          已保存为 v{view.configuration.savedRevision}，当前进程仍在使用 v{view.configuration.effectiveRevision}；重启桌宠后生效。
          <button type="button" id="model-restart-now" className="ml-2 underline text-aika-600" disabled={restart.busy}
            onClick={() => void restartNow(message => setSave(current => ({ ...current, message })))}>
            {restart.busy ? '正在重启…' : '立即重启'}
          </button>
        </Notice>
      )}
      {restart.error && <ErrorNotice message={restart.error} />}
      {form.readError && <ErrorNotice message={form.readError} />}
      {!own && <p className="text-xs text-ink-500">当前沿用默认配置。编辑下面的端点、Key 或模型并保存后，会转为本角色独立配置。</p>}
      {own && <p className="text-xs text-ink-500">本角色使用独立配置。</p>}

      <Field id="model-endpoint" label="服务端点 · Endpoint" value={form.endpoint} disabled={busy} placeholder="https://…/v1/chat/completions"
        hint="支持 base URL 或完整调用地址；不会被自动改写。"
        onChange={v => { edit({ endpoint: v }); setModels([]); setDiscovery(current => ({ ...current, stale: true, message: '', error: '' })) }} />

      {/* Key 区域：明文永不回填；同一区域提供「更换 / 使用已有 Key」折叠选择。 */}
      {!form.noKey && <>
        <Field id="model-key" label="API Key" type="password" value={form.key} disabled={busy}
          placeholder={form.credentialRef ? '已保存，留空保留' : '填写 API Key'}
          onChange={v => edit({ key: v })} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" id="model-key-toggle" className="text-xs text-aika-600 underline" onClick={() => setForm(current => ({ ...current, useExisting: !current.useExisting }))}>
            {form.useExisting ? '收起已有 Key' : '更换 / 使用已有 Key'}
          </button>
          {form.credentialRef && !form.useExisting && <span className="text-xs text-ink-400">已保存，留空保留。</span>}
        </div>
        {form.useExisting && (
          <SelectField id="model-credential" label="使用已有 Key" value={form.credentialRef} disabled={busy}
            options={[['', '不使用已有 Key'], ...form.credentials.map(item => [item.id, `${item.label}（${item.provider}）`] as [string, string])]}
            hint="显式选择后会复用它的登记 provider，并把它发送到上面填写的服务地址。"
            onChange={value => { edit({ credentialRef: value }); setConfirmedEndpoint(String(form.endpoint || '')) }} />
        )}
      </>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" id="model-no-key" checked={form.noKey} disabled={busy}
          onChange={event => edit({ noKey: event.target.checked, key: '', ...(event.target.checked ? { credentialRef: '' } : {}) })} />
        <span>此本机服务不需要 Key（仅限回环地址）</span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" id="model-discover" className="rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40"
          disabled={busy || discovery.busy || !form.endpoint}
          onClick={() => void discover()}>
          {discovery.busy ? '正在获取模型…' : keyWillBeSaved ? '保存 Key 并获取模型' : '获取模型'}
        </button>
        {discovery.message && <span className="text-xs text-ink-500">{discovery.message}</span>}
      </div>
      {keyWillBeSaved && <p className="text-xs text-ink-500" id="model-key-notice">新 Key 会保存到本机凭据库；获取模型不会保存角色绑定。</p>}
      {discovery.error && <ErrorNotice message={discovery.error} />}

      {/* RUX-05: ONE model control. Discovery candidates fill the same input's datalist; picking one
          writes into the editable field and the field keeps showing the choice. Manual entry always
          wins — the datalist is a convenience, never a second value holder. The stale flag stays: an
          edited endpoint invalidates old candidates, and the hint says so in place. */}
      <label className="block" htmlFor="model-name">
        <span className="mb-2 block text-sm text-ink-600">模型</span>
        <input id="model-name" aria-label="模型" type="text" className="soft-input" list="model-candidates"
          value={form.model} disabled={busy} placeholder="填写模型 ID，或从获取到的候选中选择"
          onChange={e => edit({ model: e.target.value })} />
        <datalist id="model-candidates">
          {models.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
        </datalist>
        <small className="mt-1 block text-xs text-ink-400">
          {models.length > 0
            ? (discovery.stale
              ? '候选列表来自之前的获取；修改服务地址后请重新获取。'
              : `已获取 ${models.length} 个候选：点击输入框可选择，也可直接手填。`)
            : '先填写服务地址与 Key 并「获取模型」，或直接手填模型 ID。'}
        </small>
      </label>

      {plan.notes.length > 0 && !plan.blocked && <Notice>{plan.notes.join(' ')}</Notice>}
      {plan.blocked && <ErrorNotice message={plan.blocked} />}
      {/* 一次成功的「保存 Key 并获取模型」之后，不能再用「请填写新的 API Key」否定它：
          那条提示只在用户**还没有**任何可用引用时才有意义。 */}
      {!own && touched && <p className="text-xs text-ink-400">保存后会成为本角色的独立配置（不再沿用默认）。</p>}

      <SuccessNotice message={save.message} />
      <ErrorNotice message={save.error} />
      {save.conflict && <Notice>{save.conflict}</Notice>}
      {(save.error || save.conflict) && (
        <button type="button" id="model-reload" disabled={busy} onClick={() => void reload()}
          className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40">重新读取服务端配置</button>
      )}
      {/* RUX-02: 普通保存只写配置；「保存并重启」是显式主操作，确认成功后才重启。 */}
      <SaveRow busy={busy || restart.busy} disabled={Boolean(plan.blocked)} onClick={() => void persist()}
        note={plan.blocked ? '缺少必要信息，暂不能保存。' : '保存只作用于本角色的对话槽位。'}>保存</SaveRow>
      <SaveRow busy={busy || restart.busy} disabled={Boolean(plan.blocked)} onClick={() => void persistAndRestart()}
        note={restart.requested ? '宿主已确认，正在重启…' : '保存确认成功后立即重启桌宠，使新配置生效。'}>保存并重启</SaveRow>
    </Panel>
  )
}
