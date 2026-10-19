// LUI-04 · 工作面板：ACP / MCP 协议工作（08-05）。
//
// 边界：保存执行器配置不运行任何命令；`/tools` 只发现工具目录；外部副作用只在确认卡确认后发生。
// 断连或重启可能留下未知结果，系统不自动重发。

import { useEffect, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useOpsSession, useRequestGuard } from './useOps'
import { WORK_PROTOCOL_LABEL, WORK_STATE_LABEL, createWorkProtocolSession, type WorkProtocolSession, type WorkProtocolState, type WorkReviseInput } from './work'
import { OpsBadge, OpsButton, OpsCard, OpsConfirm, OpsDefinition, OpsErrorNotice, OpsNotice } from './Panel'

export default function WorkPanel() {
  const guard = useRequestGuard()
  const session = useOpsSession<WorkProtocolSession>(() => createWorkProtocolSession(runtime, guard), [guard])
  const state = session.state
  useEffect(() => { void session.refresh() }, [session])
  const [protocol, setProtocol] = useState<'acp' | 'mcp'>('acp')
  const [title, setTitle] = useState('')
  const [directory, setDirectory] = useState('')
  const [instruction, setInstruction] = useState('')
  const [grants, setGrants] = useState('[]')
  const [toolName, setToolName] = useState('')
  const [args, setArgs] = useState('{}')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [revising, setRevising] = useState<string | null>(null)
  const [parseError, setParseError] = useState('')

  if (state.available === false) {
    return <OpsCard title="ACP / MCP 协议工作">
      <OpsNotice tone="warn">当前运行实例没有接入协议工作服务（unavailable）。本页不提供占位功能。</OpsNotice>
      <OpsButton tone="ghost" onClick={() => void session.refresh()}>重新读取</OpsButton>
    </OpsCard>
  }

  const profile = protocol === 'acp' ? state.profiles?.acp : state.profiles?.mcp
  const current = state.requests.find(row => row.request?.operationId === state.selected) ?? null
  return <div className="space-y-5">
    <OpsCard title="执行器配置" extra={state.profileDirty && <OpsBadge tone="warn">有未保存草稿</OpsBadge>}>
      <p className="text-sm text-ink-500">配置只登记绝对路径命令，不会在保存或启动时运行。连接检查只发现工具；实际任务仅在确认卡确认后派发。环境变量值不会回显。</p>
      <OpsErrorNotice error={state.error} fallback="工作协议" />
      <OpsErrorNotice error={state.actionError} fallback="工作协议操作" />
      {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
      <OpsDefinition rows={[
        ['ACP 执行器', state.profiles?.acp?.label ?? '未配置'],
        ['MCP 执行器', state.profiles?.mcp?.label ?? '未配置'],
        ['配置修订', state.profiles ? String(state.profiles.revision) : '未读取'],
      ]} />
      <label className="block text-sm"><span className="text-ink-700">执行器配置 JSON</span>
        <textarea className="soft-input mt-1.5 font-mono text-xs" rows={10} maxLength={240000} value={state.profileText}
          disabled={state.busy} onChange={event => session.setProfileText(event.target.value)} />
        <span className="mt-1 block text-xs text-ink-400">格式：{'{ "acp": { "executorId", "label", "command", "args", "cwd"? }, "mcp": { ... , "trustedToolPolicies" } }'}</span></label>
      {!!state.profiles?.acp?.environmentKeys.length && <OpsNotice tone="info">ACP 私密环境变量已保存：{state.profiles.acp.environmentKeys.join(', ')}</OpsNotice>}
      {!!state.profiles?.mcp?.environmentKeys.length && <OpsNotice tone="info">MCP 私密环境变量已保存：{state.profiles.mcp.environmentKeys.join(', ')}</OpsNotice>}
      <OpsButton disabled={state.busy} onClick={() => void session.saveProfiles()}>保存并应用</OpsButton>
    </OpsCard>

    <OpsCard title="新建显式确认任务">
      <label className="block text-sm"><span className="text-ink-700">协议</span>
        <select className="soft-input mt-1.5" value={protocol} disabled={state.busy} onChange={event => { setProtocol(event.target.value as 'acp' | 'mcp'); setToolName('') }}>
          <option value="acp">{WORK_PROTOCOL_LABEL.acp}</option><option value="mcp">{WORK_PROTOCOL_LABEL.mcp}</option>
        </select></label>
      {profile ? <p className="text-xs text-ink-400">当前执行器：{profile.label} · {profile.command}</p> : <OpsNotice tone="warn">配置并保存此协议执行器后，才可创建请求。</OpsNotice>}

      {protocol === 'mcp' && <>
        <OpsButton tone="ghost" disabled={state.busy || !profile} onClick={() => void session.discoverTools()}>发现 MCP 工具</OpsButton>
        {state.tools.length > 0 && <label className="block text-sm"><span className="text-ink-700">MCP 工具</span>
          <select className="soft-input mt-1.5" value={toolName} disabled={state.busy} onChange={event => setToolName(event.target.value)}>
            <option value="">请选择工具</option>
            {state.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}{tool.readOnly ? ' · 本机判定只读' : ' · 需显式授权'}</option>)}
          </select></label>}
        {state.tools.find(tool => tool.name === toolName)?.description && <p className="text-xs text-ink-400">{state.tools.find(tool => tool.name === toolName)!.description}</p>}
      </>}

      <label className="block text-sm"><span className="text-ink-700">任务标题</span>
        <input className="soft-input mt-1.5" maxLength={500} value={title} disabled={state.busy} onChange={event => setTitle(event.target.value)} /></label>
      {protocol === 'acp' && <label className="block text-sm"><span className="text-ink-700">工作目录（绝对路径，可选）</span>
        <input className="soft-input mt-1.5" maxLength={2048} value={directory} disabled={state.busy} onChange={event => setDirectory(event.target.value)} />
        <span className="mt-1 block text-xs text-ink-400">留空时使用执行器配置的工作目录。</span></label>}
      <label className="block text-sm"><span className="text-ink-700">{protocol === 'acp' ? '派发给 Agent 的完整任务' : '本次调用说明'}</span>
        <textarea className="soft-input mt-1.5" rows={5} maxLength={20000} value={instruction} disabled={state.busy} onChange={event => setInstruction(event.target.value)} /></label>
      {protocol === 'mcp' && <>
        <label className="block text-sm"><span className="text-ink-700">工具参数 JSON 对象</span>
          <textarea className="soft-input mt-1.5 font-mono text-xs" rows={4} maxLength={65536} value={args} disabled={state.busy} onChange={event => setArgs(event.target.value)} /></label>
        <label className="block text-sm"><span className="text-ink-700">本次授权 JSON 字符串数组</span>
          <input className="soft-input mt-1.5 font-mono text-xs" maxLength={4096} value={grants} disabled={state.busy} onChange={event => setGrants(event.target.value)} />
          <span className="mt-1 block text-xs text-ink-400">未配置为只读的工具默认要求 write 授权。</span></label>
      </>}
      <OpsButton disabled={state.busy || !profile || !title.trim() || !instruction.trim() || (protocol === 'mcp' && !toolName)} onClick={() => {
        let permissionGrant: string[] = []
        let toolCall: { name: string; arguments: Record<string, unknown> } | undefined
        try {
          const parsedGrants = JSON.parse(grants)
          if (!Array.isArray(parsedGrants) || parsedGrants.some(item => typeof item !== 'string')) throw Error()
          permissionGrant = parsedGrants
          if (protocol === 'mcp') {
            const parsedArgs = JSON.parse(args)
            if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) throw Error()
            toolCall = { name: toolName, arguments: parsedArgs }
          }
        } catch {
          // 参数格式错误在本地拦下：不把无效请求发给服务端，也不伪造一次「已准备」。
          setParseError('MCP 参数必须是 JSON 对象，授权必须是 JSON 字符串数组。')
          return
        }
        setParseError('')
        void session.prepare({ protocol, executorId: profile?.executorId ?? '', title, instruction, permissionGrant, ...(toolCall ? { toolCall } : {}), ...(directory.trim() ? { directory } : {}) })
      }}>生成待确认卡</OpsButton>
      {parseError && <OpsNotice tone="error">{parseError}</OpsNotice>}
      <p className="text-xs text-ink-400">MCP 参数必须是 JSON 对象，授权必须是 JSON 字符串数组。</p>
    </OpsCard>

    <OpsCard title="ACP / MCP 记录">
      <p className="text-sm text-ink-500">待确认任务在本机持久保存；遗忘会擦除本机正文和 Timeline 副本。</p>
      {state.requests.length === 0
        ? <p className="py-4 text-sm text-ink-400">暂无 ACP/MCP 任务。</p>
        : <div className="space-y-2">
          {state.requests.map(row => <button key={row.request.operationId} type="button"
            onClick={() => session.select(row.request.operationId)}
            className={`block w-full rounded-2xl border p-3 text-left ${state.selected === row.request.operationId ? 'border-aika-300 bg-aika-50' : 'border-slate-100'}`}>
            <div className="flex items-center justify-between gap-2">
              <OpsBadge tone={row.forgotten ? 'muted' : row.receipt ? 'ok' : 'warn'}>
                {row.forgotten ? '已遗忘' : row.receipt ? WORK_STATE_LABEL[row.receipt.status] ?? '未知' : row.dispatchStarted ? '执行中' : '待确认'}
              </OpsBadge>
              <span className="text-xs text-ink-400">{String(row.request.protocol).toUpperCase()}</span>
            </div>
            <p className="mt-1 text-sm">{row.forgotten ? '内容已遗忘。' : row.request.target?.title}</p>
            {!row.forgotten && <p className="text-xs text-ink-400">{row.request.executorId}</p>}
          </button>)}
        </div>}

      {current && <RequestDetail row={current} state={state} session={session}
        onConfirm={() => setConfirming(current.request.operationId)}
        onForget={() => setForgetting(current.request.operationId)}
        onRevise={() => setRevising(current.request.operationId)} />}
      {revising && current && <ReviseForm
        key={current.request.operationId}
        row={current} session={session} busy={state.busy}
        onClose={() => setRevising(null)} />}
      {confirming && current && <OpsConfirm
        title={`确认执行这项 ${WORK_PROTOCOL_LABEL[current.request.protocol] ?? current.request.protocol} 请求？`}
        description={<>
          <OpsDefinition rows={[
            ['执行器', current.request.executorId],
            ['目标', current.request.target?.title ?? '未提供'],
            ['工作目录', current.request.target?.directory || '执行器默认目录'],
            ['请求版本', String(current.request.revision)],
            ['本次授权', current.request.permissionGrant?.length ? current.request.permissionGrant.join(', ') : '无'],
          ]} />
          <p className="mt-2">外部副作用仅在确认后发生。断连或进程重启可能留下未知结果，系统不会自动重发。</p>
        </>}
        confirmLabel="确认执行" busy={state.busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void session.confirm(current.request.operationId, current.request.revision) }} />}
      {forgetting && current && <OpsConfirm
        title="遗忘本机记录？"
        description="遗忘将清除 journal 中的任务正文与回执内容，并从 Timeline 移除此来源。外部执行器上的副作用不会因此撤销。"
        confirmLabel="确认遗忘" busy={state.busy}
        onCancel={() => setForgetting(null)}
        onConfirm={() => { setForgetting(null); void session.forget(current.request.operationId) }} />}
    </OpsCard>
  </div>
}

