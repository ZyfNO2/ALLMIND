import { useParams, Link, useSearchParams } from 'react-router-dom'
import { Notice } from '../components/Connection'
import TraceView from '../components/data/TraceView'

/**
 * 角色工作区 · Trace（工程证据）。
 *
 * `tab` 取值见 LUI_CONTRACTS §2.2：`llm`（默认）/ `logs`。
 * 未知值回落到 `llm`；不渲染空白页，也不跳旧管理页。
 */
export default function TracePage() {
  const { characterId = '' } = useParams()
  const [params] = useSearchParams()
  const requested = params.get('tab')
  // 契约 tab 取值 `llm`（默认）/ `logs`；视图内部用 traces / logs。
  const tab: 'traces' | 'logs' = requested === 'logs' ? 'logs' : 'traces'

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-ink-900">Trace 与运行日志</h1>
        <p className="mt-1 text-sm text-ink-500">
          这里是工程证据：请求、阶段耗时与 Token。它和用户的动态、记忆与知识 Wiki 分开显示，也从不作为用户事实。
        </p>
      </div>

      {requested && requested !== 'llm' && requested !== 'logs' && <Notice>未知的 Trace 分区「{requested}」，已回落到调用链。</Notice>}

      <TraceView key={tab} characterId={characterId} initialTab={tab} />

      <Link className="inline-block text-sm text-aika-600" to={`/characters/${characterId}/timeline`}>
        查看角色动态 →
      </Link>
    </div>
  )
}
