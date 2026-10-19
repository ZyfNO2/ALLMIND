// LUI-04 · 宿主设置面板（快捷键与语音 / 显示）。
//
// 宿主（Electron 主进程）是这些偏好的唯一持久 owner；本页只读写真实状态，
// 未连接宿主时显示 unavailable，绝不显示「已保存」。

import { useEffect, useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useOpsSession, useRequestGuard } from './useOps'
import { createDesktopHostSession, DISPLAY_MAX_WIDTH, DISPLAY_MIN_WIDTH, hotkeyLabel, hotkeyScopeNote, isValidHotkey } from './host'
import { OpsBadge, OpsButton, OpsCard, OpsDefinition, OpsErrorNotice, OpsNotice } from './Panel'

export default function HostPanel() {
  const guard = useRequestGuard()
  const host = useOpsSession(() => createDesktopHostSession(runtime, guard), [guard])
  const state = host.state
  const [binding, setBinding] = useState(false)
  const bindButton = useRef<HTMLButtonElement>(null)

  // 只有本页可见时才读取宿主；宿主缺席时不显示任何「已保存」。
  useEffect(() => { void host.refresh() }, [host])

  useEffect(() => {
    if (!binding) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Escape') { setBinding(false); return }
      // 组合键与重复键不接受：按住发言必须是单一物理键。
      if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (!isValidHotkey(event.code)) { setBinding(false); void host.bindHotkey(event.code); return }
      setBinding(false)
      void host.bindHotkey(event.code)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [binding, host])

  const preferences = state.preferences
  return (
    <div className="space-y-4">
      <OpsCard title="快捷键与语音" extra={preferences && <OpsBadge tone={preferences.capabilities?.preferences ? 'ok' : 'warn'}>{preferences.capabilities?.preferences ? '偏好持久化已接入' : '偏好持久化不可用'}</OpsBadge>}>
        <p className="text-sm text-ink-500">这些设置由桌宠宿主（Electron 进程）保存，控制台只读写真实状态；未连接桌宠时不会显示为已保存。</p>
        <OpsErrorNotice error={state.error} fallback="宿主设置" />
        {state.message && <OpsNotice tone="ok">{state.message}</OpsNotice>}
        {state.conflict && <OpsNotice tone="warn">设置已在别处更新。你的改动仍保留在本页，请刷新核对后再保存。</OpsNotice>}

        {!preferences
          ? <div className="space-y-3">
            <OpsNotice tone="warn">尚未读取到宿主设置（宿主缺席或未接入）。本页不显示任何默认值冒充已保存。</OpsNotice>
            <OpsButton tone="ghost" disabled={state.loading} onClick={() => void host.refresh()}>{state.loading ? '读取中…' : '读取宿主设置'}</OpsButton>
          </div>
          : <>
            <OpsDefinition rows={[
              ['宿主修订', String(preferences.revision)],
              ['偏好持久化', preferences.capabilities?.preferences ? '已接入' : '不可用'],
              ['原生文件选择', preferences.capabilities?.filePicker ? '已接入' : '尚未接入'],
              ['展示与尺寸', preferences.capabilities?.display ? '已接入' : '不可用'],
            ]} />

            <div className="space-y-2">
              <span className="text-sm text-ink-700">输入框外按住发言</span>
              <div className="flex flex-wrap items-center gap-3">
                <b aria-live="polite">{binding ? '请按一个键…' : hotkeyLabel(preferences.hotkey)}</b>
                <button ref={bindButton} type="button" disabled={state.saving} onClick={() => setBinding(true)}
                  className="rounded-2xl border border-aika-200 px-4 py-2 text-sm text-aika-600 disabled:opacity-40">
                  {preferences.hotkey ? '更换按键' : '设置按键'}
                </button>
                <OpsButton tone="ghost" disabled={state.saving || preferences.hotkey === null} onClick={() => void host.clearHotkey()}>清除</OpsButton>
              </div>
              {/* native-global 才是系统级热键；window-only 必须说清只在桌宠窗口生效。 */}
              <p className="text-xs text-ink-400">{hotkeyScopeNote(preferences.capabilities)}</p>
            </div>

            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={state.draft?.replySound === true} disabled={state.saving}
                onChange={event => void host.setReplySound(event.target.checked)} />
              <span>回复声音</span>
            </label>
            <p className="text-xs text-ink-400">
              {state.draft?.replySound
                ? '角色回复会播放语音。关闭后回复仍会正常生成与显示，只是不播放声音。'
                : '已关闭：回复仍会正常生成与显示，但不会播放声音。'}
            </p>

            {preferences.capabilities?.display && state.draft && <>
              <label className="block text-sm">
                <span className="text-ink-700">展示模式</span>
                <select className="soft-input mt-1.5" value={state.draft.mode} disabled={state.saving}
                  onChange={event => void host.setMode(event.target.value as 'full' | 'half')}>
                  <option value="full">完整</option>
                  <option value="half">半身</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-700">期望宽度（{state.draft.preferredWidth} px）</span>
                <input type="range" className="mt-1.5 w-full" min={DISPLAY_MIN_WIDTH} max={DISPLAY_MAX_WIDTH} step={1}
                  value={state.draft.preferredWidth} disabled={state.saving}
                  onChange={event => host.edit('preferredWidth', Number(event.target.value))}
                  onMouseUp={() => void host.setPreferredWidth(state.draft!.preferredWidth)}
                  onTouchEnd={() => void host.setPreferredWidth(state.draft!.preferredWidth)} />
                <span className="mt-1 block text-xs text-ink-400">这是显示意图；宿主会按屏幕边界拟合，实际尺寸以宿主报告为准。</span>
              </label>
              {preferences.display && <OpsDefinition rows={[
                ['实际模型尺寸', `${preferences.display.modelWidth} × ${preferences.display.modelHeight}`],
                ['抽屉高度', String(preferences.display.drawerHeight)],
              ]} />}
            </>}

            <div className="flex flex-wrap gap-3">
              <OpsButton tone="ghost" disabled={state.saving || state.loading} onClick={() => void host.refresh()}>{state.saving ? '保存中…' : '重新读取'}</OpsButton>
              {state.conflict && <OpsButton tone="ghost" onClick={() => host.keepDraft()}>保留我的改动并继续编辑</OpsButton>}
            </div>
          </>}
      </OpsCard>
    </div>
  )
}
