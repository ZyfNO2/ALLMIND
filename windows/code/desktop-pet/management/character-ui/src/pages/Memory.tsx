import { useParams, useSearchParams } from 'react-router-dom'
import { BookOpen, Clock3, Database, Layers, Sparkles, Upload } from 'lucide-react'
import { Notice } from '../components/Connection'
import MemoryRecords from '../components/data/MemoryRecords'
import MemoryWiki from '../components/data/MemoryWiki'
import WikiReader from '../components/data/WikiReader'
import KnowledgeLibrary from '../components/data/KnowledgeLibrary'
import MemoryDynamics from '../components/data/MemoryDynamics'
import MemoryImport from '../components/data/MemoryImport'
import PendingMemory from '../components/data/PendingMemory'

/**
 * 角色工作区 · 记忆与知识。
 *
 * `tab` 取值见 LUI_CONTRACTS §2.2：memory / wiki / canon / dynamics / import / reference。
 * 未知或缺省值回落到 `memory`，不渲染空白页，也不跳旧管理页。
 */
const TABS = [
  { id: 'memory', label: '长期记忆', Icon: Clock3 },
  { id: 'wiki', label: '沉淀知识 / 陪伴 Wiki', Icon: Database },
  { id: 'canon', label: '角色设定 / Canon', Icon: BookOpen },
  { id: 'dynamics', label: '记忆动态', Icon: Sparkles },
  { id: 'reference', label: '资料库 / 文档', Icon: Layers },
  { id: 'import', label: '导入旧聊天', Icon: Upload },
] as const

type TabId = (typeof TABS)[number]['id']

const isTabId = (value: string | null): value is TabId => !!value && TABS.some(tab => tab.id === value)

export default function Memory() {
  const { characterId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab: TabId = isTabId(requested) ? requested : 'memory'

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-2xl font-bold">记忆与知识</h1>
        <p className="mt-2 text-sm text-ink-500">
          用户事实、待审候选、作者虚构的 Canon 与工程 Trace 是四类不同数据，本页不把它们合并；不把虚构设定写成用户事实。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => setParams(id === 'memory' ? {} : { tab: id }, { replace: true })}
            className={`flex items-center gap-2 rounded-2xl px-5 py-2.5 text-sm font-medium transition ${
              tab === id
                ? 'bg-gradient-to-r from-aika-500 to-aika-400 text-white shadow-soft'
                : 'bg-white/80 text-ink-500 hover:bg-aika-50 hover:text-aika-600'
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {requested && !isTabId(requested) && <Notice>未知的记忆分区「{requested}」，已回落到长期记忆。</Notice>}

      {tab === 'memory' && (
        <div className="space-y-5">
          <MemoryRecords characterId={characterId} />
          <PendingMemory />
        </div>
      )}
      {tab === 'wiki' && <div className="space-y-5"><WikiReader characterId={characterId} /><MemoryWiki characterId={characterId} initialDomain="user" /></div>}
      {tab === 'canon' && <MemoryWiki characterId={characterId} initialDomain="canon" />}
      {tab === 'dynamics' && <MemoryDynamics characterId={characterId} />}
      {tab === 'reference' && <KnowledgeLibrary characterId={characterId} />}
      {tab === 'import' && <MemoryImport characterId={characterId} />}
    </div>
  )
}
