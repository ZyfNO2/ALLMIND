// LUI-04 · 全局设置页（React）。
//
// 每个 `tab` 由 `?tab=` 决定（LUI_CONTRACTS §2.1）；未知或缺省值回落到 `basic`，
// 不渲染空白页、也不跳旧管理页。本页**没有** `Advanced` / `legacyUrl` 调用。
//
// 各 tab 的真实能力：
//   basic        本地可改项有限；主题与开机启动仍明确未实现
//   storage      备份/恢复未实现；采集与留存已迁到 collection
//   plugins      指向角色工作区的插件页（同一份 `/api/next65/*`）
//   system       运行实例快照 + 诊断面板 + Trace 入口
//   update       自动更新检查/更新渠道未实现
//   about        版本与边界说明
//   sources      全局来源/凭据编辑归角色工作区；这里只给新 UI 内部入口
//   shortcuts    宿主快捷键 / 回复声音 / 显示（HostPanel）
//   companion    主动陪伴偏好 + 主动邀请策略
//   privacy      本地采集 / 授权感知 / 屏幕授权 / 主动陪伴 / 唤醒（全部子域）
//   collection   本地采集与留存
//   diagnostics  模块状态 / 麦克风 / 运行实例 / Trace
//   work         ACP / MCP 协议工作（WorkPanel）
//   integrations 官方余额 + 微信（IntegrationsPanel）
//   companion-knowledge 陪伴知识（来源 / 今日活动 / 蒸馏发布入口，CK-09 只读转发）
//   developer    Trace 与日志入口

import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { runtime } from '../services/runtime'
import { Notice } from '../components/Connection'
import { Spinner } from '../components/ui'
import HostPanel from '../components/ops/HostPanel'
import PrivacyPanel from '../components/ops/PrivacyPanel'
import DiagnosticsPanel from '../components/ops/DiagnosticsPanel'
import IntegrationsPanel from '../components/ops/IntegrationsPanel'
import WorkPanel from '../components/ops/WorkPanel'
import { OpsButton, OpsCard, OpsDefinition, OpsNotice, NotImplemented } from '../components/ops/Panel'

const SECTIONS: [string, string][] = [
  ['basic', '基本设置'],
  ['storage', '数据与存储'],
  ['plugins', '插件管理'],
  ['system', '系统与日志'],
  ['update', '更新'],
  ['about', '关于'],
  ['sources', '全局来源与凭据'],
  ['shortcuts', '快捷键与语音'],
  ['companion', '主动陪伴'],
  ['privacy', '隐私与授权感知'],
  ['collection', '本地采集与留存'],
  ['diagnostics', '系统诊断'],
  ['work', '工作协议与任务'],
  ['integrations', '外部集成'],
  ['companion-knowledge', '陪伴知识'],
  ['developer', '开发者'],
]
const IDS = new Set(SECTIONS.map(([id]) => id))

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  // 未知 tab 回落到 basic：不空白、不跳旧页。
  const tab = requested && IDS.has(requested) ? requested : 'basic'
  const snapshot = useAsync(() => runtime.request('/api/snapshot'), [], undefined)
  const registry = useAsync(() => runtime.registry(), [], undefined)
  // 当前运行角色（若读到）用于把 Trace / 插件入口指向新 UI 内部路由。
  const currentCharacter = registry.data?.selection?.effectiveCharacterId as string | undefined

  return <div className="mx-auto max-w-6xl px-8 py-8">
    <Link to="/characters" className="text-aika-600">← 角色选择</Link>
    <h1 className="my-6 text-2xl font-bold">全局设置</h1>
    <div className="grid grid-cols-[240px_1fr] gap-6">
      <nav className="card space-y-1 p-4">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setParams(id === 'basic' ? {} : { tab: id })}
            className={`block w-full rounded-2xl p-3 text-left text-sm ${id === tab ? 'bg-aika-50 text-aika-600' : 'text-ink-600'}`}>
            {label}
          </button>
        ))}
      </nav>
      <section className="space-y-5">
        <h2 className="text-lg font-bold">{SECTIONS.find(([id]) => id === tab)?.[1]}</h2>
        {snapshot.loading && <Spinner />}
        {snapshot.error && <Notice>{snapshot.error}</Notice>}
        {tab === 'basic' && <BasicTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'plugins' && <PluginsTab characterId={currentCharacter} />}
        {tab === 'system' && <SystemTab snapshot={snapshot.data} characterId={currentCharacter} />}
        {tab === 'update' && <UpdateTab />}
        {tab === 'about' && <AboutTab snapshot={snapshot.data} />}
        {tab === 'sources' && <SourcesTab characterId={currentCharacter} />}
        {tab === 'shortcuts' && <HostPanel />}
        {tab === 'companion' && <PrivacyPanel characterId={currentCharacter} sections={['companion', 'proactive']} />}
        {tab === 'privacy' && <PrivacyPanel characterId={currentCharacter} />}
        {tab === 'collection' && <PrivacyPanel characterId={currentCharacter} sections={['collection']} />}
        {tab === 'diagnostics' && <DiagnosticsPanel characterId={currentCharacter} />}
        {tab === 'work' && <WorkPanel />}
        {tab === 'integrations' && <IntegrationsPanel />}
        {tab === 'companion-knowledge' && <CompanionKnowledgeTab />}
        {tab === 'developer' && <DeveloperTab characterId={currentCharacter} />}
      </section>
    </div>
  </div>
}

