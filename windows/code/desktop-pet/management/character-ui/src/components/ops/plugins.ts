// LUI-04 · 插件（0.65 包管理 / Flow Profile）行为层。
//
// 端点以 `management/server.ts` 与 `management/next65-management.ts` 的实际定义为准：
//   GET  /api/next65/packages                     -> Next65PackageView[]
//   POST /api/next65/packages/{id}/disable        -> LifecycleImpact
//   POST /api/next65/packages/{id}/uninstall      -> { uninstalled, packageId }
//   POST /api/next65/packages/import  { sourceRoot } -> Next65PackageView
//   GET  /api/next65/truth                        -> runtimeTruth()
//   GET  /api/next65/profiles                     -> { profiles, active }
//   PUT  /api/next65/profiles { profile, expectedRevision } -> { profile, active }
//   POST /api/next65/profiles/{id}/activate { expectedRevision } -> { profileId, revision, activatedAt }
//
// 保留的语义：
//  - `ready` 与 `enabled` 是两个不同的字段，不合并展示，也不互相推导。
//  - 卸载是不可逆的本地删除动作，必须先确认；确认契约留在 UI 层，但状态机在这里。
//  - 读失败显示失败，不显示「暂无插件」。

import { createEmitter, describeError, isAbort, newOperationId, type Emitter, type OpsClient, type OpsError, type RequestGuard } from './shared'

export interface PluginPackageView {
  packageId: string
  enabled: boolean
  /** `null` = 宿主配置不可读，ready 未知；绝不能当成 false 或 true。 */
  ready: boolean | null
  loaded: boolean
  active: boolean
  manifestLabels: string[]
  activeVersion: string | null
  pendingVersion: string | null
  installedVersions: string[]
  consumers: { packageId?: string; consumerId?: string; reason?: string }[]
  /** 生命周期影响里的本地目录字段属于宿主内部信息，不展示。 */
  packageRoot?: string
}

export interface PluginFlowProfile {
  profileId: string
  revision: number
  nodes: { nodeId: string; kind: string; capabilityId?: string | null; bindingId?: string | null }[]
  updatedAt?: string
}

export interface PluginTruth {
  hostAvailable: boolean
  flowAvailable: boolean
  installedCount: number
  loadedPackages: string[]
  activePackages: string[]
  registeredCapabilities: string[]
}

export interface PluginsState {
  loading: boolean
  error: OpsError | null
  /** 读到过的真实列表；`loaded` 为 false 时这里必须是空数组，UI 用 loaded 判断「真读到 0 条」。 */
  packages: PluginPackageView[]
  loaded: boolean
  truth: PluginTruth | null
  truthError: OpsError | null
  profiles: PluginFlowProfile[]
  profilesError: OpsError | null
  activeProfile: { profileId: string; revision: number; activatedAt: string } | null
  importRoot: string
  action: { kind: string; packageId?: string; busy: boolean; message: string; error: OpsError | null }
  /** 卸载确认：只有 packageId 完全匹配时才允许提交。 */
  pendingUninstall: string | null
  /** 卸载/导入失败后保留的输入草稿，409 时不静默清空。 */
  draft: string
}

function emptyState(): PluginsState {
  return {
    loading: false, error: null, packages: [], loaded: false,
    truth: null, truthError: null,
    profiles: [], profilesError: null, activeProfile: null,
    importRoot: '', action: { kind: '', busy: false, message: '', error: null },
    pendingUninstall: null, draft: '',
  }
}

function normalizePackage(raw: any): PluginPackageView {
  return {
    packageId: String(raw?.packageId ?? ''),
    enabled: raw?.enabled === true,
    // 只接受真正的布尔值；缺失/非布尔一律是「未知」，不伪装成 false。
    ready: typeof raw?.ready === 'boolean' ? raw.ready : null,
    loaded: raw?.loaded === true,
    active: raw?.active === true,
    manifestLabels: Array.isArray(raw?.manifestLabels) ? raw.manifestLabels.map((v: unknown) => String(v)) : [],
    activeVersion: typeof raw?.activeVersion === 'string' ? raw.activeVersion : null,
    pendingVersion: typeof raw?.pendingVersion === 'string' ? raw.pendingVersion : null,
    installedVersions: Array.isArray(raw?.installed)
      ? raw.installed.map((entry: any) => String(entry?.version ?? '')).filter(Boolean)
      : [],
    consumers: Array.isArray(raw?.consumers) ? raw.consumers : [],
  }
}

/** 每个包的生命周期标签；`ready === null` 必须显示为未知，不能折叠成「已停用」。 */
export function packageStatusLabel(pkg: PluginPackageView): { label: string; tone: 'ok' | 'warn' | 'muted' | 'error' } {
  if (pkg.ready === true) return { label: '已就绪', tone: 'ok' }
  if (pkg.enabled && pkg.ready === null) return { label: '已启用 · 就绪未知', tone: 'warn' }
  if (pkg.enabled) return { label: '已启用 · 未就绪', tone: 'warn' }
  return { label: '已停用', tone: 'muted' }
}

