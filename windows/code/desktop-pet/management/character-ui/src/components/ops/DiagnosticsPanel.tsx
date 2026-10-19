// LUI-04 · 诊断面板：模块状态 / 麦克风偏好 / 运行实例快照 / Trace 入口。
//
// 本页**不主动探测**任何端点，也不生成付费请求：它只读后端已经真实观察到的事实。
// 因此首次对话前多数模块显示「尚未确认」是预期状态，不是故障。

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { runtime } from '../../services/runtime'
import { useOpsSession, useRequestGuard } from './useOps'
import { HEALTH_EVIDENCE, HEALTH_LABEL, createDiagnosticsSession, sortHealthModules, type DiagnosticsSession, type HealthModuleView } from './diagnostics'
import { OpsBadge, OpsButton, OpsCard, OpsDefinition, OpsErrorNotice, OpsNotice } from './Panel'

const STATE_TONE: Record<string, 'ok' | 'warn' | 'muted' | 'error'> = {
  ready: 'ok', checking: 'muted', unknown: 'muted', disabled: 'muted', degraded: 'warn', failed: 'error',
}

export default function DiagnosticsPanel({ characterId }: { characterId?: string }) {
  const guard = useRequestGuard()
  const session = useOpsSession<DiagnosticsSession>(() => createDiagnosticsSession(runtime, guard), [guard])
  const state = session.state
  useEffect(() => { void session.refresh() }, [session])
  const modules = state.snapshot ? sortHealthModules(state.snapshot.modules) : []
  const ready = modules.filter(module => module.state === 'ready').length
  return <div className="space-y-5">
    <OpsCard title="模块状态" extra={<OpsBadge tone={state.error ? 'error' : 'muted'}>{state.snapshot ? `${modules.length} 个模块` : '未读取'}</OpsBadge>}>
      <p className="text-sm text-ink-500">
        这里的灯只反映后端已经真实观察到的事实。为了不给用户生成付费请求，本页不会主动探测任何端点——
        所以首次对话之前，多数模块显示为「尚未确认」或「部分可用」是预期的诚实状态，不代表故障。
      </p>
      <OpsErrorNotice error={state.error} fallback="模块状态" />
      {state.snapshot
        ? <OpsDefinition rows={[
          ['已有实际证据', `${ready} / ${modules.length}`],
          ['配置修订', String(state.snapshot.configRevision)],
          ['快照时间', state.snapshot.observedAt || '未提供'],
        ]} />
        : <OpsNotice tone="warn">尚未读取到模块状态；本页不会用「0 个模块」冒充健康快照。</OpsNotice>}
      <OpsButton tone="ghost" disabled={state.loading} onClick={() => void session.refresh()}>{state.loading ? '刷新中…' : '刷新状态'}</OpsButton>

      {state.detailError && <OpsErrorNotice error={state.detailError} fallback="修复建议" />}
      {state.detail && <section className="space-y-2 rounded-2xl border border-slate-100 p-4">
        <header className="flex items-center justify-between"><h4 className="font-bold">修复入口 · {state.detail.value.label}</h4>
          <OpsButton tone="ghost" onClick={() => session.closeDetail()}>收起</OpsButton></header>
        <OpsDefinition rows={[
          ['模块', state.detail.module],
          ['原因', state.detail.value.reasonCode ?? '（无）'],
          ['修复动作', state.detail.value.repairAction ?? '（无）'],
        ]} />
      </section>}

      {modules.length > 0 && <div className="grid gap-4 md:grid-cols-2">
        {modules.map(module => <ModuleCard key={module.id} module={module} onInspect={() => void session.inspect(module.id)} />)}
      </div>}
    </OpsCard>

    <OpsCard title="麦克风偏好">
      <p className="text-sm text-ink-500">控制台只保存本机偏好（设备标识），**不代替你打开麦克风采集**；采集仍由桌宠渲染进程在你操作时进行。</p>
      <OpsErrorNotice error={session.microphoneError} fallback="麦克风偏好" />
      {session.microphone
        ? <OpsDefinition rows={[['当前设备', session.microphone.deviceId ?? '系统默认设备']]} />
        : <OpsNotice tone="warn">尚未读取到麦克风偏好。</OpsNotice>}
      <div className="flex flex-wrap gap-3">
        <OpsButton tone="ghost" disabled={state.loading} onClick={() => void session.saveMicrophone(null)}>使用系统默认设备</OpsButton>
      </div>
    </OpsCard>

    <OpsCard title="运行实例">
      <OpsErrorNotice error={session.snapshotError} fallback="运行实例快照" />
      {session.snapshot
        ? <OpsDefinition rows={[
          ['实例', session.snapshot.runtime?.instanceId ?? '未提供'],
          ['启动时间', session.snapshot.runtime?.startedAt ?? '未提供'],
          ['源码修订', session.snapshot.runtime?.sourceRevision ?? '未提供'],
          ['当前角色', session.snapshot.runtime?.characterId ?? '未提供'],
          ['会话', session.snapshot.runtime?.sessionId ?? '未提供'],
        ]} />
        : <OpsNotice tone="warn">尚未读取到运行实例快照。</OpsNotice>}
    </OpsCard>

    <OpsCard title="Trace 与日志">
      <p className="text-sm text-ink-500">Trace 详情（LLM 调用链 / 日志）已迁到角色工作区；这里只提供新 UI 内部入口。</p>
      {characterId
        ? <Link className="inline-block rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/trace`}>打开 Trace（角色 {characterId}）</Link>
        : <OpsNotice tone="warn">本页没有角色上下文；请从角色工作区打开 Trace。</OpsNotice>}
    </OpsCard>
  </div>
}

function ModuleCard({ module, onInspect }: { module: HealthModuleView; onInspect: () => void }) {
  const evidence = HEALTH_EVIDENCE.filter(([key]) => module.evidence[key]).map(([, label]) => label)
  return <section className="space-y-2 rounded-2xl border border-slate-100 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-bold">{module.label}</h4>
      <div className="flex gap-2">
        <OpsBadge tone={STATE_TONE[module.state] ?? 'muted'}>{HEALTH_LABEL[module.state] ?? module.state}</OpsBadge>
        {module.stale && <OpsBadge tone="warn">已过期</OpsBadge>}
      </div>
    </header>
    {/* 三个证据维度分开陈列：可达不等于可用。 */}
    <p className="text-sm text-ink-500">证据：{evidence.length ? evidence.join(' · ') : '（尚无任何证据）'}</p>
    {module.reasonCode && <p className="text-xs text-ink-400">原因：{module.reasonCode}</p>}
    {module.repairAction && <p className="text-xs text-ink-400">可以这样处理：{module.repairAction}</p>}
    <p className="text-xs text-ink-400">最近检查：{module.checkedAt || '未提供'} · 配置修订 {module.configRevision}</p>
    <OpsButton tone="ghost" onClick={onInspect}>查看修复入口</OpsButton>
  </section>
}
