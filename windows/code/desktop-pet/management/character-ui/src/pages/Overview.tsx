import { BookOpen, CalendarCheck2, MessageCircle, FileText, Settings2 } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { Spinner, StatusDot } from '../components/ui'
import { Notice } from '../components/Connection'
import { useAsync } from '../hooks/useAsync'
import { runtime } from '../services/runtime'
export default function Overview() {
  const { characterId = '' } = useParams(), navigate = useNavigate()
  const c = useAsync(() => runtime.getCharacter(characterId), [characterId], undefined)
  const stats = useAsync(() => runtime.getStats(characterId), [characterId], undefined)
  const status = useAsync(() => runtime.getRuntimeStatus(characterId), [characterId], [])
  const today = useAsync(() => runtime.getTodayActivity(characterId), [characterId], undefined)
  const timeline = useAsync(() => runtime.listTimeline(characterId), [characterId], [])
  const goto = (sub: string) => navigate(`/characters/${characterId}/${sub}`)
  if (c.error) return <Notice>{c.error}</Notice>
  if (c.loading) return <Spinner />
  if (!c.data) return <Notice>没有这个角色，请返回角色选择。</Notice>
  const character = c.data
  const metrics = [{ label: '已陪伴', value: stats.data?.companionshipDays, Icon: CalendarCheck2 }, { label: '记录轮次', value: stats.data?.conversationCount, Icon: MessageCircle }, { label: '长期记忆', value: stats.data?.longTermMemoryCount, Icon: FileText }, { label: 'Wiki 条目', value: stats.data?.wikiCount, Icon: BookOpen }]
  return <div className="animate-fade-in grid grid-cols-[1fr_340px] gap-6"><div className="space-y-6">
    <section className="relative h-[300px] overflow-hidden rounded-4xl bg-gradient-to-r from-[#23264a] to-aika-300 shadow-soft"><img src="/assets/avatar-neutral.svg" alt="中性占位图标，非当前桌宠形象" className="h-full w-full object-cover opacity-60" /><div className="absolute left-8 top-7"><h1 className="font-script text-[56px] text-white">{character.name}</h1><p className="mt-3 text-white">{character.tagline}</p></div><div className="absolute right-7 top-7 max-w-[280px] rounded-3xl bg-white/90 p-5"><p>{character.greeting || '选择开始对话，与角色互动。'}</p><button className="mt-3 text-aika-600" onClick={() => goto('chat')}>开始对话 →</button></div></section>
    {stats.error && <Notice>统计读取失败：{stats.error}</Notice>}<section className="grid grid-cols-4 gap-4">{metrics.map(({label,value,Icon}) => <div key={label} className="card p-5"><Icon className="text-aika-500" size={22} /><p className="my-2 text-2xl font-bold">{value ?? '未提供'}</p><p className="text-sm text-ink-500">{label}</p></div>)}</section>
    <section className="card p-6"><h2 className="mb-5 text-lg font-bold">系统状态</h2>{status.error && <Notice>{status.error}</Notice>}<div className="grid grid-cols-3 gap-3">{status.data.map(s => <div key={s.key} className="rounded-2xl bg-slate-50 p-4"><div className="flex items-center gap-2"><StatusDot status={s.status} />{s.label}</div><p className="mt-2 text-xs text-ink-500">{s.detail}</p></div>)}</div></section>
    <section className="card p-6"><h2 className="mb-5 text-lg font-bold">今天的活动</h2>{today.error && <Notice>{today.error}</Notice>}<div className="grid grid-cols-4 gap-4">{Object.entries({ 对话: today.data?.chats, 感知: today.data?.perceptions, 产生记忆: today.data?.memoriesGenerated, 主动事件: today.data?.proactiveCount }).map(([label,value]) => <div key={label}><p className="text-2xl font-bold">{value ?? '未提供'}</p><p className="text-sm text-ink-500">{label}</p></div>)}</div><p className="mt-4 text-xs text-ink-400">活动按当日已存事件统计；未知指标不以零代替。</p></section>
    <section className="card p-6"><div className="flex justify-between"><h2 className="text-lg font-bold">人物简介</h2><button onClick={() => goto('config')} className="text-aika-600"><Settings2 size={18} /></button></div><p className="mt-4 whitespace-pre-wrap text-sm text-ink-600">{character.description || '尚未填写'}</p></section>
  </div><aside className="space-y-6"><section className="card p-5"><h2 className="mb-4 font-bold">近期动态</h2>{timeline.error && <Notice>{timeline.error}</Notice>}{timeline.data.length === 0 && !timeline.error && <p className="text-sm text-ink-400">暂无已存记录</p>}{timeline.data.slice(0,8).map(t => <button key={t.id} onClick={() => goto('timeline')} className="mb-3 block w-full rounded-2xl bg-slate-50 p-3 text-left"><p className="text-xs text-ink-400">{t.time} · {t.title}</p><p className="mt-1 text-sm">{t.summary}</p></button>)}</section><section className="card space-y-3 p-5"><h2 className="font-bold">快速操作</h2>{[['chat','开始对话'],['memory','查看记忆'],['config','调整配置'],['trace','查看 Trace']].map(([sub,label]) => <button key={sub} className="block w-full rounded-xl bg-aika-50 p-3 text-aika-600" onClick={() => goto(sub)}>{label}</button>)}</section></aside></div>
}