function RequestDetail({ row, state, session, onConfirm, onForget, onRevise }: {
  row: WorkProtocolState['requests'][number]; state: WorkProtocolState; session: WorkProtocolSession
  onConfirm: () => void; onForget: () => void; onRevise: () => void
}) {
  const request = row.request
  const receipt = row.receipt
  const staleProfile = !row.forgotten && request.executorRevision !== undefined && request.executorRevision !== state.profiles?.revision
  return <section className="mt-4 space-y-3 rounded-2xl border border-slate-100 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-bold">{request.target?.title ?? '未命名请求'}</h4>
      <OpsBadge tone={row.forgotten ? 'muted' : staleProfile || receipt?.status !== 'succeeded' ? 'warn' : 'ok'}>
        {row.forgotten ? '已遗忘' : staleProfile ? '配置已变化' : receipt ? WORK_STATE_LABEL[receipt.status] ?? '未知' : row.dispatchStarted ? '执行中' : '待确认'}
      </OpsBadge>
    </header>
    {staleProfile && <OpsNotice tone="warn">此请求绑定的执行器配置已变更。请用当前配置重新准备并核对，不会自动改派。</OpsNotice>}
    <OpsDefinition rows={[
      ['协议', WORK_PROTOCOL_LABEL[request.protocol] ?? request.protocol],
      ['执行器', request.executorId],
      ['执行器配置版本', request.executorRevision ?? '旧记录'],
      ['工作目录', request.target?.directory || '执行器默认目录'],
      ['请求版本', String(request.revision)],
    ]} />
    <div>
      <h5 className="text-sm font-bold">本次确认内容</h5>
      <pre className="mt-1 whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-xs">{row.forgotten ? '内容已按要求遗忘。' : request.instruction}</pre>
    </div>
    {request.toolCall && !row.forgotten && <div>
      <h5 className="text-sm font-bold">工具：{request.toolCall.name}</h5>
      <pre className="mt-1 overflow-x-auto rounded-2xl bg-slate-50 p-3 text-xs">{JSON.stringify(request.toolCall.arguments, null, 2)}</pre>
    </div>}
    {!!request.permissionGrant?.length && !row.forgotten && <OpsNotice tone="warn">授权：{request.permissionGrant.join(', ')}</OpsNotice>}
    {receipt?.summary && !row.forgotten && <div>
      <h5 className="text-sm font-bold">执行回执</h5>
      <pre className="mt-1 whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-xs">{receipt.summary}</pre>
    </div>}
    {receipt?.error?.message && <OpsNotice tone={receipt.status === 'failed' ? 'error' : 'warn'}>{receipt.error.message}</OpsNotice>}
    <div className="flex flex-wrap gap-3">
      {!row.forgotten && !row.dispatchStarted && !receipt && <OpsButton disabled={state.busy || staleProfile} onClick={onConfirm}>打开确认卡</OpsButton>}
      {/* 修订只允许尚未派发、无回执的行；修订后 revision +1，旧确认卡失效。 */}
      {!row.forgotten && !row.dispatchStarted && !receipt && <OpsButton tone="ghost" disabled={state.busy} onClick={onRevise}>修订这条请求</OpsButton>}
      {row.dispatchStarted && !receipt && <OpsButton tone="ghost" disabled={state.busy} onClick={() => void session.cancel(request.operationId, request.revision)}>请求取消</OpsButton>}
      {!row.forgotten && <OpsButton tone="danger" disabled={state.busy} onClick={onForget}>遗忘本机记录</OpsButton>}
    </div>
  </section>
}