export function createPluginsSession(client: OpsClient, guard: RequestGuard, emitter: Emitter = createEmitter()) {
  let state = emptyState()
  const notify = () => emitter.emit()
  const patch = (next: Partial<PluginsState>) => { state = { ...state, ...next }; notify() }

  async function readAll(): Promise<void> {
    patch({ loading: true, error: null })
    const ticket = guard.begin()
    try {
      const [packages, truth] = await Promise.all([
        client.request('/api/next65/packages', { signal: ticket.controller.signal }),
        client.request('/api/next65/truth', { signal: ticket.controller.signal }).then(
          value => ({ ok: true as const, value }),
          error => ({ ok: false as const, error }),
        ),
      ])
      if (!ticket.current()) return
      const list = Array.isArray(packages) ? packages.map(normalizePackage) : []
      patch({
        loading: false, loaded: true, packages: list, error: null,
        // truth 与 packages 是两个独立读；一个失败不隐藏另一个的真实结果。
        truth: truth.ok ? truth.value as PluginTruth : null,
        truthError: truth.ok ? null : describeError(truth.error, '无法读取运行时真值。'),
      })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      patch({ loading: false, error: describeError(error, '无法读取插件包列表。'), packages: [], loaded: false })
    } finally { guard.end(ticket.controller) }
  }

  async function readProfiles(): Promise<void> {
    const ticket = guard.begin()
    try {
      const value = await client.request('/api/next65/profiles', { signal: ticket.controller.signal })
      if (!ticket.current()) return
      const profiles = Array.isArray(value?.profiles)
        ? value.profiles.map((entry: any) => ({
          profileId: String(entry?.profile?.profileId ?? ''),
          revision: typeof entry?.profile?.revision === 'number' ? entry.profile.revision : 0,
          nodes: Array.isArray(entry?.profile?.nodes) ? entry.profile.nodes : [],
          updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : undefined,
        }))
        : []
      patch({ profiles, profilesError: null, activeProfile: value?.active ?? null })
    } catch (error) {
      if (isAbort(error) || !ticket.current()) return
      // 读失败不清空已有列表，但明确标记失败；UI 用 profilesError 显示错误而不是「暂无」。
      patch({ profilesError: describeError(error, '无法读取 Flow 配置。') })
    } finally { guard.end(ticket.controller) }
  }

  async function run(kind: string, packageId: string | undefined, action: () => Promise<string>): Promise<void> {
    if (state.action.busy) return
    patch({ action: { kind, ...(packageId ? { packageId } : {}), busy: true, message: '', error: null } })
    try {
      const message = await action()
      patch({ action: { kind, ...(packageId ? { packageId } : {}), busy: false, message, error: null } })
    } catch (error) {
      patch({ action: { kind, ...(packageId ? { packageId } : {}), busy: false, message: '', error: describeError(error, '插件操作未完成。') } })
    }
  }

  return {
    subscribe: emitter.subscribe,
    get state(): PluginsState { return state },
    refresh: async () => { await Promise.all([readAll(), readProfiles()]) },
    setImportRoot(value: string) { patch({ importRoot: value, draft: value }) },
    /** 卸载是不可逆的本地删除：必须显式确认，且确认对象与当前包一致。 */
    requestUninstall(packageId: string) { patch({ pendingUninstall: packageId }) },
    cancelUninstall() { patch({ pendingUninstall: null }) },
    async confirmUninstall(): Promise<void> {
      const packageId = state.pendingUninstall
      if (!packageId) return
      await run('uninstall', packageId, async () => {
        await client.request(`/api/next65/packages/${encodeURIComponent(packageId)}/uninstall`, { method: 'POST', body: {} })
        patch({ pendingUninstall: null })
        await readAll()
        return `已卸载 ${packageId}；本机包目录已删除，重启后不再加载。`
      })
    },
    async disable(packageId: string): Promise<void> {
      await run('disable', packageId, async () => {
        await client.request(`/api/next65/packages/${encodeURIComponent(packageId)}/disable`, { method: 'POST', body: {} })
        await readAll()
        return `${packageId} 已停用；已加载的运行时不受影响，重启后不再加载。`
      })
    },
    async importPackage(): Promise<void> {
      const sourceRoot = state.importRoot.trim()
      if (!sourceRoot) {
        patch({ action: { kind: 'import', busy: false, message: '', error: describeError({ status: 400, message: '请先填写本地包目录。' }, '请先填写本地包目录。') } })
        return
      }
      await run('import', undefined, async () => {
        const created = await client.request('/api/next65/packages/import', { method: 'POST', body: { sourceRoot } })
        // 导入成功才清空草稿；失败时草稿保留在 importRoot 里。
        patch({ importRoot: '', draft: '' })
        await readAll()
        return `已登记 ${created?.packageId ?? '插件包'}；是否启用由宿主配置决定，本次不自动启用。`
      })
    },
    async activateProfile(profileId: string, expectedRevision: number): Promise<void> {
      await run('activate', profileId, async () => {
        await client.request(`/api/next65/profiles/${encodeURIComponent(profileId)}/activate`, { method: 'POST', body: { expectedRevision } })
        await readProfiles()
        return `Flow 配置 ${profileId} 已激活（修订 ${expectedRevision}）。`
      })
    },
    /** 用于测试与卸载：中止在途请求，之后不会再有任何状态写入。 */
    dispose() { guard.invalidate() },
    newOperationId,
  }
}
export type PluginsSession = ReturnType<typeof createPluginsSession>
