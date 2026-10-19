// LUI-02: 角色高级编辑的读/写语义，从旧 `management/ui/roles-session.mjs` 逐条迁移到 React 前端。
//
// 本文件刻意不依赖 React 或 DOM：写入契约（expectedRevision、operationId 复用、409 保留草稿、
// 写后回读、readErrors 逐槽、运行/非运行角色的形象写入分离）可以在没有浏览器的情况下被直接断言，
// 页面只负责渲染回执。
//
// 从旧实现保留的规则（每一条都有对应测试）：
//  * `mode: 'inherit-default' | 'own'`；`own` 时**先** `POST /api/provider-sources` 登记来源，**再**
//    用返回的 sourceInstanceId/modelProfileId 写 `PUT /api/characters/bindings`。
//  * 同一 body 重试复用同一个 `operationId`；body 变了才换新 id（`operationFor`）。
//  * 写后回读：每次保存成功后重新 `GET` 对应 owner，采用服务端返回的 revision，不本地猜。
//  * 读失败逐槽显示（`readErrors`），绝不把失败渲染成「空」。
//  * 409 保留用户草稿并提示刷新，不静默重载覆盖。
//  * 非运行角色的形象写入只改该角色 saved 配置，绝不调用全局激活。
//
// 只消费真实管理 API；本模块不新增 `runtime.ts` 的具名包装，调用方用 `createCharacterSession(runtime)`
// 注入生产客户端。
//
// 本文件**不 import 任何模块**：它必须在纯 Node 下可断言（`tests/ui-rework/character-config-session.test.mjs`），
// 而 `services/runtime` 在 import 时会读 `window.location`/`sessionStorage`。

/** 客户端形状；生产传 `runtime`，测试传同形状的假客户端。 */
export interface ManagementClient {
  request: (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; responseType?: 'bytes' }) => Promise<any>
}

/** 一个操作编号对应一次尝试；重试复用同一个 id，让服务端可以按 id 去重。 */
export const newOperationId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(16).slice(2)}`

/** 绑定槽位：UI 用 `stt`，接口用 `asr`。 */
export type SlotId = 'dialogue' | 'tts' | 'stt'
export type ApiSlot = 'dialogue' | 'tts' | 'asr'
export const apiSlotOf = (slot: SlotId): ApiSlot => (slot === 'stt' ? 'asr' : slot)

/** 一次写入的身份：body 没变就沿用同一个 operationId，body 变了才换新 id。 */
export interface OperationHolder {
  signature?: string
  operationId?: string
}

export function operationFor(holder: OperationHolder, body: unknown): string {
  const signature = JSON.stringify(body)
  if (holder.signature !== signature || !holder.operationId) {
    holder.signature = signature
    holder.operationId = newOperationId()
  }
  return holder.operationId
}

/** 409 与普通失败必须分开：冲突要保留草稿，普通失败只报告错误。 */
export const isConflict = (error: unknown): boolean => (error as { status?: number } | null)?.status === 409

/** 用户/页面取消：不是服务端失败，不能据此说「没有写入」。 */
export const isCancelled = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'AbortError'
  || (error as { name?: string } | null)?.name === 'TimeoutError'
  || (error as { message?: string } | null)?.message === '预览已取消。'

/**
 * CUX-03：结果未知的失败（超时/断线/取消）。
 *
 * 取消与超时**可能已经完成服务器写入**，所以不得声称已撤销或自动删除服务器凭据；只能提示
 * 「凭据保存结果待确认」并让调用方用同一 operationId 重试或回读。
 */
export const isOutcomeUnknown = (error: unknown): boolean => {
  const status = (error as { status?: number } | null)?.status
  // 4xx/409 是明确的服务器回答；0/未设置说明没有拿到 HTTP 状态。
  if (typeof status === 'number' && status >= 400) return false
  return true
}

/** 把接口错误转成页面文案，不吞掉真实原因。 */
export const messageOf = (error: unknown): string => (error as Error | null)?.message || '操作未完成'

/**
 * CUX-04：两个绑定的逐字段对照。
 *
 * 接受服务器**补全** `parameters`（own 时服务端会把来源里的参数写回绑定），但拒绝 owner/slot/mode/
 * 引用不一致。只比较模型名是不够的 —— 这正是原问题里「看起来保存了、其实不是这次提交」的盲区。
 */
export function bindingMismatch(expected: any, actual: any): string[] {
  const problems: string[] = []
  const left = expected ?? null, right = actual ?? null
  const modeOf = (value: any) => (value?.mode === 'own' ? 'own' : value?.mode === 'inherit-default' ? 'inherit-default' : null)
  if (modeOf(left) !== modeOf(right)) problems.push(`来源方式 ${modeOf(left) ?? '缺失'} → ${modeOf(right) ?? '缺失'}`)
  if (modeOf(left) === 'own') {
    for (const key of ['sourceInstanceId', 'modelProfileId', 'credentialRef'] as const) {
      const a = left?.[key] ?? '', b = right?.[key] ?? ''
      if (a !== b) problems.push(`${key} ${a || '空'} → ${b || '空'}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------- 绑定

