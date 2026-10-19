import { useState, type ComponentType } from 'react'
import {
  BookOpen,
  Bot,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  MessageCircle,
  Plug,
  Plus,
  Settings2,
  Users,
  X,
} from 'lucide-react'
import { Navigate, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { Notice, Action } from '../components/Connection'
import CharacterAvatar from '../components/CharacterAvatar'
import { useAsync } from '../hooks/useAsync'
import { runtime } from '../services/runtime'
import type { Character } from '../types'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ size?: number | string; className?: string }>
  end?: boolean
}

const characterNav: NavItem[] = [
  { to: 'overview', label: '概览', icon: LayoutDashboard },
  { to: 'timeline', label: '动态', icon: Clock3 },
  { to: 'memory', label: '记忆', icon: BookOpen },
  { to: 'config', label: '配置', icon: Settings2 },
]

const toolNav: NavItem[] = [
  { to: 'chat', label: '聊天', icon: MessageCircle },
  { to: 'trace', label: 'Trace', icon: Bot },
  { to: 'plugins', label: '插件', icon: Plug },
]

export default function AppLayout() {
  const { characterId = 'aika' } = useParams()
  const navigate = useNavigate()
  const { data: characters, loading, error } = useAsync(() => runtime.listCharacters(), [], [] as Character[])
  const registry = useAsync(() => runtime.registry(), [characterId], undefined)
  const current = characters.find((c) => c.id === characterId)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-[13.5px] font-medium transition-all ${
      isActive
        ? 'bg-gradient-to-r from-aika-500 to-aika-400 text-white shadow-soft'
        : 'text-ink-500 hover:bg-aika-50 hover:text-aika-600'
    }`

  if (error) return <Notice>{error}</Notice>
  if (!loading && !current) return <Navigate to="/characters" replace />
  return (
    <div className="flex h-screen overflow-hidden">
      {/* ============ 固定 Sidebar ============ */}
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-white/70 bg-white/70 backdrop-blur-xl">
        {/* 品牌 */}
        <button
          onClick={() => navigate('/characters')}
          className="flex items-center gap-2 px-5 pt-5 pb-3 text-left"
        >
          <span className="font-script text-[34px] leading-none text-aika-500">ALLMIND</span>
          <span className="mt-3 rounded-full bg-aika-100 px-1.5 py-0.5 text-[10px] font-semibold text-aika-600">
            Next
          </span>
        </button>

        {/* 当前角色卡 */}
        <div className="px-3">
          <button
            onClick={() => setSwitcherOpen(true)}
            className="flex w-full items-center gap-3 rounded-2xl border border-aika-100 bg-white/80 p-2.5 text-left transition hover:shadow-card"
          >
            <CharacterAvatar characterId={current?.id ?? characterId} alt={current?.name ?? ''} className="h-10 w-10 rounded-xl object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-ink-900">
                {current?.name ?? '加载中…'}
              </div>
              <div className="truncate text-[11px] text-ink-300">
                {current?.status === 'ready' ? current.tagline : '建设中…'}
              </div>
            </div>
            <Users size={15} className="text-ink-300" />
          </button>
        </div>

        {/* 角色功能区 */}
        <div className="mt-4 px-3">
          <p className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-ink-300">
            角色功能
          </p>
          <nav className="space-y-1">
            {characterNav.map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClass}>
                <item.icon size={17} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        {/* 工程工具区 */}
        <div className="mt-5 px-3">
          <p className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-ink-300">
            工程工具
          </p>
          <nav className="space-y-1">
            {toolNav.map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClass}>
                <item.icon size={17} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex-1" />

        {/* CUX-05：角色工作区不再提供「全局设置」常驻入口。
            `/settings` 深链、宿主维护入口与对应 API 全部保留（见 pages/Settings.tsx）；
            隐藏常驻 UI 不等于禁止维护路由。 */}
      </aside>

      {/* ============ 主内容 ============ */}
      <main className="flex-1 overflow-y-auto">
        {/* 顶栏：只保留角色切换。CUX-05 移除了「全局设置」按钮。 */}
        <div className="sticky top-0 z-20 flex items-center justify-end gap-3 bg-transparent px-7 py-4">
          <button
            onClick={() => setSwitcherOpen(true)}
            className="flex items-center gap-2 rounded-2xl border border-white/80 bg-white/70 px-4 py-2 text-[13px] font-medium text-ink-700 shadow-card backdrop-blur transition hover:bg-white"
          >
            <Users size={15} className="text-aika-500" />
            角色切换
          </button>
        </div>

        <div className="px-7 pb-10">
          {registry.error && <Notice>{registry.error}</Notice>}
          {registry.data && <div className="mb-5 rounded-2xl bg-white/70 p-3 text-xs text-ink-500">当前运行：{registry.data.selection.effectiveCharacterId} · 下次启动：{registry.data.selection.savedCharacterId} · 本页只浏览 {characterId}
            {registry.data.selection.savedCharacterId !== characterId && <Action run={async () => { await runtime.selectCharacter(characterId, registry.data.selection.selectionRevision); registry.setData(await runtime.registry()); return '运行角色选择已保存，重启后生效；当前轮次不切换。' }}>设为下次运行角色</Action>}
          </div>}
          <Outlet key={characterId} />
        </div>
      </main>

      {/* ============ 角色切换 Drawer ============ */}
      {switcherOpen && (
        <CharacterSwitcher
          characters={characters}
          currentId={characterId}
          onClose={() => setSwitcherOpen(false)}
          onPick={(id) => {
            setSwitcherOpen(false)
            navigate(`/characters/${id}/overview`)
          }}
          onCreate={() => {
            setSwitcherOpen(false)
            navigate('/characters')
          }}
        />
      )}
    </div>
  )
}

function CharacterSwitcher({
  characters,
  currentId,
  onClose,
  onPick,
  onCreate,
}: {
  characters: Character[]
  currentId: string
  onClose: () => void
  onPick: (id: string) => void
  onCreate: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-slide-in relative flex h-full w-[320px] flex-col bg-white p-5 shadow-soft">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-ink-900">切换角色</h3>
          <button onClick={onClose} className="rounded-xl p-1.5 text-ink-300 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2">
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c.id)}
              className={`flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition ${
                c.id === currentId
                  ? 'border-aika-300 bg-aika-50'
                  : 'border-slate-100 hover:bg-slate-50'
              }`}
            >
              <CharacterAvatar characterId={c.id} alt={c.name} className="h-11 w-11 rounded-xl object-cover" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-ink-900">{c.name}</div>
                <div className="truncate text-xs text-ink-300">
                  {c.status === 'ready' ? c.tagline : '建设中…'}
                </div>
              </div>
              {c.id === currentId && <ChevronRight size={16} className="text-aika-500" />}
            </button>
          ))}
        </div>

        <button
          onClick={onCreate}
          className="mt-3 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-aika-200 py-3 text-sm font-medium text-aika-500 transition hover:border-aika-400 hover:bg-aika-50"
        >
          <Plus size={16} />
          创建新角色
        </button>
      </div>
    </div>
  )
}
