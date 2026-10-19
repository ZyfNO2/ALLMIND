// CUX-02: 角色立绘头像。
//
// 三处消费者（侧栏卡片、角色切换抽屉、角色选择卡）共用这一个组件，保证同一套规则：
// 运行角色用真实 activeSkinId，非运行角色用该角色已保存的 appearance.resourceId。
//
// 读取失败或资源不存在时显示默认图并附可访问状态文案；**绝不显示另一角色的图**。
import { useEffect, useRef, useState } from 'react'
import { acquireAvatar, DEFAULT_AVATAR, invalidateAvatar, subscribeAvatarInvalidation, type AvatarStatus } from '../services/character-avatar'

export default function CharacterAvatar({ characterId, alt, className }: { characterId: string; alt: string; className?: string }) {
  const [state, setState] = useState<{ status: AvatarStatus; url: string; message: string }>({ status: 'loading', url: DEFAULT_AVATAR, message: '' })
  const release = useRef<(() => void) | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  // CUX-01 的保存/应用成功后广播失效：本组件立即重新解析权威映射（不等整页刷新）。
  useEffect(() => subscribeAvatarInvalidation(id => {
    if (id === characterId || id === '*') setAttempt(value => value + 1)
  }), [characterId])

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setState({ status: 'loading', url: DEFAULT_AVATAR, message: '' })
    void (async () => {
      const handle = await acquireAvatar({ characterId, signal: controller.signal })
      // 组件已卸载/角色已切换：立刻释放本次订阅，不把旧角色的图留给新角色。
      if (!alive) { handle.release(); return }
      release.current = handle.release
      setState({ status: handle.status, url: handle.url, message: handle.message })
    })()
    return () => {
      alive = false
      controller.abort()
      release.current?.()
      release.current = undefined
    }
    // 重试通过 attempt 触发；characterId 变化必须重新解析。
  }, [characterId, attempt])

  const status = state.status === 'loading' ? '正在生成头像' : state.status === 'ready' ? '' : state.message
  return (
    <span className="relative inline-block shrink-0">
      <img
        src={state.url}
        alt={state.status === 'ready' ? alt : `${alt}（默认头像）`}
        className={className}
        data-avatar-status={state.status}
        data-avatar-character={characterId}
      />
      {/* 可访问状态：读屏能听到「头像暂不可用/未设置」，视觉上不干扰布局。 */}
      {status && <span className="sr-only" role="status" data-avatar-message={state.status}>{status}</span>}
      {state.status === 'error' && (
        <button
          type="button"
          aria-label={`重新生成 ${alt} 的头像`}
          className="absolute inset-0 rounded-xl bg-ink-900/40 text-[10px] text-white opacity-0 transition hover:opacity-100 focus:opacity-100"
          onClick={() => { invalidateAvatar(characterId); setAttempt(value => value + 1) }}
        >重试</button>
      )}
    </span>
  )
}