export interface BindingView {
  apiVersion?: number
  configuration: any
  selections: Record<string, any>
  readErrors?: Record<string, string>
  effective?: any
}

export interface BindingLoad {
  view: BindingView
  /** 适配器目录（`GET /api/snapshot` 的 adapters）。 */
  adapters: any[]
  credentials: any[]
}

/** 每个槽位的草稿：来源方式、选择内容、明文 Key 只留在内存里。 */
export interface BindingDraft {
  mode: 'inherit-default' | 'own'
  selection: Record<string, any>
  key: string
  readError: string
  error: string
  message: string
}

export const draftFromView = (view: BindingView, slot: SlotId): BindingDraft => {
  const name = apiSlotOf(slot)
  const stored = view.configuration?.bindings?.[name]
  const selection = { ...(view.selections?.[name] || {}) }
  return {
    mode: stored?.mode === 'own' ? 'own' : 'inherit-default',
    selection,
    key: '',
    readError: view.readErrors?.[name] || '',
    error: '',
    message: '',
  }
}

/** 空字符串的选填参数在发送前删除，避免把「未填写」写成一个空值。 */
const OPTIONAL_SELECTION_KEYS = ['voice', 'language', 'temperature'] as const

/** 高级参数与计费字段：与旧 `role-api-view.mjs` 的清单一致。 */
export const ADVANCED_KEYS: Record<SlotId, [string, string][]> = {
  dialogue: [['inputTokenLimit', '输入 token 上限'], ['outputTokenLimit', '输出 token 上限'], ['reservationMicros', '每次调用预留（微元）'], ['inputMicrosPerToken', '输入费率（微元/token）'], ['outputMicrosPerToken', '输出费率（微元/token）']],
  tts: [['inputTokenLimit', '输入 token 上限'], ['outputTokenLimit', '输出 token 上限'], ['reservationMicros', '每次调用预留（微元）'], ['inputMicrosPerToken', '输入费率（微元/token）'], ['outputMicrosPerToken', '输出费率（微元/token）'], ['characterMicros', '语音费率（微元/字符）']],
  stt: [['inputTokenLimit', '输入 token 上限'], ['outputTokenLimit', '输出 token 上限'], ['reservationMicros', '每次调用预留（微元）'], ['inputMicrosPerToken', '输入费率（微元/token）'], ['outputMicrosPerToken', '输出费率（微元/token）'], ['audioMicrosPerSecond', '音频费率（微元/秒）']],
}

