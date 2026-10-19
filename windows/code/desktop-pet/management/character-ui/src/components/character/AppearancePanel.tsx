// CUX-01: 形象资源管理（角色作用域）——内嵌预览、导入后自动显示、外观选择正确回读。
//
// 真实契约：
//  * `GET  /api/skins`                        → 外观登记（revision / activeSkinId / skins）
//  * `GET  /api/snapshot`                     → `runtime.characterId`（运行身份的唯一权威）
//  * `GET  /api/characters/bindings?characterId` → `configuration.appearance` 才是**已保存选择**的权威
//  * `POST /api/skins/{id}/activate`          → **运行角色**切换（`expectedRevision`）
//  * `PUT  /api/characters/appearance`        → **非运行角色**只写自己的 saved 选择
//  * `POST /api/desktop/resource-picker`      → 原生选择器票据；导入只登记，不激活
//
// 两个状态必须分开（A 的核心 + DUX-02 选中即预览）：
//   * `selected`  草稿：用户在资源下拉里选的资源，未保存；预览**直接跟随**它渲染（初始已选、
//                 普通选择、导入成功即渲染，无常驻预览/关闭按钮），绝不写入后端；
//   * `saved`     后端事实：非运行角色取 `configuration.appearance.resourceId`，运行角色取
//                 `state.activeSkinId`。
//
// 读取来源修正：本页**不再**从 `/api/characters/profile` 猜 appearance —— 该接口不返回这个字段
// （CUX-00 场景 5 已取证），旧写法让初始选择永远是空。
//
// 关键不变量：非运行角色的应用**绝不**调用全局激活；应用失败保留原形象（不乐观更新）；
// 预览只读（不 activate、不写 appearance、不启麦克风、不发 LLM/TTS/STT）。
import { useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import AppearanceResources from '../AppearanceResources'
import PortraitPanel from './PortraitPanel'
import ResourcePreview from '../ResourcePreview'
import { invalidateAvatar } from '../../services/character-avatar'
import { createCharacterSession, isConflict, messageOf, type SkinState } from './session'
import { ErrorNotice, Panel, SelectField, SuccessNotice, Unavailable } from './primitives'

const session = createCharacterSession(runtime)

export default function AppearancePanel({ characterId }: { characterId: string }) {
  const loaded = useAsync(async () => {
    const [skins, snapshot, bindings] = await Promise.all([
      session.loadSkins(),
      runtime.request('/api/snapshot'),
      session.loadBindings(characterId),
    ])
    return { skins, snapshot, bindings: bindings.view }
  }, [characterId], undefined)
  if (loaded.error) return <ErrorNotice message={`读取形象资源失败：${loaded.error}`} />
  if (!loaded.data) return <Spinner />
  return (
    <AppearanceEditor
      key={characterId}
      characterId={characterId}
      initial={loaded.data}
      onRefresh={async () => {
        const [skins, bindings] = await Promise.all([session.loadSkins(), session.loadBindings(characterId)])
        loaded.setData({ ...loaded.data!, skins, bindings: bindings.view })
        return { skins, saved: bindings.view.configuration?.appearance }
      }}
    />
  )
}

/** 已保存选择：非运行角色取 `configuration.appearance`，运行角色取登记表的 `activeSkinId`。 */
function savedAppearanceOf(initial: { skins: SkinState; snapshot: any; bindings: any }, characterId: string): { resourceId: string; type: 'live2d' | 'sprite' } {
  const runningCharacterId: string = initial.snapshot?.runtime?.characterId || ''
  if (runningCharacterId === characterId && initial.skins.state.activeSkinId) {
    const active = initial.skins.state.skins.find((skin: any) => skin.skinId === initial.skins.state.activeSkinId)
    return { resourceId: initial.skins.state.activeSkinId, type: (active?.type as 'live2d' | 'sprite') || 'live2d' }
  }
  const saved = initial.bindings?.configuration?.appearance
  return { resourceId: saved?.resourceId || '', type: saved?.type === 'sprite' ? 'sprite' : 'live2d' }
}

function AppearanceEditor({ characterId, initial, onRefresh }: {
  characterId: string
  initial: { skins: SkinState; snapshot: any; bindings: any }
  onRefresh: () => Promise<{ skins: SkinState; saved: any }>
}) {
  const runningCharacterId: string = initial.snapshot?.runtime?.characterId || ''
  const isRunning = runningCharacterId === characterId
  const saved0 = savedAppearanceOf(initial, characterId)
  const [skins, setSkins] = useState<SkinState>(initial.skins)
  // 草稿（未保存）；saved 是后端事实。DUX-02：预览跟随 selected（初始/选择/导入即渲染），无独立开关。
  const [type, setType] = useState<'live2d' | 'sprite'>(saved0.type)
  const [selected, setSelected] = useState<string>(saved0.resourceId)
  const [saved, setSaved] = useState<{ resourceId: string; type: 'live2d' | 'sprite' }>(saved0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [state, setState] = useState({ busy: false, message: '', error: '', conflict: '', previewError: '' })
  const applying = useRef(false)

  const available = skins.state.skins.filter(skin => (skin.type || 'live2d') === type)
  // 预览对象直接跟随草稿选择：资源消失（被移除/登记表刷新）时自然不渲染旧资源。
  const preview = selected ? skins.state.skins.find(skin => skin.skinId === selected) : undefined

  /** 草稿选择变化：预览立即跟随切换。 */
  function chooseResource(skinId: string) {
    setSelected(skinId)
    setState(current => ({ ...current, message: '', error: '', conflict: '', previewError: '' }))
  }

  /** 切换类型：草稿清空，预览随之回到选择提示。 */
  function chooseType(next: 'live2d' | 'sprite') {
    setType(next)
    setSelected('')
    setState(current => ({ ...current, message: '', error: '', conflict: '', previewError: '' }))
  }

  // 路由退出/角色切换：卸载时由 ResourcePreview 的 cleanup 释放引擎（abort + dispose）；
  // 这里不 setState —— 卸载后更新状态是无效写入，旧画面也不会被保留。

  /** 显式应用/保存。预览组件从不调用它。 */
  async function apply() {
    if (applying.current) return
    applying.current = true
    setState(current => ({ ...current, busy: true, message: '', error: '', conflict: '' }))
    try {
      const result = await session.applyAppearance({
        characterId,
        runningCharacterId,
        resourceId: selected,
        type,
        expectedRevision: skins.state.revision,
        activeSkinId: skins.state.activeSkinId,
      })
      // 应用成功后**真实回读**并同步本编辑器的局部状态（不只更新父组件的 initial）。
      const refreshed = await onRefresh()
      setSkins(refreshed.skins)
      const nextSaved = isRunning
        ? { resourceId: refreshed.skins.state.activeSkinId, type }
        : { resourceId: refreshed.saved?.resourceId || selected, type: (refreshed.saved?.type as 'live2d' | 'sprite') || type }
      setSaved(nextSaved)
      setSelected(nextSaved.resourceId)
      setType(nextSaved.type)
      // CUX-02：应用/保存成功后让侧栏等头像消费者立即重新解析权威映射。
      invalidateAvatar(characterId)
      setState({ busy: false, error: '', conflict: '', previewError: '', message: result.message })
    } catch (error) {
      setState(current => ({
        ...current,
        busy: false, message: '',
        error: isConflict(error) ? '' : `应用形象失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 原形象保持不变，请刷新后重试。` : '',
      }))
    } finally { applying.current = false }
  }

  return (
    <Panel
      title="形象与资源来源"
      description="从已登记的资源包中选择形象；导入只登记资源，应用成功后才显示为生效。"
      extra={<span className="chip bg-slate-100 text-ink-500">外观登记修订 {skins.state.revision} · 当前生效 {skins.state.activeSkinId || '未知'}</span>}
    >
      <p className="text-xs text-ink-500">
        {isRunning
          ? '该角色正在运行：应用会切换运行形象（带登记修订校验）。'
          : `该角色当前未运行（运行中：${runningCharacterId || '未知'}）：应用只保存该角色自己的选择，下次它成为运行角色时生效；不会翻转正在运行的形象。`}
      </p>
      <p className="text-xs text-ink-500">已保存的选择：{saved.resourceId || '未设置'}{saved.resourceId && saved.resourceId !== selected ? `（当前草稿：${selected || '未选择'}，尚未保存）` : ''}</p>
      <SelectField
        id="appearance-type"
        label="形象类型"
        value={type}
        options={[['live2d', 'Live2D 模型'], ['sprite', '精灵图 / Sprite']]}
        onChange={value => chooseType(value as 'live2d' | 'sprite')}
      />
      {available.length === 0
        ? <Unavailable>没有已登记的{type === 'sprite' ? '精灵图' : 'Live2D'}资源；可先在下方导入并登记。</Unavailable>
        : (
          <SelectField
            id="appearance-resource"
            label="形象资源包"
            value={selected}
            options={[['', '请选择已登记资源'], ...available.map((skin: any) => [skin.skinId, `${skin.label || skin.skinId}${skin.skinId === skins.state.activeSkinId ? ' · 当前生效' : ''}${skin.skinId === saved.resourceId ? ' · 已保存' : ''} (${skin.origin})`] as [string, string])]}
            onChange={chooseResource}
          />
        )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" id="appearance-apply" className="rounded-2xl bg-aika-500 px-5 py-2 text-white disabled:opacity-40"
          disabled={state.busy || !selected || available.length === 0} onClick={() => void apply()}>
          {state.busy ? '应用中…' : (isRunning ? '应用并切换运行形象' : '保存到该角色')}
        </button>
        <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" onClick={() => setDialogOpen(true)}>导入资源</button>
      </div>
      <p className="text-xs text-ink-400">导入只登记资源；运行角色应用后立即切换，其他角色下次启动生效。</p>

      {/* ---- 内嵌预览：初始已选/普通选择/导入成功即渲染，无常驻开关（DUX-02） ---- */}
      <section className="space-y-3 rounded-2xl border border-slate-100 p-4" aria-label="资源预览">
        <h3 className="text-sm font-bold">实际资源预览</h3>
        <p className="text-xs text-ink-400">选中即预览已登记资源，不应用、不切换运行形象，也不启动麦克风或语音服务。非运行角色同样可以预览。</p>
        {/* ResourcePreview 始终挂载：两个 canvas 元素必须常驻 DOM —— 同一 canvas 不能换 context 类型，
            且频繁重建会耗尽 WebGL context。未选资源时组件内部显示选择提示并停引擎。 */}
        <ResourcePreview skin={preview} onFailure={message => setState(current => ({ ...current, previewError: message }))} />
        {state.previewError && <Notice>预览失败：{state.previewError}（资源已登记，可重新选择后重试）</Notice>}
      </section>

      <SuccessNotice message={state.message} />
      <ErrorNotice message={state.error} />
      {state.conflict && <Notice>{state.conflict}</Notice>}
      {dialogOpen && (
        <AppearanceResources
          id={characterId}
          skins={skins.state.skins}
          selected={selected || ''}
          onClose={() => setDialogOpen(false)}
          onImported={async (state2, skinId) => {
            // 导入只登记：不激活、不改变运行形象，也不自动应用。
            setSkins(current => ({ ...current, state: state2 }))
            const imported = state2?.skins?.find((skin: any) => skin.skinId === skinId)
            if (!skinId) {
              // 差集不能唯一识别：不猜、不取任意首项，也不把旧 selected 说成新导入。
              setState(current => ({ ...current, message: '导入已完成，未能确定预览资源，请手动选择要预览的资源。', error: '', conflict: '', previewError: '' }))
              return
            }
            // 选中新资源、切到它的真实类型、关闭弹窗；预览随 selected 立即渲染。
            setSelected(skinId)
            if (imported?.type === 'sprite' || imported?.type === 'live2d') setType(imported.type)
            setDialogOpen(false)
            setState({ busy: false, error: '', conflict: '', previewError: '', message: '已导入并预览，尚未应用。' })
          }}
        />
      )}
      <Notice>支持已登记 Live2D / Sprite 的实际预览及系统选择器导入。3D 形象未实现。静态立绘差分在下方单独管理，不会因为导入而替换当前形象。</Notice>
      <PortraitPanel characterId={characterId} />
    </Panel>
  )
}
