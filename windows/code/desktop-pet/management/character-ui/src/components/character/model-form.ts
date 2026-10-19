// CUX-06: dialogue 模型页的投影与草稿构造（纯函数，可脱离浏览器断言）。
//
// 为什么单独成模块：模型页只常驻五项（Endpoint / API Key / 获取模型 / 模型选择 / 保存），但后端
// `validateManagedSettings` 要求的字段远不止五项。隐藏字段必须**原样继承**，不能因为 UI 简化就丢掉
// 已审核 adapter 的 tariff、protocol、modelsEndpoint 或预算。
//
// 契约（SPEC §3）：
//   * `projectModelForm(view)` 产出**显示值**与隐藏的原始 selection；
//   * `buildModelDraft(form)` 产出既有 `BindingDraft`，继续交给 `saveBinding` 校验/登记/写入；
//   * 本模块**不**直接 PUT 全量角色配置，也不复制 session 的写入逻辑。
//
// 关键不变量：
//   * 初始读取用 saved binding + `selections.dialogue`，**不用**默认 DeepSeek 兜底；
//   * 原 `own` 且用户未编辑的字段原样保留；
//   * 原 `inherit-default` 仅打开/发现**不改变 mode**；只有用户真的编辑了可见字段才转 `own`；
//   * endpoint 变化时清理旧 modelsEndpoint / 旧模型列表，旧 credentialRef 进入待确认；
//   * 不根据 URL 或模型名猜 provider（不把 ofm 假标成 dashscope 或 deepseek）。

/** 全新自定义连接使用的通用 provider 标识：只是本机分组，不声称为任何厂商。 */
export const CUSTOM_PROVIDER = 'custom-openai'
/** 通用 OpenAI-compatible 文本适配器。 */
export const OPEN_ADAPTER = 'openai-compatible-text'
/** 通用 provider 标识的合法形状（与后端 `isProviderId` 一致）。 */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/

/** 预算/上界字段：同连接必须原样保留，不能因 UI 简化而丢。 */
export const BUDGET_KEYS = ['inputTokenLimit', 'outputTokenLimit', 'reservationMicros', 'inputMicrosPerToken', 'outputMicrosPerToken'] as const
/** 只在同连接保留的可支持参数。 */
const CARRIED_KEYS = ['thinking', 'temperature', 'modelsEndpoint', 'auth', 'voice', 'language', 'characterMicros', 'audioMicrosPerSecond'] as const

export interface ModelFormCredential { id: string; label: string; provider: string }

/** 模型页的显示状态 + 隐藏基线。 */
export interface ModelFormState {
  /** `inherit-default` 表示当前沿用默认配置；用户编辑可见字段后由调用方置为 `own`。 */
  mode: 'own' | 'inherit-default'
  endpoint: string
  model: string
  /** 明文 Key：**永不回填**，只由用户输入。 */
  key: string
  /** 生效的凭据引用（可能是继承来的）。 */
  credentialRef: string
  auth: 'credentialRef' | 'none'
  /** 显式勾选「此本机服务不需要 Key」。 */
  noKey: boolean
  /** 折叠区是否展开「更换/使用已有 Key」。 */
  useExisting: boolean
  /** 可复用的已配置凭据（带登记 provider）。 */
  credentials: ModelFormCredential[]
  /** 隐藏基线：用户未编辑的字段从这里原样带过去。 */
  baseline: Record<string, any>
  /** 基线所属连接，用来判断「是否换了地址」。 */
  baselineEndpoint: string
  /** 读取错误逐槽显示，绝不用默认值兜底。 */
  readError: string
}

export interface ModelDraftPlan {
  draft: { mode: 'own' | 'inherit-default'; selection: Record<string, any>; key: string; readError: string; error: string; message: string }
  /** 保存前必须让用户看到的说明（例如「保存为此角色配置」）。 */
  notes: string[]
  /** 非空表示**明确阻止保存**并指出缺失项；不得填任意数字或放宽校验求通过。 */
  blocked: string
  /** 本次提交是否会被登记为角色独立来源。 */
  becomesOwn: boolean
}