function BasicTab() {
  return <OpsCard title="基本设置">
    <p className="text-sm text-ink-500">语言、主题与开机启动的新编辑器**未实现**：这些能力当前没有对应的管理 API，本页不提供假开关。</p>
    <NotImplemented>主题（浅色/深色/跟随系统）未实现；不显示占位选择器。</NotImplemented>
    <NotImplemented>开机启动未实现；请在操作系统层面自行配置。</NotImplemented>
    <OpsNotice tone="info">宿主快捷键、回复声音与显示尺寸在「快捷键与语音」；主动陪伴与隐私在「隐私与授权感知」。</OpsNotice>
  </OpsCard>
}

function StorageTab() {
  return <OpsCard title="数据与存储">
    <NotImplemented>备份与恢复未实现：没有真实的导出/导入管理 API，本页不提供假下载或假按钮。</NotImplemented>
    <OpsNotice tone="info">已有资料与记忆导入工具在角色工作区（记忆 → 导入）；本地采集的留存与删除在「本地采集与留存」。</OpsNotice>
  </OpsCard>
}

function PluginsTab({ characterId }: { characterId?: string }) {
  return <OpsCard title="插件管理">
    <p className="text-sm text-ink-500">插件包与 Flow 配置的完整界面在角色工作区的插件页；两者消费同一份 `/api/next65/*`，本页不再外跳旧管理页。</p>
    {characterId
      ? <Link className="inline-block rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/plugins`}>打开插件管理（角色 {characterId}）</Link>
      : <OpsNotice tone="warn">尚未读取到运行角色；请从角色工作区打开插件页。</OpsNotice>}
  </OpsCard>
}

function SystemTab({ snapshot, characterId }: { snapshot: any; characterId?: string }) {
  return <div className="space-y-5">
    <OpsCard title="运行实例">
      {snapshot
        ? <OpsDefinition rows={[
          ['运行实例', snapshot.runtime?.instanceId ?? '未读取'],
          ['启动时间', snapshot.runtime?.startedAt ?? '未读取'],
          ['源码修订', snapshot.runtime?.sourceRevision ?? '未读取'],
          ['当前角色', snapshot.runtime?.characterId ?? '未读取'],
          ['进程号', snapshot.runtime?.pid === undefined ? '未读取' : String(snapshot.runtime.pid)],
        ]} />
        : <OpsNotice tone="warn">尚未读取到运行实例快照；本页不显示占位值。</OpsNotice>}
    </OpsCard>
    <DiagnosticsPanel characterId={characterId} />
  </div>
}

function UpdateTab() {
  return <OpsCard title="更新">
    <NotImplemented>自动更新检查与更新渠道未实现：没有真实的更新管理 API，本页不提供假检查按钮。</NotImplemented>
  </OpsCard>
}

function AboutTab({ snapshot }: { snapshot: any }) {
  return <OpsCard title="关于">
    <p>ALLMIND</p>
    <p className="text-sm text-ink-500">前端只消费本机管理 API。界面装饰插画来自用户提供的原型，不自动成为角色的运行资产。</p>
    <OpsDefinition rows={[['源码修订', snapshot?.runtime?.sourceRevision ?? '未读取']]} />
  </OpsCard>
}

function SourcesTab({ characterId }: { characterId?: string }) {
  return <OpsCard title="全局来源与凭据">
    <p className="text-sm text-ink-500">
      全局来源、凭据引用与角色绑定的编辑界面在角色工作区（配置 → 模型 / 语音），首次设置在 `/setup`。
      本页不再打开旧管理页；凭据只以引用形式出现，密钥不进 URL、日志或浏览器存储。
    </p>
    {characterId
      ? <Link className="inline-block rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/config?tab=model`}>打开角色模型配置（{characterId}）</Link>
      : <OpsNotice tone="warn">尚未读取到运行角色；请从角色工作区打开配置。</OpsNotice>}
  </OpsCard>
}

