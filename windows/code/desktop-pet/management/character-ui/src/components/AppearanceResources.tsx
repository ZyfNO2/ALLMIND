// CUX-01: 资源导入弹窗（只负责导入与登记，不再承担预览）。
//
// A 要求「预览选中资源 / 关闭预览」和七状态从对话框搬到形象页内嵌展示。因此本组件现在只保留
// 导入所需的交互：原生选择器票据、Sprite 帧参数、状态片段，以及一次确认导入。
//
// 关键不变量：
//   * 导入**只登记**：不调用 activate、不写 characters/appearance、不自动应用；
//   * 取消/失败不改变选中态；
//   * 弹窗里**不保留第二个预览引擎**（预览归 `ResourcePreview.tsx` 与形象页）。
import { useEffect, useRef, useState } from 'react'
import { runtime } from '../services/runtime'
import { Action, Notice } from './Connection'

type ResourceType = 'live2d' | 'sprite'
type SelectionKind = 'directory' | 'model-entry' | 'archive' | 'image'
interface Selection { selectionId: string; displayName: string; selectionKind: SelectionKind; entries: { entry: string }[] }

/** 从导入前后的 skinId 集合差集识别新资源；差集不唯一时返回 undefined 而不是任取首项。 */
export function identifyImported(previous: Set<string>, skins: any[]): string | undefined {
  const added = (skins || []).filter(skin => !previous.has(skin.skinId))
  return added.length === 1 ? added[0].skinId : undefined
}