/** 一个 endpoint 是否与基线指向同一连接（去掉 query/hash 与尾部斜杠后比较）。 */
export function sameConnection(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      const url = new URL(String(value || ''))
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
    } catch { return String(value || '').trim().replace(/\/+$/, '') }
  }
  return normalize(left) === normalize(right)
}

/** 从适配器目录里找出能服务该 endpoint 的通用适配器。 */
function openAdapterFor(adapters: any[], slot: 'dialogue'): any | undefined {
  return adapters.find(item => item.id === OPEN_ADAPTER && (item.slots || []).includes(slot))
}

/**
 * 读出一个槽位的**当前有效选择**。
 *
 * 优先用服务端解析好的 `selections[slot]`；读失败的槽位是 `null`，此时返回 `{}` 并保留 readError，
 * **不**填任何默认来源 —— 这正是「不用默认 DeepSeek 兜底」的要求。
 */
function currentSelection(view: any, apiSlot: string): Record<string, any> {
  const selection = view?.selections?.[apiSlot]
  return selection && typeof selection === 'object' ? { ...selection } : {}
}

/**
 * 投影模型页的显示状态。
 *
 * `view` 是 `GET /api/characters/bindings` 的响应；`adapters`/`credentials` 来自 `GET /api/snapshot`。
 */
export function projectModelForm(view: any, credentials: any[] = []): ModelFormState {
  const stored = view?.configuration?.bindings?.dialogue
  const selection = currentSelection(view, 'dialogue')
  const mode: 'own' | 'inherit-default' = stored?.mode === 'own' ? 'own' : 'inherit-default'
  const readError = view?.readErrors?.dialogue || ''
  const usable = credentials
    .filter(item => item && item.status === 'configured' && typeof item.id === 'string' && PROVIDER_ID.test(String(item.provider || '')))
    .map(item => ({ id: String(item.id), label: String(item.label || item.id), provider: String(item.provider) }))
  // 保存的引用可能来自本角色自己的来源（不在已配置列表里），仍必须能回显。
  const savedRef = String(stored?.credentialRef || selection.credentialRef || '')
  const credentialRef = savedRef
  const listed = usable.some(item => item.id === credentialRef)
  if (credentialRef && !listed) usable.push({ id: credentialRef, label: '本角色已保存凭据', provider: String(selection.provider || '') })
  return {
    mode,
    // 显示值：saved/effective 解析出来的 endpoint 与 model；读失败时为空而不是默认 DeepSeek。
    endpoint: String(selection.endpoint ?? ''),
    model: String(selection.model ?? ''),
    key: '',
    credentialRef,
    auth: selection.auth === 'none' ? 'none' : 'credentialRef',
    noKey: selection.auth === 'none',
    useExisting: false,
    credentials: usable,
    baseline: selection,
    baselineEndpoint: String(selection.endpoint ?? ''),
    readError,
  }
}

/** 用户是否编辑了会改变连接身份的可见字段。 */
export function connectionChanged(form: ModelFormState): boolean {
  return !sameConnection(form.endpoint, form.baselineEndpoint)
}

/** `buildModelDraft` 需要适配器目录来判断通用适配器；调用方显式传入，不用模块级可变状态。 */
export interface ModelFormContext {
  adapters: any[]
  /**
   * 该引用是否已在**当前 endpoint** 上确认过（用户刚保存了新 Key，或显式选择了复用）。
   *
   * 没有它，用户成功「保存 Key 并获取模型」之后，表单仍会把引用当成「属于旧连接」而丢弃，
   * 于是保存按钮继续显示「请填写新的 API Key」——这正是把一次成功说成未完成。
   */
  credentialConfirmedForEndpoint?: boolean
}

/**
 * 依据当前表单构造提交计划。
 *
 * 返回 `blocked` 非空时调用方**必须**阻止保存并显示原因，不得用任意数字或放宽校验绕过。
 */
