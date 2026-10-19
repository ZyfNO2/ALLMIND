// LUI-02: 角色工作区的「配置」页。
//
// 路由契约（LUI_CONTRACTS §2.2）：`/characters/:id/config?tab=…`，tab ∈
// `character` `model` `voice` `memory` `perception` `ability` `appearance` `lorebook` `emotion`。
// 未知或缺省 tab 回落到默认值，不渲染空白页，也**不跳旧管理页**——本页已删除全部 `Advanced`
// 与「请使用旧管理页」文案；每个 tab 都消费真实管理 API。
//
// tab 归属：
//  * `character`  → 作者资料 + 人设正文（`/api/characters/profile`、`/api/prompt`）
//  * `model`      → 对话模型最小表单（`ModelPanel`：五项主操作 + 隐藏字段映射）
//  * `voice`      → STT + TTS 绑定 + 本地能力诊断（只读）
//  * `appearance` → 形象资源（复用 `AppearanceResources.tsx`）
//  * `lorebook`   → 故事书 / Lorebook
//  * `emotion`    → 表现策略（`/api/presentation`）
//  * `memory`     → 记忆/知识的高级编辑属于记忆页；这里给新 UI 内部链接
//  * `perception` → 感知授权：**直接挂载**已有 PrivacyPanel（CUX-05 后不再跳全局设置）
//  * `ability`    → 插件/能力属于插件页；这里给新 UI 内部链接
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Settings2, Layers, Mic, Eye, Sparkles, Wrench, Image, BookOpen, Smile, FileText } from 'lucide-react'
import AuthorPanel from '../components/character/AuthorPanel'
import BindingsPanel from '../components/character/BindingPanel'
import ModelPanel from '../components/character/ModelPanel'
import AppearancePanel from '../components/character/AppearancePanel'
import LorebookPanel from '../components/character/LorebookPanel'
import WikiImportPanel from '../components/character/WikiImportPanel'
import DocumentImportPanel from '../components/character/DocumentImportPanel'
import EmotionPanel from '../components/character/EmotionPanel'
import { LocalCapabilityPanel, PerceptionPanel } from '../components/character/CapabilityPanel'
import { Panel } from '../components/character/primitives'

const TABS = [
  { id: 'document', label: '导入角色文档', Icon: FileText },
  { id: 'character', label: '角色配置', Icon: Settings2 },
  { id: 'model', label: '模型', Icon: Wrench },
  { id: 'voice', label: '语音', Icon: Mic },
  { id: 'appearance', label: '形象', Icon: Image },
  { id: 'lorebook', label: '故事书', Icon: BookOpen },
  { id: 'wiki', label: '角色 Wiki', Icon: BookOpen },
  { id: 'emotion', label: '表现', Icon: Smile },
  { id: 'memory', label: '记忆', Icon: Layers },
  { id: 'perception', label: '感知', Icon: Eye },
  { id: 'ability', label: '能力', Icon: Sparkles },
] as const

type TabId = typeof TABS[number]['id']
const DEFAULT_TAB: TabId = 'character'
const TAB_IDS = TABS.map(tab => tab.id) as readonly string[]

/** 未知或缺省 tab 回落到默认值；不因未知 tab 渲染空白页或跳旧页。 */
export function resolveTab(value: string | null | undefined): TabId {
  return value && TAB_IDS.includes(value) ? (value as TabId) : DEFAULT_TAB
}

export default function Config() {
  const { characterId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [fallback, setFallback] = useState<TabId>(DEFAULT_TAB)
  const tab = resolveTab(params.get('tab') || fallback)
  const select = (id: TabId) => {
    setFallback(id)
    // tab 写进 query，便于深链接与刷新保持；未知值由 resolveTab 收敛到默认值。
    setParams(id === DEFAULT_TAB ? {} : { tab: id }, { replace: true })
  }
  return (
    <div className="animate-fade-in space-y-6">
      <nav className="flex flex-wrap gap-2" aria-label="角色配置分区">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => select(id)}
            className={`flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm ${tab === id ? 'bg-aika-500 text-white' : 'bg-white text-ink-500 hover:bg-aika-50'}`}>
            <Icon size={16} />{label}
          </button>
        ))}
      </nav>
      <div key={`${characterId}:${tab}`} className="space-y-6">
        {tab === 'character' && <AuthorPanel characterId={characterId} />}
        {tab === 'document' && <DocumentImportPanel characterId={characterId} />}
        {tab === 'model' && <ModelPanel characterId={characterId} />}
        {tab === 'voice' && <>
          <BindingsPanel characterId={characterId} slots={['stt', 'tts']} />
          <LocalCapabilityPanel />
        </>}
        {tab === 'appearance' && <AppearancePanel characterId={characterId} />}
        {tab === 'lorebook' && <LorebookPanel characterId={characterId} />}
        {tab === 'wiki' && <WikiImportPanel characterId={characterId} />}
        {tab === 'emotion' && <EmotionPanel />}
        {tab === 'memory' && <OwnedElsewhere title="记忆与知识" to={`/characters/${encodeURIComponent(characterId)}/memory`} label="前往 记忆与知识">纠正、遗忘、Wiki、资料库与记忆导入都在「记忆」页，因为它们的范围是记忆数据本身，而不是角色配置。</OwnedElsewhere>}
        {tab === 'perception' && <PerceptionPanel characterId={characterId} />}
        {tab === 'ability' && <OwnedElsewhere title="能力与插件" to={`/characters/${encodeURIComponent(characterId)}/plugins`} label="前往 插件">插件安装/停用与 Flow 配置在「插件」页；未接入的包管理会如实显示不可用。</OwnedElsewhere>}
      </div>
    </div>
  )
}

/** 指向新 UI 内部页面；不提供任何旧管理页入口。 */
function OwnedElsewhere({ title, to, label, children }: { title: string; to: string; label: string; children: string }) {
  return (
    <Panel title={title} description="该分区归属另一个新 UI 页面。">
      <p className="text-sm text-ink-500">{children}</p>
      <Link className="inline-block rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" to={to}>{label}</Link>
    </Panel>
  )
}