export default function AppearanceResources({ id, skins, selected, onImported, onClose }: {
  id: string; skins: any[]; selected: string;
  onImported: (state: any, selected: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [type, setType] = useState<ResourceType>('live2d')
  const [ticket, setTicket] = useState<Selection>()
  const [entry, setEntry] = useState(''), [label, setLabel] = useState(''), [picking, setPicking] = useState(false)
  const [frames, setFrames] = useState({ rows: 1, columns: 1, frameCount: 1, fps: 12 })
  const [clipState, setClipState] = useState('idle')
  const [clips, setClips] = useState<Record<string, { start: number; frameCount: number; fps: number }>>({})
  useEffect(() => { dialog.current?.showModal() }, [])
  async function pick(selectionKind: SelectionKind) {
    setPicking(true); setTicket(undefined); setEntry('')
    try {
      const result = await runtime.request('/api/desktop/resource-picker', { method: 'POST', body: { characterId: id, type, selectionKind } })
      if (result.outcome === 'cancelled') return '已取消选择，没有改动任何设置。'
      if (result.outcome !== 'selected' || !result.selectionId) throw Error('资源选择器返回了无效票据。')
      const entries = result.entries || []
      setTicket({ selectionId: result.selectionId, displayName: result.displayName, selectionKind, entries })
      setEntry(entries.length === 1 ? entries[0].entry : '')
      return ''
    } finally { setPicking(false) }
  }
  return <dialog ref={dialog} aria-labelledby="appearance-resources-title" onCancel={event => { event.preventDefault(); onClose() }}
    className="max-h-[85vh] w-[min(800px,90vw)] overflow-y-auto rounded-3xl border border-aika-100 bg-white p-6 shadow-soft backdrop:bg-ink-900/30">
    <header className="mb-5 flex items-center justify-between"><h2 id="appearance-resources-title" className="text-xl font-bold">资源导入</h2><button aria-label="关闭资源导入" onClick={onClose} className="rounded-xl px-3 py-2 hover:bg-slate-100">关闭</button></header>
    <p className="mb-5 text-sm text-ink-500">导入只登记资源；导入成功后会在形象页内嵌预览，但不会自动应用到角色。</p>
    <section className="space-y-4">
      <h3 className="font-bold">导入资源</h3>
      <label className="block text-sm">导入类型<select aria-label="导入类型" className="soft-input mt-2" value={type} disabled={picking} onChange={e => { setType(e.target.value as ResourceType); setTicket(undefined); setEntry('') }}><option value="live2d">Live2D 模型包</option><option value="sprite">Sprite 图片 / 图集</option></select></label>
      <div key={type} className="flex flex-wrap gap-3">{type === 'live2d' ? <><Action disabled={picking} run={() => pick('directory')}>选择模型包目录</Action><Action disabled={picking} run={() => pick('model-entry')}>选择 .model3.json 文件</Action><Action disabled={picking} run={() => pick('archive')}>选择 ZIP 模型包</Action></> : <Action disabled={picking} run={() => pick('image')}>选择 PNG / WebP</Action>}</div>
      <label className="block text-sm">显示名称（选填）<input className="soft-input mt-2" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
      {type === 'sprite' && <div className="grid grid-cols-4 gap-3">{Object.entries({ rows: '行数', columns: '列数', frameCount: '有效帧数', fps: 'FPS' }).map(([key, title]) => <label key={key} className="text-sm">{title}<input type="number" className="soft-input mt-2" min="1" step={key === 'fps' ? 'any' : '1'} value={frames[key as keyof typeof frames]} onChange={e => setFrames({ ...frames, [key]: Number(e.target.value) })} /></label>)}</div>}
      {type === 'sprite' && <div className="space-y-3 rounded-xl bg-slate-50 p-4">
        <label className="block text-sm">状态动画<select aria-label="状态动画" className="soft-input mt-2" value={clipState} onChange={e => setClipState(e.target.value)}>{Object.entries({ idle: '待机', listening: '倾听', thinking: '思考', speaking: '说话', working: '工作', happy: '开心', sleeping: '睡眠' }).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!clips[clipState]} onChange={e => { const next = { ...clips }; if (e.target.checked) next[clipState] = { start: 0, frameCount: frames.frameCount, fps: frames.fps }; else delete next[clipState]; setClips(next) }} />为该状态指定动画片段</label>
        {clips[clipState] && <div className="grid grid-cols-3 gap-3">{Object.entries({ start: '起始帧（从 0 计）', frameCount: '帧数', fps: 'FPS' }).map(([key, title]) => <label key={key} className="text-sm">{title}<input type="number" className="soft-input mt-2" min={key === 'start' ? 0 : 1} value={clips[clipState][key as 'start' | 'frameCount' | 'fps']} onChange={e => setClips({ ...clips, [clipState]: { ...clips[clipState], [key]: Number(e.target.value) } })} /></label>)}</div>}
        <p className="text-xs text-ink-500">没有单独指定的状态沿用待机片段；没有待机片段时使用完整图集。</p>
      </div>}
      {ticket && <div className="space-y-3 rounded-2xl bg-slate-50 p-4">
        <p>已选择：{ticket.displayName}</p>
        {type === 'live2d' && ticket.entries.length === 0 && <Notice>没有找到 .model3.json 入口，请重新选择模型包。</Notice>}
        {type === 'live2d' && ticket.entries.length > 0 && <label className="block text-sm">模型入口<select className="soft-input mt-2" value={entry} onChange={e => setEntry(e.target.value)}><option value="">请选择模型入口</option>{ticket.entries.map(v => <option key={v.entry} value={v.entry}>{v.entry}</option>)}</select></label>}
      </div>}
      <Action disabled={!ticket || picking || (type === 'live2d' && !entry) || (type === 'sprite' && Object.values(frames).some(v => !Number.isFinite(v) || v <= 0))} run={async () => {
        if (!ticket) throw Error('请先选择资源。')
        const previous = new Set(skins.map(skin => skin.skinId))
        const state = await runtime.request('/api/desktop/resource-picker', { method: 'POST', body: { characterId: id, type, selectionKind: ticket.selectionKind, selectionId: ticket.selectionId, ...(entry ? { entry } : {}), ...(label.trim() ? { label: label.trim() } : {}), ...(type === 'sprite' ? { sprite: { ...frames, ...(Object.keys(clips).length ? { clips } : {}) } } : {}) } })
        const added = identifyImported(previous, state.skins)
        // 差集不能唯一识别时**不取任意首项**，也不把旧 selected 伪称为新导入。
        await onImported(state, added ?? '')
        setTicket(undefined); setEntry('')
        return '资源已导入并登记，尚未应用到角色。'
      }}>确认导入</Action>
      <p className="text-xs text-ink-400">已登记资源：{skins.length} 个{selected ? `（当前选中 ${selected}）` : ''}。导入不改变选中态以外的任何设置。</p>
    </section>
  </dialog>
}
