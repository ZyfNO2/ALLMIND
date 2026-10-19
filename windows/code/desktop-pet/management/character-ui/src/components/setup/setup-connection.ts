/**
 * LUI-01: the first-run setup session — one client + state machine around the real
 * `/api/self-setup` endpoints, ported from the retired `management/ui/self-setup-view.mjs`.
 *
 * Rules that must not be lost in the move:
 *  - `instanceId` / `operationId` / `expectedRevision` all survive; a retry reuses the same
 *    operation id, and a changed body gets a new one.
 *  - `costConsent` is sent only as an explicit `true` after a user action; nothing is sent while the
 *    box is unchecked.
 *  - `unknown` / `transport_unknown` / dropped connections are never retried automatically; the
 *    operation stays disabled until the user refreshes and the server reports a new revision.
 *  - a 409 keeps the user's draft and asks for a refresh instead of silently overwriting it.
 *  - the key field is cleared after a save, and the receipt only ever shows the last six characters
 *    of the credential reference. The key itself never reaches a URL, the console or web storage.
 *  - audio is decoded offline and converted locally; a successful upload means "saved on this
 *    machine", never "sent to the cloud".
 */
import { ApiError, runtime } from '../../services/runtime'
import {
  MAX_REFERENCE_BYTES, PHASES, SAFE_ERRORS, UNCONFIRMED_OUTCOME, bindingsValid, deepEqual, encodeSetupReference,
  operationKey, snapshotProblem, snapshotStale, text, validOperation, validReference, validSettings,
  type ManagedSettings, type ProviderSelection, type SetupSnapshot, type SetupVoiceOperation,
} from './model'
export type { ManagedSettings, ProviderSelection, SetupSnapshot, SetupVoiceOperation }

export type SetupWriteKind = '' | 'credentials' | 'settings' | 'reference' | 'voice' | 'finish' | 'sample'

export interface SetupState {
  /** The last verified snapshot; null until the first successful read. */
  data: SetupSnapshot | null
  /** First read in flight (no snapshot yet). */
  loading: boolean
  /** No verified snapshot: every write stays disabled. */
  stale: boolean
  /** `/api/self-setup` answered 404 for this instance: there is no setup surface to drive. */
  unavailable: boolean
  /** The console token is missing or rejected. */
  authError: string
  readError: string
  error: string
  /** Classified failure kind, so the page can add the matching draft/duplicate-charge note. */
  failure: '' | 'version_conflict' | 'unconfirmed' | 'other'
  message: string
  write: SetupWriteKind
  secret: string
  credentialProvider: string
  selectedFile: { name: string; size: number } | null
  referenceId: string
  voiceLabel: string
  targetModel: string
  voiceCredentialRef: string
  voiceText: string
  settingsDraft: ManagedSettings | null
  settingsBase: ManagedSettings | null
  settingsRevision: number
  settingsConflict: boolean
  consent: readonly string[]
  uncertain: readonly string[]
  sample: { url: string; label: string; operationId: string; kind: 'demo' | 'activation' } | null
  activationReady: boolean
  /** The last finish receipt for this instance, shown once. */
  finished: boolean
  hidden: boolean
}

const initialState = (): SetupState => ({
  data: null, loading: true, stale: true, unavailable: false, authError: '', readError: '', error: '', failure: '',
  message: '', write: '', secret: '', credentialProvider: 'deepseek', selectedFile: null, referenceId: '', voiceLabel: '',
  targetModel: 'MiniMax/speech-2.8-turbo', voiceCredentialRef: '', voiceText: '', settingsDraft: null, settingsBase: null,
  settingsRevision: 0, settingsConflict: false, consent: [], uncertain: [], sample: null, activationReady: false,
  finished: false, hidden: typeof document !== 'undefined' && document.hidden,
})

const copy = <T,>(value: T): T => structuredClone(value)

