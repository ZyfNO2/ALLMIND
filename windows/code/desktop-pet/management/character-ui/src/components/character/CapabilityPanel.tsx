// LUI-02 / CUX-05: 本地能力诊断（只读）与感知授权（内嵌）。
//
// 本地能力是「诚实」面板：未接入时显示未接入原因而不是假 ready。
// 感知授权自 CUX-05 起直接在本页挂载已有 PrivacyPanel，不再只给一个指向全局设置的链接。
import { useCallback, useEffect, useState } from 'react'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { runtime } from '../../services/runtime'
import PrivacyPanel from '../ops/PrivacyPanel'
import { createCharacterSession, messageOf, type LocalCapability } from './session'
import { ErrorNotice, Panel } from './primitives'

const session = createCharacterSession(runtime)

type CapabilityState = { loading: boolean; observedAt?: string; capabilities?: LocalCapability[]; error: string }

export function LocalCapabilityPanel() {
  const [state, setState] = useState<CapabilityState>({ loading: true, error: '' })

  const refresh = useCallback(async () => {
    setState(current => ({ ...current, loading: true, error: '' }))
    try {
      const data = await session.loadLocalCapabilities()
      setState({ loading: false, observedAt: data.observedAt, capabilities: data.capabilities, error: '' })
    } catch (error) {
      // 未接入 ≠ 不可用，也 ≠ 可用：这里只报告真实的失败原因。
      setState(current => ({ loading: false, observedAt: current.observedAt, capabilities: current.capabilities, error: messageOf(error) }))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const retry = <button type="button" className="rounded-xl border border-aika-200 px-4 py-2 text-sm text-aika-600" disabled={state.loading} onClick={() => void refresh()}>{state.loading ? '检测中…' : '重新检测'}</button>

  if (state.loading && !state.capabilities) return <Spinner />
  if (state.error && !state.capabilities) {
    return (
      <Panel title="本地能力诊断" description="只读检测本机可用的本地语音能力；不做合成、不加载模型。" extra={retry}>
        <Notice>{`本机本地能力检测未接入：${state.error}`}</Notice>
        <p className="text-xs text-ink-400">未接入不等于不可用，也不代表可用；这里不显示任何猜测结果。</p>
      </Panel>
    )
  }
  return (
    <Panel
      title="本地能力诊断"
      description={`只读检测（观测时间 ${state.observedAt}）。检测成功不等于真实合成/识别验收。`}
      extra={retry}
    >
      <div className="space-y-3">
        {(state.capabilities || []).map(capability => (
          <div key={capability.capabilityId} className="rounded-2xl bg-slate-50 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <strong className="text-sm">{capability.capabilityId}</strong>
              <span className={`chip ${capability.availability === 'ready' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700'}`}>
                {capability.availability === 'ready' ? '可用' : capability.availability === 'unsupported' ? '本平台不支持' : '不可用'}
              </span>
              <code className="text-xs text-ink-500">{capability.adapterId}</code>
            </div>
            <p className="mt-1 text-xs text-ink-500">原因：{capability.reason}</p>
            {capability.voices?.length ? <p className="mt-1 text-xs text-ink-500">已枚举音色：{capability.voices.map(v => v.label || v.id).join('、')}</p> : null}
            {capability.languages?.length ? <p className="mt-1 text-xs text-ink-500">声明语言：{capability.languages.join('、')}</p> : null}
          </div>
        ))}
      </div>
      {state.error ? <Notice>{`上次检测失败：${state.error}`}</Notice> : null}
      <ErrorNotice message="" />
    </Panel>
  )
}

/**
 * CUX-05：感知 tab 直接挂载**已有的** PrivacyPanel，不再只给一个指向 `/settings` 的链接。
 *
 * 为什么必须这样：隐藏「全局设置」常驻入口后，如果感知授权只靠那条链接到达，就会造成「无入口功能」。
 * 这里复用现有面板与其真实读取/授权/撤销方法，**不复制第二份请求状态机**，也不新增 grant schema。
 *
 * 归属说明（SPEC §2.3）：采集、唤醒等设置作用于**整个运行实例**；屏幕与陪伴操作按**当前角色和运行配对**校验。
 * `characterId` 传递给按角色的子域，用浏览对象而不是运行角色，避免偷换校验对象。
 */
export function PerceptionPanel({ characterId }: { characterId: string }) {
  return (
    <div className="space-y-6">
      <Panel title="感知与隐私" description="授权与撤销都在本页完成；不需要离开角色工作区。">
        <Notice>
          采集、唤醒等设置作用于<strong>整个运行实例</strong>；屏幕及陪伴操作按<strong>当前角色和运行配对</strong>校验（当前浏览：{characterId}）。
          进入本页只读取，只有你明确操作才会写入。
        </Notice>
        <p className="text-sm text-ink-500">默认全部关闭。未装配或读取失败时如实显示，不用空列表或默认值冒充健康。</p>
        <p className="text-xs text-ink-400">非运行角色不会因此获得运行角色的授权；按角色的操作由既有 pairing/admission 规则校验。</p>
      </Panel>
      <PrivacyPanel characterId={characterId} />
    </div>
  )
}