export function createCharacterSession(client: ManagementClient) {
  const request: ManagementClient['request'] = (path, options) => client.request(path, options)

  /** 读取一个角色的绑定视图与适配器目录（`readErrors` 原样保留给页面逐槽显示）。 */
  async function loadBindings(characterId: string, signal?: AbortSignal): Promise<BindingLoad> {
    const [view, snapshot] = await Promise.all([
      request(`/api/characters/bindings?characterId=${encodeURIComponent(characterId)}`, { signal }),
      request('/api/snapshot', { signal }),
    ])
    if (view?.apiVersion !== undefined && view.apiVersion !== 1) throw new Error(`绑定接口版本不支持：${view.apiVersion}`)
    return { view, adapters: snapshot?.adapters || [], credentials: snapshot?.credentials || [] }
  }

  /**
   * 录入一个新 Key（若用户填了）并返回可写入来源的 credentialRef。
   *
   * 同一个 (provider, key) 重试沿用同一个 operationId；保存成功后立刻清空本地明文。Key 只作为请求体，
   * 不进 URL、不进 localStorage/sessionStorage、不进日志。
   */
  async function ensureCredential(input: {
    selection: Record<string, any>
    key: string
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<{ credentialRef: string; keyCleared: boolean }> {
    const key = String(input.key || '').trim()
    if (!key || input.selection.auth === 'none') return { credentialRef: String(input.selection.credentialRef || ''), keyCleared: false }
    const snapshot = await request('/api/self-setup', { signal: input.signal })
    const signature = JSON.stringify([input.selection.provider, key])
    if (input.holder.signature !== `credential:${signature}`) {
      input.holder.signature = `credential:${signature}`
      input.holder.operationId = newOperationId()
    }
    const receipt = await request('/api/self-setup/credentials', {
      method: 'POST',
      signal: input.signal,
      body: {
        instanceId: snapshot.instanceId,
        provider: input.selection.provider,
        key,
        expectedRevision: snapshot.credentialRevision,
        operationId: input.holder.operationId,
      },
    })
    return { credentialRef: receipt.credentialRef, keyCleared: true }
  }

  /**
   * 保存一个槽位。
   *
   * 顺序是契约的一部分：`own` 时先登记来源（`POST /api/provider-sources`），成功后才写绑定；来源登记失败
   * 时绑定一个字节都不写，页面也就不会出现「绑定已保存但来源不存在」的假成功。
   *
   * CUX-04：返回的是一个**判别联合**，而不是「成功/异常」两态。
   *   * `writeReceipt` 是 PUT **自己返回**的 `configuration`，不再用随后 GET 的 revision 冒充它；
   *   * 写后 GET 与写回执逐字段对照，`confirmed` 才代表「本次提交被确认」；
   *   * PUT 2xx 但回读失败/回旧值/readError → `written-unconfirmed`（不抛错，页面据此提示重新读取）；
   *   * 目标槽位被后续写入改变 → `superseded`；
   *   * PUT 超时/断线 → `outcome-unknown`（不假设没有写入）。
   */
  async function saveBinding(input: {
    characterId: string
    slot: SlotId
    draft: BindingDraft
    expectedRevision: number
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<BindingSaveResult> {
    const { characterId, slot, draft } = input
    const name = apiSlotOf(slot)
    let binding: any = { mode: 'inherit-default' }
    let credentialRef: string | undefined
    if (draft.mode === 'own') {
      const selection: Record<string, any> = { ...draft.selection }
      const credential = await ensureCredential({ selection, key: draft.key, holder: input.holder, signal: input.signal })
      credentialRef = credential.credentialRef
      if (credentialRef) selection.credentialRef = credentialRef
      // Local-only draft fields must never reach the wire: `key` is the plaintext secret (it goes to
      // the credential endpoint, not here), and the server rejects a selection carrying unknown keys.
      delete selection.key
      for (const key of OPTIONAL_SELECTION_KEYS) {
        if (selection[key] === undefined || selection[key] === '') delete selection[key]
      }
      if (selection.auth === 'none') selection.credentialRef = ''
      const source = await request('/api/provider-sources', {
        method: 'POST',
        signal: input.signal,
        body: { characterId, slot: name, selection },
      })
      binding = {
        mode: 'own',
        sourceInstanceId: source.entry.source.sourceId,
        modelProfileId: source.entry.profile.modelProfileId,
        ...(source.entry.source.auth.kind === 'credentialRef' ? { credentialRef: source.entry.source.auth.ref } : {}),
      }
    }
    const body = { characterId, expectedRevision: input.expectedRevision, bindings: { [name]: binding } }
    const operationId = operationFor(input.holder, body)

    let receipt: any
    try {
      receipt = await request('/api/characters/bindings', {
        method: 'PUT',
        signal: input.signal,
        body: { ...body, operationId },
      })
    } catch (error) {
      // 超时/断线没有回执：写入**可能**已经发生。不得假设没有写入，也不得声称已回滚。
      if (isOutcomeUnknown(error) && !isConflict(error)) {
        return {
          outcome: 'outcome-unknown', stage: 'binding-write', reason: `写入结果未知：${messageOf(error)}`,
          view: await readBackQuietly(characterId, input.signal),
          draft, credentialRef, operationId,
        }
      }
      throw error
    }

    // 写回执：服务端在 PUT 响应里直接返回 configuration，这才是本次提交的凭据。
    const writeConfiguration = receipt?.configuration
    const writeReceipt: BindingSaveReceipt = {
      savedRevision: writeConfiguration?.savedRevision,
      effectiveRevision: writeConfiguration?.effectiveRevision,
      applyOn: receipt?.applyOn || 'restart',
      binding: writeConfiguration?.bindings?.[name],
      selection: undefined,
      readError: '',
    }
    // 提交内容与服务器规范化结果对照：接受服务器补全 parameters，拒绝 owner/slot/mode/引用不符。
    const mismatch = bindingMismatch(binding, writeReceipt.binding)
    if (mismatch.length) {
      return {
        outcome: 'written-unconfirmed', stage: 'binding-write',
        reason: `写入回执与提交内容不一致（${mismatch.join('、')}），不能确认本次提交。`,
        writeReceipt, view: await readBackQuietly(characterId, input.signal),
        draft, credentialRef, operationId,
      }
    }

    // 写后回读：与**写回执**对照，而不是与本地草稿对照。
    let fresh: BindingLoad
    try {
      fresh = await loadBindings(characterId, input.signal)
    } catch (error) {
      return {
        outcome: 'written-unconfirmed', stage: 'readback',
        reason: `写入已完成，回读未确认（${messageOf(error)}），请重新读取。`,
        writeReceipt, view: undefined as unknown as BindingView,
        draft, credentialRef, operationId,
      }
    }
    const readbackBinding = fresh.view.configuration?.bindings?.[name]
    const readError = fresh.view.readErrors?.[name] || ''
    const next = draftFromView(fresh.view, slot)
    const readback: BindingSaveReadback = {
      savedRevision: fresh.view.configuration?.savedRevision,
      effectiveRevision: fresh.view.configuration?.effectiveRevision,
      binding: readbackBinding,
      selection: next.selection,
      readError,
      view: fresh.view,
    }

    if (readError) {
      return {
        outcome: 'written-unconfirmed', stage: 'readback',
        reason: `写入已完成，回读报告读取失败：${readError}`,
        writeReceipt, readback, view: fresh.view, draft, credentialRef, operationId,
      }
    }
    const readbackMismatch = bindingMismatch(writeReceipt.binding, readbackBinding)
    if (readbackMismatch.length) {
      // 目标槽位已被后续写入改变：保留本次提交副本，不宣称回读一致。
      return {
        outcome: 'superseded', stage: 'readback',
        reason: `写入已完成，随后配置又发生了变化（${readbackMismatch.join('、')}）。本次提交的内容已保留在写回执中。`,
        writeReceipt, readback, view: fresh.view, draft, credentialRef, operationId,
      }
    }
    if (typeof readback.savedRevision === 'number' && typeof writeReceipt.savedRevision === 'number'
      && readback.savedRevision < writeReceipt.savedRevision) {
      // 回读的修订比写回执还旧：这是一次陈旧响应，不是确认。
      return {
        outcome: 'superseded', stage: 'readback',
        reason: `回读到的修订（${readback.savedRevision}）早于写入回执（${writeReceipt.savedRevision}），这是一次陈旧读取，不能确认本次提交。`,
        writeReceipt, readback, view: fresh.view, draft, credentialRef, operationId,
      }
    }
    // 修订更大但目标槽位一致：允许确认，并记录「并发的其他更改」。
    const concurrent = typeof readback.savedRevision === 'number' && typeof writeReceipt.savedRevision === 'number'
      && readback.savedRevision > writeReceipt.savedRevision
    return {
      outcome: 'confirmed', stage: 'readback',
      reason: concurrent ? '本次提交已确认；期间有其他更改一并保存。' : '本次提交已确认。',
      concurrentChanges: concurrent,
      writeReceipt,
      readback,
      view: fresh.view,
      // confirmed 才用服务端回读的草稿替换本地草稿；不再强留旧 draft.mode。
      draft: draftFromView(fresh.view, slot),
      credentialRef, operationId,
    }
  }

  /** 回读失败时的兜底：尽最大努力拿一份视图，拿不到就返回 undefined。 */
  async function readBackQuietly(characterId: string, signal?: AbortSignal): Promise<BindingView> {
    try { return (await loadBindings(characterId, signal)).view } catch { return undefined as unknown as BindingView }
  }

  /** 模型发现。只接受凭据引用；免 Key 本机服务用 `auth: 'none'`。 */
  async function discoverModels(input: {
    characterId: string
    slot: SlotId
    protocol?: string
    endpoint: string
    modelsEndpoint?: string
    credentialRef?: string
    auth?: string
    signal?: AbortSignal
  }): Promise<{ items: { id: string; label?: string }[] }> {
    const result = await request('/api/provider-sources/discover', {
      method: 'POST',
      signal: input.signal,
      body: {
        characterId: input.characterId,
        slot: apiSlotOf(input.slot),
        protocol: input.protocol || 'openai-compatible',
        endpoint: input.endpoint,
        ...(input.modelsEndpoint ? { modelsEndpoint: input.modelsEndpoint } : {}),
        credentialRef: input.credentialRef || '',
        auth: input.auth || 'credentialRef',
      },
    })
    return { items: result.items || [] }
  }

  /**
   * CUX-03：把「新 Key」先转成本机 credentialRef，**再**发现模型。
   *
   * 为什么必须在这里做：`POST /api/provider-sources/discover` 有意只接受凭据引用（服务端
   * `ModelDiscovery.list` 会拒绝空引用）。用户填了新 Key 却没选「已有凭据」时，发现请求必然失败。
   * 修复方式是在发现之前用**已有的**凭据写入路径把它存成引用，而不是把明文 Key 送进发现请求。
   *
   * 分阶段契约（凭据持久化、来源登记、角色绑定是三个阶段，不是一笔原子事务）：
   *   * 新 Key 非空且 auth 不是 none → 先保存凭据，拿到 credentialRef；
   *   * `onCredentialSaved` 必须在发现**开始之前**回调，让 UI 立刻清空明文草稿；
   *   * 凭据成功后销毁 holder 里含明文 Key 的签名（不留驻内存）；
   *   * 发现失败时保留已确认的引用，**不**恢复明文，下次只重试发现；
   *   * 只调 `/api/provider-sources/discover`，不登记来源、不写绑定。
   *
   * 安全边界：明文 Key 只进入已有的同源凭据写入接口；绝不进发现、来源、绑定、URL、日志或 Web Storage。
   */
  async function discoverForDraft(input: {
    characterId: string
    slot: SlotId
    draft: BindingDraft
    /** 凭据保存**专用** holder：与绑定写入的 holder 分开，避免互相覆盖 operationId。 */
    credentialOperation: OperationHolder
    signal?: AbortSignal
    onPhase?: (phase: DiscoveryPhase) => void
    onCredentialSaved?: (receipt: CredentialSavedReceipt) => void
  }): Promise<DiscoverForDraftResult> {
    const { characterId, slot, draft } = input
    const selection: Record<string, any> = { ...draft.selection }
    const key = String(draft.key || '').trim()
    const auth = selection.auth || 'credentialRef'
    const phase = (value: DiscoveryPhase) => input.onPhase?.(value)

    const discover = async (credentialRef: string): Promise<DiscoverForDraftResult> => {
      phase('discovering')
      try {
        const result = await discoverModels({
          characterId, slot,
          protocol: selection.protocol,
          endpoint: selection.endpoint,
          modelsEndpoint: selection.modelsEndpoint,
          credentialRef,
          auth,
          signal: input.signal,
        })
        phase('success')
        return { phase: 'success', items: result.items, credentialRef, credentialSaved: Boolean(credentialRef) && key.length > 0 }
      } catch (error) {
        // 发现失败不丢凭据：调用方据此提示「Key 已保存在本机；获取模型失败」并只重试发现。
        phase(isCancelled(error) ? 'cancelled' : 'error')
        return {
          phase: isCancelled(error) ? 'cancelled' : 'error',
          items: [], credentialRef,
          credentialSaved: Boolean(credentialRef) && key.length > 0,
          error: messageOf(error),
        }
      }
    }

    // 免 Key 本机服务：不调用 credentials 接口，也不自动降低远端鉴权。
    if (auth === 'none') return discover('')

    // 新 Key 优先于已选择的凭据：必须按本次 provider 保存，不能发现偷偷用旧引用。
    if (!key) {
      const existing = String(selection.credentialRef || '')
      // 二者均无：前端直接说明，禁止发送一个必然失败的请求。
      if (!existing) {
        phase('error')
        return { phase: 'error', items: [], credentialRef: '', credentialSaved: false, error: '请先填写新的 API Key，或在「已有凭据」中选择一个已保存的凭据。' }
      }
      return discover(existing)
    }

    phase('savingCredential')
    let receipt: { credentialRef: string; keyCleared: boolean }
    try {
      receipt = await ensureCredential({ selection, key, holder: input.credentialOperation, signal: input.signal })
    } catch (error) {
      // 取消/超时/断线时没有回执，但服务器可能已经写入：不得声称已撤销，也不得清掉用户的输入。
      const unknown = isCancelled(error) || isOutcomeUnknown(error)
      phase(isCancelled(error) ? 'cancelled' : 'error')
      return {
        phase: isCancelled(error) ? 'cancelled' : 'error',
        items: [], credentialRef: '',
        credentialSaved: false,
        credentialOutcomeUnknown: unknown,
        error: unknown
          ? '凭据保存结果待确认：请求已发出但没有拿到回执，服务器可能已经写入。请用同一操作重试或回读，不要重复填写。'
          : `Key 保存失败：${messageOf(error)}`,
      }
    }
    const credentialRef = receipt.credentialRef
    if (!credentialRef) {
      phase('error')
      return { phase: 'error', items: [], credentialRef: '', credentialSaved: false, error: '凭据已提交但未返回可用的引用，请回读本机凭据后重试。' }
    }
    // 回执必须在发现开始**之前**交给 UI：清空明文草稿、销毁含 Key 的重试签名。
    // 这里同步清掉 holder 的签名，明文 Key 不再驻留内存。
    input.credentialOperation.signature = undefined
    input.credentialOperation.operationId = undefined
    input.onCredentialSaved?.({ credentialRef, saved: true })
    return discover(credentialRef)
  }

  // -------------------------------------------------------------- 本地能力诊断

  /** 只读检测本机本地能力。未接入时抛 `unavailable`，页面显示诚实不可用而不是 ready。 */
  async function loadLocalCapabilities(signal?: AbortSignal) {
    const view = await request('/api/roles/local-capabilities', { signal })
    return { apiVersion: view.apiVersion as number, observedAt: view.observedAt as string, capabilities: (view.capabilities || []) as LocalCapability[] }
  }

  // -------------------------------------------------------------- 故事书

  /** 读取该角色的故事书。「本机未装配」与「该角色没有书」是两种不同的诚实状态。 */
  async function loadLorebooks(characterId: string, signal?: AbortSignal): Promise<LorebookView> {
    const view = await request(`/api/characters/lorebooks?characterId=${encodeURIComponent(characterId)}`, { signal })
    return { apiVersion: view.apiVersion, characterId: view.characterId, books: view.books || [] }
  }

  /** 新建一本故事书。标题与 operationId 都先校验，只有服务端确认后才清空输入框。 */
  async function createLorebook(input: {
    characterId: string
    title: string
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<{ lorebook: Lorebook; created: boolean }> {
    const title = input.title.trim()
    if (!title) throw new Error('请填写故事书标题。')
    const body = { characterId: input.characterId, title }
    const operationId = operationFor(input.holder, body)
    const receipt = await request('/api/characters/lorebooks', { method: 'POST', signal: input.signal, body: { ...body, operationId } })
    return { lorebook: receipt.lorebook, created: receipt.created === true }
  }

  /** 条目操作：add / toggle / remove 是三次**不同**的真实调用。 */
  async function writeLorebookEntry(characterId: string, input: LorebookEntryOp, signal?: AbortSignal): Promise<Lorebook> {
    const base = `/api/characters/lorebooks/${encodeURIComponent(input.bookId)}`
    if (input.op === 'add') {
      const content = input.entry.content.trim()
      if (!content) throw new Error('请填写条目正文。')
      if (input.entry.strategy !== 'always' && !input.entry.keywords.length) throw new Error('关键词触发至少需要一个关键词。')
      const receipt = await request(base, {
        method: 'PUT',
        signal,
        body: {
          characterId,
          expectedRevision: input.expectedRevision,
          entries: [{ title: input.entry.title.trim() || '未命名条目', content, strategy: input.entry.strategy, keywords: input.entry.keywords }],
        },
      })
      return receipt.lorebook
    }
    const entryPath = `${base}/entries/${encodeURIComponent(input.entryId)}`
    // 只发送 `enabled`：服务端保留被省略的字段，一次开关不可能把作者写好的正文清空。
    const receipt = input.op === 'toggle'
      ? await request(entryPath, { method: 'PUT', signal, body: { characterId, expectedRevision: input.expectedRevision, entry: { enabled: input.enabled } } })
      : await request(entryPath, { method: 'DELETE', signal, body: { characterId, expectedRevision: input.expectedRevision } })
    return receipt.lorebook
  }

  /** 先 preview 再显式 confirm：preview 不写库，confirm 才提交一次事务。 */
  async function previewLorebookImport(characterId: string, book: unknown, signal?: AbortSignal) {
    const receipt = await request('/api/characters/lorebooks/import', { method: 'POST', signal, body: { characterId, book } })
    return { preview: receipt.preview as { title: string; entries: unknown[] }, entryCount: receipt.entryCount as number }
  }

  async function confirmLorebookImport(input: {
    characterId: string
    book: unknown
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<Lorebook> {
    const body = { characterId: input.characterId, book: input.book }
    const operationId = operationFor(input.holder, body)
    const receipt = await request('/api/characters/lorebooks/import/confirm', { method: 'POST', signal: input.signal, body: { ...body, operationId } })
    return receipt.lorebook
  }

  // -------------------------------------------------------------- 形象

  async function loadSkins(signal?: AbortSignal): Promise<SkinState> {
    const view = await request('/api/skins', { signal })
    if (view?.apiVersion !== 1) throw new Error('当前后端未提供外观登记接口。')
    return view
  }

  /**
   * 应用一个已登记形象。
   *
   * 运行角色走全局外观登记（带 expectedRevision）；**非运行角色只写该角色自己的 saved 配置**，绝不能调用
   * 全局激活翻转正在运行的形象。因此 `runningCharacterId` 必须来自服务端快照，而不是页面猜测。
   */
  async function applyAppearance(input: {
    characterId: string
    runningCharacterId: string
    resourceId: string
    type: 'live2d' | 'sprite'
    expectedRevision: number
    activeSkinId: string
    signal?: AbortSignal
  }): Promise<{ target: 'running' | 'saved'; message: string; state?: SkinState; revision?: number; unchanged?: boolean }> {
    if (!input.resourceId) throw new Error('请先选择形象资源。')
    if (input.characterId === input.runningCharacterId) {
      if (input.resourceId === input.activeSkinId) return { target: 'running', unchanged: true, message: '该形象已是当前生效形象。' }
      const next = await request(`/api/skins/${encodeURIComponent(input.resourceId)}/activate`, {
        method: 'POST',
        signal: input.signal,
        body: { expectedRevision: input.expectedRevision },
      })
      return { target: 'running', state: next, message: `形象已应用：${next.state?.activeSkinId || input.resourceId}` }
    }
    const receipt = await request('/api/characters/appearance', {
      method: 'PUT',
      signal: input.signal,
      body: { characterId: input.characterId, resourceId: input.resourceId, type: input.type },
    })
    return {
      target: 'saved',
      revision: receipt.revision,
      message: `角色形象已保存：${receipt.resourceId || input.resourceId}，下次该角色成为运行角色时生效。`,
    }
  }

  // -------------------------------------------------------------- 表现策略

  async function loadPresentation(signal?: AbortSignal): Promise<PresentationView> {
    const view = await request('/api/presentation', { signal })
    return { catalog: view.catalog, policy: view.policy }
  }

  /** 保存自动表现开关；`expectedRevision` 保留，409 时页面保留用户选择并提示刷新。 */
  async function savePresentation(input: { modelId: string; expectedRevision: number; enabledIds: string[]; signal?: AbortSignal }): Promise<PresentationView> {
    const view = await request('/api/presentation', {
      method: 'PUT',
      signal: input.signal,
      body: { modelId: input.modelId, expectedRevision: input.expectedRevision, enabledIds: input.enabledIds },
    })
    return { catalog: view.catalog, policy: view.policy }
  }

  // -------------------------------------------------------------- 角色资料

  /**
   * 保存作者元数据（简介/背景/开场白/示例对话）。
   *
   * 与旧实现一致：只发送本次编辑的字段；`operationId` 同一 body 重试复用；采用服务端返回的
   * `fieldRevision`，不本地推进。
   */
  async function saveAuthorMetadata(input: {
    characterId: string
    fields: Record<string, string | undefined>
    expectedFieldRevision: number
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<any> {
    const body: Record<string, unknown> = { characterId: input.characterId, expectedFieldRevision: input.expectedFieldRevision }
    for (const [key, value] of Object.entries(input.fields)) if (value !== undefined) body[key] = value
    const operationId = operationFor(input.holder, body)
    return request('/api/characters/profile', { method: 'PUT', signal: input.signal, body: { ...body, operationId } })
  }

  /** 保存人设正文：唯一权威是 prompt owner，采用它返回的 revision 作为下一次写入的游标。 */
  async function savePersona(input: {
    characterId: string
    text: string
    expectedRevision: number
    holder: OperationHolder
    signal?: AbortSignal
  }): Promise<any> {
    const body = { characterId: input.characterId, expectedRevision: input.expectedRevision, text: input.text }
    const operationId = operationFor(input.holder, body)
    return request('/api/prompt', { method: 'PUT', signal: input.signal, body: { ...body, operationId } })
  }

  return {
    request,
    loadBindings, draftFromView, saveBinding, discoverModels, discoverForDraft, ensureCredential,
    loadLocalCapabilities,
    loadLorebooks, createLorebook, writeLorebookEntry, previewLorebookImport, confirmLorebookImport,
    loadSkins, applyAppearance,
    loadPresentation, savePresentation,
    saveAuthorMetadata, savePersona,
  }
}

// ---------------------------------------------------------------- 类型

export interface BindingSaveReceipt {
  savedRevision: number
  effectiveRevision: number
  applyOn: string
  binding: any
  selection: any
  readError: string
}

// ---------------------------------------------------------------- CUX-04 保存确认

/** 写后回读的结果；与写回执分开保留，便于页面显示「写回执 vs 回读」的真实差异。 */
export interface BindingSaveReadback {
  savedRevision?: number
  effectiveRevision?: number
  binding: any
  selection: any
  readError: string
  view?: BindingView
}

/** 保存的四个真实结果。**只有 `confirmed` 表示「本次提交被确认」。** */
export type BindingSaveOutcome = 'confirmed' | 'written-unconfirmed' | 'superseded' | 'outcome-unknown'

export interface BindingSaveResult {
  outcome: BindingSaveOutcome
  /** 失败/未确认发生在哪一步，便于页面给出可操作的提示。 */
  stage: 'binding-write' | 'readback'
  reason: string
  /** 修订更大但目标槽位一致时为 true：确认并记录「并发的其他更改」。 */
  concurrentChanges?: boolean
  /** PUT 响应里返回的 configuration，本次提交的真实回执。 */
  writeReceipt?: BindingSaveReceipt
  readback?: BindingSaveReadback
  view?: BindingView
  /** `confirmed` 时是服务端回读的草稿；其他结果保留调用方原草稿。 */
  draft: BindingDraft
  credentialRef?: string
  operationId?: string
}

/** 只有 `confirmed` 才允许显示成功。 */
export const isConfirmed = (result: BindingSaveResult): boolean => result.outcome === 'confirmed'

// ---------------------------------------------------------------- CUX-03 发现编排

/** 发现流程的阶段：UI 据此显示诚实的分阶段状态，而不是一个笼统的「失败」。 */
export type DiscoveryPhase = 'idle' | 'savingCredential' | 'discovering' | 'success' | 'error' | 'cancelled'

/** 凭据已落盘的回执；调用方必须在发现开始前据此清空明文草稿。 */
export interface CredentialSavedReceipt {
  credentialRef: string
  saved: boolean
}

export interface DiscoverForDraftResult {
  phase: DiscoveryPhase
  items: { id: string; label?: string }[]
  credentialRef: string
  /** 本次调用是否真的把新 Key 存进了本机凭据库。 */
  credentialSaved: boolean
  /** 取消/超时导致结果未知：不得声称已撤销，也不得清掉用户输入。 */
  credentialOutcomeUnknown?: boolean
  error?: string
}

export interface LocalCapability {
  capabilityId: string
  adapterId: string
  availability: 'ready' | 'unavailable' | 'unsupported'
  reason: string
  voices?: { id: string; label: string }[]
  languages?: string[]
  resourceRef?: string
}

export interface LorebookEntry {
  id: string
  title: string
  enabled: boolean
  strategy: 'keyword' | 'always'
  keywords: string[]
  content: string
  revision: number
  order: number
}

export interface Lorebook {
  schemaVersion: 1
  id: string
  ownerCharacterId: string
  title: string
  revision: number
  entries: LorebookEntry[]
}

export interface LorebookView {
  apiVersion: number
  characterId: string
  books: Lorebook[]
}

export interface SkinState {
  apiVersion: number
  state: { schemaVersion: number; revision: number; activeSkinId: string; skins: any[] }
}

export interface PresentationView {
  catalog: { schemaVersion: number; modelId: string; modelFingerprint: string; items: any[] }
  policy: { modelId: string; revision: number; enabledIds: string[] }
}

export type LorebookEntryOp =
  | { op: 'add'; bookId: string; expectedRevision: number; entry: { title: string; content: string; strategy: 'keyword' | 'always'; keywords: string[] } }
  | { op: 'toggle'; bookId: string; entryId: string; expectedRevision: number; enabled: boolean }
  | { op: 'remove'; bookId: string; entryId: string; expectedRevision: number }

// ---------------------------------------------------------------- 纯函数

/**
 * 用服务端返回的**整本书**替换本地副本。
 *
 * 服务端每次条目写入都返回整本书，所以本地只保留一个真相来源；把本地乐观修改合并进去会让一次被拒绝的
 * 写入看起来已经生效。
 */
export function replaceBook(books: Lorebook[], lorebook: Lorebook | undefined): Lorebook[] {
  if (!lorebook) return books
  const at = books.findIndex(book => book.id === lorebook.id)
  return at === -1 ? [...books, lorebook] : books.map((book, index) => (index === at ? lorebook : book))
}

export const splitKeywords = (value: string): string[] =>
  value.split(/[,，]/).map(part => part.trim()).filter(Boolean)
