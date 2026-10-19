import { useState } from 'react'
import { Notice, Action } from '../components/Connection'
import CharacterAvatar from '../components/CharacterAvatar'
import { Plus, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { runtime } from '../services/runtime'
import type { Character } from '../types'

export default function CharacterSelect() {
  const navigate = useNavigate()
  const { data: characters, loading, error, setData } = useAsync(
    () => runtime.listCharacters(),
    [],
    [] as Character[],
  )
  const [keyword, setKeyword] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [operation, setOperation] = useState(crypto.randomUUID())
  const [target, setTarget] = useState<string>('')
  const [replacement, setReplacement] = useState('')

  const filtered = characters.filter(
    (c) => c.name.includes(keyword) || c.tagline.includes(keyword),
  )

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#1e2138]">
      {/* 背景：角色主视觉 + 深色遮罩 + 光斑 */}
      <img
        src="/assets/avatar-neutral.svg"
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-40"
      />
      <div className="absolute inset-0 bg-gradient-to-br from-[#1b1e36]/90 via-[#23264a]/70 to-[#2a2440]/85" />
      <div className="pointer-events-none absolute -right-24 top-10 h-96 w-96 rounded-full bg-aika-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -left-20 bottom-0 h-80 w-80 rounded-full bg-sakura-400/10 blur-3xl" />

      <div className="relative mx-auto max-w-6xl px-10 py-12">
        {/* 顶部：Logo + 说明 + 搜索 */}
        <header className="flex items-start justify-between">
          <div>
            <h1 className="font-script text-[72px] leading-none text-white drop-shadow-lg">
              ALLMIND
            </h1>
            <p className="mt-3 text-lg tracking-wide text-white/70">
              与你一起，记录平凡的日常
            </p>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 backdrop-blur-md">
            <Search size={16} className="text-white/50" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索角色…"
              className="w-40 bg-transparent text-sm text-white placeholder:text-white/40 focus:outline-none"
            />
          </div>
        </header>

        {error && <Notice>{error}</Notice>}
        <p className="mt-6 text-sm text-white/70">这里列出已登记角色。进入只浏览，不切换当前运行角色；界面插画不是角色的运行形象。</p>
        {/* 角色卡 */}
        <div className="mt-12 grid grid-cols-3 gap-7">
          {loading &&
            [0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[420px] animate-pulse rounded-3xl bg-white/10"
              />
            ))}

          {filtered.map((c) => (
            <CharacterCard
              key={c.id}
              character={c}
              onEnter={() =>
                c.status === 'ready'
                  ? navigate(`/characters/${c.id}/overview`)
                  : undefined
              }
              onManage={() => { setTarget(c.id); setReplacement('') }}
            />
          ))}
        </div>
        {target && <div className="card mt-5 space-y-3 p-5">
          <h2 className="font-bold">管理整个角色：{characters.find(c => c.id === target)?.name}</h2>
          <p className="text-sm text-ink-500">删除后该角色不能继续运行或被选中，历史隔离保留。替换会建立新的角色身份，不继承旧角色记忆；运行中或已选中的角色请先切换并重启。</p>
          <label className="block text-sm">替换后的角色名称<input aria-label="替换后的角色名称" className="soft-input mt-2" value={replacement} onChange={e => setReplacement(e.target.value)} /></label>
          <div className="flex gap-3"><Action run={async () => {
            if (!window.confirm('删除整个角色？该角色将从列表移除并停止准入，历史隔离保留。')) return ''
            const roster = await runtime.registry(), role = roster.characters.find((c: any) => c.id === target)
            if (!role) throw Error('角色已不存在，请刷新。')
            await runtime.request(`/api/characters/${encodeURIComponent(target)}/remove`, { method: 'POST', body: { expectedRevision: role.revision } })
            setData(await runtime.listCharacters()); setTarget(''); return '整个角色已删除，历史隔离保留。'
          }}>删除整个角色</Action><Action disabled={!replacement.trim()} run={async () => {
            if (!window.confirm('替换整个角色？新角色使用独立身份，旧角色将从列表移除。')) return ''
            const roster = await runtime.registry(), role = roster.characters.find((c: any) => c.id === target)
            if (!role) throw Error('角色已不存在，请刷新。')
            const result = await runtime.request(`/api/characters/${encodeURIComponent(target)}/replace`, { method: 'POST', body: { expectedRevision: role.revision, label: replacement.trim(), operationId: crypto.randomUUID() } })
            setData(await runtime.listCharacters()); setTarget(''); navigate(`/characters/${result.character.id}/config`); return '已建立替换角色，请配置新角色。'
          }}>替换整个角色</Action><button onClick={() => setTarget('')}>关闭</button></div>
        </div>}

        {/* 创建新角色 */}
        <button
          onClick={() => setCreating(v => !v)}
          className="group mt-8 flex h-[190px] w-[300px] flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-white/25 text-white/70 transition hover:border-white/50 hover:bg-white/5 hover:text-white"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/30 transition group-hover:scale-110">
            <Plus size={24} />
          </span>
          <span className="text-lg font-medium">创建新角色</span>
        </button>
        {creating && <div className="card mt-5 max-w-md space-y-4 p-5"><input className="soft-input" placeholder="角色名称" value={name} onChange={e => { setName(e.target.value); setOperation(crypto.randomUUID()) }}/><Action disabled={!name.trim()} run={async () => { await runtime.createCharacter(name.trim(), operation); setOperation(crypto.randomUUID()); setName(''); setData(await runtime.listCharacters()); setCreating(false); return '角色已登记；人设和模型绑定请继续配置。' }}>登记角色</Action></div>}
      </div>
    </div>
  )
}

