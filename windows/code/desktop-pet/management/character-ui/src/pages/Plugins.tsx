// LUI-04 · 插件页（React）。消费 `/api/next65/*` 的真实契约，不再外跳旧管理页。
//
// 两个子视图：已安装包 / Flow 配置。`tab` 由 `?tab=` 决定（LUI_CONTRACTS §2.2），
// 未知或缺省值回落到 `list`。

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Package, RefreshCw } from 'lucide-react'
import { runtime } from '../services/runtime'
import { useRequestGuard } from '../components/ops/useOps'
import { createPluginsSession, packageStatusLabel, type PluginPackageView, type PluginsSession, type PluginsState } from '../components/ops/plugins'
import { OpsBadge, OpsButton, OpsCard, OpsConfirm, OpsDefinition, OpsErrorNotice, OpsNotice, OpsReadState } from '../components/ops/Panel'

const TABS = [
  { id: 'list', label: '已安装插件包' },
  { id: 'flow', label: 'Flow 流程编排' },
] as const

export default function Plugins() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  // 未知 tab 回落到 list：不渲染空白页，也不跳旧页。
  const tab = TABS.some(item => item.id === requested) ? requested! : 'list'
  const guard = useRequestGuard()
  const session = useRef<PluginsSession | null>(null)
  if (!session.current) session.current = createPluginsSession(runtime, guard)
  const plugins = session.current
  const [, force] = useState(0)
  useEffect(() => {
    const unsubscribe = plugins.subscribe(() => force(n => n + 1))
    return () => { unsubscribe(); plugins.dispose() }
  }, [plugins])
  // 进入本页即读一次真实列表；两个子视图共用同一份数据。
  useEffect(() => { void plugins.refresh() }, [plugins])

  const state = plugins.state
  return (
    <div className="animate-fade-in space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">插件管理</h1>
          <p className="mt-1 text-sm text-ink-500">管理本机 0.65 插件包的生命周期与 Flow 配置。列表只展示真实登记的包，不使用原型目录冒充已安装插件。</p>
        </div>
        <OpsButton tone="ghost" onClick={() => void plugins.refresh()} disabled={state.loading}>
          <span className="inline-flex items-center gap-2"><RefreshCw size={14} />刷新</span>
        </OpsButton>
      </header>

      <nav className="flex gap-2">
        {TABS.map(item => (
          <button key={item.id} type="button" onClick={() => setParams(item.id === 'list' ? {} : { tab: item.id })}
            className={`rounded-2xl px-5 py-2.5 text-sm ${tab === item.id ? 'bg-aika-500 text-white' : 'bg-white text-ink-500'}`}>
            {item.label}
          </button>
        ))}
      </nav>

      <OpsErrorNotice error={state.error} fallback="读取插件包失败" />
      <OpsErrorNotice error={state.action.error} fallback="插件操作失败" />
      {state.action.message && <OpsNotice tone="ok">{state.action.message}</OpsNotice>}

      {tab === 'list'
        ? <PackageList plugins={plugins} state={state} />
        : <FlowProfiles plugins={plugins} state={state} />}

      <OpsNotice tone="warn">本页只做登记与启停：不会启动未选择的引擎，也不会在导入时自动启用包。</OpsNotice>
    </div>
  )
}

function PackageList({ plugins, state }: { plugins: PluginsSession; state: PluginsState }) {
  const [importRoot, setImportRoot] = useState('')
  return <>
    <OpsCard title="本地包路径导入">
      <p className="text-sm text-ink-500">导入只把包登记到本机宿主目录；是否启用由宿主配置决定，本页不会自动启用。</p>
      <label className="block text-sm">
        <span className="text-ink-700">本地包目录</span>
        <input className="soft-input mt-1.5" value={importRoot} maxLength={1000} placeholder="例如 packages/my-custom-plugin"
          onChange={event => { setImportRoot(event.target.value); plugins.setImportRoot(event.target.value) }} />
      </label>
      <OpsButton disabled={state.action.busy || !importRoot.trim()} onClick={() => void plugins.importPackage()}>
        {state.action.busy && state.action.kind === 'import' ? '导入中…' : '导入并登记'}
      </OpsButton>
      {/* 导入失败时草稿保留在输入框里，用户不需要重打路径。 */}
      {state.action.kind === 'import' && state.action.error && <OpsNotice tone="warn">导入未完成；上面的路径已保留。</OpsNotice>}
    </OpsCard>

    <OpsCard title="已安装插件包">
      <OpsReadState loading={state.loading} error={state.error} loaded={state.loaded} empty={state.packages.length === 0}
        loadingText="正在读取正式插件列表…" errorText="插件列表读取失败" emptyText="当前未安装任何本地插件包。">
        <div className="grid gap-4 md:grid-cols-2">
          {state.packages.map(pkg => <PackageCard key={pkg.packageId} pkg={pkg} plugins={plugins} state={state} />)}
        </div>
      </OpsReadState>
    </OpsCard>

    <OpsCard title="运行时真值">
      {state.truthError
        ? <OpsErrorNotice error={state.truthError} fallback="运行时真值读取失败" />
        : state.truth
          ? <OpsDefinition rows={[
            ['宿主已接入', state.truth.hostAvailable ? '是' : '否'],
            ['Flow 运行时', state.truth.flowAvailable ? '已接入' : '不可用'],
            ['已登记包数', String(state.truth.installedCount)],
            ['已加载', state.truth.loadedPackages.length ? state.truth.loadedPackages.join('、') : '（无）'],
            ['运行中', state.truth.activePackages.length ? state.truth.activePackages.join('、') : '（无）'],
            ['已注册能力', state.truth.registeredCapabilities.length ? state.truth.registeredCapabilities.join('、') : '（无）'],
          ]} />
          : <OpsNotice tone="warn">尚未读取到运行时真值。</OpsNotice>}
    </OpsCard>
  </>
}

