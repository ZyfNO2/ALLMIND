// CUX-01 / DUX-02: 形象页内嵌的实际资源预览。
//
// CUX-01：从导入对话框提升为共享组件；加载真实资产、卸载时释放引擎。
// DUX-02：新增「动作与表情预览」——选项来自**模型包自身**（getPreviewOptions：全部 expression、
// 全部 motion group/index、Sprite 已声明 clips、静态资源），选择只在本预览引擎内播放；
// 运行时七状态保留为次要诊断，不再冒充模型能力。
//
// 关键不变量：
//   * 预览**只读**：不调用 activate、不写 characters/appearance、不启麦克风、不发 LLM/TTS/STT 请求；
//   * 每个引擎成对释放（abort + dispose），切换资源或角色离开时不残留 RAF / 旧画面；
//   * 加载失败是可见状态并允许显式重试，不保留永久 rejected promise；
//   * 未知/不可用选项真实报错，不静默回落到待机动画。
import { useEffect, useRef, useState } from 'react'
import { Notice } from './Connection'
import { openSkinPreview, PREVIEW_STATE_LABELS, PREVIEW_STATES, type SkinPreviewHandle, type SkinPreviewOption } from '../services/skin-preview'

/** DUX 契约的 PreviewOption 只读形状（由 preview 引擎的 getPreviewOptions 提供）。 */
type PreviewOption = SkinPreviewOption

export default function ResourcePreview({ skin, onFailure }: { skin: any; onFailure?: (message: string) => void }) {
  // Two stable canvases: a canvas can never host a second context kind after a WebGL one, so the
  // Live2D (WebGL) and Sprite (2d) previews each keep their own element and reuse it across loads.
  // The component itself stays mounted even without a selection (the canvases must never leave the
  // DOM — rebuilding them would exhaust WebGL contexts), so `skin` may be undefined.
  const glCanvas = useRef<HTMLCanvasElement>(null)
  const spriteCanvas = useRef<HTMLCanvasElement>(null)
  const handle = useRef<SkinPreviewHandle | undefined>(undefined)
  const [characterState, setCharacterState] = useState<string>('idle')
  const [selectedOption, setSelectedOption] = useState('')
  const [options, setOptions] = useState<PreviewOption[]>([])
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ loading: true, error: '' })
  const isSprite = (skin?.type || 'live2d') === 'sprite'
  const skinId: string = skin?.skinId ?? ''

  useEffect(() => {
    // 没有已选资源：停掉旧引擎，保留两个画布在 DOM 里（不能因条件渲染卸载它们）。
    if (!skinId) {
      handle.current?.dispose(); handle.current = undefined
      setState({ loading: false, error: '' })
      setCharacterState('idle'); setSelectedOption(''); setOptions([])
      return
    }
    const controller = new AbortController()
    let alive = true
    setState({ loading: true, error: '' })
    setCharacterState('idle'); setSelectedOption(''); setOptions([])
    handle.current = undefined
    void (async () => {
      try {
        const opened = await openSkinPreview({ canvas: isSprite ? spriteCanvas.current : glCanvas.current, skinId, signal: controller.signal })
        // 晚到的句柄：组件已卸载或已换资源时必须自己 dispose，绝不把旧角色画布留在这里。
        if (!alive) { opened.dispose(); return }
        handle.current = opened
        setOptions((opened.getPreviewOptions?.() ?? []) as PreviewOption[])
        setState({ loading: false, error: '' })
      } catch (error) {
        if (!alive || controller.signal.aborted) return
        const message = (error as Error).message
        setState({ loading: false, error: message })
        onFailure?.(message)
      }
    })()
    return () => { alive = false; handle.current = undefined; controller.abort() }
    // `attempt` 只用于显式重试；`skinId` 变化必须重建引擎。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinId, attempt])

  return (
    <div className="space-y-3">
      {/* 没有已选资源：只提示，不渲染下拉；两个画布仍常驻 DOM（context 复用前提）。 */}
      {!skinId && <p role="status" className="text-sm text-ink-500">请选择要预览的已登记资源。</p>}
      {skinId && state.loading && <p role="status">正在加载实际资源…</p>}
      {skinId && state.error && (
        <div className="space-y-2">
          <Notice>预览失败：{state.error}</Notice>
          <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" onClick={() => setAttempt(value => value + 1)}>重新加载预览</button>
        </div>
      )}
      {skinId && !state.loading && !state.error && <p role="status">正在预览：{skin.label || skin.skinId}</p>}
      {skinId && !state.loading && !state.error && options.length > 0 && (
        <label className="block text-sm">
          动作与表情预览
          <select
            aria-label="动作与表情预览"
            className="soft-input mt-2"
            value={selectedOption}
            onChange={event => {
              const id = event.target.value
              setSelectedOption(id)
              if (!id) { handle.current?.resetPreview?.(); return }
              void handle.current?.selectPreviewOption?.(id).catch((error: unknown) => {
                // 未知/不可用选项是真实错误：回显原因并复位选择，不静默回落。
                setSelectedOption('')
                setState(current => ({ ...current, error: (error as Error).message }))
              })
            }}
          >
            <option value="">默认预览</option>
            {options.map(option => (
              <option key={option.id} value={option.id} disabled={!option.available}>
                {option.label}{option.available ? '' : `（不可用${option.reason ? `：${option.reason}` : ''}）`}
              </option>
            ))}
          </select>
          <span className="mt-2 block text-xs text-ink-500">只播放本模型包的动作/表情，不影响角色运行状态。</span>
        </label>
      )}
      {skinId && !state.loading && !state.error && options.length === 0 && (
        <p className="text-xs text-ink-400">当前资源没有可预览的动作或表情（静态外观）。</p>
      )}
      {skinId && !state.loading && !state.error && (
        <label className="block text-sm">
          角色状态测试
          <select
            aria-label="角色状态测试"
            className="soft-input mt-2"
            value={characterState}
            onChange={event => { handle.current?.setState(event.target.value); setCharacterState(event.target.value) }}
          >
            {PREVIEW_STATES.map(key => <option key={key} value={key}>{PREVIEW_STATE_LABELS[key]}</option>)}
          </select>
          <span className="mt-2 block text-xs text-ink-500">只测试角色运行动画，不启动麦克风或语音服务。</span>
        </label>
      )}
      {/* 两个稳定画布：Live2D 用 WebGL，Sprite 用 2d；同一 canvas 不能换 context 类型。
          hidden 的画布不参与命中测试（interactive regions 按可见性上报），但保留元素以复用 context。 */}
      <canvas ref={glCanvas} hidden={isSprite} aria-label="资源实际预览" className="h-[320px] w-full rounded-2xl bg-slate-50" />
      <canvas ref={spriteCanvas} hidden={!isSprite} aria-label="资源实际预览" className="h-[320px] w-full rounded-2xl bg-slate-50" />
    </div>
  )
}