export function buildModelDraft(form: ModelFormState, context: ModelFormContext, options: { touched?: boolean } = {}): ModelDraftPlan {
  const notes: string[] = []
  const baseline = form.baseline || {}
  const endpoint = String(form.endpoint || '').trim()
  const model = String(form.model || '').trim()
  const key = String(form.key || '')
  const changed = connectionChanged(form)
  const touched = options.touched === true

  // 未编辑任何可见字段的继承配置：保存为「无改动」，不改变 mode。
  if (form.mode === 'inherit-default' && !touched && !key) {
    return {
      draft: { mode: 'inherit-default', selection: {}, key: '', readError: form.readError, error: '', message: '' },
      notes: ['当前沿用默认配置，本次没有可保存的改动。'],
      blocked: '', becomesOwn: false,
    }
  }

  if (!endpoint) {
    return {
      draft: { mode: 'inherit-default', selection: {}, key: '', readError: form.readError, error: '', message: '' },
      notes, blocked: '请填写服务端点 Endpoint。', becomesOwn: false,
    }
  }

  // 免 Key 只由用户显式勾选；空 Key 不等于免鉴权。
  const authNone = form.noKey === true
  const selection: Record<string, any> = { ...baseline }
  selection.endpoint = endpoint

  if (changed) {
    // 换连接：清理只对旧连接成立的字段，避免把旧值静默带到新目标。
    for (const carried of CARRIED_KEYS) delete selection[carried]
    // 不根据 URL 猜 provider；全新连接用合法的通用标识。
    selection.provider = CUSTOM_PROVIDER
    const open = openAdapterFor(context.adapters, 'dialogue')
    selection.adapterId = open?.id || OPEN_ADAPTER
    selection.protocol = 'openai-compatible'
    notes.push(`保存为此角色配置：${CUSTOM_PROVIDER} 只是本机分组标识，不代表任何厂商。`)
  }

  // 已审核 adapter 只允许同 provider；通用 adapter 允许用户显式选择的凭据 provider。
  const chosen = form.useExisting && form.credentialRef
    ? form.credentials.find(item => item.id === form.credentialRef)
    : undefined
  if (chosen) {
    // 显式复用：使用该凭据登记的 provider，不凭显示名称推断。
    if (PROVIDER_ID.test(chosen.provider)) selection.provider = chosen.provider
    selection.credentialRef = chosen.id
    notes.push('已显式选择复用已有凭据；它会发送到当前填写的服务地址。')
  } else if (form.credentialRef && (!changed || context.credentialConfirmedForEndpoint)) {
    // 引用可用：同连接直接沿用；换连接但已在新地址上确认过（刚保存新 Key）也沿用。
    // 少了后半句，用户成功「保存 Key 并获取模型」之后会被继续要求重新填写。
    selection.credentialRef = form.credentialRef
  } else if (changed) {
    // 换了地址又没确认过：旧引用进入待确认，不自动发送。
    delete selection.credentialRef
  }
  if (!selection.provider || !PROVIDER_ID.test(String(selection.provider))) {
    return { draft: { mode: 'own', selection: {}, key, readError: form.readError, error: '', message: '' }, notes, blocked: '供应商标识无效：请使用小写字母/数字/连字符（例如 custom-openai）。', becomesOwn: true }
  }

  if (authNone) {
    selection.auth = 'none'
    selection.credentialRef = ''
  } else {
    delete selection.auth
    if (!key && !selection.credentialRef) {
      return { draft: { mode: 'own', selection: {}, key, readError: form.readError, error: '', message: '' }, notes, blocked: '请填写新的 API Key，或在 Key 区域选择已有凭据；本机免 Key 服务请显式勾选。', becomesOwn: true }
    }
  }

  // 预算/上界：同连接原值保留；缺失时明确阻止，不填任意数字、不切 unlimited。
  if (!authNone) {
    const missing = BUDGET_KEYS.filter(field => selection[field] === undefined || selection[field] === null)
    if (missing.length) {
      return {
        draft: { mode: 'own', selection: {}, key, readError: form.readError, error: '', message: '' },
        notes,
        blocked: `缺少本机调用策略（${missing.join('、')}）：无法为这个服务确定调用上界与预留。请先在已通过校验的配置上确认本机限制，不要填任意数字或关闭校验。`,
        becomesOwn: true,
      }
    }
  }

  selection.model = model
  if (form.mode === 'inherit-default') notes.unshift('保存为此角色配置（当前沿用默认配置，编辑后会转为本角色独立来源）。')
  return {
    draft: { mode: 'own', selection, key, readError: form.readError, error: '', message: '' },
    notes, blocked: '', becomesOwn: true,
  }
}