function PackageCard({ pkg, plugins, state }: { pkg: PluginPackageView; plugins: PluginsSession; state: PluginsState }) {
  const status = packageStatusLabel(pkg)
  const busy = state.action.busy && state.action.packageId === pkg.packageId
  const confirming = state.pendingUninstall === pkg.packageId
  return (
    <section className="space-y-3 rounded-2xl border border-slate-100 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 font-bold"><Package size={18} />{pkg.packageId}</h4>
        <div className="flex gap-2">
          <OpsBadge tone={status.tone}>{status.label}</OpsBadge>
          {pkg.pendingVersion && <OpsBadge tone="warn">重启后 {pkg.pendingVersion}</OpsBadge>}
        </div>
      </header>
      <p className="text-sm text-ink-500">{pkg.manifestLabels.length ? `包含插件：${pkg.manifestLabels.join('、')}` : '基础扩展包'}</p>
      {/* ready 与 enabled 分开陈列：两者不是同一个事实。 */}
      <OpsDefinition rows={[
        ['enabled（宿主配置）', pkg.enabled ? '是' : '否'],
        ['ready（宿主报告）', pkg.ready === null ? '未知（宿主配置不可读）' : pkg.ready ? '是' : '否'],
        ['loaded（已加载）', pkg.loaded ? '是' : '否'],
        ['active（运行中）', pkg.active ? '是' : '否'],
        ['已登记版本', pkg.installedVersions.length ? pkg.installedVersions.join('、') : '未提供'],
      ]} />
      <div className="flex flex-wrap gap-3">
        {pkg.enabled && <OpsButton tone="ghost" disabled={busy} onClick={() => void plugins.disable(pkg.packageId)}>{busy ? '处理中…' : '停用'}</OpsButton>}
        <OpsButton tone="danger" disabled={busy} onClick={() => plugins.requestUninstall(pkg.packageId)}>卸载</OpsButton>
      </div>
      {confirming && <OpsConfirm
        title={`确定要从本机卸载 ${pkg.packageId} 吗？`}
        description={<>卸载会删除本机包目录，重启后不再加载。这个动作不可撤销；包内数据随目录一起移除。</>}
        confirmLabel="确认卸载" busy={busy}
        onConfirm={() => void plugins.confirmUninstall()} onCancel={() => plugins.cancelUninstall()} />}
    </section>
  )
}

function FlowProfiles({ plugins, state }: { plugins: PluginsSession; state: PluginsState }) {
  return <>
    <OpsCard title="Flow 配置">
      <p className="text-sm text-ink-500">激活前服务端会校验 profile 与已启用绑定；本页只提交激活请求并回读真实状态。</p>
      <OpsReadState loading={state.loading} error={state.profilesError} loaded={!state.profilesError} empty={state.profiles.length === 0}
        loadingText="正在读取 Flow 配置…" errorText="Flow 配置读取失败" emptyText="当前没有已保存的 Flow 配置。">
        <div className="space-y-3">
          {state.profiles.map(profile => {
            const active = state.activeProfile?.profileId === profile.profileId
            const busy = state.action.busy && state.action.packageId === profile.profileId
            return (
              <section key={profile.profileId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 p-4">
                <div>
                  <h4 className="font-bold">{profile.profileId}</h4>
                  <p className="text-xs text-ink-400">修订 {profile.revision} · {profile.nodes.length} 个节点{profile.updatedAt ? ` · 更新于 ${profile.updatedAt}` : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  {active && <OpsBadge tone="ok">当前激活</OpsBadge>}
                  <OpsButton tone="ghost" disabled={busy || active} onClick={() => void plugins.activateProfile(profile.profileId, profile.revision)}>
                    {busy ? '处理中…' : '激活'}
                  </OpsButton>
                </div>
              </section>
            )
          })}
        </div>
      </OpsReadState>
      {state.activeProfile && <OpsDefinition rows={[['当前激活 profile', state.activeProfile.profileId], ['激活修订', String(state.activeProfile.revision)], ['激活时间', state.activeProfile.activatedAt]]} />}
    </OpsCard>
    <OpsCard title="注册能力">
      {state.truthError
        ? <OpsErrorNotice error={state.truthError} fallback="能力真值读取失败" />
        : state.truth
          ? <p className="text-sm text-ink-600">{state.truth.registeredCapabilities.length ? state.truth.registeredCapabilities.join('、') : '当前没有注册能力。'}</p>
          : <OpsNotice tone="warn">尚未读取到能力真值。</OpsNotice>}
    </OpsCard>
  </>
}