function CompanionKnowledgeTab() {
  return <div className="space-y-5">
    <OpsCard title="陪伴知识">
      <p className="text-sm text-ink-500">
        陪伴知识（正文来源 / 今日活动 / 知识域 / 角色蒸馏与发布）是只读转发面：所有状态来自已鉴权的真实 API，
        所有写操作都必须拿到 owner 回执才显示成功。本页不实现任何存储、编纂或发布逻辑。
      </p>
      <OpsNotice tone="info">配对由服务端从当前运行实例确定；浏览器不传也不改写用户 / 角色 / 实例标识。未装配的后端显示「不可用 + 原因」，不显示空的成功态。</OpsNotice>
    </OpsCard>
    <KnowledgeSourcesCard />
    <KnowledgeActivityCard />
  </div>
}

function KnowledgeSourcesCard() {
  const snapshot = useAsync(() => runtime.request('/api/companion/sources'), [], undefined)
  return <OpsCard title="正文来源">
    {snapshot.loading && <Spinner />}
    {snapshot.error && <Notice>{snapshot.error}</Notice>}
    {snapshot.data
      ? snapshot.data.available === false
        ? <OpsNotice tone="warn">正文来源管理未装配（{snapshot.data.reason ?? 'not_wired'}）。本页不显示空的成功态。</OpsNotice>
        : <OpsDefinition rows={[
          ['可用', snapshot.data.available ? '是' : '否'],
          ['来源数', String(snapshot.data.sources?.length ?? 0)],
          ['工作区', snapshot.data.workspace?.available ? `已接入（跟踪 ${snapshot.data.workspace.trackedCount ?? 0} 个）` : `未接入（${snapshot.data.workspace?.reason ?? '未知原因'}）`],
        ]} />
      : !snapshot.loading && <OpsNotice tone="warn">尚未读取到来源状态；本页不会用空列表代替。</OpsNotice>}
  </OpsCard>
}

function KnowledgeActivityCard() {
  const today = new Date()
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const query = `?date=${encodeURIComponent(localDate)}&timezone=${encodeURIComponent('Asia/Shanghai')}`
  const activities = useAsync(() => runtime.request(`/api/companion/activities${query}`), [], undefined)
  const summary = useAsync(() => runtime.request(`/api/companion/daily-summaries${query}`), [], undefined)
  return <OpsCard title={`今日活动（${localDate}）`}>
    <p className="text-sm text-ink-500">事件的「发生时间」与「记录时间」分列展示；没有发生时间的事件明确标注，不假装它何时发生。生成摘要不等于发送消息。</p>
    {(activities.loading || summary.loading) && <Spinner />}
    {activities.error && <Notice>{activities.error}</Notice>}
    {summary.error && <Notice>{summary.error}</Notice>}
    {activities.data && <OpsDefinition rows={[
      ['事件数', String(activities.data.events?.length ?? 0)],
      ['覆盖', activities.data.coverage ?? '未提供'],
      ['已送达', activities.data.delivered ? '是' : '否'],
    ]} />}
    {summary.data && <OpsDefinition rows={[
      ['摘要状态', summary.data.status ?? '未提供'],
      ['事件计数', String(summary.data.eventCount ?? 0)],
      ['仅记录时间', summary.data.recordedTimeOnly ? '是' : '否'],
    ]} />}
    {!activities.data && !summary.data && !activities.loading && !summary.loading &&
      <OpsNotice tone="warn">尚未读取到今日活动；本页不显示假零。</OpsNotice>}
    <OpsNotice tone="info">角色蒸馏与发布的完整操作面在角色工作区；本页只做来源与活动的只读转发，不签发发布。</OpsNotice>
  </OpsCard>
}

function DeveloperTab({ characterId }: { characterId?: string }) {
  const [open, setOpen] = useState(false)
  return <OpsCard title="开发者">
    <p className="text-sm text-ink-500">Trace（LLM 调用链）与运行日志在角色工作区的 Trace 页；本页只做新 UI 内部入口。</p>
    {characterId
      ? <div className="flex flex-wrap gap-3">
        <Link className="inline-block rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/trace`}>打开 Trace（{characterId}）</Link>
        <Link className="inline-block rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/trace?tab=logs`}>打开运行日志</Link>
      </div>
      : <OpsNotice tone="warn">尚未读取到运行角色；请从角色工作区打开 Trace。</OpsNotice>}
    <OpsButton tone="ghost" onClick={() => setOpen(v => !v)}>{open ? '收起边界说明' : '查看边界说明'}</OpsButton>
    {open && <OpsNotice tone="info">本页不读取 Raw Trace 正文，也不做持久化缓存；忘记/撤销后旧正文不会在这里复现。</OpsNotice>}
  </OpsCard>
}