/** 修订表单：从选中行预填，提交后 revision +1，必须重新核对。 */
function ReviseForm({ row, session, busy, onClose }: {
  row: WorkProtocolState['requests'][number]; session: WorkProtocolSession; busy: boolean; onClose: () => void
}) {
  const request = row.request
  const [formProtocol] = useState<'acp' | 'mcp'>(request.protocol === 'mcp' ? 'mcp' : 'acp')
  const [formTitle, setFormTitle] = useState(String(request.target?.title ?? ''))
  const [formInstruction, setFormInstruction] = useState(String(request.instruction ?? ''))
  const [formGrants, setFormGrants] = useState(JSON.stringify(request.permissionGrant ?? []))
  const [formArgs, setFormArgs] = useState(JSON.stringify(request.toolCall?.arguments ?? {}))
  const [formError, setFormError] = useState('')
  const submit = () => {
    let permissionGrant: string[] = []
    let toolCall: WorkReviseInput['toolCall']
    try {
      const parsedGrants: unknown = JSON.parse(formGrants)
      if (!Array.isArray(parsedGrants) || parsedGrants.some(item => typeof item !== 'string')) throw Error()
      permissionGrant = parsedGrants as string[]
      if (formProtocol === 'mcp') {
        const parsedArgs: unknown = JSON.parse(formArgs)
        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) throw Error()
        toolCall = { name: String(request.toolCall?.name ?? ''), arguments: parsedArgs as Record<string, unknown> }
        if (!toolCall.name) { setFormError('MCP 修订需要保留原工具名；换工具请重新准备一条请求。'); return }
      }
    } catch {
      setFormError('MCP 参数必须是 JSON 对象，授权必须是 JSON 字符串数组。')
      return
    }
    if (!formTitle.trim() || !formInstruction.trim()) { setFormError('请填写任务标题和说明。'); return }
    setFormError('')
    onClose()
    void session.revise(request.operationId, request.revision, {
      protocol: formProtocol, executorId: String(request.executorId ?? ''),
      title: formTitle, instruction: formInstruction, permissionGrant,
      ...(toolCall ? { toolCall } : {}),
      ...(request.target?.directory ? { directory: String(request.target.directory) } : {}),
    })
  }
  return <section className="mt-4 space-y-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-4">
    <h4 className="font-bold">修订待确认请求（版本 {String(request.revision)} → 新版本）</h4>
    <p className="text-xs text-ink-400">修订后旧确认卡失效，必须重新核对。执行器与工具名沿用原行；换执行器或换工具请重新准备。</p>
    <label className="block text-sm"><span className="text-ink-700">任务标题</span>
      <input className="soft-input mt-1.5" maxLength={500} value={formTitle} disabled={busy} onChange={event => setFormTitle(event.target.value)} /></label>
    <label className="block text-sm"><span className="text-ink-700">任务说明</span>
      <textarea className="soft-input mt-1.5" rows={4} maxLength={20000} value={formInstruction} disabled={busy} onChange={event => setFormInstruction(event.target.value)} /></label>
    {formProtocol === 'mcp' && <label className="block text-sm"><span className="text-ink-700">工具参数 JSON 对象</span>
      <textarea className="soft-input mt-1.5 font-mono text-xs" rows={4} maxLength={65536} value={formArgs} disabled={busy} onChange={event => setFormArgs(event.target.value)} /></label>}
    <label className="block text-sm"><span className="text-ink-700">本次授权 JSON 字符串数组</span>
      <input className="soft-input mt-1.5 font-mono text-xs" maxLength={4096} value={formGrants} disabled={busy} onChange={event => setFormGrants(event.target.value)} /></label>
    {formError && <OpsNotice tone="error">{formError}</OpsNotice>}
    <div className="flex flex-wrap gap-3">
      <OpsButton disabled={busy} onClick={submit}>提交修订</OpsButton>
      <OpsButton tone="ghost" disabled={busy} onClick={onClose}>取消</OpsButton>
    </div>
  </section>
}