function CharacterCard({
  character,
  onEnter,
  onManage,
}: {
  character: Character
  onEnter: () => void
  onManage: () => void
}) {
  const ready = character.status === 'ready'
  return (
    <div
      role="group" aria-label={`角色：${character.name}`}
      className={`group overflow-hidden rounded-3xl text-left transition-all duration-300 ${
        ready
          ? 'bg-white shadow-soft hover:-translate-y-1.5 hover:shadow-[0_24px_60px_-12px_rgba(122,108,245,0.45)]'
          : 'bg-white/85 opacity-90'
      }`}
    >
      {/* 图片区 */}
      <div className="relative h-[268px] overflow-hidden">
        <CharacterAvatar
          characterId={character.id}
          alt={character.name}
          className={`h-full w-full object-cover transition-transform duration-500 ${
            ready ? 'group-hover:scale-105' : ''
          }`}
        />
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/25 to-transparent" />
        {!ready && (
          <span className="absolute right-3 top-3 rounded-full bg-ink-900/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur">
            建设中
          </span>
        )}
      </div>

      {/* 信息区 */}
      <div className="px-6 pb-6 pt-5 text-center">
        <h3 className="text-[26px] font-bold text-ink-900">{character.name}</h3>
        <p className="mt-2 h-5 text-[15px] text-ink-500">
          {ready ? character.tagline : '还在建设中…'}
        </p>
        {character.lastUsedAt && (
          <p className="mt-1 text-[11px] text-ink-300">最近使用：{character.lastUsedAt}</p>
        )}
        <div
          className={`mt-4 rounded-2xl py-3 text-[17px] font-semibold transition ${
            ready
              ? 'bg-slate-100 text-ink-700 group-hover:bg-gradient-to-r group-hover:from-aika-500 group-hover:to-aika-400 group-hover:text-white'
              : 'cursor-not-allowed bg-slate-100 text-ink-300'
          }`}
        >
          <button type="button" className="w-full" onClick={onEnter} disabled={!ready}>进入</button>
        </div>
        <button type="button" className="mt-3 w-full text-sm text-ink-500" onClick={onManage}>删除 / 替换整个角色</button>
      </div>
    </div>
  )
}
