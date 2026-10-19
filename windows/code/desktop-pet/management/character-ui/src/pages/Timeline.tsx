import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Notice } from '../components/Connection'
import TimelineView from '../components/data/TimelineView'

/**
 * 角色工作区 · 动态（完整时间线）。
 *
 * `tab` 取值见 LUI_CONTRACTS §2.2：`timeline`（默认）/ `collection`。
 * 未知值回落到 `timeline`；不渲染空白页，也不跳旧管理页。
 *
 * 本页只展示面向用户的经历记录（Canon / Companion / Work / Collection 四个领域）。
 * 请求、耗时、Token 等工程字段只在 Trace 页出现。
 */
export default function Timeline() {
  const { characterId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab = requested === 'collection' ? 'collection' : 'timeline'

  return (
    <div className="animate-fade-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">动态与统一时间线</h1>
          <p className="mt-1 text-sm text-ink-500">
            按领域与日期查看已存事件；领域筛选、分页游标与日期区间都由服务端执行，未知事件类型不冒充对话或感知。
          </p>
        </div>
        <div className="flex gap-2">
          {(
            [
              ['timeline', '统一时间线'],
              ['collection', '采集记录'],
            ] as ['timeline' | 'collection', string][]
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setParams(id === 'timeline' ? {} : { tab: id }, { replace: true })}
              className={`rounded-2xl px-4 py-2 text-[13px] font-medium transition ${
                tab === id
                  ? 'bg-gradient-to-r from-aika-500 to-aika-400 text-white shadow-soft'
                  : 'bg-white/80 text-ink-500 hover:bg-aika-50 hover:text-aika-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {requested && requested !== 'timeline' && requested !== 'collection' && (
        <Notice>未知的动态分区「{requested}」，已回落到统一时间线。</Notice>
      )}

      {tab === 'timeline' ? (
        <TimelineView characterId={characterId} />
      ) : (
        <section className="card space-y-3 p-6">
          <h2 className="text-base font-bold">采集记录</h2>
          <p className="text-sm text-ink-500">
            本机采集的授权、来源与样本管理在
            <Link className="mx-1 text-aika-600" to={`/characters/${encodeURIComponent(characterId)}/config?tab=perception`}>
              角色配置 · 感知
            </Link>
            中完成；采集是显式授权能力，本页不代用户开启来源。
          </p>
          <p className="text-xs text-ink-400">
            已授权来源产生的采集事件会作为 collection 领域出现在统一时间线中，可回到「统一时间线」勾选该领域查看。
          </p>
        </section>
      )}
    </div>
  )
}
