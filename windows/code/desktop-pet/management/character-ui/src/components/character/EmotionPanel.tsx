// LUI-02: 表情 / 动作表现策略（`GET/PUT /api/presentation`）。
//
// 真实契约（`management/presentation.ts` + `management/server.ts`）：
//  * `GET /api/presentation` → `{ catalog, policy }`；`catalog` 是当前模型的已核对预设目录，
//    `policy` 是允许自动使用的条目与它自己的 revision。
//  * `PUT /api/presentation` → `{ modelId, expectedRevision, enabledIds }`；revision 不匹配是 409。
//
// 只允许切换 `availability === 'automatic'` 的条目：外观类预设不进入自动策略，服务端也会拒绝
// （`只能更改当前模型已接入的自动表现。`）。保存成功后采用服务端返回的 policy，不本地推进 revision。
import { useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { createCharacterSession, isConflict, messageOf } from './session'
import { ErrorNotice, Panel, SuccessNotice, Unavailable } from './primitives'

const session = createCharacterSession(runtime)

const CATEGORY_NAMES: Record<string, string> = { all: '全部', expression: '表情', pose: '姿势', appearance: '外观', idle: '待机' }
const SOURCE_NAMES: Record<string, string> = { 'model-expression': '模型预设', 'model-motion': '模型动画', procedural: '程序动作' }

export default function EmotionPanel() {
  const loaded = useAsync(() => session.loadPresentation(), [], undefined)
  if (loaded.error) return <ErrorNotice message={`读取表现策略失败：${loaded.error}`} />
  if (!loaded.data) return <Spinner />
  return <EmotionEditor initial={loaded.data} onChange={next => loaded.setData(next)} />
}

function EmotionEditor({ initial, onChange }: { initial: Awaited<ReturnType<typeof session.loadPresentation>>; onChange: (next: Awaited<ReturnType<typeof session.loadPresentation>>) => void }) {
  const [view, setView] = useState(initial)
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [state, setState] = useState({ busy: '', message: '', error: '', conflict: '' })

  const enabled = new Set(view.policy.enabledIds)
  const items = view.catalog.items.filter(item =>
    (category === 'all' || item.category === category) && (!query || String(item.label).toLowerCase().includes(query.toLowerCase())))

  async function toggle(item: any, next: boolean) {
    setState({ busy: item.id, message: '', error: '', conflict: '' })
    const ids = new Set(enabled)
    if (next) ids.add(item.id); else ids.delete(item.id)
    try {
      const saved = await session.savePresentation({ modelId: view.catalog.modelId, expectedRevision: view.policy.revision, enabledIds: [...ids] })
      setView(saved)
      onChange(saved)
      setState({ busy: '', error: '', conflict: '', message: `已保存：${item.label}${next ? '允许' : '不再'}自动使用。` })
    } catch (error) {
      // 409 时保留用户的选择意图并提示刷新，不静默重载覆盖。
      setState({
        busy: '', message: '',
        error: isConflict(error) ? '' : `保存失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 你的选择尚未保存，请刷新后重试。` : '',
      })
    }
  }

  return (
    <Panel
      title="表情与动作表现策略"
      description="勾选只控制桌宠自动使用；保存后立即生效。外观配件仅供手动预览，不进入自动策略。"
      extra={<span className="chip bg-slate-100 text-ink-500">设置修订 {view.policy.revision} · 模型 {view.catalog.modelId}</span>}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="搜索表情或动作" type="search" className="soft-input max-w-xs" value={query} placeholder="搜索表情或动作" onChange={e => setQuery(e.target.value)} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="预设分类">
          {Object.entries(CATEGORY_NAMES).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={category === id}
              className={`rounded-xl px-3 py-1.5 text-xs ${category === id ? 'bg-aika-500 text-white' : 'border border-aika-200 text-aika-600'}`}
              onClick={() => setCategory(id)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {items.map((item: any) => {
          const allowed = enabled.has(item.id)
          return (
            <div key={item.id} data-preset-id={item.id} className="rounded-2xl border border-slate-100 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <strong className="text-sm">{item.label}</strong>
                  <p className="text-xs text-ink-400">{CATEGORY_NAMES[item.category]} · {SOURCE_NAMES[item.source]}</p>
                </div>
                {item.availability === 'automatic'
                  ? (
                    <label className="flex items-center gap-2 text-xs text-ink-600">
                      <input type="checkbox" aria-label={`${item.label} 允许自动使用`} checked={allowed} disabled={!!state.busy}
                        onChange={e => void toggle(item, e.target.checked)} />
                      允许自动使用
                    </label>
                  )
                  : <span className="chip bg-amber-50 text-amber-700">{item.previewable ? '手动预览' : '不可预览'}</span>}
              </div>
              {item.reason && <p className="mt-1 text-xs text-ink-400">{item.reason}</p>}
            </div>
          )
        })}
        {items.length === 0 && <Unavailable>没有找到匹配的预设。</Unavailable>}
      </div>

      <SuccessNotice message={state.message} />
      <ErrorNotice message={state.error} />
      {state.conflict && <Notice>{state.conflict}</Notice>}
      <p className="text-xs text-ink-400">未开放的外观预设不会交给聊天模型；这里的开关不改变模型文件本身。</p>
    </Panel>
  )
}