function failureOf(error: unknown): { text: string; kind: SetupState['failure'] } {
  const status = error instanceof ApiError ? error.status : 0
  if (status === 409) return { text: SAFE_ERRORS.version_conflict!, kind: 'version_conflict' }
  // A transport drop, a timeout or a 5xx may or may not have been charged: never invent a cause.
  if (status === 0 || status >= 500) return { text: UNCONFIRMED_OUTCOME, kind: 'unconfirmed' }
  // Only the server's own classified message (already user-facing) is repeated verbatim.
  const message = error instanceof ApiError && error.message ? error.message : ''
  return { text: message || UNCONFIRMED_OUTCOME, kind: 'other' }
}

export class SetupSession {
  private state: SetupState = initialState()
  private listeners = new Set<() => void>()
  private epoch = 0
  private active = false
  private reading: { epoch: number; controller: AbortController } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private uploadId: string | null = null
  private bound = false
  private readonly onVisibility = () => this.syncVisibility()
  private readonly onPageHide = () => this.stop()
  private readonly onPageShow = () => this.start()

  getState = (): SetupState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private patch(part: Partial<SetupState>): void {
    this.state = { ...this.state, ...part }
    for (const listener of this.listeners) listener()
  }

  private consentSet(): Set<string> { return new Set(this.state.consent) }
  private uncertainSet(): Set<string> { return new Set(this.state.uncertain) }
  private addConsent(key: string): void { const next = this.consentSet(); next.add(key); this.patch({ consent: [...next] }) }
  private dropConsent(key: string): void { const next = this.consentSet(); next.delete(key); this.patch({ consent: [...next] }) }
  private addUncertain(key: string): void { const next = this.uncertainSet(); next.add(key); this.patch({ uncertain: [...next] }) }
  private dropUncertain(key: string): void { const next = this.uncertainSet(); next.delete(key); this.patch({ uncertain: [...next] }) }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (!this.bound && typeof document !== 'undefined') {
      this.bound = true
      document.addEventListener('visibilitychange', this.onVisibility)
      window.addEventListener('pagehide', this.onPageHide)
      window.addEventListener('pageshow', this.onPageShow)
    }
    this.active = true
    this.syncVisibility()
    if (!this.state.data && !this.reading) void this.refresh()
    else this.schedule()
  }

  stop(): void {
    this.active = false
    this.epoch += 1
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.reading?.controller.abort()
    this.reading = null
    this.releaseSample()
    this.uploadId = null
    this.patch({ stale: true, write: '', secret: '', selectedFile: null, activationReady: false, consent: [] })
  }

  /** Unmount: drop timers, listeners and object URLs. */
  dispose(): void {
    this.stop()
    if (this.bound && typeof document !== 'undefined') {
      this.bound = false
      document.removeEventListener('visibilitychange', this.onVisibility)
      window.removeEventListener('pagehide', this.onPageHide)
      window.removeEventListener('pageshow', this.onPageShow)
    }
    this.listeners.clear()
  }

  private syncVisibility(): void {
    const hidden = typeof document !== 'undefined' && document.hidden
    this.patch({ hidden })
    if (hidden) { if (this.timer) { clearTimeout(this.timer); this.timer = null } }
    else if (this.active) { void this.refresh(); this.schedule() }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.active || this.state.hidden) return
    this.timer = setTimeout(() => { this.timer = null; void this.refresh() }, 3000)
  }

  // ------------------------------------------------------------------- reads

  private ready(): boolean {
    return !!this.state.data && !this.state.stale && !this.state.write
  }

  async refresh(): Promise<SetupSnapshot | null> {
    if (this.reading) return this.state.data
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const ticket = { epoch: this.epoch, controller: new AbortController() }
    this.reading = ticket
    if (!this.state.data) this.patch({ loading: true })
    try {
      const value: SetupSnapshot = await runtime.request('/api/self-setup', { signal: ticket.controller.signal })
      if (this.reading !== ticket || ticket.epoch !== this.epoch) return null
      if (snapshotProblem(value)) { this.patch({ stale: true, readError: '读取到的设置状态无法核对，操作已停用，请刷新。' }); return null }
      if (snapshotStale(this.state.data, value)) { this.patch({ stale: true, readError: '设置状态比上次更旧，操作已停用，请刷新。' }); return null }
      this.accept(value)
      this.patch({ readError: '', authError: '', loading: false })
      return value
    } catch (error) {
      if (this.reading !== ticket || ticket.epoch !== this.epoch) return null
      if ((error as Error)?.name === 'AbortError') return null
      const status = error instanceof ApiError ? error.status : 0
      this.patch({ stale: true, loading: false })
      if (status === 401 || status === 403) this.patch({ authError: '请从桌宠的管理入口重新打开此页面。' })
      else if (status === 404 && !this.state.data) this.patch({ unavailable: true })
      else this.patch({ readError: '暂时无法核对自助设置状态，操作已停用，请刷新。' })
      return null
    } finally {
      if (this.reading === ticket) { this.reading = null; this.patch({ loading: false }); this.schedule() }
    }
  }

  private accept(value: SetupSnapshot): void {
    const changed = !!this.state.data && this.state.data.instanceId !== value.instanceId
    if (changed) {
      this.epoch += 1
      this.uploadId = null
      this.releaseSample()
      this.patch({
        activationReady: false, secret: '', selectedFile: null, consent: [], uncertain: [], message: '设置服务已更新，请核对当前配置后继续。',
        settingsConflict: !!this.state.settingsDraft, finished: false,
      })
    }
    if (this.state.data && (changed || value.settings.revision !== this.state.data.settings.revision || value.credentialRevision !== this.state.data.credentialRevision)) {
      this.patch({ consent: [] })
    }
    let draft = this.state.settingsDraft, base = this.state.settingsBase, revision = this.state.settingsRevision, conflict = this.state.settingsConflict
    if (!draft || !base || deepEqual(base, draft)) {
      draft = copy(value.settings.saved); base = copy(value.settings.saved); revision = value.settings.revision
    } else if (revision !== value.settings.revision) conflict = true
    this.patch({ data: value, stale: false, unavailable: false, settingsDraft: draft, settingsBase: base, settingsRevision: revision, settingsConflict: conflict })
  }

  // ------------------------------------------------------------- form setters

  setSecret(secret: string): void { this.patch({ secret }) }
  setCredentialProvider(provider: string): void { this.patch({ credentialProvider: provider, secret: '' }) }
  setVoiceField(part: Partial<Pick<SetupState, 'referenceId' | 'voiceLabel' | 'targetModel' | 'voiceCredentialRef' | 'voiceText'>>): void { this.patch(part) }
  dismissMessage(): void { this.patch({ message: '' }) }

  /** Copy-on-write edit of the settings draft; the base stays untouched so changes are comparable. */
  editProvider(slot: string, key: keyof ProviderSelection, value: unknown): void {
    const draft = this.state.settingsDraft
    if (!draft) return
    const next = copy(draft)
    const provider = { ...next.providers[slot] } as unknown as Record<string, unknown>
    if (value === undefined) delete provider[key]
    else provider[key] = value
    next.providers = { ...next.providers, [slot]: provider as unknown as ProviderSelection }
    this.patch({ settingsDraft: next })
  }

  applyProviderChoice(slot: string, adapterId: string, model: string): void {
    const draft = this.state.settingsDraft
    const data = this.state.data
    if (!draft || !data) return
    const current = draft.providers[slot]
    if (!current) return
    const adapter = data.adapters.find(a => a.id === adapterId)
    const choice = adapter?.choices?.find(c => c.configuration.model === model)
    if (choice) {
      const configuration = copy(choice.configuration) as ProviderSelection
      configuration.credentialRef = current.provider === choice.configuration.provider ? current.credentialRef : ''
      this.patch({ settingsDraft: { ...copy(draft), providers: { ...draft.providers, [slot]: configuration } } })
      return
    }
    const next = copy(draft)
    const provider = { ...next.providers[slot] } as unknown as Record<string, unknown>
    if (adapter?.provider && adapter.provider !== current.provider) provider.credentialRef = ''
    provider.adapterId = adapterId
    provider.provider = adapter?.provider || current.provider || 'deepseek'
    provider.model = model || current.model || ''
    provider.endpoint = adapter?.endpoints?.[0] || current.endpoint || ''
    next.providers = { ...next.providers, [slot]: provider as unknown as ProviderSelection }
    this.patch({ settingsDraft: next })
  }

  editContext(key: keyof ManagedSettings['context'], value: number): void {
    const draft = this.state.settingsDraft
    if (!draft) return
    this.patch({ settingsDraft: { ...copy(draft), context: { ...draft.context, [key]: value } } })
  }

  /** Explicit "read the latest configuration and drop my model edits" (409 recovery). */
  discardModelDraft(): void {
    const data = this.state.data
    if (!data) return
    this.patch({
      settingsDraft: copy(data.settings.saved), settingsBase: copy(data.settings.saved),
      settingsRevision: data.settings.revision, settingsConflict: false, message: '已读取最新配置，本页模型草稿已放弃。',
    })
  }

  // ------------------------------------------------------------------ writes

  private async mutate(path: string, body: Record<string, unknown>, accept: (result: any) => void, options: { method?: string; cloudKey?: string | null; kind: SetupWriteKind; timeoutMs?: number } = { kind: 'voice' }): Promise<void> {
    const data = this.state.data
    if (!this.ready() || !data) return
    const ticket = { epoch: this.epoch, instance: data.instanceId }
    this.reading?.controller.abort()
    this.reading = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.patch({ write: options.kind, error: '', failure: '', message: '' })
    if (options.cloudKey) this.addUncertain(options.cloudKey)
    try {
      const result = await runtime.request('/api/self-setup/' + path, {
        method: options.method || 'POST',
        body: { ...body, instanceId: ticket.instance },
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      if (ticket.epoch !== this.epoch || this.state.data?.instanceId !== ticket.instance) return
      accept(result)
      if (options.cloudKey) this.dropUncertain(options.cloudKey)
    } catch (error) {
      if (ticket.epoch === this.epoch) {
        const failure = failureOf(error)
        this.patch({ stale: true, error: failure.text, failure: failure.kind })
        // A definite client-side refusal never reached a charge; a timeout or a 5xx may have.
        const status = error instanceof ApiError ? error.status : 0
        if (options.cloudKey && status >= 400 && status < 500 && status !== 408) this.dropUncertain(options.cloudKey)
      }
    } finally {
      this.patch({ write: '' })
      if (this.active) await this.refresh()
    }
  }

  async saveKey(): Promise<void> {
    const data = this.state.data
    if (!this.ready() || !data) return
    if (!this.state.secret.trim()) { this.patch({ error: '请填写 API Key 后保存。', failure: 'other' }); return }
    const key = this.state.secret.trim(), provider = this.state.credentialProvider
    // The field is cleared before the request: a failed save must not leave the key in the page.
    this.patch({ secret: '' })
    await this.mutate('credentials', { provider, key, expectedRevision: data.credentialRevision, operationId: crypto.randomUUID() }, result => {
      if (result?.provider !== provider || !text(result.credentialRef) || !Number.isSafeInteger(result.revision))
        throw Error('Invalid credential receipt')
      this.patch({ message: 'API Key 已保存到本机，凭据条目 ' + String(result.credentialRef).slice(-6) + '。请在模型配置中手动选择；当前使用的凭据未改变，尚未验证模型是否开通。' })
    }, { kind: 'credentials' })
  }

  async uploadReference(): Promise<void> {
    const data = this.state.data
    const selected = this.selectedFileValue
    if (!this.ready() || !data || !selected) return
    const ticket = { epoch: this.epoch, instance: data.instanceId }
    this.reading?.controller.abort()
    this.reading = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.patch({ write: 'reference', error: '', failure: '', message: '正在本机转换音频…' })
    try {
      const audio = await encodeSetupReference(selected)
      if (ticket.epoch !== this.epoch || this.state.data?.instanceId !== ticket.instance) return
      const operationId = this.uploadId || crypto.randomUUID()
      this.uploadId = operationId
      const result = await runtime.request('/api/self-setup/reference', { method: 'POST', body: { instanceId: ticket.instance, operationId, ...audio } })
      if (ticket.epoch !== this.epoch || this.state.data?.instanceId !== ticket.instance) return
      if (!validReference(result)) throw Error('音频保存回执无法核对，请刷新。')
      this.patch({ referenceId: result.id, selectedFile: null, message: '参考音频已保存到本机，尚未发送到云端。' })
      this.uploadId = null
    } catch (error) {
      if (ticket.epoch === this.epoch) {
        const failure = failureOf(error)
        const status = error instanceof ApiError ? error.status : 0
        this.patch({ error: status ? '音频保存结果尚未确认，请刷新核对。' : failure.text, failure: status ? 'unconfirmed' : failure.kind })
      }
    } finally {
      this.patch({ write: '' })
      if (this.active) await this.refresh()
    }
  }

  /** The real File object lives outside React state; only its metadata is rendered. */
  private fileValue: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null = null
  setFile(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null): void {
    this.fileValue = file
    this.uploadId = null
    this.patch({ selectedFile: file ? { name: file.name, size: file.size } : null, error: '', failure: '' })
  }
  private get selectedFileValue() { return this.fileValue }

  async saveModels(): Promise<void> {
    const data = this.state.data, draft = this.state.settingsDraft
    if (!this.ready() || !data || !draft || this.state.settingsConflict) return
    if (!bindingsValid(draft, data.credentials)) return
    const revision = this.state.settingsRevision, saved = copy(draft)
    await this.mutate('settings', { expectedRevision: revision, settings: saved }, result => {
      if (!validSettings(result)) throw Error('Invalid settings receipt')
      this.patch({
        settingsDraft: copy(result.saved), settingsBase: copy(result.saved), settingsRevision: result.revision,
        settingsConflict: false, message: '配置已保存，完成设置并重启后生效。',
      })
    }, { method: 'PUT', kind: 'settings' })
  }

  async prepareVoice(): Promise<void> {
    const data = this.state.data
    const label = this.state.voiceLabel.trim(), voiceText = this.state.voiceText.trim()
    if (!this.ready() || !data || !label || !voiceText) return
    if (!data.references.some(r => r.id === this.state.referenceId)) return
    if (!this.dashscopeCredentials().some(c => c.id === this.state.voiceCredentialRef && c.status === 'configured')) return
    await this.mutate('voice/prepare', {
      referenceId: this.state.referenceId, label, targetModel: this.state.targetModel,
      credentialRef: this.state.voiceCredentialRef, configRevision: data.settings.revision, text: voiceText,
    }, result => {
      if (!validOperation(result) || result.phase !== 'prepared') throw Error('Invalid preparation receipt')
      this.patch({ message: '音色方案已准备，尚未调用云端。请查看费用后确认创建。' })
    }, { kind: 'voice', timeoutMs: 60000 })
  }

  canConfirm(operation: SetupVoiceOperation): boolean {
    const data = this.state.data
    if (!this.ready() || !data) return false
    if (!['prepared', 'clone_ready'].includes(operation.phase)) return false
    if (operation.configRevision !== data.settings.revision) return false
    if (!this.dashscopeCredentials().some(c => c.id === operation.credentialRef && c.status === 'configured')) return false
    return !this.uncertainSet().has(operationKey(operation))
  }

  consentGiven(operation: SetupVoiceOperation): boolean { return this.consentSet().has(operationKey(operation)) }
  isUncertain(operation: SetupVoiceOperation): boolean { return this.uncertainSet().has(operationKey(operation)) }

  toggleConsent(operation: SetupVoiceOperation, checked: boolean): void {
    if (!this.canConfirm(operation)) return
    if (checked) this.addConsent(operationKey(operation))
    else this.dropConsent(operationKey(operation))
  }

  /** The cloud call happens only here, only with an explicit `costConsent: true`. */
  async confirmVoice(operation: SetupVoiceOperation): Promise<void> {
    const current = this.currentOperation(operation)
    if (!current || current.revision !== operation.revision || !this.canConfirm(current)) return
    if (!this.consentSet().has(operationKey(operation))) return
    this.dropConsent(operationKey(operation))
    const activating = operation.phase === 'clone_ready'
    await this.mutate('voice/confirm', { operationId: operation.operationId, expectedRevision: operation.revision, costConsent: true }, result => {
      if (!validOperation(result) || result.operationId !== operation.operationId || result.revision <= operation.revision) throw Error('Invalid voice receipt')
      const allowed = activating ? ['activating', 'registered', 'failed', 'unknown'] : ['cloning', 'clone_ready', 'failed', 'unknown']
      if (!allowed.includes(result.phase)) throw Error('Invalid voice receipt')
      this.patch({ message: '云端操作已返回，请以最新音色状态为准。' })
    }, { kind: 'voice', cloudKey: operationKey(operation), timeoutMs: 180000 })
  }

  /** Zero-network retry: it only prepares a new operation, which needs its own confirmation. */
  async retryVoice(operation: SetupVoiceOperation): Promise<void> {
    const current = this.currentOperation(operation)
    if (!this.ready() || !current || current.revision !== operation.revision) return
    if (current.phase !== 'failed' || current.retryAvailable !== true) return
    if (this.uncertainSet().has(operationKey(current))) return
    await this.mutate('voice/retry', { operationId: operation.operationId, expectedRevision: operation.revision }, result => {
      if (!validOperation(result) || result.phase !== 'prepared' || result.operationId === operation.operationId) throw Error('Invalid retry receipt')
      this.patch({ message: '新的音色方案已准备，未调用云端。请再次核对费用后确认。' })
    }, { kind: 'voice' })
  }

  async cancelVoice(operation: SetupVoiceOperation): Promise<void> {
    if (!this.ready()) return
    await this.mutate('voice/cancel', { operationId: operation.operationId }, result => {
      if (!validOperation(result)) throw Error('Invalid cancel receipt')
      this.patch({ message: '方案状态已更新。' })
    }, { kind: 'voice' })
  }

  /** Loading a sample is a user action; playback itself still needs a second, explicit click. */
  async loadSample(operation: SetupVoiceOperation, kind: 'demo' | 'activation'): Promise<void> {
    const data = this.state.data
    if (!this.ready() || !data) return
    if (!(kind === 'demo' ? operation.demoAvailable : operation.activationAvailable)) return
    this.releaseSample()
    const ticket = { epoch: this.epoch, instance: data.instanceId }
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.patch({ write: 'sample', error: '', failure: '' })
    try {
      const path = `/api/self-setup/voice/sample?${new URLSearchParams({ instanceId: ticket.instance, operationId: operation.operationId, kind })}`
      const bytes = await runtime.request(path, { responseType: 'bytes', timeoutMs: 60000 })
      if (ticket.epoch !== this.epoch || this.state.data?.instanceId !== ticket.instance) return
      if (!bytes || !(bytes as ArrayBuffer).byteLength) throw Error('empty sample')
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      this.patch({ sample: { url, label: operation.label, operationId: operation.operationId, kind }, message: '音频已就绪，点击播放器后才会播放。' })
    } catch (error) {
      if (ticket.epoch === this.epoch) this.patch({ error: '无法读取试听音频，请刷新核对。', failure: 'unconfirmed' })
    } finally {
      this.patch({ write: '' })
      if (this.active) this.schedule()
    }
  }

  releaseSample(): void {
    const sample = this.state.sample
    if (!sample) return
    URL.revokeObjectURL(sample.url)
    this.patch({ sample: null })
  }

  canFinish(): boolean {
    const data = this.state.data
    if (!this.ready() || !data || data.mode !== 'first-run') return false
    if (data.initialization.blockers.length) return false
    if (this.state.settingsConflict) return false
    return !deepEqual(this.state.settingsBase, this.state.settingsDraft)
  }

  /** Prepares the launch configuration. It never launches anything and never activates a voice. */
  async finish(): Promise<void> {
    const data = this.state.data
    if (!this.canFinish() || !data) return
    await this.mutate('finish', { expectedRevision: data.settings.revision }, result => {
      if (result?.status !== 'prepared' || result.requiresRestart !== true) throw Error('Invalid finish receipt')
      this.patch({ activationReady: true, finished: true, message: '初始化配置已准备好，尚未运行。本页不会自动启动，请按下方说明显式启用。' })
    }, { kind: 'finish', timeoutMs: 120000 })
  }

  // ----------------------------------------------------------------- helpers

  private currentOperation(operation: SetupVoiceOperation): SetupVoiceOperation | undefined {
    return this.state.data?.operations.find(o => o.operationId === operation.operationId)
  }

  dashscopeCredentials() {
    return (this.state.data?.credentials || []).filter(c => c.provider === 'dashscope')
  }

  adaptersFor(slot: string) { return (this.state.data?.adapters || []).filter(a => a.slots?.includes(slot)) }

  /** Reasons the finish button is disabled, in the order the old page reported them. */
  finishBlockers(): string[] {
    const data = this.state.data
    if (!data) return []
    const reasons = [...data.initialization.blockers]
    if (this.state.settingsConflict) reasons.push('配置版本已变化，请先核对最新配置。')
    else if (!deepEqual(this.state.settingsBase, this.state.settingsDraft)) reasons.push('模型配置还有未保存的修改。')
    return reasons
  }

  phaseLabel(operation: SetupVoiceOperation): string { return PHASES[operation.phase] || operation.phase }
  errorText(operation: SetupVoiceOperation): string {
    return (operation.errorCode && SAFE_ERRORS[operation.errorCode]) || '本次未完成，请核对模型开通、凭据和参考音频。'
  }

  referenceOptions() {
    return (this.state.data?.references || []).map((reference, index) => ({
      value: reference.id,
      label: `参考 ${index + 1} · ${(reference.durationMs / 1000).toFixed(1)} 秒 · ${(reference.bytes / 1024 / 1024).toFixed(2)} MiB`,
    }))
  }

  canPrepare(): boolean {
    const data = this.state.data
    if (!this.ready() || !data) return false
    if (!this.state.voiceLabel.trim() || !this.state.voiceText.trim()) return false
    if (!data.references.some(r => r.id === this.state.referenceId)) return false
    return this.dashscopeCredentials().some(c => c.id === this.state.voiceCredentialRef && c.status === 'configured')
  }

  canSaveKey(): boolean { return this.ready() && this.state.secret.trim().length > 0 }
  canUpload(): boolean { return this.ready() && !!this.state.selectedFile }
  canSaveModels(): boolean {
    const data = this.state.data, draft = this.state.settingsDraft
    return this.ready() && !!data && !!draft && !this.state.settingsConflict && bindingsValid(draft, data.credentials)
  }
  maxReferenceBytes(): number { return MAX_REFERENCE_BYTES }
}
